# 18 Router (distilled)

## Purpose

The router is the **localhost HTTP dispatch layer** that gives every devstack-launched service a
stable, browser-friendly URL. A single Traefik v3 reverse-proxy container, shared across every
`<app, stack>` on the host, listens on fixed well-known host ports (the "entrypoints") and
dispatches by `Host:` header to the right upstream — be that a docker container or a Node host
process. The router exists so that parallel stacks of the same app can coexist on identical
entrypoint ports (Host headers differ per stack) and so that every service URL is a memorable
`<service>.<app>.localhost` rather than a port number, with zero `/etc/hosts` edits or TLS certs
(`*.localhost` resolves to 127.0.0.1 per RFC 6761).

It is **orchestrator-level infrastructure**, not a per-stack participant: one container and one
network serve every `pnpm dev` on the host, and the router intentionally has no `Identity`
requirement so it can outlive any single stack.

## Responsibilities

- Ensure exactly one shared Traefik container and one shared docker network exist on the host.
- Maintain a directory of per-backend dispatch entries (one file per backend) consumed by Traefik's
  file-watching configuration provider.
- Mint per-backend hostnames and IDs from `(app, stack, service)` such that parallel stacks never
  collide.
- Decide whether each `ensureRouter` call adopts a healthy existing container, resumes a stopped
  one, recreates on image mismatch, or creates from scratch.
- Connect each opting-in container to the shared network and learn the container's IP on that
  network with bounded retries before publishing the dispatch entry.
- Provide a registered set of named entrypoints (one fixed host port each) that backends select by
  name.
- Provide a single shared, permissive CORS middleware that backends can opt into.
- Tear down per-backend dispatch entries when their owning scope closes; leave the shared container
  running between supervisor invocations.

## Routable capability contract

A "Routable" is anything the router will dispatch traffic to. Conceptually, a participating
component must declare:

- **A backend identity** — a unique key derived from `(app, stack, service)` that produces both a
  per-backend hostname and a per-backend dispatch-file id. Distinct `(app, stack, service)` triples
  MUST produce distinct hostnames and ids.
- **A named entrypoint** — a previously-registered well-known port name (e.g. an RPC entrypoint, a
  faucet entrypoint, a dev-server entrypoint). The component does NOT pick a port; it picks an
  entrypoint name.
- **An upstream target** — either "a container reachable on the shared router network at port N" or
  "a host process reachable at host-loopback port N". The component does not write this URL itself;
  the router resolves it (for docker backends, after attaching the container to the shared network
  and learning its IP).
- **Optional CORS opt-in** — a boolean that, when set, attaches the shared CORS middleware.
- **Optional wire protocol** — typically HTTP, with cleartext HTTP/2 ("h2c") as the only other
  current variant (for gRPC backends).

A participating component must NOT:

- Pick a port number directly.
- Pick a hostname directly (the router mints it from identity + service).
- Ask Traefik to discover it via container labels — see invariants.

Plugin-authored components participate by declaring routable backends through the same conceptual
contract as in-tree services; the router has no compiled-in awareness of which services exist. The
entrypoint registry is a single shared namespace populated at module-load time and read once when
the router container is launched.

## Lifecycle states

**Router container / network states** (deciding what `ensureRouter` should do):

| Found state                          | Image matches? | Action                            |
| ------------------------------------ | -------------- | --------------------------------- |
| Container absent                     | n/a            | Ensure network + create fresh     |
| Container running                    | yes            | Adopt (no-op)                     |
| Container running                    | no             | Force-remove + create fresh       |
| Container stopped                    | yes            | Resume; on failure recreate fresh |
| Container stopped                    | no             | Force-remove + create fresh       |
| Network absent (any container state) | n/a            | Create network first              |

**Bootstrap is invoked from two call paths** (the long-lived supervisor and the one-shot apply), but
the boot-decision behaviour is identical. Both call paths run the bootstrap **at most once** in
their lifetime, on a scope that survives hot-reload cycles — re-ensuring the router per cycle would
re-pay docker inspect cost for no gain.

**Per-backend dispatch-entry lifecycle**:

1. Owner declares a Routable.
2. Router (for docker backends) connects the container to the shared network; (for host-process
   backends) skips this step.
3. Router resolves the upstream URL — for containers, by inspecting the container's IP on the shared
   network with a bounded retry budget (the IP does not settle synchronously when the
   network-connect call returns).
4. Router atomically writes the per-backend dispatch file into the watched directory.
5. Owner's scope finalizer removes the file when the scope closes.
6. Traefik picks up additions and removals through its file watcher (asynchronous, sub-second in
   practice).

**Hot-reload safety on dispatch files**: writes must be atomic (tmp + rename) because Traefik's
watcher can observe a partial body and then refuse to load further updates from that file. Deletes
are best-effort and tolerate "already gone".

**Shared CORS middleware** is rewritten on each router boot, before any per-backend file references
it, and its filename sorts before per-backend filenames so the watcher loads it first.

**Teardown granularity**:

- Per-cycle (hot-restart): per-backend dispatch files removed via their owning scopes; shared
  container and network untouched.
- Supervisor exit: same as above.
- Explicit "include router" prune: shared container removed, shared network removed.
- Per-stack "wipe": never touches the router (router is cross-stack infrastructure, distinguished by
  a singleton router label, not by app/stack labels).

## Inputs / dependencies

- A subprocess-spawning capability (the only ambient effect requirement of the router boot path —
  deliberately not depending on the wider engine context so it can run before the rest of the layer
  is built).
- The `Identity` of any participating component, when minting that component's hostname/id (the
  router boot itself does NOT take `Identity`; only the per-backend dispatch step does).
- An atomic file-write capability.
- A pre-populated **entrypoint registry**: a process-global mapping from entrypoint name to
  `(host port, default protocol)`. Registrations land at module-load time and must be present before
  the router container is launched.
- The host docker daemon and CLI: for container/network create-inspect-start-remove and for
  attaching a container to the shared network.
- A host-resolvable address back to the host machine, used by host-process backends as their
  upstream.
- A host directory to mount into Traefik as its configuration source (a watched directory of
  per-backend files), with an environment-variable override for tests.
- Two environment opt-outs: one to disable the router entirely (skip ensure, fall back to direct
  ports), one to redirect the dispatch directory.

## Outputs / capabilities provided

- **Stable URL surface**: every Routable resolves to `<protocol>://<hostname>:<entrypointPort>`,
  where `<hostname>` is `<service>.<app>.localhost` for the default ("main") stack and
  `<stack>.<service>.<app>.localhost` for every other stack. The default-stack omission is
  intentional UX so the single-stack case feels uncluttered.
- **A shared CORS middleware** that any Routable may opt into.
- **A boot-decision report** (span attribute: adopt / resume / fresh) usable by diagnostics
  surfaces.
- **An inventory row** (router status, suitable for doctor/prune output): container existence,
  running state, image, network presence.
- **An includable scope in the `prune` command** to fully tear down shared router state.
- **A snapshot-aware footprint of zero**: the router is host infrastructure, not part of any stack's
  snapshot/restore.
- **No state-store writes**; router state lives entirely in the dispatch directory on disk plus the
  docker daemon.

## Invariants and constraints

1. **File-provider only — NOT docker-provider.** Traefik must read its dispatch config from the
   watched directory of files, NEVER from docker container labels. Reason: the router upstream IP we
   need is the container's address on the shared router network, which is added _after_ the
   container starts; a label-driven docker-provider would capture the per-stack IP at first event
   and never refresh, breaking every request. The supervisor writes the dispatch file
   deterministically after network attach and IP resolution succeed.

2. **Two-network attach.** Every docker backend joins TWO networks — its per-stack network and the
   shared router network — and the IP published into the dispatch file is the shared-network IP, not
   the per-stack IP.

3. **Bounded IP-inspect retry.** After network connect succeeds, the daemon assigns the
   shared-network IP asynchronously; a single inspect can return empty or a sentinel "no value". The
   retry budget must be tight enough to fail fast but long enough to cover the daemon race.
   Exhaustion is a hard failure of the participating primitive (the route cannot be honored).

4. **Adopt path must rewrite dispatch files, not skip.** When a container is reused warm, the
   network-connect call returns "endpoint already exists"; this must be detected and treated as
   success so the dispatch file is rewritten (the upstream IP may have changed if the daemon re-IP'd
   the container).

5. **Atomic dispatch-file writes.** Non-atomic writes can be torn-read by the watcher and silently
   disable that route until something else mutates the file. Every write is tmp + rename.

6. **Allowlist of entrypoints.** Routables select an entrypoint by _name_ from a closed set
   populated at module-load time. The set is read once at router launch — registrations after launch
   don't reach Traefik. Re-registering the same `(name, port, default protocol)` is idempotent;
   re-registering with conflict throws synchronously.

7. **Hostname & id uniqueness across stacks.** Hostname and id minting MUST embed the stack
   dimension for non-default stacks. The default ("main") stack omits the stack segment for UX
   reasons; every other stack includes it. Distinct `(app, stack, service)` triples MUST produce
   distinct hostnames AND distinct dispatch ids.

8. **Service-segment normalization.** Dots in the service segment of dispatch ids are folded to a
   label-safe separator (docker label-value constraints).

9. **CORS-middleware-before-routes.** The shared middleware file must be written before any
   per-backend file that references it, and named so the watcher's lexicographic load order picks it
   up first.

10. **Router boot does NOT take `Identity`.** Coupling boot to per-stack identity would defeat the
    singleton property; the router must be share-able across every concurrent stack on the host.

11. **Bootstrap survives hot-reload cycles.** The ensure step runs once per supervisor lifetime on
    the long-lived outer scope, not per cycle. Re-running per cycle re-pays docker inspect cost for
    zero benefit.

12. **HTTP only.** Every entrypoint is plain HTTP (or h2c). There is no TLS configuration and no
    `https://` surface.

13. **Validation on user-influenceable strings.** Any string spliced into a dispatch-file body (id,
    hostname, entrypoint name, upstream URL) must be validated against a conservative character set
    before render. Failure is a programming error in the caller, not a transient.

## Edge cases and known failure modes

- **Router opt-out**: when disabled by env var, the bootstrap short-circuits; per-primitive
  network-attach later fails with "no such network" and is logged as a warning. Containers remain
  reachable on direct ports if they expose any; `*.localhost` URLs return connection refused.
  Documented escape hatch for CI shapes where the router adds no test value.
- **Docker daemon hung**: bootstrap has a hard timeout; on expiry the router is downgraded to
  "continue without" with a warning. Same observable outcome as the opt-out.
- **Image mismatch**: existing container is force-removed and recreated. Logged.
- **Stopped container fails to resume** (e.g. port conflict from another process): force-remove and
  try fresh. If the underlying port conflict is real, the fresh path also fails and surfaces as a
  hard error.
- **Dispatch-file write fails** (filesystem perms): the per-primitive route is silently absent; the
  route's hostname returns Traefik's default 404. Warning is logged but easily lost in noisy
  supervisor output.
- **Network-connect "network not found"** post-bootstrap: router was disabled or its bootstrap
  failed; container stays up on direct ports.
- **IP-inspect retry exhausted** after a successful network-connect: hard fail of the participating
  primitive (the dispatch promise cannot be kept).
- **SIGKILL mid-write**: atomic-write design leaves a tmp orphan that Traefik ignores. Next boot
  overwrites the canonical file. Tmp orphans accumulate but are harmless.
- **Entrypoint registered after router launch**: it never makes it into Traefik's CLI args; routes
  for it return 404 until the router is recreated.
- **Two stacks accidentally collide on hostname/id**: contract violation in the minting helpers;
  would route both stacks' traffic to whichever container matched first.
- **User dials `https://`**: connection refused (no TLS).
- **`*.localhost` doesn't auto-resolve** (very old browser / non-RFC-6761 resolver): connection
  failed with no DNS. Workaround is `/etc/hosts` edit.
- **File-provider watcher misses a change**: stale route until a manual router restart. No formal
  SLO; no in-process verification that Traefik picked up the change.
- **Concurrent supervisors writing to the same dispatch directory**: safe so long as their
  identities differ (file names won't collide). If they don't differ, one supervisor's cleanup may
  delete the other's live route.
- **External prune-router while a supervisor is alive**: subsequent per-primitive routes fail at
  network-connect; the supervisor never re-runs ensure, so it cannot self-heal mid-life.
- **Health of Traefik itself**: bootstrap only checks "container running" via inspect — a Traefik
  that's running but crashed mid-boot still looks healthy.

## Learnings from current implementation

- **Three small modules with overlapping concerns** (router boot wrapper, pure hostname/id helpers,
  the big docker-side router file with registry + boot + render + write + IP cache) sprawl across
  two directories. They could and probably should live as one cohesive subsystem.
- **`ensureRouter` had to be made fully idempotent on a four-way decision** (adopt / resume /
  recreate / fresh) — a single boot path was insufficient because warm reuse, image upgrades, and
  clean restarts all surfaced in the wild.
- **Adopt-path bug**: an earlier version skipped the dispatch-file rewrite on every non-zero exit
  from network-connect, including the harmless "endpoint already exists" case. After a docker daemon
  restart re-IP'd containers, adopted containers retained stale IPs in their dispatch files and
  surfaced as 502s. The "rewrite always; detect already-attached via stderr regex" pattern is
  load-bearing.
- **IP-settling race after network-connect is real** and was the source of multiple flaky-test
  reports before the retry was introduced; a single inspect routinely returns empty or a "no value"
  sentinel.
- **The docker-provider was considered and rejected** for the IP-capture timing reason above; the
  file-provider choice is deliberate, not legacy.
- **Atomic writes are not a polish detail** — Traefik's watcher can silently disable a route after a
  torn read until the file is rewritten by something else.
- **Per-cycle ensure was a real wart**: removing it from the inner loop and pushing it to the outer
  scope removed measurable docker-inspect churn during hot-reloads.
- **Shared host directory is mounted read-only inside the container.** Traefik never writes; the
  supervisor writes from outside. This makes the watcher integration cleaner and the bind mount
  semantics safer.
- **Plugin-author opt-in flows through a single conceptual data shape** ("routable backend"), even
  though current code splits docker vs host-process opt-in across two open-coded sites; the
  duplication is a code-smell, not a contract difference.
- **`*.localhost` choice paid off**: zero `/etc/hosts` mutation and no TLS cert work for the
  dev-loop, at the cost of a small DNS-resolver footnote.
- **Naming legacy**: the current "RouterLabel" type name predates the file-provider pivot (when
  entries used to be stamped as docker labels). Devstack is unreleased, so the name should change
  with the redesign.
- **Documented-but-unimplemented escape hatch** for forcing both direct port and routed access
  exists in a JSDoc but no code reads it. Either implement or delete.
- **Unused exported IP-memoization** (a host-side debug helper) ships with a process-global mutable
  cell and a test-reset hook that have zero in-tree consumers. Strong candidate for deletion.
- **Comment promising a docker-stop finalizer on supervisor teardown does not match code reality** —
  the container has restart-unless-stopped, no finalizer is wired, and behavior is fine but the docs
  lie.
- **Permissive CORS** (`*` everywhere, very long max-age) is fine for dev but a footgun if anyone
  copies the YAML elsewhere.

## Cross-component references

- **`engine/identity.ts`** — the `(app, stack, network)` triple that drives hostname and id minting;
  also the source of the router-only label that distinguishes singleton router resources from
  per-stack resources.
- **Docker runtime substrate** — every container that opts in flows through the shared run
  primitive, which (for docker backends) performs the network-attach + IP-resolve + dispatch-file
  write + finalizer wiring.
- **Supervisor** — calls the bootstrap once per lifetime on the long-lived outer scope.
- **Apply command** — calls the bootstrap once per invocation (a fresh CI runner has no shared
  network from a prior `up`).
- **Prune command** — owns the explicit "include router" flag; tears down the shared container and
  network.
- **Inventory / doctor** — read the router's container and network state for the status row.
- **Wallet service**, **dev (host-process) service**, **walrus**, **seal**, **sui (localnet +
  fork)**, **deepbook (indexer + server)** — all declare Routables for their backends, in-tree.
- **Plugin-author docker-container surface** — the public path by which out-of-tree authors declare
  Routables for their containers.
- **Snapshot subsystem** — explicitly does NOT touch the router; router is host infrastructure
  outside any stack's snapshot.

## Open questions / decisions deferred

1. Should the supervisor self-heal if an external prune removes the shared container mid-life? Today
   it cannot.
2. Should the bootstrap verify Traefik liveness with an actual HTTP probe, not just
   container-running?
3. Should the redesign add an optional TLS mode (for `https:`-gating production-parity tests), or
   formally close that door?
4. Should the bootstrap re-pay an "ensure" on hot-reload to recover from external mutations, or
   remain once-per-lifetime?
5. Should `defineDevstack` accept a `router: {…}` config surface (enable flag, dispatch dir),
   retiring the env-var escape hatches?
6. Should every entrypoint registration also declare a URL scheme, decoupling protocol-vs-scheme in
   advance of any HTTPS work?
7. Should the dispatch-file watcher behavior be verified by an in-process test (e.g. "add a route
   mid-supervisor-life and observe it via Traefik"), not just end-to-end through service
   ready-probes?
8. Is there a meaningful "router available on this stack but not that one" use case, or is the
   router always-on-or-off per host?
9. Should the Traefik image be pinned by digest rather than tag, accepting friction at upgrade time
   for full reproducibility?
10. Should the conceptual Routable contract be exposed as a first-class capability rather than two
    open-coded call sites (docker-backend opt-in and host-process opt-in)?

## Opportunities noticed

1. **One shared "publish-a-Routable" code path** for docker and host-process backends, replacing the
   two ~30-line open-coded blocks; aligns with declaring "Routable" as a real capability in the
   redesign.
2. **Collapse the three router-related modules into one subsystem directory** (registry + boot +
   render + IP cache + hostname/id helpers) so "the router" is findable in one place.
3. **Drop unused surface**: the exported IP-memoization helper, its memo cell, and its test-reset
   hook; the documented-but-unimplemented direct-ports env var.
4. **Rename "RouterLabel" → something like "RouterRoute" / "BackendRoute"** to match the post-pivot
   reality; devstack is unreleased.
5. **Move CORS-middleware writing out of `ensureRouter`** into a static "common dispatch config"
   step that doesn't conceptually require the container to exist.
6. **Pre-decide whether HTTPS is in scope.** If yes, declare protocol-vs-scheme separately at
   entrypoint registration. If no, document the decision and stop entertaining the option.
7. **Length-cap and tighten the user-influenceable-string validators** in preparation for a wider
   plugin-author surface.
8. **Move the router config knobs (enable flag, dispatch dir) into the engine config surface**
   rather than env vars; reserve env vars for ops escape hatches.
9. **Add a doctor diagnostic** that probes `*.localhost` resolution from a Node process so users in
   broken DNS environments fail loud instead of getting confusing 404s.
10. **Consolidate the parallel-stack hostname/id invariant test** into one canonical place instead
    of re-asserting it from each service's test file.
11. **Plan for hot-reloadable entrypoint set** — today registering a new entrypoint after router
    launch is a programming error; a diff-aware re-run could make plugin development less
    foot-gunny.
12. **Decide on Traefik dashboard auth** for shared-CI-runner contexts; the current
    unauthenticated-on-loopback default is fine for solo dev only.
