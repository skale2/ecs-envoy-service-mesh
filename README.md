# Envoy Service Mesh on ECS/EC2

A working demo of an Envoy-based service mesh on Amazon ECS (EC2 launch type). Deploy one CDK stack to get:

- **Envoy sidecar proxies** on each service with transparent iptables egress interception
- **Edge proxy** (standalone Envoy behind an NLB) for external traffic into the mesh
- **xDS control plane** (AWS Lambda + EventBridge) generating Envoy configs from AWS Cloud Map
- **Uniform DNS addressing** — callers use `{service}.{prefix}.mesh` whether inside or outside the mesh
- **Service API** — a REST endpoint (`POST /services/{name}`) that onboards new mesh services at runtime, no CDK required
- **Load testing** — `POST /load/{target}` holds a fixed TPS against any service, using [Fortio](https://github.com/fortio/fortio)
- **DynamoDB service registry** — one table both entrypoints write to and the control plane reads
- **Three config files for the whole mesh** — the mesh is fully connected, so every proxy reads the same CDS/LDS/RDS

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

mesh create checkout               # the Python sample app; returns once it is routable
mesh exec checkout curl -s http://predict.demo.mesh:8080/call/features
mesh list
mesh delete checkout
```

`mesh create <name> perf` runs a [Fortio](https://github.com/fortio/fortio) echo server instead, and `mesh create <name> <image-uri>` runs your own image. Run `mesh help` for the full list.

## Load Testing

A load test is a Fortio load generator running as a mesh service, `<target>-load`, with its own Envoy sidecar, so its requests take the same path real traffic does. It holds the requested TPS until it is deleted, and reports achieved TPS, latency percentiles and errors every 30 seconds.

```bash
mesh create perf1 perf
mesh load create perf1 2000 --delay 50 --resp 1024    # 2000 TPS, 50 ms server time, 1 KB responses
mesh load watch perf1
mesh load delete perf1
```

`--delay` and `--resp` set the server's latency and response size on every request, which only a `perf` target honours. `--req` sends a request body of that size, and `--path` loads a specific route, e.g. `mesh load create features 100 --path /call/predict` for a two-hop chain.

Measured on t3.xlarge with 1 KB responses, one load generator against one Fortio task:

| Target TPS | p50, 0 ms delay | p99, 0 ms delay | p50, 50 ms delay | p99, 50 ms delay | Errors |
|---|---|---|---|---|---|
| 1,000 | 1.4 ms | 4.6 ms | 55.5 ms | 59.9 ms | 0 |
| 2,000 | 1.5 ms | 7.6 ms | 55.6 ms | 68.3 ms | 0 |
| 4,000 | 1.7 ms | 13.7 ms | 56.5 ms | 87.9 ms | 0 |
| 8,000 | 4.6 ms | 71.6 ms | — | — | 0 |

The limit is the load generator's own Envoy sidecar (about 2 cores at 4,000 TPS); the Fortio server uses about half a core at that rate.

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
                         │ Amazon S3    │  CDS, EDS, LDS, RDS
                         │  (xDS YAML)  │  per service + edge proxy
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
├── cdk/                          CDK infrastructure (TypeScript)
│   ├── bin/app.ts               Stack entry point
│   └── lib/
│       ├── mesh-stack.ts        Demo stack: VPC + Mesh + services
│       └── constructs/
│           ├── mesh.ts          Mesh construct (cluster, control plane, edge proxy)
│           ├── mesh-service.ts  Per-service construct (app + sidecar + DNS)
│           ├── mesh-config.ts   Shared config interface
│           ├── mesh-control-plane.ts   AWS Cloud Map, Amazon Route 53, Amazon S3, DynamoDB, AWS Lambda
│           ├── mesh-service-api.ts     API Gateway + AWS Lambda (REST entrypoint)
│           └── mesh-edge-proxy.ts      NLB + standalone Envoy
├── service-api/                 REST entrypoint (Python AWS Lambda)
│   ├── handler.py               Registry writes + CloudFormation CreateStack per service
│   ├── service-template.json    Pre-synthesized template behind POST /services/{name}
│   └── load-template.json       Pre-synthesized template behind POST /load/{target}
├── xds-transformer/             xDS config generator (Python AWS Lambda)
│   ├── transformer.py           Reads the registry + AWS Cloud Map, writes CDS/LDS/RDS to Amazon S3
│   └── envoy_config.py          Envoy v3 API config builders
├── envoy-sidecar/               Single Docker image for sidecar + edge proxy
│   ├── entrypoint.sh            iptables setup, Amazon S3 fetch, bootstrap, Envoy launch
│   └── Dockerfile
└── sample-services/
    ├── demo/                    Python sample app (identity via env vars)
    └── perf/                    Fortio: perf target and load generator
```

## Cleanup

```bash
cd cdk
npx cdk destroy --all
```

## License

MIT
