// Command demo is the sample service for the Envoy service mesh: one small
// program that can become any service, configured entirely by environment.
//
//	GET  /health         liveness, for the ECS health check
//	GET  /               answers as this service
//	GET  /call/b/c/...   forwards along a chain: calls b with /call/c/...,
//	                     and the last service in the chain answers /
//	GET  /stats          this task's calls to each service it has called
//
// Any request takes ?delay=<ms> and ?size=<bytes>. They are passed along the
// chain unchanged and applied by whichever service answers, so a load test
// sets the leaf's latency and response size, and every hop before it adds
// only what forwarding costs. POST works the same as GET.
//
// The program has no idea a mesh exists. It calls b.demo.mesh like any
// hostname; iptables in the task sends the connection to the local Envoy
// sidecar, and Envoy routes it to one of b's tasks. Run without a sidecar,
// behind an NLB, the same call goes to b's NLB instead, and /stats is the
// only record of it: what Envoy would otherwise count for free.
package main

import (
	"cmp"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	service    = cmp.Or(os.Getenv("SERVICE_NAME"), "unknown")
	meshDomain = cmp.Or(os.Getenv("MESH_DOMAIN"), "demo.mesh")
	targetPort = cmp.Or(os.Getenv("DEFAULT_TARGET_PORT"), "8080")
)

const maxDelay = 10 * time.Second

// Every response body is one of these; empty fields are left out.
type body struct {
	Service  string          `json:"service,omitempty"`
	Status   string          `json:"status,omitempty"`
	Message  string          `json:"message,omitempty"`
	Called   string          `json:"called,omitempty"`
	Response json.RawMessage `json:"response,omitempty"`
	Error    string          `json:"error,omitempty"`
	Padding  string          `json:"padding,omitempty"`
}

// One client for every downstream call, keeping connections open between
// calls. Go keeps only two idle connections per host by default, which under
// load would mean opening and closing connections constantly.
var client = &http.Client{
	Timeout:   10 * time.Second,
	Transport: &http.Transport{MaxIdleConnsPerHost: 1024, IdleConnTimeout: 90 * time.Second},
}

// Calls to one service: running totals, and the latest latencies, kept in a
// ring so a percentile reflects recent traffic rather than all of it.
type calls struct {
	mu               sync.Mutex
	requests, errors uint64
	recentMs         [2048]float64
	n                int
}

var outbound sync.Map // target name -> *calls

func record(target string, took time.Duration, failed bool) {
	c, _ := outbound.LoadOrStore(target, &calls{})
	stats := c.(*calls)
	stats.mu.Lock()
	defer stats.mu.Unlock()
	stats.requests++
	if failed {
		stats.errors++
	}
	stats.recentMs[stats.n%len(stats.recentMs)] = float64(took.Microseconds()) / 1000
	stats.n++
}

// The same shape the dashboard reads from Envoy: per target, the totals and
// recent p50 and p99.
func serveStats(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{}
	outbound.Range(func(target, c any) bool {
		stats := c.(*calls)
		stats.mu.Lock()
		recent := slices.Clone(stats.recentMs[:min(stats.n, len(stats.recentMs))])
		requests, errors := stats.requests, stats.errors
		stats.mu.Unlock()
		slices.Sort(recent)
		at := func(p float64) float64 { return recent[int(p*float64(len(recent)-1))] }
		out[target.(string)] = map[string]any{"requests": requests, "errors": errors, "p50Ms": at(0.50), "p99Ms": at(0.99)}
		return true
	})
	data, _ := json.Marshal(out)
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

func main() {
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		reply(w, http.StatusOK, body{Service: service, Status: "healthy"})
	})
	http.HandleFunc("/{$}", answer)
	http.HandleFunc("/stats", serveStats)
	http.HandleFunc("/call/{target}", forward)
	http.HandleFunc("/call/{target}/{rest...}", forward)
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		reply(w, http.StatusNotFound, body{Error: "not found"})
	})

	port := cmp.Or(os.Getenv("APP_PORT"), "8080")
	fmt.Printf("%s listening on port %s\n", service, port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func answer(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	delayMs, errDelay := strconv.ParseFloat(strings.TrimSuffix(cmp.Or(q.Get("delay"), "0"), "ms"), 64)
	size, errSize := strconv.Atoi(cmp.Or(q.Get("size"), "0"))
	if errDelay != nil || errSize != nil {
		reply(w, http.StatusBadRequest, body{Error: "delay is milliseconds (e.g. 50 or 50ms), size is bytes"})
		return
	}
	time.Sleep(min(time.Duration(delayMs*float64(time.Millisecond)), maxDelay))

	b := body{Service: service, Message: "Hello from " + service + "!"}
	if size > 0 {
		base, _ := json.Marshal(b)
		b.Padding = strings.Repeat(".", max(0, size-len(base)-len(`,"padding":""`)))
	}
	reply(w, http.StatusOK, b)
}

// /call/b/c/d asks b for /call/c/d; the last service in the chain is asked for /.
func forward(w http.ResponseWriter, r *http.Request) {
	target, path := r.PathValue("target"), "/"
	if rest := r.PathValue("rest"); rest != "" {
		path = "/call/" + rest
	}
	// A mesh service's address is just its name plus the mesh domain.
	downstream := url.URL{Scheme: "http", Host: target + "." + meshDomain + ":" + targetPort, Path: path, RawQuery: r.URL.RawQuery}

	start := time.Now()
	resp, err := client.Get(downstream.String())
	if err != nil {
		record(target, time.Since(start), true)
		reply(w, http.StatusBadGateway, body{Service: service, Error: fmt.Sprintf("calling %s: %v", target, err)})
		return
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	record(target, time.Since(start), err != nil || resp.StatusCode >= 400)
	if err != nil || resp.StatusCode >= 400 {
		reply(w, http.StatusBadGateway, body{Service: service, Error: fmt.Sprintf("%s returned %d", target, resp.StatusCode)})
		return
	}
	// The downstream's JSON is embedded as-is, not parsed and rebuilt.
	reply(w, http.StatusOK, body{Service: service, Called: target, Response: raw})
}

func reply(w http.ResponseWriter, code int, b body) {
	data, err := json.Marshal(b)
	if err != nil {
		code, data = http.StatusBadGateway, []byte(`{"error":"downstream returned invalid JSON"}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(code)
	w.Write(data)
}
