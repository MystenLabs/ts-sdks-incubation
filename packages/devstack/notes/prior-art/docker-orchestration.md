# Prior art: docker / dev-environment orchestration

Survey of tools adjacent to `@mysten-incubation/devstack`. Devstack's job: emit compose, bring
stacks up/down, allocate ports per app, detect "already healthy" stacks, run per-plugin doctor
probes, watch files, deploy seeded on-chain state. Each tool is rated against six recurring axes —
idempotent bring-up, per-service readiness, watch loop, port forwarding / endpoints, plugin model,
multi-stack isolation — plus the "is the stack already up?" and "long-tail one-shot init"
cross-cuts.

---

## 1. Tilt (tilt.dev)

**Shape.** A `Tiltfile` (Starlark) declares resources; Tilt builds a DAG and reconciles toward it.
Wraps K8s, Docker Compose, and arbitrary local commands.

```starlark
docker_build('myapp', '.', live_update=[sync('./src', '/app/src')])
k8s_resource('myapp', port_forwards=8080, resource_deps=['db'],
  readiness_probe=probe(http_get=http_get_action(path='/healthz', port=8080)),
  links=[link('http://localhost:8080', 'App')])
local_resource('db', cmd='docker run -d postgres', auto_init=True)
```

**Extension model.** `load('ext://...')` pulls Starlark from
[tilt-extensions](https://github.com/tilt-dev/tilt-extensions). Extensions are pure Starlark calling
the public API — no privileged host.

**Solves.** Resource model (`local_resource` / `docker_build` / `k8s_resource` / `dc_resource` as
peers, each with `resource_deps`, `readiness_probe`, `port_forwards`, `links` = our `endpoints()`)
is structurally close to our `DevstackPlugin`. **Live update** (`sync()` + `run()` +
`restart_container()`) is faster than rebuild→recreate. **Warm re-up** is reconcile-toward-graph:
unchanged resources are no-ops; `tilt down` is explicit. Multi-stack: weak — multiple Tilts on one
host don't coordinate ports. **One-shot init** = `local_resource(auto_init=True)` with no
`serve_cmd`.

Sources: [API](https://docs.tilt.dev/api.html),
[live update](https://docs.tilt.dev/live_update_reference.html),
[local_resource](https://docs.tilt.dev/local_resource.html),
[Compose](https://docs.tilt.dev/docker_compose.html).

---

## 2. Skaffold

**Shape.** `skaffold dev` runs build → push → deploy on file change, mostly K8s-targeted. Build
backends: Docker, Buildpacks, Bazel, ko, Jib. Deploy: kubectl, Helm, kustomize, Cloud Run.

```yaml
apiVersion: skaffold/v4beta11
kind: Config
build: { artifacts: [{ image: myapp, docker: { dockerfile: Dockerfile } }] }
deploy: { kubectl: { manifests: ['k8s/*.yaml'] } }
portForward:
  - { resourceType: service, resourceName: myapp, port: 8080, localPort: 8080 }
profiles: [{ name: ci, deploy: { kubectl: { defaultNamespace: ci } } }]
```

**Extension model.** Curated build/deploy backends; user extensibility = profiles +
`before-`/`after-` lifecycle hooks. Not pluggable in the Garden/Tilt sense.

**Solves.** **Status checks**: built-in. After deploy, blocks until Pods, Deployments, StatefulSets,
Cloud Run instances are Ready; `statusCheckDeadlineSeconds` + `tolerateFailuresUntilDeadline`.
**Profiles**: clean dev/CI/prod split via `-p ci` — closer to our future
`network: 'localnet' | 'testnet' | 'mainnet'` switch. Port-forward declarative + auto.

Sources: [docs](https://skaffold.dev/docs/),
[port-forwarding](https://skaffold.dev/docs/port-forwarding/),
[status check](https://skaffold.dev/docs/status-check/).

---

## 3. Garden (garden.io)

**Shape.** Declarative DevOps built around a **Stack Graph** — DAG where nodes are typed actions
(`build`, `deploy`, `run`, `test`) and edges are deps. `garden dev` is the watch loop.

```yaml
apiVersion: garden.io/v2
kind: Project
name: my-app
environments: [{ name: dev }, { name: ci }]
providers:
  - { name: local-kubernetes, environments: [dev] }
  - { name: kubernetes,       environments: [ci] }
---
kind: Build  ; type: container ; name: api
---
kind: Deploy ; type: helm      ; name: api ; dependencies: [build.api]
```

**Plugin model.** First-class. Providers (`kubernetes`, `terraform`, `pulumi`, `exec`, `container`)
contribute action types and handlers (validate / build / deploy / **getStatus** / delete / getLogs /
exec). This is the closest published prior art to our plugin model.

**Solves.** Stack graph + per-action `getStatus` is exactly what our `topoSortPlugins` + per-hook
walk does, generalized across action _types_. `getStatus` is the moral equivalent of our `doctor()`
_and_ our already-up detector — every action self-reports liveness. Result caching across team via
shared backends.

Sources: [docs](https://docs.garden.io/), [basics](https://docs.garden.io/getting-started/basics),
[graph execution](https://docs.garden.io/contributing-to-garden/graph-execution).

---

## 4. Dev Containers + Features

**Shape.** A spec (multi-vendor: VS Code, JetBrains, Codespaces, devpod) for
`.devcontainer/devcontainer.json`. **Features** are reusable install units distributed via OCI
registries.

```jsonc
{
	"image": "mcr.microsoft.com/devcontainers/base:ubuntu",
	"features": {
		"ghcr.io/devcontainers/features/node:1": { "version": "22" },
		"ghcr.io/devcontainers/features/docker-in-docker:2": {},
	},
	"postCreateCommand": "pnpm install",
	"postStartCommand": { "redis": "redis-server", "api": "pnpm dev" },
	"forwardPorts": [3000, 5432],
}
```

**Plugin model.** A feature = `devcontainer-feature.json` (metadata + options) + `install.sh` (root,
build-time) + lifecycle contributions. Composes via `dependsOn` (hard) and `installsAfter` (soft);
deterministic round-based topological sort. Distribution via OCI: `ghcr.io/owner/repo/feature:1`.

**Solves.** Lifecycle hooks (`onCreate / updateContent / postCreate / postStart / postAttach`)
accept string, array, or **object** form (object keys run in parallel). The `installsAfter`
semantics are the same idea as our `needs:`. OCI distribution gives free versioning we don't have.

Sources: [spec](https://containers.dev/implementors/spec/),
[features](https://containers.dev/implementors/features/),
[json reference](https://containers.dev/implementors/json_reference/).

---

## 5. devenv (devenv.sh)

**Shape.** Nix-backed dev environments. 50+ language modules, 40+ services, native Rust process
manager. <100ms activation, `devenv.lock` for reproducibility.

```nix
{ pkgs, ... }: {
  languages.javascript = { enable = true; package = pkgs.nodejs_22; };
  services.postgres.enable = true;
  processes.api.exec = "pnpm dev";
  processes.api.process-compose.depends_on.postgres.condition = "process_healthy";
}
```

**Plugin model.** Nix modules + (devenv 1.9+) profiles for selective activation. Type-checked at
evaluation time.

**Solves.** Services + processes declarative, with deps, restart policies, readiness probes, watch —
compose's job done by `process-compose`, natively, no Docker. `devenv.lock` pins down to glibc.

Sources: [home](https://devenv.sh/), [options](https://devenv.sh/reference/options/),
[1.9 modules+profiles](https://devenv.sh/blog/2025/09/17/devenv-19-scaling-nix-projects-using-modules-and-profiles/).

---

## 6. Nix flakes for dev shells

`flake.nix` declares `devShells.<system>.default`; `nix develop` enters with declared `buildInputs`
on PATH. `flake.lock` pins everything.

```nix
devShells.aarch64-darwin.default = pkgs.mkShell {
  buildInputs = with pkgs; [ nodejs_22 sui ];
};
```

**Solves.** Toolchain reproducibility — orthogonal to compose orchestration. Doesn't address
services, ports, deploy. devenv layers on top.

Sources: [Flakes wiki](https://wiki.nixos.org/wiki/Flakes),
[`nix develop`](https://nix.dev/manual/nix/2.26/command-ref/new-cli/nix3-develop).

---

## 7. k3d / kind / minikube

Single-node K8s locally. **k3d** = k3s in Docker (fastest, ships Traefik). **kind** = upstream
Kubernetes-in-Docker (no ingress, no LB by default). **minikube** = VM-or-container with addon
ecosystem.

Service exposure: k3d `-p "8081:80@loadbalancer"` at cluster create; kind needs MetalLB or
`kubectl port-forward`; minikube has `minikube service` tunnels.

**Relevance.** They're the _substrate_ Tilt/Skaffold/Garden run on, not the orchestrator. Lesson:
cluster-create-time port mapping (k3d) vs ad-hoc tunnels (`kubectl port-forward`) — our allocator is
the moral equivalent of the former.

Sources: [k3d exposing services](https://k3d.io/v5.3.0/usage/exposing_services/),
[Reintech comparison](https://reintech.io/blog/kind-vs-minikube-vs-k3d-local-kubernetes-comparison).

---

## 8. mirrord / Telepresence

Bridge a _remote_ K8s cluster into a local process. Telepresence: tun device + Traffic Manager.
mirrord: `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES` hooks libc to redirect FS/network/env to a remote
agent.

**Relevance.** Negative — antithetical to our principle "real chain, real wallet, real Move" applied
locally. Mentioned only as the architecture pattern if we ever want "develop against testnet but
publish locally."

Sources: [K8s blog comparison](https://kubernetes.io/blog/2023/09/12/local-k8s-development-tools/),
[mirrord vs telepresence](https://metalbear.com/mirrord/compare/telepresence/).

---

## 9. Earthly / BuildKit

Reproducible build orchestration. `Earthfile` = Dockerfile + Makefile; targets run in isolated
BuildKit containers; cache-aware; `SAVE ARTIFACT`

- `SAVE IMAGE`.

```dockerfile
VERSION 0.8
FROM golang:1.21-alpine
build:
  COPY main.go .
  RUN go build -o app main.go
  SAVE ARTIFACT app
docker:
  COPY +build/app .
  SAVE IMAGE myapp:latest
```

**Relevance.** The image-build half. Today we shell `docker build` in plugins; Earthly _could_ be
the unit of an image-build hook with shared caching across walrus + seal + sui. Overkill for 3
images today.

Sources: [GitHub](https://github.com/earthly/earthly),
[basics](https://docs.earthly.dev/basics/part-1-a-simple-earthfile).

---

## 10. Dapr

Sidecar runtime for distributed apps. `daprd` runs beside your service, exposing HTTP/gRPC
building-block APIs (state, pub/sub, secrets, bindings, actors, workflows). `dapr init` sets up
local state + redis; `dapr run` starts app + sidecar.

**Relevance.** The _sidecar pattern_. Our `seal-key-server` is structurally a sidecar to
`sui-localnet`. If devstack grows a narrower "sidecar" plugin shape, Dapr's component-config +
auto-injection model is the reference.

Sources: [overview](https://docs.dapr.io/concepts/overview/),
[sidecar](https://docs.dapr.io/concepts/dapr-services/sidecar/).

---

## Cross-cut: "is the stack already up?"

| Tool              | Mechanism                                                                   |
| ----------------- | --------------------------------------------------------------------------- |
| Tilt              | Reconcile-toward-graph; image hash + resource state; unchanged → no-op.     |
| Skaffold          | Pre-run digest comparison; redeploys only changed.                          |
| Garden            | Per-action `getStatus` handler; framework decides.                          |
| devcontainer      | Container ID persisted; only `postStart` re-runs on attach.                 |
| devenv            | Nix re-eval; only changed `process-compose` processes restart.              |
| **devstack (us)** | `<app>-sui` healthcheck; on `healthy`, skip first compose-up pass entirely. |

**Garden's per-action `getStatus`** is the cleanest generalization, and it's what we'd grow toward
to let plugin authors declare "is my piece already up?" instead of relying on a single sui-only
health gate.

## Cross-cut: long-tail one-shot init

Our `walrus-deploy` is the canonical case (runs once, exits 0, non-idempotent).

| Tool              | Pattern                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| Tilt              | `local_resource(auto_init=True)`, no `serve_cmd`.                               |
| Skaffold          | `before-deploy` / `after-deploy` lifecycle hooks.                               |
| Garden            | `Run` action type with `dependencies`; cached by hash.                          |
| devcontainer      | `onCreateCommand` (per-image) vs `postCreateCommand` (per-instance).            |
| **devstack (us)** | A compose service + the side-channel hack of skipping first compose-up on warm. |

devcontainer's _two-stage_ split (per-image vs per-instance) is exactly what walrus needs: per-image
build, per-instance on-chain register.

---

## What to steal

1. **Garden's per-action `getStatus`.** Adding `getStatus(ctx)` as a first-class plugin hook
   (parallel to `doctor()` but answering "is this plugin's contribution still live on-chain?") lets
   plugins own idempotency instead of leaning on the `<app>-sui` detector. Maps onto §10.1's "Seal
   `deploy()` is non-idempotent" + §10.2 q4 (DI for deploy steps). Highest-leverage idea in this
   doc.

2. **Tilt's resource shape + live-update.** A `local_resource` with `deps`, `serve_cmd`, `cmd`,
   `links` is the same shape as our `render + deploy + endpoints`. The `live_update` pattern (sync +
   run + restart_container) for Move package editing — `sui move build` in-container against a
   synced source dir instead of full `docker cp` + republish — is the most plausible warm-loop win
   we haven't tried.

3. **Skaffold's profile model.** Cleaner shape (`-p ci`) than what we have for `network` switching.
   Steal when we land non-localnet bring-up — but constrain swappable surface (network + plugin
   overlays only, not arbitrary fields).

## What to avoid

- **Tilt's Starlark DSL.** TS `defineDevstackConfig` is the right call.
- **Garden's K8s-by-default.** Steal the graph, not the cluster commitment.
- **OCI plugin distribution (devcontainer Features) early.** Beautiful, but solves a problem
  (third-party plugins) we don't yet have.
- **Telepresence-style bridges.** Antithetical to "real chain, local."

## Specific design questions

- **Adopt Tiltfile / Tilt's resource model?** Not the DSL. _Yes_ on the conceptual upgrade: split
  `deploy()` into `deploy() + getStatus() + liveUpdate()` so the orchestrator reconciles like Tilt
  does.

- **Devcontainer Features spec for our plugins?** Worth _learning from_ (`installsAfter` algorithm,
  parallel-object lifecycle commands). Not worth aligning structurally — different problem domain
  (host toolchain vs running services).

- **devenv/Nix at the chain-image-build layer?** No for the chain — Sui release artifact is the
  source of truth, Docker is the right boundary. _Yes_ for the host-side `sui` codegen CLI
  requirement (§6.6, §10.1). Treat as supplementary toolchain manager, not Docker replacement.
