"""The mesh's Envoy config, as plain dicts in Envoy's v3 API.

The transformer serializes these to YAML and uploads them to S3, and every
proxy in the mesh, sidecars and the edge proxy alike, reads the same four
files:

    cds.yaml   clusters: one per service, and a passthrough for everything else
    eds.yaml   endpoints: each service's tasks, grouped by zone
    lds.yaml   the listener on :15000 that intercepted traffic arrives at
    rds.yaml   routes: Host header -> cluster

The mesh is fully connected, so every proxy wants a cluster for every
service, and nothing in these files depends on which proxy reads them. A
proxy's own identity arrives through its bootstrap instead (see
envoy-sidecar/entrypoint.sh).

https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol
"""

ENVOY_PORT = 15000
# Where each proxy keeps these files. The sidecar writes one endpoints file per
# service under eds/, from eds.yaml; see envoy-sidecar/refresh.py.
CONFIG_DIR = "/etc/envoy"

# Envoy's defaults allow 1,024 connections and 1,024 requests in flight per
# upstream, per proxy, and answer the rest with 503s. A sidecar holding 4,000
# TPS against a 500 ms service needs 2,000, so the limits are raised well past
# anything one task can generate.
CIRCUIT_BREAKERS = {"thresholds": [{
    "max_connections": 100000,
    "max_pending_requests": 100000,
    "max_requests": 100000,
}]}


# ---------------------------------------------------------------------------
# CDS: clusters
# ---------------------------------------------------------------------------

def build_cluster(name):
    """A mesh service, whose endpoints Envoy reads from a file of their own.

    Keeping them out of the cluster is what makes a deploy cheap: a task
    starting or stopping changes only that file, and Envoy updates the
    cluster's hosts in place instead of rebuilding the cluster and draining
    its connections.
    """
    return {
        "@type": "type.googleapis.com/envoy.config.cluster.v3.Cluster",
        "name": name,
        "type": "EDS",
        "eds_cluster_config": {
            "eds_config": {"path_config_source": {"path": f"{CONFIG_DIR}/eds/{name}.yaml"}},
        },
        "connect_timeout": "0.25s",
        "lb_policy": "ROUND_ROBIN",
        "circuit_breakers": CIRCUIT_BREAKERS,
        # Zone-aware routing is on by default, but only for upstreams of 6
        # hosts or more. A service here often has 2.
        "common_lb_config": {"zone_aware_lb_config": {"min_cluster_size": 1}},
    }


def build_nlb_cluster(name, address, port):
    """A service fronted by its own NLB instead of sidecars.

    One endpoint, the NLB's DNS name, which Envoy keeps re-resolving
    (STRICT_DNS) and balances over the addresses it gets back, one per zone.
    The NLB picks the task. Any Envoy in the mesh can call such a service by
    name like any other.
    """
    return {
        "@type": "type.googleapis.com/envoy.config.cluster.v3.Cluster",
        "name": name,
        "type": "STRICT_DNS",
        "dns_lookup_family": "V4_ONLY",
        "connect_timeout": "0.25s",
        "lb_policy": "ROUND_ROBIN",
        "circuit_breakers": CIRCUIT_BREAKERS,
        "load_assignment": {
            "cluster_name": name,
            "endpoints": [{"lb_endpoints": [_endpoint(address, port)]}],
        },
    }


def build_passthrough_cluster():
    """Where a request for anything outside the mesh goes: to the address the
    app dialed, which iptables recorded before redirecting it (ORIGINAL_DST)."""
    return {
        "@type": "type.googleapis.com/envoy.config.cluster.v3.Cluster",
        "name": "passthrough",
        "type": "ORIGINAL_DST",
        "connect_timeout": "5s",
        "lb_policy": "CLUSTER_PROVIDED",
    }


def build_clusters_config(services, nlbs):
    """cds.yaml. A service in `nlbs`, {name: (NLB DNS name, port)}, is
    reached through its NLB; every other one through its tasks."""
    clusters = [build_nlb_cluster(name, *nlbs[name]) if name in nlbs else build_cluster(name)
                for name in services]
    return {"resources": clusters + [build_passthrough_cluster()]}


# ---------------------------------------------------------------------------
# EDS: endpoints
# ---------------------------------------------------------------------------

def _endpoint(address, port):
    return {"endpoint": {"address": {"socket_address": {"address": address, "port_value": port}}}}


def build_load_assignment(name, endpoints, region):
    """One service's tasks, grouped by zone.

    The zones are what zone-aware routing works from: each proxy compares how
    the upstream is spread across zones with how its own service is, keeps as
    much traffic in its zone as the upstream's share there can take, and
    spreads the rest. The localities have to match the proxies' own exactly,
    region included, which is why the region is passed in rather than guessed.
    """
    by_zone = {}
    for ep in endpoints:
        by_zone.setdefault(ep["az"], []).append(_endpoint(ep["ip"], ep["port"]))
    return {
        "@type": "type.googleapis.com/envoy.config.endpoint.v3.ClusterLoadAssignment",
        "cluster_name": name,
        "endpoints": [{"locality": {"region": region, "zone": zone}, "lb_endpoints": hosts}
                      for zone, hosts in sorted(by_zone.items())],
    }


def build_endpoints_config(endpoints, region):
    """eds.yaml, from {service: [{ip, port, az}, ...]}.

    Envoy reads one service's endpoints per file, so each sidecar splits this
    into eds/<service>.yaml. A service with no tasks still gets an entry,
    with no endpoints, so that callers get a clean 503.
    """
    return {"resources": [build_load_assignment(name, eps, region)
                          for name, eps in sorted(endpoints.items())]}


# ---------------------------------------------------------------------------
# LDS: the listener
# ---------------------------------------------------------------------------

def build_listener():
    """0.0.0.0:15000, where iptables sends a sidecar's outbound traffic and
    the edge NLB sends traffic from outside the mesh."""
    return {
        "@type": "type.googleapis.com/envoy.config.listener.v3.Listener",
        "name": "mesh_listener",
        # nosec B104 - Envoy must bind all interfaces to receive intercepted traffic.
        "address": {"socket_address": {"address": "0.0.0.0", "port_value": ENVOY_PORT}},
        # Recovers the address the app dialed, which the passthrough cluster
        # connects to. A no-op for traffic that wasn't redirected.
        "use_original_dst": True,
        "filter_chains": [{"filters": [{
            "name": "envoy.filters.network.http_connection_manager",
            "typed_config": {
                "@type": "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager",
                "stat_prefix": "mesh_http",
                "rds": {
                    "config_source": {"path_config_source": {"path": f"{CONFIG_DIR}/rds.yaml"}},
                    "route_config_name": "egress_route",
                },
                "http_filters": [{
                    "name": "envoy.filters.http.router",
                    "typed_config": {"@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router"},
                }],
            },
        }]}],
    }


def build_listeners_config():
    """lds.yaml."""
    return {"resources": [build_listener()]}


# ---------------------------------------------------------------------------
# RDS: routes
# ---------------------------------------------------------------------------

def build_routes_config(services, mesh_domain):
    """rds.yaml: a virtual host per service, matched by Host header.

    Each matches both `predict.demo.mesh` and `predict.demo.mesh:<port>`,
    because clients include a non-standard port in the Host header and Envoy
    treats the two as different domains. Any other host goes to the
    passthrough cluster, so a sidecar never blocks traffic leaving the mesh.
    """
    def virtual_host(name, domains, cluster):
        return {"name": name, "domains": domains,
                "routes": [{"match": {"prefix": "/"}, "route": {"cluster": cluster}}]}

    hosts = [virtual_host(name, [f"{name}.{mesh_domain}", f"{name}.{mesh_domain}:*"], name)
             for name in services]
    return {"resources": [{
        "@type": "type.googleapis.com/envoy.config.route.v3.RouteConfiguration",
        "name": "egress_route",
        "virtual_hosts": hosts + [virtual_host("passthrough", ["*"], "passthrough")],
    }]}
