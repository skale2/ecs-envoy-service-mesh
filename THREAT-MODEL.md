# Threat Model

This document identifies trust boundaries, attack surfaces, threat scenarios, and mitigations for the Envoy Service Mesh on ECS/EC2.

## Trust Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│                        Internet                              │
└────────────────────────────┬────────────────────────────────┘
                             │
                    ─────────┼───────── Boundary 1: External → NLB
                             │
┌────────────────────────────┼────────────────────────────────┐
│                        VPC │                                 │
│                            ▼                                 │
│  ┌──────────────────────────────────────────┐               │
│  │         Edge Proxy (Envoy)                │               │
│  └──────────────────────┬───────────────────┘               │
│                         │                                    │
│            ─────────────┼──────────── Boundary 2: Edge → Mesh│
│                         │                                    │
│  ┌──────────────────────┼───────────────────┐               │
│  │              Mesh Services                │               │
│  │  ┌─────────┐    ┌─────────┐              │               │
│  │  │App + Sidecar│ │App + Sidecar│          │               │
│  │  └─────────┘    └─────────┘              │               │
│  └──────────────────────────────────────────┘               │
│                                                              │
│            ─────────────────────────── Boundary 3: Data → Control
│                                                              │
│  ┌──────────────────────────────────────────┐               │
│  │         Control Plane                     │               │
│  │  AWS Lambda + S3 + AWS Cloud Map          │               │
│  └──────────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────┘
```

### Boundary 1: External clients → NLB
- Untrusted traffic from the internet enters via the NLB
- The NLB forwards to the edge proxy Envoy on port 15000

### Boundary 2: Edge proxy → Mesh services
- The edge proxy routes by Host header to backend task IPs
- Backend services trust traffic from the edge proxy (no mutual authentication in demo)

### Boundary 3: Data plane → Control plane
- The control plane (Lambda) writes xDS configs to S3
- Envoy sidecars read configs from S3
- Compromise of the control plane means control over all mesh routing

## Attack Surface

| Component | Exposure | Ports |
|-----------|----------|-------|
| NLB | Internet-facing | Per-service ports (e.g., 8080) |
| Edge proxy Envoy | Via NLB only | 15000 (listener), 9901 (admin) |
| Mesh service Envoy sidecars | VPC-internal | 15000, 9901 |
| App containers | VPC-internal | App port (e.g., 8080) |
| Envoy admin interface | VPC-internal | 9901 |
| S3 xDS bucket | AWS API (IAM-gated) | HTTPS |
| Lambda function | EventBridge-triggered | N/A |
| AWS Cloud Map | AWS API (IAM-gated) | HTTPS |

## Threat Scenarios

### T1: Unauthorized service access via NLB

**Threat:** An external attacker sends requests to the NLB with crafted Host headers to reach internal services.

**Likelihood:** Medium — the NLB is internet-facing.

**Impact:** Access to any service registered in the mesh.

**Mitigations:**
- Envoy only routes to services with matching Host header entries in its xDS config
- Unknown Host headers are rejected (no default route)
- Production: Add authentication at the edge proxy (JWT validation, OAuth2 filter)

### T2: Container escape via NET_ADMIN capability

**Threat:** An attacker exploits a vulnerability in Envoy to leverage NET_ADMIN for container escape or network manipulation.

**Likelihood:** Low — requires an Envoy RCE vulnerability.

**Impact:** High — could manipulate iptables to intercept or redirect traffic.

**Mitigations:**
- Envoy runs as non-root UID 101 after iptables setup
- NET_ADMIN is on the sidecar only, not the app container
- VPC security groups provide network-level isolation
- Production: AppArmor/SELinux profiles to constrain capabilities

### T3: Traffic interception bypass

**Threat:** A compromised app container bypasses iptables interception to communicate directly with other services, circumventing mesh policies.

**Likelihood:** Low — requires modifying iptables (which requires NET_ADMIN, only on the sidecar).

**Impact:** Medium — bypasses any mesh-level access control or observability.

**Mitigations:**
- App containers do not have NET_ADMIN capability
- iptables rules are set by the sidecar's entrypoint at container start (sidecar uses `dependsOn` with a health check, so the app container waits until iptables is configured)
- Production: Implement NetworkPolicy or service-level mTLS for authentication

### T4: Control plane compromise (Lambda or S3)

**Threat:** Attacker gains write access to the S3 xDS bucket or compromises the Lambda function, injecting malicious routing configs.

**Likelihood:** Low — requires IAM credential compromise.

**Impact:** Critical — full control over mesh routing (redirect traffic, add malicious clusters, exfiltrate data).

**Mitigations:**
- S3 bucket has Block Public Access, enforceSSL, and encryption at rest
- Lambda IAM role is scoped to specific resources
- S3 versioning enables audit trail and rollback
- S3 access logging tracks all read/write operations
- Production: S3 Object Lock for immutability, CloudTrail alerts on unauthorized access

### T5: Envoy admin interface exploitation

**Threat:** Attacker with VPC access hits Envoy admin on port 9901 to dump configs, modify log levels, or trigger config drain.

**Likelihood:** Low — requires VPC network access.

**Impact:** Medium — information disclosure (service topology, endpoints), potential traffic disruption.

**Mitigations:**
- Admin port only accessible within VPC (security group restricted)
- No internet-facing path to port 9901
- Production: Disable admin interface or bind to localhost, use Envoy's admin access log filter

### T6: SSRF against instance metadata

**Threat:** Attacker exploits an application vulnerability to query EC2 instance metadata and steal IAM credentials.

**Likelihood:** Low — IMDSv2 is enforced.

**Impact:** High — could escalate to other AWS API access.

**Mitigations:**
- IMDSv2 enforced (`requireImdsv2: true`) — requires a PUT-based token exchange, preventing simple GET-based SSRF from extracting credentials
- Task roles use least-privilege permissions, limiting blast radius of stolen credentials
- ECS agent injects task-specific credentials via the task credential endpoint (169.254.170.2), so tasks don't need to query instance IMDS for their own role

## Residual Risks

| Risk | Status | Recommendation |
|------|--------|----------------|
| No mTLS between services | Accepted (demo) | Implement Envoy SDS with SPIFFE certificates |
| No authentication at edge proxy | Accepted (demo) | Add JWT/OAuth2 filter in Envoy |
| Plaintext traffic within VPC | Accepted (demo) | Enable TLS on NLB listener + mTLS in mesh |
| Allow-all intra-VPC security groups | Accepted (demo) | Restrict to specific ports per service |
| No rate limiting at NLB | Accepted (demo) | Add connection/request rate limits in Envoy config |
