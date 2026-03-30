# Envoy Service Mesh on ECS/EC2

A working demo of an Envoy-based service mesh on Amazon ECS (EC2 launch type). Deploy one CDK stack to get:

- **Envoy sidecar proxies** on each service with transparent iptables egress interception
- **Edge proxy** (standalone Envoy behind an NLB) for external traffic into the mesh
- **xDS control plane** (Lambda + EventBridge) generating Envoy configs from Cloud Map
- **Uniform DNS addressing** — callers use `{service}.{prefix}.mesh` whether inside or outside the mesh

## How It Works

Every service in the mesh gets a DNS name like `predict.demo.mesh`. The same address works from two places:

**From inside the mesh** (sidecar path):
```
App calls predict.demo.mesh:8080
  → DNS resolves to NLB IP (Route 53 alias)
  → iptables intercepts the outbound TCP before it leaves
  → Redirects to local Envoy sidecar on port 15000
  → Envoy matches the Host header, routes to predict's task IPs
```

**From outside the mesh** (edge proxy path):
```
Client calls predict.demo.mesh:8080
  → DNS resolves to NLB IP (Route 53 alias)
  → NLB forwards to edge proxy Envoy on port 15000
  → Envoy matches the Host header, routes to predict's task IPs
```

Both paths use the same Envoy xDS configuration. The only difference is where the caller sits.

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
# → {"service": "features", "status": "healthy"}

# Full round-trip: predict → sidecar → features → sidecar → predict
aws ecs execute-command --cluster $CLUSTER --task $TASK \
  --container app --interactive --region us-west-2 \
  --command "curl -s http://features.demo.mesh:8080/call/predict"
# → {"service": "features", "downstream_call": {"target": "predict", ...}}
```

### Option 2: From outside the mesh (edge proxy path)

The stack deploys a bastion EC2 instance in the VPC. It can resolve mesh DNS
names via the Route 53 private hosted zone, but it is **not** part of the mesh —
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

## Architecture

```
                         ┌──────────────┐
                         │  Lambda +    │
                         │  EventBridge │  reads Cloud Map IPs,
                         │  (xDS ctrl   │  writes xDS configs to S3
                         │   plane)     │
                         └──────┬───────┘
                                │
                                ▼
                         ┌──────────────┐
                         │   S3 Bucket  │  CDS, EDS, LDS, RDS
                         │  (xDS YAML)  │  per service + edge proxy
                         └──────┬───────┘
                                │ Envoy polls S3 every 5s
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
                                           Route 53
                                        predict.demo.mesh
                                        features.demo.mesh
```

## Project Structure

```
├── cdk/                          CDK infrastructure (TypeScript)
│   ├── bin/app.ts               Stack entry point
│   └── lib/
│       ├── mesh-stack.ts        Demo stack: VPC + Mesh + services
│       └── constructs/
│           ├── mesh.ts          Mesh construct (cluster, control plane, edge proxy)
│           ├── mesh-service.ts  Per-service construct (app + sidecar + DNS)
│           ├── mesh-config.ts   Shared config interface
│           ├── mesh-control-plane.ts   Cloud Map, Route 53, S3, Lambda
│           └── mesh-edge-proxy.ts      NLB + standalone Envoy
├── xds-transformer/             xDS config generator (Python Lambda)
│   ├── transformer.py           Reads Cloud Map, writes CDS/EDS/LDS/RDS to S3
│   └── envoy_config.py          Envoy v3 API config builders
├── envoy-sidecar/               Single Docker image for sidecar + edge proxy
│   ├── entrypoint.sh            iptables setup, S3 fetch, bootstrap, Envoy launch
│   └── Dockerfile
└── sample-services/service/     Generic demo HTTP service (identity via env vars)
```

## Cleanup

```bash
cd cdk
npx cdk destroy --all
```

## License

MIT
