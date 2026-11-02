# Envoy Service Mesh on ECS/EC2

A working demo of an Envoy-based service mesh on Amazon ECS (EC2 launch type). Deploy one CDK stack to get:

- **Envoy sidecar proxies** on each service with transparent iptables egress interception
- **Edge proxy** (standalone Envoy behind an NLB) for external traffic into the mesh
- **xDS control plane** (AWS Lambda + EventBridge) generating Envoy configs from AWS Cloud Map
- **Uniform DNS addressing** — callers use `{service}.{prefix}.mesh` whether inside or outside the mesh
- **Service API** — a REST endpoint (`POST /services/{name}`) that onboards new mesh services at runtime, no CDK required
- **Load testing** — `POST /load/{target}` holds a fixed TPS against any service, using [Fortio](https://github.com/fortio/fortio)
- **DynamoDB service registry** — one table both entrypoints write to and the control plane reads
- **Four config files for the whole mesh** — the mesh is fully connected, so every proxy reads the same CDS, EDS, LDS and RDS

## How It Works

Every service in the mesh gets a DNS name like `predict.demo.mesh`. The same address works from two places:

**From inside the mesh** (sidecar path):
```
App calls predict.demo.mesh:8080
  → DNS resolves to NLB IP (Amazon Route 53 alias)
  → iptables intercepts the outbound TCP before it leaves
  → Redirects to local Envoy sidecar on port 15000
  → Envoy matches the Host header, routes to predict's task IPs
```

**From outside the mesh** (edge proxy path):
```
Client calls predict.demo.mesh:8080
  → DNS resolves to NLB IP (Amazon Route 53 alias)
  → NLB forwards to edge proxy Envoy on port 15000
  → Envoy matches the Host header, routes to predict's task IPs
```

Both paths use the same Envoy xDS configuration. The only difference is where the caller sits.

### The control plane is four files

There is no xDS server. A Lambda function (`xds-transformer/`) reads which services exist from the registry and where their tasks are from AWS Cloud Map, and writes four files to S3, the same four for every proxy in the mesh:

| File | Holds |
|---|---|
| `cds.yaml` | a cluster per service, and a passthrough for traffic leaving the mesh |
| `eds.yaml` | each service's tasks, grouped by zone |
| `lds.yaml` | the listener on :15000 |
| `rds.yaml` | a route per service, by Host header |

Every proxy polls them every 5 seconds with conditional GETs (`envoy-sidecar/refresh.py`), so an unchanged file costs a 304, and moves a changed one into place, which is what Envoy watches for. Envoy reads a cluster's endpoints from a file of its own, so each proxy splits `eds.yaml` into `eds/<service>.yaml`, rewriting only the services whose tasks changed. A deploy or a scale-out therefore changes only endpoint files: Envoy updates the cluster's hosts in place and keeps its connections, instead of rebuilding the cluster.

Two details make filesystem EDS reliable:

- **Endpoints before clusters.** Envoy rejects a `cds.yaml` that names a cluster whose endpoints file doesn't exist yet, and doesn't look at it again until the next `cds.yaml`. So the transformer writes `eds.yaml` before `cds.yaml`, and each proxy reads them in the opposite order: having seen a cluster, it is sure to see that cluster's endpoints, and it writes them before moving `cds.yaml` into place.
- **inotify instances.** Envoy watches each file with an inotify instance of its own, one per service. Linux allows 128 per user per host, and every sidecar on a host runs as the same user, so the hosts raise `fs.inotify.max_user_instances` at boot (`cdk/lib/mesh/mesh.ts`). Without it, Envoy aborts once a host's sidecars together watch more than 128 files.

### Zone-aware routing

A sidecar keeps each request in its own Availability Zone as far as the upstream's tasks there can take it, and spreads the rest, so a balanced service never pays for a cross-zone hop. Each sidecar learns its zone from the ECS task metadata, and its own service's spread across zones from the `local` cluster in its bootstrap, which reads the same endpoints file as the service's callers.

## Quick Start

```bash
cd cdk
npm install
npx cdk deploy --all --require-approval never
```

## Validating the Mesh

### Option 1: From inside a service container (sidecar path)

Exec into a service's app container and call another service by its mesh hostname.
The request is transparently intercepted by iptables and routed through the local Envoy sidecar.

```bash
CLUSTER="demo-envoy-mesh"

# Get a task from the predict service
TASK=$(aws ecs list-tasks --cluster $CLUSTER \
  --service-name service-predict --region us-west-2 \
  --query 'taskArns[0]' --output text)

# Call features through the mesh — the app has no idea Envoy is involved
aws ecs execute-command --cluster $CLUSTER --task $TASK \
  --container app --interactive --region us-west-2 \
  --command "curl -s http://features.demo.mesh:8080/health"
# → {"service":"features","status":"healthy"}

# Full round-trip: predict → sidecar → features → sidecar → predict
aws ecs execute-command --cluster $CLUSTER --task $TASK \
  --container app --interactive --region us-west-2 \
  --command "curl -s http://features.demo.mesh:8080/call/predict"
# → {"service":"features","called":"predict","response":{"service":"predict",...}}
```

### Option 2: From outside the mesh (edge proxy path)

The stack deploys a bastion EC2 instance in the VPC. It can resolve mesh DNS
names via the Amazon Route 53 private hosted zone, but it is **not** part of the mesh —
it has no sidecar and no iptables. Its traffic goes through the NLB to the
edge proxy, exactly like any external client would.

```bash
# Get the bastion instance ID from stack outputs
BASTION=$(aws cloudformation describe-stacks --stack-name DemoEnvoyServiceMesh \
  --region us-west-2 --query 'Stacks[0].Outputs[?OutputKey==`BastionInstanceId`].OutputValue' \
  --output text)

# Open a shell on the bastion
aws ssm start-session --target $BASTION --region us-west-2

# Same DNS name, same port — traffic flows through the edge proxy instead of a sidecar:
curl http://predict.demo.mesh:8080/health
curl http://features.demo.mesh:8080/call/predict
```

## Creating Services from the Command Line

`scripts/mesh.sh` wraps the API, so no hand-written `awscurl` is needed. It works in bash and zsh, and needs `awscurl` plus credentials for the mesh account.

```bash
source scripts/mesh.sh

mesh create checkout               # the sample app; returns once it is routable
mesh exec checkout curl -s http://predict.demo.mesh:8080/call/features
mesh scale checkout 20             # returns once all 20 tasks are running
mesh list
mesh delete checkout
```

`mesh create <name> <image-uri>` runs your own image instead of the sample app. Run `mesh help` for the full list.

`mesh create <name> --nlb` builds the comparison case instead: the app alone, with no Envoy sidecar, behind an internal NLB of its own, and `<name>.demo.mesh` a CNAME to that NLB. Its own calls go out uninterrupted and through the next service's NLB, as they would without a mesh. Mesh callers, load generators included, still reach it by name: the control plane gives it an Envoy cluster that points at the NLB.

A service can run up to 200 tasks (`mesh create --tasks N`, or `mesh scale` later). Every task is placed through the cluster's capacity provider, so when the tasks don't fit on the fleet — a t3.xlarge holds 3 awsvpc tasks, limited by its ENIs — ECS managed scaling adds instances, up to 200 of them, and drains them again once they are empty. Scaling one service from 40 to 130 tasks grew the fleet from 50 to 63 instances, and had every task running 3 minutes later.

## Load Testing

A load test is a mesh service, `<target>-load`, made of [Fortio](https://github.com/fortio/fortio) load generators with their own Envoy sidecars, so their requests take the same path real traffic does. It holds the requested TPS until it is deleted, and reports achieved TPS, latency percentiles and errors every 30 seconds.

A test runs on as many generator tasks as its TPS needs, up to 1,000,000 TPS on 200 tasks, and the API works out how many. A generator's own Envoy sidecar is what runs out first, so each task is given at most 4,000 TPS, less for large payloads (16 KB costs ~20%, 64 KB ~40%) and for slow targets (each task stays under 1,000 connections). Every task ends its windows on the same :00 and :30, and the API sums their histograms, so the percentiles reported are of every request in the test, not an average of each task's.

```bash
mesh create a && mesh create b && mesh create c
mesh load create a 1000 --path /call/b/c --delay 50    # load -> a -> b -> c, 50 ms at c
mesh load watch a
mesh load delete a
```

The sample app forwards along any `/call/...` path: `a` receives `/call/b/c`, asks `b` for `/call/c`, and `b` asks `c` for `/`. `--delay` and `--resp` set the latency and response size of whichever service ends the path, so every hop before it adds only what forwarding costs. `--req` sends a request body of that size.

Measured through the mesh on t3.xlarge, 2 tasks per service, with every hop going through its caller's Envoy sidecar (median of the 30-second windows):

| Path | TPS held | p50 | p99 | Errors |
|---|---|---|---|---|
| One service | 6,000 | 1.3 ms | 5.4 ms | 0 |
| Three hops | 3,000 | 5.3 ms | 29.7 ms | 0 |
| Three hops | 6,000 | 4.2 ms | 19.5 ms | 0 |

The sample app is one Go file using only the standard library. On a single core it answers about 33,000 requests a second, or forwards about 8,000. A forwarding hop's limit is usually its Envoy sidecar instead, at around 4,000 TPS per task, so size each service in a chain at one task per few thousand TPS.

At scale, against one 40-task service:

| Test | Load tasks | Achieved | p50 | p99 | Errors |
|---|---|---|---|---|---|
| 100,000 TPS | 25 | 99,850 | 1.4 ms | 22 ms | 0 |
| 100,000 TPS, split finer | 40 | 99,850 | 1.4 ms | 21 ms | 0 |

Splitting the same load across more generators doesn't change the tail, so the generators aren't what sets it. The busy fleet does: during these tests the median t3 instance peaked at 57% CPU, with up to 26% lost to hypervisor steal. Compute-optimized instances are the lever for a lower p99 at this scale.

## Live Dashboard

`dashboard/` draws the mesh as a live graph: one node per service, load generators and the edge proxy included, and an edge for every pair of services exchanging traffic. Particles flow along each edge at a rate that follows its TPS, and edges turn red when more than 1% of requests fail.

Hovering an edge splits its latency into the part the hop itself added and the part the service it called spent answering: its own outbound call, or the delay a load test asked it for. The hop's share is the network plus the proxy in between, Envoy or an NLB. A load generator shows what it was asked to send, and hovering it lists every hop of its path that way.

```bash
python3 dashboard/serve.py      # then open http://127.0.0.1:8000
```

It needs only `python3` and `botocore` (installed with `awscurl`). The page polls `GET /graph` every 3 seconds through `serve.py`, which signs each request with your AWS credentials and listens on loopback only.

`GET /graph` reads each task's Envoy stats, from the read-only view of its admin interface on port 9901 (the admin interface itself listens on loopback only), where every sidecar keeps a running count of the requests it has sent to each upstream, and returns those counts per task. The page turns two successive polls into rates. Counts are diffed per task rather than per service, since a counter restarts from zero when its task is replaced. A service behind an NLB has no Envoy to read, so its app keeps the same counts itself and serves them at `/stats`: the instrumentation every service would need if the mesh weren't counting for it.

## Architecture

```
                         ┌──────────────┐
                         │ AWS Lambda + │
                         │  EventBridge │  reads AWS Cloud Map IPs,
                         │  (xDS ctrl   │  writes xDS configs to Amazon S3
                         │   plane)     │
                         └──────┬───────┘
                                │
                                ▼
                         ┌──────────────┐
                         │ Amazon S3    │  cds.yaml, eds.yaml, lds.yaml, rds.yaml
                         │  (xDS YAML)  │  one set for the whole mesh
                         └──────┬───────┘
                                │ Envoy polls Amazon S3 every 5s
               ┌────────────────┼────────────────┐
               ▼                ▼                 ▼
        ┌────────────┐  ┌────────────┐    ┌────────────┐
        │  predict   │  │  features  │    │   Edge     │
        │ ┌────────┐ │  │ ┌────────┐ │    │   Proxy   │
        │ │  App   │ │  │ │  App   │ │    │  (Envoy)  │
        │ ├────────┤ │  │ ├────────┤ │    │           │
        │ │ Envoy  │ │  │ │ Envoy  │ │    │  port     │
        │ │sidecar │ │  │ │sidecar │ │    │  15000    │
        │ ├────────┤ │  │ ├────────┤ │    └─────┬─────┘
        │ │iptables│ │  │ │iptables│ │          │
        │ └────────┘ │  │ └────────┘ │     NLB :8080
        └────────────┘  └────────────┘          │
                                           Amazon Route 53
                                        predict.demo.mesh
                                        features.demo.mesh
```

## Project Structure

```
├── cdk/                              CDK infrastructure (TypeScript)
│   ├── bin/app.ts                    the demo app
│   ├── bin/templates.ts              synthesizes the templates behind the service API
│   └── lib/
│       ├── mesh-stack.ts             demo stack: VPC, mesh, two services, the API, a bastion
│       ├── service-stack.ts          per-service template (POST /services)
│       ├── load-stack.ts             per-load-test template (POST /load)
│       ├── service-api/api.ts        API Gateway + the service API's Lambda functions
│       └── mesh/
│           ├── mesh.ts               the mesh: ECS cluster and hosts, control plane, edge proxy
│           ├── service.ts            MeshService: a service's app, sidecar, and registry row
│           ├── control-plane.ts      Cloud Map, Route 53, the xDS bucket, the registry, the transformer
│           ├── edge-proxy.ts         the edge NLB and its standalone Envoy
│           ├── registry-entry.ts     a registry row as a CloudFormation resource
│           └── ref.ts                what a service needs from the mesh, shared through SSM
├── xds-transformer/                  the control plane (Python Lambda)
│   ├── transformer.py                reads the registry and Cloud Map, writes the four files to S3
│   └── envoy_config.py               the files' content, as Envoy v3 API dicts
├── envoy-sidecar/                    one image for the sidecar and the edge proxy
│   ├── entrypoint.sh                 iptables, first fetch, bootstrap, Envoy
│   ├── refresh.py                    keeps the files in step with S3
│   └── Dockerfile
├── service-api/                      REST entrypoint (Python Lambda)
│   ├── handler.py                    services and load tests, a CloudFormation stack each
│   ├── graph.py                      GET /graph: per-task request counters
│   └── *-template.json               templates synthesized by bin/templates.ts
├── dashboard/                        live mesh graph: index.html and a loopback signing proxy
├── scripts/mesh.sh                   the `mesh` command
└── sample-services/
    ├── demo/                         Go sample app
    └── load/                         Fortio load generator
```

## Cleanup

```bash
cd cdk
npx cdk destroy --all
```

## License

MIT
