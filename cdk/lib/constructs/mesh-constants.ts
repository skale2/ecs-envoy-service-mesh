/** Shared port constants for the mesh infrastructure. */

/** Envoy's listener port — receives intercepted (sidecar) or NLB-forwarded (edge) traffic. */
export const ENVOY_LISTENER_PORT = 15000;

/** Envoy's admin interface port — exposes /ready health check and operational endpoints. */
export const ENVOY_ADMIN_PORT = 9901;

/** Default application container port when not explicitly configured. */
export const DEFAULT_APP_PORT = 8080;

/** CloudWatch agent StatsD port — receives DogStatsD metrics from Envoy over UDP. */
export const CLOUDWATCH_STATSD_PORT = 8126;

/** Envoy runs as this UID. iptables rules use --uid-owner to skip Envoy's own traffic. */
export const ENVOY_UID = 101;
