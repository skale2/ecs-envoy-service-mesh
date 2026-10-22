# Security

This document describes the security architecture, controls, and responsibilities for the Envoy Service Mesh demo.

## Shared Responsibility Model

| Responsibility | AWS | Customer |
|----------------|-----|----------|
| Underlying ECS/EC2 infrastructure, hypervisor, hardware | Manages | — |
| VPC networking infrastructure, NLB service | Manages | — |
| IAM service availability and enforcement | Manages | — |
| IAM roles and policies (least privilege) | — | Configures |
| Security group rules | — | Configures |
| Container capabilities (NET_ADMIN, NET_RAW) | — | Configures |
| S3 bucket access policies and encryption | — | Configures |
| Network segmentation within VPC | — | Configures |
| iptables rules and traffic interception | — | Configures |
| Application-level authentication/authorization | — | Implements |
| TLS certificates and encryption in transit | — | Implements |

Reference: [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/)

## Security Design

### Network Security Model

Traffic interception uses iptables NAT rules in each task's network namespace:

- The Envoy sidecar container sets up iptables REDIRECT rules at startup
- All egress TCP traffic (except from Envoy itself, UID 101) is redirected to Envoy on port 15000
- Envoy inspects the Host header and routes to the correct backend service
- This creates a security boundary where all service-to-service traffic passes through Envoy

The edge proxy receives external traffic via the NLB without iptables interception.

### IAM and Access Control

Principle of least privilege is applied to:

- **Envoy task role**: S3 read-only access (xDS configs), SSM for ECS Exec debugging, CloudWatch for metrics
- **Transformer Lambda role**: `ListServices` scoped to the mesh namespace ARN, `ListInstances` scoped to account/region, S3 read/write to the xDS bucket, and read-only on the service registry table. The transformer never writes the registry; it only renders it.
- **Service API Lambda role**: read/write on the service registry table, read-only on the xDS bucket (it only needs the per-service CloudFormation template), and CloudFormation create/delete scoped to `mesh-svc-*` stacks. The split matters: the API owns the registry and the transformer owns the generated config, so neither can corrupt the other's state.
- **ECS execution role**: Standard `AmazonECSTaskExecutionRolePolicy` for image pull and log creation

### Container Security

- **NET_ADMIN / NET_RAW capabilities**: Granted only to the Envoy sidecar container (not app containers). Required for iptables rule creation. After setup, Envoy runs as non-root UID 101.
- **Edge proxy**: Runs entirely as UID 101 (non-root) since it does not use iptables.
- **IMDSv2**: Enforced on all EC2 instances (`requireImdsv2: true`) to prevent SSRF attacks against instance metadata.

### Encryption

**At rest:**
- S3 xDS configuration bucket: Encrypted with SSE-S3 (AES-256)
- Block Public Access enabled on all S3 buckets
- S3 access logging enabled to a dedicated log bucket
- Service registry table: DynamoDB encryption at rest (always on), point-in-time recovery enabled, no resource policy — reachable only through IAM by the two Lambda roles above

**In transit:**
- NLB to edge proxy: Plaintext within VPC (demo only; see below)
- Service-to-service within mesh: Plaintext within VPC (demo only)
- AWS API calls: HTTPS only (SDK default). S3 bucket policy additionally rejects any non-TLS requests (enforceSSL).

**Production recommendation:** Add TLS termination at the NLB with ACM certificates, and implement mTLS between Envoy proxies using SDS (Secret Discovery Service).

## Security Guidelines by AWS Service

### Amazon ECS
- Tasks use `awsvpc` network mode for per-task security group enforcement
- ECS Exec enabled for debugging (requires SSM permissions)
- Task definitions specify minimum required CPU/memory

### Amazon S3
- Server-side encryption enabled (SSE-S3)
- Block Public Access: BLOCK_ALL
- enforceSSL: All requests must use HTTPS
- Versioning enabled for config audit trail
- Access logging to dedicated bucket

### Network Load Balancer
- Internal: reachable from inside the VPC only, which is all the mesh ingress needs. Nothing in the mesh is reachable from the internet.
- Health checks use Envoy admin `/ready` endpoint
- Production recommendation: If the mesh ever needs a public entry point, put it behind a separate internet-facing load balancer with TLS termination, AWS WAF and Shield Advanced, rather than making this one public.

### IAM
- Task roles follow least-privilege (read-only S3 access, scoped managed policies)
- Service Discovery: `ListServices` and `ListInstances` require `resources: ["*"]` (AWS IAM rejects any resource-level scoping for these actions — confirmed by deployment failure). Scoping is enforced at the application layer via the `CLOUDMAP_NAMESPACE_ID` filter. Only 2 actions are granted (unused `DiscoverInstances` and `ListNamespaces` were removed).
- Managed policies used only where appropriate (SSM, CloudWatch, ECS execution)

### AWS Lambda
- Execution role scoped to specific S3 bucket and AWS Cloud Map namespace
- Runs without VPC attachment (accesses Amazon S3 and AWS Cloud Map via public endpoints)
- Timeout configured to prevent runaway invocations

### Security Groups
- One group for all awsvpc tasks, allowing intra-VPC traffic only (demo debuggability). No rule in the mesh admits traffic from outside the VPC.
- The edge proxy needs no rule of its own. Its NLB is internal, so every client — and every health check — reaches it from a VPC-local address that the intra-VPC rule already covers.
- Nothing opens the Envoy admin port (9901) beyond the VPC. It serves `/config_dump`, which lists every endpoint IP in the mesh, and accepts `POST /quitquitquit`, and it has no authentication of its own.
- Production recommendation: Restrict the intra-VPC rule to specific ports — 8080 (app), 15000 (Envoy), 9901 (admin), 8126/UDP (StatsD)

## Risk Assessment

### Deployment Risks
- The Quick Start uses `--require-approval never` for simplicity. In production, always review CloudFormation changesets before deployment (`--require-approval broadening` at minimum).

### Operational Risks
- **No mTLS**: Services within the mesh communicate in plaintext. A compromised task could sniff traffic. Mitigate by enabling Envoy mTLS.
- **Envoy admin interface (port 9901)**: Exposes operational endpoints. Accessible only within VPC via security groups.
- **Control plane latency**: Endpoint updates propagate in a few seconds — an ECS task state change invokes the transformer, and sidecars pick up the new config on their next 5-second poll. Traffic may route to a terminating task during that window.

### Container Capability Risks
- NET_ADMIN allows iptables manipulation. A compromised Envoy container could alter routing rules. Mitigated by running as non-root after setup.
- NET_RAW allows raw socket creation. Mitigated by container isolation and VPC security groups.

## Compliance Considerations

- **Data residency**: All resources deploy within a single AWS region
- **Audit trail**: S3 access logs, CloudTrail (for API calls), CloudWatch Logs (for application and Envoy logs)
- **Monitoring**: CloudWatch metrics via StatsD from Envoy, ECS service metrics
