"""Envoy xDS configuration builders.

Generates CDS, EDS, LDS, and RDS configuration as Python dicts compatible
with Envoy's v3 API.  These dicts are serialized to YAML and uploaded to S3
for consumption by Envoy sidecars and the edge proxy.

Both sidecars and the edge proxy use identical configurations.  The listener
is always on port 15000.  Routing is driven entirely by the Host header via
virtual hosts in the RDS.

xDS overview (see https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol):
  - CDS defines logical clusters (upstream services) and how to discover their endpoints
  - EDS provides the actual IP:port:zone endpoints for each cluster
  - LDS defines listeners (network entry points) and their filter chains
  - RDS defines HTTP routing rules (virtual hosts, routes, path matching)
"""

# ---------------------------------------------------------------------------
# CDS – Cluster Discovery Service
#
# A "cluster" in Envoy is a logical upstream service.  Each dependency in
# the mesh becomes a cluster.  We use EDS (Endpoint Discovery Service) type
# so that endpoints are loaded from a separate file and can be updated
# independently of the cluster definition.
# ---------------------------------------------------------------------------

def _build_locality_endpoints(endpoints):
    """Convert a flat list of endpoints into Envoy locality-grouped format.

    Groups endpoints by AZ for locality-aware load balancing, where Envoy
    prefers sending traffic to backends in the same AZ as the caller.
    """
    by_zone: dict[str, list] = {}
    for ep in endpoints:
        az = ep.get("az", "unknown")
        by_zone.setdefault(az, []).append(ep)

    locality_endpoints = []
    for zone, zone_eps in sorted(by_zone.items()):
        lb_endpoints = [
            {
                "endpoint": {
                    "address": {
                        "socket_address": {
                            "address": ep["ip"],
                            "port_value": ep["port"],
                        }
                    }
                }
            }
            for ep in zone_eps
        ]
        # Derive the AWS region from the AZ name by stripping the trailing
        # letter (e.g. "us-west-2a" -> "us-west-2").
        region = zone.rstrip("abcdefghijklmnopqrstuvwxyz") if zone != "unknown" else "unknown"
        locality_endpoints.append({
            "locality": {"region": region, "zone": zone},
            "lb_endpoints": lb_endpoints,
        })
    return locality_endpoints


def build_cluster(dependency_name, endpoints, connect_timeout="0.25s"):
    """STATIC cluster with endpoints embedded via load_assignment.

    We embed endpoints directly in the CDS rather than using a separate EDS
    file because Envoy's filesystem-based EDS (path_config_source inside
    eds_cluster_config) does not reliably reload on file changes. By using
    STATIC clusters with load_assignment, the endpoints are part of the CDS
    file itself — when the CDS file is atomically replaced (mv), Envoy
    reloads both the cluster definitions and their endpoints in one shot.
    """
    return {
        # Envoy v3 protobuf type URL — tells Envoy how to deserialize this resource
        "@type": "type.googleapis.com/envoy.config.cluster.v3.Cluster",
        "name": dependency_name,
        "connect_timeout": connect_timeout,
        "type": "STATIC",
        "lb_policy": "ROUND_ROBIN",
        "load_assignment": {
            "cluster_name": dependency_name,
            "endpoints": _build_locality_endpoints(endpoints),
        },
    }


def _passthrough_cluster():
    """ORIGINAL_DST cluster for traffic that doesn't match any mesh service.

    When a request's Host header doesn't match any virtual host in the RDS,
    the catch-all route sends it here.  ORIGINAL_DST tells Envoy to connect
    to whatever IP:port the client originally intended (before iptables
    redirected it).  This lets non-mesh traffic (e.g. calls to external
    APIs) pass through transparently.
    """
    return {
        "@type": "type.googleapis.com/envoy.config.cluster.v3.Cluster",
        "name": "passthrough",
        "connect_timeout": "5s",
        "type": "ORIGINAL_DST",
        "lb_policy": "CLUSTER_PROVIDED",
    }


def build_clusters_config(dependencies, endpoints_map):
    """Full CDS response — one STATIC cluster per dependency, plus a passthrough cluster."""
    resources = [
        build_cluster(dep, endpoints_map.get(dep, []))
        for dep in dependencies
    ]
    # The passthrough cluster handles any traffic that doesn't match a
    # mesh service, forwarding it to the original destination.
    resources.append(_passthrough_cluster())
    return {
        "version_info": "1",
        "resources": resources,
    }


# ---------------------------------------------------------------------------
# EDS – Endpoint Discovery Service
#
# Provides the actual IP addresses for each cluster.  Endpoints are grouped
# by availability zone ("locality") so Envoy can prefer same-zone backends,
# reducing cross-AZ data transfer costs and latency.
# ---------------------------------------------------------------------------

def build_eds_config(endpoints_map):
    """Build an EDS response from a map of service -> endpoint list.

    *endpoints_map* has the shape::

        {
            "service-b": [
                {"ip": "10.0.1.5", "port": 8080, "az": "us-west-2a"},
                ...
            ]
        }

    Each entry becomes a ``ClusterLoadAssignment`` — the EDS resource that
    maps a cluster name to its backends.  Endpoints are grouped by AZ so
    Envoy's zone-aware load balancing can prefer same-zone backends.

    Note: This EDS file is written to S3 alongside the CDS, but the CDS
    uses STATIC clusters with embedded load_assignment rather than
    referencing this file.  The EDS file is kept for observability and
    debugging (operators can inspect it to see current endpoint state).
    """
    resources = []
    for service_name, endpoints in endpoints_map.items():
        resources.append({
            "@type": "type.googleapis.com/envoy.config.endpoint.v3.ClusterLoadAssignment",
            "cluster_name": service_name,
            "endpoints": _build_locality_endpoints(endpoints),
        })
    return {
        "version_info": "1",
        "resources": resources,
    }


# ---------------------------------------------------------------------------
# LDS – Listener Discovery Service
#
# A "listener" is a network entry point — it binds to an address:port and
# applies a chain of filters to incoming connections.  We use a single
# listener on port 15000 for both sidecars (receives iptables-redirected
# traffic) and the edge proxy (receives NLB-forwarded traffic).
# ---------------------------------------------------------------------------

def _http_connection_manager(stat_prefix, rds_route_name):
    """Build an HTTP connection manager (HCM) network filter.

    The HCM is the L7 filter that decodes HTTP and applies routing rules.
    It references an RDS route config by name, loaded from a local file.
    Envoy watches the file for atomic moves and reloads automatically.
    """
    return {
        "name": "envoy.filters.network.http_connection_manager",
        "typed_config": {
            "@type": "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager",
            "stat_prefix": stat_prefix,
            "rds": {
                "config_source": {
                    "path_config_source": {"path": "/etc/envoy/rds.yaml"}
                },
                "route_config_name": rds_route_name,
            },
            # The Router filter is required — it actually executes the routing
            # decision made by the HCM based on the route configuration above.
            "http_filters": [{
                "name": "envoy.filters.http.router", 
                "typed_config": {"@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router"}
            }],
        },
    }


def build_listener(service_name):
    """Listener on 0.0.0.0:15000 with HTTP connection manager.

    Port 15000 serves dual purpose:
      - Sidecar: iptables redirects all outbound TCP here
      - Edge proxy: NLB forwards external traffic here
    """
    return {
        "@type": "type.googleapis.com/envoy.config.listener.v3.Listener",
        "name": f"{service_name}_listener",
        "address": {
            "socket_address": {"address": "0.0.0.0", "port_value": 15000}
        },
        # use_original_dst tells Envoy to recover the original destination
        # from SO_ORIGINAL_DST (set by iptables REDIRECT). This metadata is
        # used by the ORIGINAL_DST passthrough cluster. When traffic wasn't
        # redirected (e.g. edge proxy receiving from NLB), this is a no-op.
        "use_original_dst": True,
        "filter_chains": [
            {
                "filters": [
                    _http_connection_manager(f"{service_name}_http", "egress_route")
                ]
            }
        ],
    }


def build_listeners_config(service_name):
    """Full LDS response."""
    return {
        "version_info": "1",
        "resources": [build_listener(service_name)],
    }


# ---------------------------------------------------------------------------
# RDS – Route Discovery Service
#
# Routes match incoming requests by Host header and forward them to the
# appropriate cluster.  Both sidecars and the edge proxy use the same
# routing scheme: one virtual host per dependency matching its mesh hostname.
# ---------------------------------------------------------------------------

def build_egress_route(dependencies, mesh_domain):
    """Route config with one virtual host per dependency service.

    Each virtual host matches the service's mesh hostname (e.g.
    ``predict.demo.mesh``).  We also match with a wildcard port suffix
    because HTTP clients often include the port in the Host header when
    the port is non-standard (e.g. 8080), and Envoy treats ``host`` and
    ``host:port`` as different domains.
    """
    virtual_hosts = []
    for dep in dependencies:
        virtual_hosts.append({
            "name": dep,
            "domains": [f"{dep}.{mesh_domain}", f"{dep}.{mesh_domain}:*"],
            "routes": [
                {
                    "match": {"prefix": "/"},
                    "route": {"cluster": dep},
                }
            ],
        })

    # Catch-all: any Host header that doesn't match a mesh service is
    # forwarded to the passthrough cluster, which connects to the original
    # destination via ORIGINAL_DST.  This ensures non-mesh traffic (e.g.
    # calls to external APIs) isn't blocked by the sidecar.
    virtual_hosts.append({
        "name": "passthrough",
        "domains": ["*"],
        "routes": [
            {
                "match": {"prefix": "/"},
                "route": {"cluster": "passthrough"},
            }
        ],
    })

    return {
        "@type": "type.googleapis.com/envoy.config.route.v3.RouteConfiguration",
        "name": "egress_route",
        "virtual_hosts": virtual_hosts,
    }


def build_routes_config(dependencies, mesh_domain):
    """Full RDS response."""
    return {
        "version_info": "1",
        "resources": [build_egress_route(dependencies, mesh_domain)],
    }
