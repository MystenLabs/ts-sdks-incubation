# Friction journal

Concrete pain encountered while building. Each entry: short title, file path(s), one-line
description. This is the input to Phase 2 (devkit extraction). Add freely; we triage when the
journal is full.

Format:

```
## YYYY-MM-DD · short title
**Where:** path/to/file:line (or category)
**Pain:** one or two lines describing what hurt
**Hypothesis:** what an abstraction would do (optional, lightweight)
```

---

## v3 API refactor (2026-04-30) — what it closed

The v3 refactor (`notes/api-refactor.md`) shipped library-level fixes for the biggest journal
entries below. Quick map (entries marked `[v3-CLOSED]` in the historical log are the originals):

- **`dapp-kit.ts` boilerplate copied app-to-app** → `createDevstackDappKit` in
  `@mysten-incubation/devstack/react` (G2). One factory + a `walletInitializerFactory` param.
- **Per-app `useSignAndExecute` (the "fourth copy" comment in arena's `lib/queries.ts`)** →
  `useDevstackSignAndExecute` (E2). Same hook; one source of truth.
- **Per-app `tx.moveCall({ target: '${pkgId}::module::fn' })` boilerplate** →
  `useDevstackPackage(name)` (E1). The codegen builders are pre-bound to the live `packageId` so
  call sites become `pkg.fn({ arguments })(tx)`.
- **Hand-rolled DeepBook import in wallet** → `imports({ packages })` plugin (D1) +
  `withRecursiveDeps` (D2). DeepBook becomes a config-line.
- **`function suiClient(url)` duplicated in 4 plugin files** → `createLocalSuiClient` in
  `@mysten-incubation/devstack/helpers` (G1).
- **6 fragmented signer-materialization paths (`loadAccountKeypair`, `cliSigner`, `envSigner`,
  `ConsoleAccount`, hardcoded keys, deterministic mnemonic)** → top-level `accounts: { ... }` in
  `defineDevstackConfig` (A1+A2). One materializer (`resolveAccounts`), one consumer interface
  (`ctx.accounts.get(name)`).
- **Vite `devKeysPlugin` duplicated wholesale across apps** → already shipped to
  `@mysten-incubation/devstack/vite` in M10; entries left for history.
- **e2e setup/teardown as separate scripts** → `manageStack: true` flag in
  `defineDevstackPlaywrightConfig` wires globalSetup/globalTeardown. Hermetic `pnpm test:e2e`.
- **`devstack stack down`/`drop` lacked top-level shortcuts** → `devstack down` and
  `devstack reset --yes` (I1).
- **`Plugin.schemas` exported but unused** → dropped (I4).
- **No way to scope `apply` to a single package** → `apply --actions a,b,c`
  - REPL `.deploy <pkg>` (I6).

Open entries below are still real. New friction goes at the bottom.

---

## M6 — Plugin foundation

**Goal.** Convert `services/{sui,walrus,seal}.ts` into self-contained plugins so adding a new
service (indexer, oracle, Pyth, Walrus aggregator) doesn't require editing `runDeploy()` or the
static `services/index.ts` REGISTRY map. Removes the architectural smell flagged in §6 of the eval
at `~/.claude/plans/hidden-greeting-waterfall.md`.

### 2026-04-29 · Service interface didn't model image build / deploy / manifest contributions

**Where:** `tooling/devkit/src/services/types.ts:88` (old `Service`),
`tooling/devkit/src/deploy/run.ts:163` (seal-specific `if`),
`tooling/devkit/src/services/types.ts:23` (seal-specific `sealConfig?` field on `ServiceContext`),
`tooling/devkit/src/services/index.ts:7` (static REGISTRY map). **Pain:** Each service-shaped
concern (image build for walrus/seal, on-chain bootstrap for seal, manifest contribution for seal)
leaked into a different layer of devkit core. Adding any new service to the dev stack required edits
in 3+ files across `services/`, `deploy/run.ts`, `manifest/schema.ts`, `cli/commands/up.ts`.
**Resolution path (chunk 1, this entry).** Defined a `DevkitPlugin` interface at
`tooling/devkit/src/plugin/types.ts` with hooks for `requiredPorts` / `buildImage` / `render` /
`deploy` / `manifestKey` + `manifestSchema` + `manifest`. Created the first plugin
(`tooling/devkit/src/plugins/sui/index.ts`) that owns the sui-localnet image-tag computation and
compose render. `services/sui.ts` is now a thin adapter that wraps the plugin so the legacy
`services: [...]` config and the existing renderer stay unchanged. Verified the adapter produces
byte-identical compose YAML for arena (sui-only stack). **Next chunks.**

- Chunk 2: walrus plugin + plugin orchestrator (topological sort, render-merge across plugins).
  Walrus is the second consumer that exercises `buildImage()`.
- Chunk 3: seal plugin pulls `bootstrapSeal` out of `runDeploy` into the plugin's `deploy()` hook.
  Removes the seal-specific `if` and replaces `ServiceContext.sealConfig` with the generic
  `RenderContext.composeContext`. Manifest schema becomes plugin-extended.
- Chunk 4: switch `defineDevnetConfig` to accept `plugins: DevkitPlugin[]`; legacy
  `services: string[]` becomes a back-compat shim that resolves strings to in-tree plugin factories.

### 2026-04-29 · Plugin orchestrator + walrus plugin (chunk 2)

**Where:** `tooling/devkit/src/plugin/orchestrator.ts` (new),
`tooling/devkit/src/plugins/walrus/index.ts` (new), `tooling/devkit/src/services/walrus.ts` (now
adapter). **Pain (predicted):** None — chunk 2 was a clean parallel of chunk 1 plus a 90-line
orchestrator (Kahn's algorithm + render-merge). One small wart: walrus's `render()` falls back to
`walrusImageTag(rev)` if `ctx.imageTag` is undefined. That fallback only exists because the legacy
adapter path doesn't call `buildImage()`. Goes away in chunk 4 when `up.ts` switches to the
orchestrator. **Verified:** orchestrator's `renderAll([sui(), walrus()])` produces structurally
identical compose fragments to the legacy `renderCompose({ services: ['sui', 'walrus'] })` for both
arena (sui only) and private-content (sui+walrus). Workspace typechecks + lints clean. **Next chunk
(3):** seal plugin. This is where the design pays rent — pulls `bootstrapSeal` out of `runDeploy()`
into the plugin's `deploy()` hook, replaces `ServiceContext.sealConfig` with the generic
`RenderContext.composeContext`, and converts the hard-coded top-level `seal?:` manifest field to a
plugin-extended schema.

### 2026-04-29 · Seal plugin render — composeContext stand-in (chunk 3a)

**Where:** `tooling/devkit/src/plugins/seal/index.ts` (new), `tooling/devkit/src/services/seal.ts`
(now adapter). **Pain (predicted):** Seal's two-pass render needs typed access to bootstrap state.
The old `ServiceContext.sealConfig` was nominally typed (`SealServiceConfig`) but only because the
_consumer_ of the field was statically known. With a generic plugin,
`RenderContext.composeContext: unknown` lands as a deliberate escape hatch — each plugin owns its
own concrete type and casts on the way in. Acceptable: the plugin still gets full type safety
internally; the cost is one cast at the boundary. **Verified:** seal plugin via the orchestrator
produces byte-identical output to the legacy `services/seal.ts` path for both first-pass (empty
fragment) and second-pass (seal-key-server with full env) renders. `renderCompose` envelope still
works through the `services/seal.ts` adapter. **Open (chunk 3b):** the seal-specific
`if (config.services.includes('seal'))` branch in `runDeploy()` (`deploy/run.ts:163`) and the
`bootstrapSeal()` direct import are still there. Pulling them out into the plugin's `deploy()` hook
is chunk 3b — that's the actual smell-removal step.

### 2026-04-29 · Seal `deploy()` hook + plugin-extended manifest (chunk 3b)

**Where:** `tooling/devkit/src/plugin/orchestrator.ts` (added `deployAll`,
`composePluginManifests`), `tooling/devkit/src/plugins/seal/index.ts` (added `deploy`, `manifest`,
`manifestSchema`), `tooling/devkit/src/manifest/schema.ts` (dropped hard-coded `seal:` field — now
`.passthrough()` so plugin keys aren't stripped), `tooling/devkit/src/deploy/run.ts:162-191` (the
seal-specific `if (services.includes('seal'))` branch is gone — replaced by a generic
`deployAll(plugins, ctx)` walk). **Pain (predicted):** Two design choices stood out. (1) `Manifest`
type lost the typed `seal?: SealManifest` field once `manifest/schema.ts` stopped hard-coding it.
Mitigated by switching the schema to `.passthrough()` and intersecting the inferred type with
`Record<string, unknown>` — apps that want a typed accessor inline the shape in their
`vite-env.d.ts` (already the case for private-content). (2) `bootstrapSeal()` previously returned a
`SealServiceConfig` defined in `services/types.ts`; the plugin now wraps that into a
`DeployContribution` (composeContext + captured fields) so `manifest()` can read
`ctx.contributions.seal.captured` without `bootstrapSeal` knowing about plugin types. One ergonomic
wart: `DeployContribution.captured` is `Record<string, string>` (manifest values), not arbitrary
plugin-internal state — that's a chosen narrowness so manifest contributions can be JSON-rendered
without per-plugin helpers. **Verified:** workspace-wide `pnpm typecheck && pnpm lint` clean.
Compose service-key sets identical to the chunk-3a path for arena (sui-only), private-content
first-pass (sui+walrus), and private-content second-pass (sui+walrus+seal); `addedServices` diff
correctly returns `['seal-key-server']` for the second pass. `runDeploy` no longer imports
`bootstrapSeal` directly — the seal Move package can now be deleted from the importedPackages list
and the failure surfaces inside the plugin
(`seal plugin: no published package with alias "seal" found`) rather than as a generic deploy error.
**Open (chunk 4):** `defineDevnetConfig` still takes `services: string[]` + `suiVersion: string`.
Apps haven't migrated to `plugins: DevkitPlugin[]` yet, and the legacy
`services/{sui,walrus,seal}.ts` adapters + the static `services/index.ts` REGISTRY are still present
(now thin shims behind plugins).

### 2026-04-29 · Plugins-only config + adapter cleanup (chunk 4)

**Where:** `tooling/devkit/src/config/schema.ts` (added `plugins: DevkitPlugin[]`, deprecated
`services` + `suiVersion`), `tooling/devkit/src/config/load.ts` (back-compat shim resolves legacy
`services: [...]` via `plugins/registry.ts`), `tooling/devkit/src/cli/commands/up.ts` (replaced
legacy `renderCompose` + per-service `ensure*Image` calls with `renderAll` + `buildAllImages`),
`tooling/devkit/src/compose/render.ts` (now a fragment-to-YAML serializer with no plugin/service
awareness — old API gone), `tooling/devkit/src/ports/allocator.ts` (walks `plugins[].requiredPorts`
instead of `getService(name).requiredPorts`), all four apps' `devnet.config.ts` (migrated to
`plugins: [suiPlugin({ version }), walrusPlugin?, sealPlugin?]`), deleted:
`services/{sui,walrus,seal}.ts`, `services/index.ts`, `SealServiceConfig` + `ServiceContext` +
`Service` interface in `services/types.ts`, `imageTagFor` in `cli/paths.ts`. **Pain (predicted):**
Three friction points worth recording. (1) Zod can't validate plugin objects (closures, methods) —
`z.custom<DevkitPlugin>(() => true)` is a typing escape hatch, not real runtime validation.
Tolerable because mistyped plugins fail loudly inside `topoSortPlugins` or the first `render()`
call. (2) The back-compat shim for `services: [...]` lives in `loadDevnetConfig`, which means the
loader now imports the in-tree registry — a circular-feeling layering that goes away the moment the
legacy fields are deleted. (3) `compose/render.ts` is now well-located _contents-wise_ but the file
path retains its old name; a follow-up rename to `compose/yaml.ts` would clean the hierarchy
further. Leaving for now to keep this chunk's diff focused on the architectural change.
**Verified:** `pnpm typecheck && pnpm lint` clean across all 6 packages. `renderAll` +
`renderComposeYaml` produces structurally identical compose output for arena (1 service:
sui-localnet), private-content first-pass (6 services: sui + walrus deploy + 4 nodes), and
private-content second-pass (7 services adding seal-key-server). Apps' inlined `Manifest` types in
`vite-env.d.ts` continue to type the seal field, even though `manifest/schema.ts` no longer
hardcodes it (the runtime composes via `composePluginManifests`). Real
`pnpm --filter <app> devnet:up` against Docker is the canary that the plugin-driven `deploy()` +
post-deploy compose-up still works end-to-end; the static checks above only catch refactor errors.
**Resolved:**

- `runDeploy` seal-specific `if` (line 163, now gone — replaced by `deployAll(plugins, ctx)`).
- Static `REGISTRY` map in `services/index.ts` (file deleted).
- Hardcoded `seal-key-server` in the second compose-up pass (now `compose up <addedServices>`
  derived from a generic render diff).
- `ServiceContext.sealConfig` field (interface gone in chunk 4 along with the rest of
  `ServiceContext`).

### Hooks intentionally deferred

- `vite()` hook on the plugin interface. Wait until M10 (frontend extraction) when there are 4
  consumers asking for it.
- ~~`doctor()` hook~~ — landed in M7 alongside `endpoints()`; per-plugin probes contribute to
  `devkit doctor`.
- `down()` hook. Wait until a plugin first needs cleanup beyond `docker compose down -v` (likely
  M11, when allowlist-based `.env` cleanup is wanted).
- `ready()` hook. Compose's `--wait` covers it for now.

---

## M7 — README + observability

**Goal.** Make the tool legible without reading source. Add `endpoints()` + `doctor()` hooks so
plugins contribute live URLs to the `up` banner and per-plugin probes to `devkit doctor`. Write the
workspace README.

### 2026-04-29 · gRPC discoverability — resolved by `endpoints()` hook + plugin doctor probe

**Where:** previously `notes/friction.md:139` ("gRPC works on localnet but the service path is
undocumented"). Resolution lands at `tooling/devkit/src/plugins/sui/index.ts:endpoints()` (sui
plugin contributes a `gRPC` entry to the `up` banner alongside `RPC` and `Faucet`) and
`tooling/devkit/src/plugins/sui/index.ts:doctor()` (probes
`<rpc-url>/sui.rpc.v2.LedgerService/GetServiceInfo` to flag the wrong path early). **Pain
(original).** gRPC shares the JSON-RPC port on sui localnet, but `sui start --help` doesn't mention
it and the obvious-looking `/sui.rpc.v2beta2.LedgerService/...` path returns 404 (correct path is
`sui.rpc.v2.LedgerService` — no `beta2`). 30+ minutes of debugging. **Resolution.** `pnpm devnet:up`
now prints, in one block:

```
━━ endpoints ━━
  RPC     http://127.0.0.1:9404
  gRPC    http://127.0.0.1:9404
  Faucet  http://127.0.0.1:9743
  Seal    http://127.0.0.1:2099
```

And `devkit doctor` runs the gRPC path probe automatically — a wrong-path regression in upstream Sui
surfaces as a `404 — wrong path? expected sui.rpc.v2.LedgerService` line within a sub-second probe.
**Verified (runtime).** `cd apps/private-content && pnpm exec devkit doctor` printed all 19 checks
green against the live stack including `sui gRPC ... HTTP 200`. Kill `seal-key-server`, re-run:
doctor flags the dead port (`port seal.api (2099) — allocated but nothing listening — run \`devkit
reset\` to re-render compose`) and the seal probe (`fetch failed`).

### 2026-04-29 · `endpoints()` + `doctor()` plugin hooks (M7a / M7b)

**Where:** `tooling/devkit/src/plugin/types.ts` (added `EndpointEntry`, `EndpointsContext`,
`DoctorCheck`, `DoctorContext`), `tooling/devkit/src/plugin/orchestrator.ts` (added
`composeEndpoints` + `runPluginDoctors` walks; both pure-ish — `runPluginDoctors` propagates
per-plugin throws as failed checks rather than aborting the run),
`tooling/devkit/src/cli/commands/up.ts` (banner now uses `composeEndpoints`),
`tooling/devkit/src/cli/commands/doctor.ts` (rewritten — Docker daemon + Node + image-freshness +
port-listening + per-plugin doctor walk). **Pain (predicted).** Two design choices stood out. (1)
Image-freshness was first sketched as a per-plugin check (each plugin reports its image tag), but
plugin instances don't naturally expose their tag synchronously (it's computed inside
`buildImage()`). Solution: a generic `docker image ls dev-examples/*` scan, no plugin coupling. New
plugins' images are picked up automatically. (2) Port-listening drift was first sketched as
`docker inspect <app>-<plugin>` looking up the container by plugin-name suffix, but the seal
plugin's container is `<app>-seal-key-server` not `<app>-seal` (the rendered service key differs
from the plugin name). Replaced with a plugin-agnostic `lsof -iTCP:<port> -sTCP:LISTEN` probe per
allocated port — works regardless of container naming convention. **Verified.** Workspace
`pnpm typecheck && pnpm lint` clean. `up` banner output shows the new `gRPC` row. `devkit doctor`
against private-content reports 19 green checks; deliberately stopping `seal-key-server` (the M7
verification spec's broken-state test) surfaces both the port-listening failure and the seal probe
failure with actionable detail strings. **Open.** Sui plugin's image-freshness sub-check on
`dev-examples/sui-localnet:devnet-v1.71.0-r2` only flags age, not whether the local image was built
from the _current_ Dockerfile. The `-r2` suffix on the tag is bumped manually when the Dockerfile
changes meaningfully — this is brittle. M8's source-digest gate idea should be applied to the
Dockerfile too: hash the build context and embed in the tag. Deferred to M8.

---

## M8 — Warm-loop speed

**Goal.** `pnpm devkit up` on an unchanged tree under 2s. Two deliverables shipped: source-digest
gate in `publishMovePackage` (skip republish when `.move` source SHA + chainId match the prior
manifest), and a `runCodegen` invocation tightening so importedPackages-only apps still regen.

### 2026-04-29 · Source-digest gate (M8a)

**Where:** `tooling/devkit/src/deploy/steps/publish.ts` (added `computeSourceDigest` + cache check),
`tooling/devkit/src/manifest/schema.ts` (added `PackageDeployment.sourceDigest` and `core.chainId`),
`tooling/devkit/src/deploy/run.ts` (reads prior manifest, fetches `getChainIdentifier`, threads
cache into each `publishMovePackage` call). **Pain (predicted).** Two design choices stood out. (1)
Digest scope: hashing only `*.move` files would miss `Move.toml` changes (e.g. bumping a
`[dependencies]` rev), which silently change build output. Solution: include `Move.toml` in the
digest set. `build/` and `tests/` are excluded — they don't affect published bytecode and `tests/`
would reuse-cache spuriously when only test code changed. (2) Cache liveness: digest match alone
isn't enough — a `down --purge` could have wiped on-chain state with the same chainId. Added a
one-roundtrip `client.getObject({ id: prior.packageId })` liveness probe before reusing the cache.
Cheap (~10ms on localnet). **Verified (runtime).** `time pnpm exec devkit up` in `apps/arena`
(sui-only, warm cache, vault-equivalent unchanged): **1.92s**, under the spec target of <5s on
Docker / <2s on native. Breakdown: `compose up --wait` skipped via M5's stack-already-healthy
detector; runDeploy hits the digest cache; codegen re-runs (idempotent). Source-change verification:
appended `// M8 cache-bust marker` to `apps/private-content/move/vault/sources/vault.move` → next
`devkit deploy` republished with new packageId; reverted → next deploy republished again (digest now
matches the reverted source); subsequent deploy hit cache
(`Reusing cached publish (digest match): 0x7786c5f3...`). **Open.** chainId-bust (force-regenesis)
is theoretically covered (`prior.chainId === chainId` check) but I haven't runtime-verified it —
would require `devkit down -v && devkit up` and inspecting that the cache busted. The logic is
straightforward; the test is mostly belt-and-suspenders.

### 2026-04-29 · Codegen widening (M8c)

**Where:** `tooling/devkit/src/deploy/run.ts:232` — replaced
`(config.movePackages?.length ?? 0) > 0` with `Object.keys(packages).length > 0`. **Pain
(predicted).** Apps that import a package but own none (a hypothetical "frontend-only consumer of
upstream Seal") would have skipped codegen because the gate keyed off authored packages, not the
resulting deployment map. Now keyed off what landed in the manifest, which includes both kinds.
**Verified.** `pnpm typecheck && pnpm lint` clean. private-content still regens vault on deploy as
expected; the imported `seal` package would also be picked up if codegen were configured for it.

### 2026-04-29 · sharedObjects clobbered on every deploy — surfaced by digest cache

**Where:** `tooling/devkit/src/deploy/run.ts:217` — `runDeploy` was unconditionally writing
`sharedObjects: {}` into the manifest, then post-deploy seed scripts (e.g.
`apps/arena/devnet/seed-lobby.ts`) would write back their entries. **Pain.** Pre-M8a, this was
self-healing: every deploy republished the underlying package, which gave it a fresh `packageId`
that made any prior shared-object's `objectType` (carrying the _old_ packageId) unreachable from the
frontend. Once M8a's source-digest cache landed, deploy stopped republishing on unchanged sources —
and the frontend now saw _all_ prior shared objects (e.g. every `Lobby` ever seeded by a re-run of
`devnet:up`). Arena's e2e regressed because the test expects exactly one open Lobby. **Resolution.**
runDeploy now preserves `sharedObjects` from the prior manifest when chainId matches;
force-regenesis still busts them along with the package cache. `apps/arena/devnet/seed-lobby.ts`
also gained an idempotency check: read the cached `openLobby` entry, verify the object exists
on-chain with the matching package's type, reuse on hit. **Verified.** `pnpm devnet:up` twice in
arena now logs `✓ Reusing seeded Lobby <id>` on the second call instead of creating a new one. Arena
e2e passes on warm + cold chain.

### 2026-04-29 · Native sui mode — deferred

**Where:** `tooling/devkit/src/plugins/sui/index.ts` (no change). **Decision.** The handoff specced
a `mode: 'native' | 'docker' | 'auto'` option for the sui plugin to spawn `sui start` natively on
Apple Silicon, expected to bring warm `up` from "<5s on Docker" to "<2s on native". After M8a the
warm path on Docker is already **1.92s** for sui-only apps (M5's stack-already-healthy detector +
the digest cache combine to skip both `compose up --wait` and the `publish` round-trip). The
remaining ~1s gap to native is dominated by Node startup + tsx eval, not docker. Adding native mode
would add: a parallel non-compose lifecycle in `up.ts`/`down.ts`/`doctor.ts`, a port-allocator
bypass (host's :9000/:9123 fixed), and a host↔docker network bridge for walrus/seal that have to
dial sui via the `sui-localnet` DNS alias inside `devkit-net`. Cost outweighs the marginal speedup
until a real consumer needs it. **Open.** Multi-plugin warm path is **not** sub-2s —
`pnpm exec devkit up` for private-content is **~12s warm**, dominated by the seal plugin's
non-idempotent `deploy()` (always re-registers a KeyServer object on-chain, then a second
`compose up --wait seal-key-server` pass). A seal-side idempotency check (cache `keyServerObjectId`
alongside the master key, verify on-chain, skip registration on hit) would close most of the gap.
Worth its own friction entry once we have a planned consumer that cares.

---

## M9 — Test infrastructure

**Goal.** A shared `@dev-examples/devkit/vitest` config + `AccountPool` for parallel-safe tests on a
real chain. Replaces the per-app `vitest.config.ts` duplication with a one-line
`defineDevkitVitestConfig()` call. Per-spec testcontainers isolation deferred until a flaky test
surfaces.

### 2026-04-29 · `defineDevkitVitestConfig` + `AccountPool` (M9a/M9b/M9c)

**Where:** `tooling/devkit/src/vitest/index.ts` (new — the config-load entry, fully self-contained),
`tooling/devkit/src/vitest/accountPool.ts` (new — blocking lease/release pool),
`tooling/devkit/src/vitest/runtime.ts` (new — `@dev-examples/devkit/vitest/runtime` subpath for
test-side imports), `tooling/devkit/src/vitest/globalSetup.ts` (new — opt-in via `chain: true`). All
four apps' `vitest.config.ts` collapsed from 7 lines each to 2. **Pain (predicted).** Two friction
points landed during the migration. (1) **Vitest config-loader has no `.js` → `.ts` fallback for
transitive imports inside external packages.** Apps' `vitest.config.ts` imports
`@dev-examples/devkit/vitest` (resolves to `index.ts`); when that re-exported from sibling `.js`
files, plain Node ESM loader ran out of fallbacks and threw `ERR_MODULE_NOT_FOUND`. Playwright
doesn't have this issue (its config loader uses esbuild). Resolution: split the surface — `index.ts`
is fully self-contained (no transitive devkit imports, just `vitest/config`), runtime helpers live
behind the `./vitest/runtime` subpath which Vitest loads through vite-node where `.ts` resolution
works. (2) **Vitest's `ProvidedContext` module augmentation broke under tooling/devkit's tsc setup**
— the augmentation pattern requires vitest's full d.ts surface to be reachable, and our
`peerDependenciesMeta.optional: true` means vitest may or may not be hoisted to a place tsc finds
during typecheck. Dropped the augmentation; consumers add their own
`declare module 'vitest' { ... }` if they want typed `inject('devkit')`. **Behavior diff vs.
deeptrade reference.** The deeptrade `AccountPool.lease()` _throws_ on exhaustion
(`AccountPool exhausted — increase SEED_ACCOUNT_COUNT or release sooner.`). Ours **blocks** instead,
via an internal waiter queue. Reasoning: a parallel test suite that pile up on a too-small pool
should surface as a clear stall (debuggable via the test runner's hook timeout) rather than crashing
an arbitrary subset of tests with a confusing error. Cost: a deadlock if every test leases without
releasing. **Verified.** `pnpm typecheck && pnpm lint` clean across 6 packages. `pnpm -r test` runs
vitest in all four apps (passWithNoTests since no unit tests exist yet); the shared config loads
cleanly. `pnpm test:e2e` for all four apps passes: arena (1 test), private-content (1, seal-flow),
token-studio (2, mint + transfer), wallet (3, send-sui + send-musdc + swap). 7 e2e tests, ~38s
aggregate. **Open.** Per-spec testcontainers isolation (`test.isolation: 'per-spec'` in the schema)
is wired in the schema but not in the runtime — the helper still expects a single
`devkit up`-managed chain shared across the suite. Land it when a flaky test or a planned app needs
it.

---

## M10 — Frontend extraction (narrowed)

**Goal.** Lift the duplicated `devKeysPlugin` from each app's `vite.config.ts` into the devkit. Add
a `vite()` hook to `DevkitPlugin` so future plugins can contribute Vite plugins. Explicitly **not**
lifting UI components, hooks, format helpers, or dapp-kit setup — those are the _content_ of an
example app and stay inline.

### 2026-04-29 · `devKeysPlugin` lift + `vite()` hook (M10a/M10b/M10c)

**Where:** `tooling/devkit/src/vite/plugin.ts` (added `devKeysPlugin` +
`devkitVitePlugins({ plugins?, manifestPath?, keysDir? })` helper),
`tooling/devkit/src/plugin/types.ts` (added `vite?: () => VitePlugin[]` hook on `DevkitPlugin`), all
four apps' `vite.config.ts` (now 18 lines each, was ~65). **Pain (predicted).** Two design points
landed during the migration. (1) **Scope discipline.** The plan-of-record M10 spec called for
hoisting `Card`/`Field`/`useSignAndExecute`/format helpers/`createDevExamplesDAppKit` factory into
`@dev-examples/devkit/{ui,hooks}` subpaths. Reframed to "this project is only for dev tools": apps
are example-tier reference implementations and a developer reading `apps/arena` should see the whole
app inline. The line: dev-keys is _plumbing_ (boring, identical, never inspected) → hoist; UI +
hooks + dapp-kit are _content_ → stay per-app. (2) **The `vite()` hook is speculative.** No in-tree
plugin implements it; the wiring lives in `devkitVitePlugins({ plugins: config.plugins })` for
future consumers. Per the build-first methodology, normally we'd defer adding the hook, but the
surface cost is one optional method on the interface and one `for` loop in the helper — cheap
insurance for the next plugin that wants to surface app-side state. Friction-journal entry will be
added retroactively once a consumer materializes. **Verified.** `pnpm typecheck && pnpm lint` clean
across 6 packages. All four apps' `pnpm test:e2e` green: arena (1 test, 17.5s), private-content (1,
4.4s), token-studio (2, ~3.6s), wallet (3, ~5.9s) — 7 tests aggregate, no regressions. Net app-side
LOC delta: each app's vite.config.ts went from ~65 LOC to 18 → ~190 LOC of pure plumbing duplication
deleted. Devkit gained ~80 LOC of consolidated implementation.

**Resolved** — read for history; do not act on:

- _Phase 1 (entries 1-19)_: `mysten/sui-tools` arm64, glibc 2.38, `--skip-fetch-latest-git-deps`,
  framework auto-add, `sui-tools` no `git`, `Move.toml` rev coupling, JSON-RPC healthcheck, vite
  host binding. Addressed by Milestone A: shared Dockerfile, port allocator, manifest writer, deploy
  library.
- _Phase 3 wallet-app duplications_: Vite/dapp-kit boilerplate, per-app Dockerfile, compose
  duplication, deploy structural overlap, Card/Field UI primitives, useSignAndExecute+invalidate
  pattern, format helpers, Playwright config, e2e shadow-DOM helpers, balance refetch race,
  generated `deployment.ts` shape, wallet-no-Move-package extension point. Addressed by Milestones
  A + B.
- _Milestone C codegen workarounds (`--noPrune`, `// @ts-nocheck`)_: `--noPrune` came off in
  `@mysten/codegen@0.10.1`, `// @ts-nocheck` came off in 0.10.3, output paths flattened in 0.10.4.
  `runCodegen` is plain `sui-ts-codegen generate`; output typechecks strict.
- _Schema-only devkit features without a consumer_: `tokens` (M1 wallet mock USDC/WETH),
  `importedPackages` + `workers` (M2 DeepBook + market-maker), `walrus` + `seal` services (M3
  private-content), shared-object seeding (M4 arena Lobby). Every devkit feature now has at least
  one real consumer.
- _Walrus-deploy non-idempotency on re-up_: M5.1 added a "stack-already-healthy" detector to
  `devkit up`; subsequent ups skip the initial compose pass entirely, so `walrus-deploy`'s Exited(0)
  container is never restarted into its own mutated Move.toml.

**Open — outstanding follow-ups (M5+):**

- ~~_dev-keys Vite plugin still per-app_~~ — resolved in M10 via `devkitVitePlugins()`.
- ~~_Card / Field / shortAddress / labelFor / useSignAndExecute / dapp-kit factory_: 4 copies each
  across apps.~~ — explicitly **kept per-app** as of M10. The four apps are example-tier reference
  implementations: a developer reading `apps/arena` should see the whole app without chasing imports
  into a shared UI/hooks package. This is the inverse of the dev-keys decision: dev-keys is plumbing
  (boring, identical, never inspected), so it gets hoisted; UI/hooks/dapp-kit are the _content_ of
  an example app, so they stay inline.
- _Cold-clone CI + parallel test-infra_: M5.4 lands a basic CI; testcontainers-based per-spec
  isolation is deferred — the existing "fresh chain shared across one e2e file" pattern covers the
  four current apps.

---

## 2026-04-28 · Localnet RPC URL hardcoded in app config

**Where:** apps/token-studio/src/networks.ts:4 **Pain:** Frontend hardcodes `http://127.0.0.1:9000`
(overridable via `VITE_SUI_RPC_URL`). Once devnet allocates ports dynamically, every app will need a
generated manifest the frontend can read at build/dev time. **Hypothesis:** devkit emits
`apps/<app>/devnet/manifest.json` with `{ rpcUrl, faucetUrl, packageIds, accounts, ... }`; Vite
plugin or shared helper exposes it as `import.meta.env.SUI_*` or as a typed import.

## 2026-04-28 · Vite binds to IPv6 localhost; Docker bridge will only see IPv4

**Where:** apps/token-studio/vite.config.ts (server.host default) **Pain:** Vite's default is
`localhost` which resolves to `::1` on macOS — `curl 127.0.0.1:5173` failed. Fine for hand-testing,
but Playwright-in-Docker hitting the dev server (or Docker→host RPC URL on Linux) will need explicit
host binding. Each app will rediscover this. **Hypothesis:** devkit's per-app config supplies the
dev server bind address consistently (`server.host = '0.0.0.0'` for Docker e2e, `'localhost'` for
human dev) so we don't sprinkle the choice across each app.

## 2026-04-28 · `mysten/sui-tools` image is amd64-only — **resolved by writing our own Dockerfile**

**Where:** apps/token-studio/devnet/Dockerfile (replacement) **Pain:**
`docker manifest inspect mysten/sui-tools:mainnet` shows a single-platform amd64 manifest. On Apple
Silicon, Docker silently emulates via Rosetta — `sui start --force-regenesis` took 4+ minutes and
never came up during testing, with zero stdout (the binary defers log emission until after genesis,
so the container looks indistinguishable from broken). The image also ships no `curl`/`wget`/`nc`,
so a Docker healthcheck couldn't even validate the JSON-RPC endpoint. **Resolution:** Wrote a small
multi-arch Dockerfile that downloads the matching `ubuntu-aarch64` / `ubuntu-x86_64` binary from the
official Sui releases. Native: 6 seconds to healthy. **Hypothesis (devkit):** the devkit owns this
Dockerfile and the binary download cache. Per-app, the user only declares the Sui version they want,
not the build mechanics.

## 2026-04-28 · Sui release tarball labelled `ubuntu-aarch64` actually requires Ubuntu 24.04+ (glibc 2.38+)

**Where:** apps/token-studio/devnet/Dockerfile (FROM ubuntu:24.04) **Pain:** First Dockerfile
attempt used `debian:bookworm-slim` (glibc 2.36) — `sui --version` failed with
`version 'GLIBC_2.38' not found`. The release filename suggests "any modern Linux," but the binary
is built on Ubuntu 24.04 specifically. **Hypothesis (devkit):** devkit pins the base image to Ubuntu
24.04 (or whatever Mysten currently builds against) and surfaces the version requirement in one
place rather than rediscovering it per-app.

## 2026-04-28 · `sui move build` writes build/ next to sources, breaks read-only mounts

**Where:** apps/token-studio/devnet/docker-compose.yml (volume mount) **Pain:** Mounted `../move` as
`:ro` to keep host filesystem clean. Build failed with "Read-only file system (os error 30)" —
`--dump-bytecode-as-base64` still writes a `build/` directory adjacent to `sources/` even though we
never asked for the artifacts. No `--out-dir` flag exists. **Hypothesis (devkit):** devkit copies
sources into an ephemeral container path before building (or uses a tmpfs) so host-side Move dirs
stay clean and read-only.

## 2026-04-28 · `--skip-fetch-latest-git-deps` is no longer a valid sui-cli flag

**Where:** apps/token-studio/devnet/deploy.ts:152 (removed) **Pain:** Older deploy script and
tutorials use `--skip-fetch-latest-git-deps`. mainnet-v1.70.2 silently rejects it. Unhelpful:
command-not-found errors for flags suggest stack drift between Sui versions. **Hypothesis
(devkit):** the devkit's internal CLI invocations are version-aware; consumers don't write raw `sui`
commands.

## 2026-04-28 · Sui's "auto-add framework deps" disables itself when any dep is explicit

**Where:** apps/token-studio/move/managed_coin/Move.toml **Pain:** Including `Sui = { git = ... }`
in `[dependencies]` quietly turns OFF the 2024-edition auto-add of all framework deps (Sui,
MoveStdlib, Bridge, DeepBook, SuiSystem). A diagnostic NOTE prints, but it's noise alongside
warnings — easy to miss. Then the explicit dep needs `git` in the container, which our base image
lacks → confusing failure cascade. **Hypothesis (devkit):** the devkit ships Move.toml templates
that lean on the auto-add behavior; explicit framework deps are an opt-in escape hatch with a clear
pointer.

## 2026-04-28 · sui-tools image has no `git`, but `sui move build` runs git for explicit deps

**Where:** apps/token-studio/devnet/Dockerfile (now installs git) **Pain:** Even with the auto-add
behavior, Move can in some cases shell out to `git ls-remote` to resolve framework refs. The base
sui-tools layer historically had it; our hand-rolled Ubuntu 24.04 image initially didn't. Errors
look like `IoError: code: 2 NotFound`. **Hypothesis (devkit):** the dev container ships `git` and
any other CLI Sui's Move tooling expects.

## 2026-04-28 · @mysten/dapp-kit pins its own `@mysten/sui` as a regular dep, breaks app's version

**Where:** package.json (pnpm.overrides) + pnpm-workspace.yaml (catalog) **Pain:**
`@mysten/dapp-kit@0.18.0` declares `@mysten/sui@1.38.0` in `dependencies` (not `peerDependencies`),
so it ships its own copy. App code importing from `@mysten/sui` resolved 1.45.2 (latest matching
catalog `^1.40.0`). Same `Transaction` class but different `#private` brands → "Transaction is not
assignable to Transaction" type errors. Same problem for `@mysten/wallet-standard`. Forced both
versions to dapp-kit's pinned values via `pnpm.overrides`. We lose access to newer SDK features like
`tx.coinWithBalance` until dapp-kit bumps. **Hypothesis (devkit):** pin a single SDK version per
release and ensure dapp-kit's pin matches; surface the override at the catalog level so each app
doesn't rediscover this. Long term: lobby for `@mysten/sui` to be a peer-dep of dapp-kit.

## 2026-04-28 · Wallet-standard feature versions are non-uniform and easy to flip

**Where:** packages/dev-wallet/src/wallet.ts **Pain:** `standard:connect`, `standard:disconnect`,
`standard:events` are all version `'1.0.0'`. But `sui:signPersonalMessage` is `'1.1.0'` while
`sui:signTransaction` and `sui:signAndExecuteTransaction` are `'2.0.0'`. Each is a string-literal
type — flipping any one yields a confusing TS error (and likely a runtime failure where the wallet
appears in the connect modal but signing fails). No single source documents the correct constants.
**Hypothesis (devkit):** ship a `createDevWallet({ keypair, client })` helper in
@dev-examples/dev-wallet that hides feature-version bookkeeping. Tests for the wallet would catch a
future drift in the spec.

## 2026-04-28 · Playwright `selectOption({ label: regex })` is not supported

**Where:** apps/token-studio/e2e/create-coin.spec.ts (`selectAccount` helper) **Pain:**
`selectOption({ label: /bob/i })` throws "options[0].label: expected string, got object". The DOM
`<select>` API isn't regex-aware. Worked around by reading the matching `<option>`'s `value`
attribute first and passing the string. Every test that needs to pick a known account by short-name
reinvents this. **Hypothesis (devkit):** ship `e2e/test-helpers.ts` (eventually
`@dev-examples/test-utils`) with a `selectAccount(select, name)` helper. Cross-cutting Playwright
helpers are first-class deliverables, not per-app utilities.

## 2026-04-28 · ~~gRPC works on localnet but the service path is undocumented~~ (RESOLVED in M7)

**Where:** apps/token-studio/src/dapp-kit.ts (`SuiGrpcClient` baseUrl) **Pain:** Sui's localnet does
serve gRPC alongside JSON-RPC on port 9000 — they're both axum routes on the same HTTP server
(`crates/sui-rpc-api/src/lib.rs`). But `sui start --help` doesn't mention gRPC, and the
obvious-looking probe `curl http://127.0.0.1:9000/sui.rpc.v2beta2.LedgerService/GetServiceInfo`
returns 404. The actual mounted path is `sui.rpc.v2.LedgerService` (no `beta2`). 30+ minutes of
debugging because the version namespace in the proto wasn't in the docs near the `SuiGrpcClient`
example. **Resolution (M7):** the `up` banner prints the gRPC URL alongside JSON-RPC + Faucet
(`tooling/devkit/src/plugins/sui/index.ts:endpoints()`), and `devkit doctor` probes the v2 path at
sub-second timeout (`tooling/devkit/src/plugins/sui/index.ts:doctor()`). See M7 section above for
the full resolution entry.

## 2026-04-28 · @mysten/dapp-kit → @mysten/dapp-kit-react migration: huge surface, valuable docs

**Where:** apps/token-studio (everywhere), packages/dev-wallet **Pain:** Going from
`@mysten/dapp-kit@0.18` to `@mysten/dapp-kit-react@2.0.1` + `@mysten/dapp-kit-core@1.3.0` was a
near-rewrite of the React surface: provider model (`<DAppKitProvider dAppKit={...}>` instead of
nested providers), hooks (`useCurrentClient`, no built-in mutation hooks — use TanStack
`useMutation` with `dAppKit.signAndExecuteTransaction`), no built-in CSS, web-component connect
button, network parameter required on every client, response shape changed
(`result.Transaction ?? result.FailedTransaction`), wallet builder pattern uses
`keypair.signAndExecuteTransaction({ transaction, client })` and reads `effects.bcs` (Uint8Array)
instead of legacy `rawEffects` (number[]). Also the global type registration
(`declare module '@mysten/dapp-kit-react' { interface Register { dAppKit: typeof dAppKit; } }`) is
mandatory for typed hooks. **Hypothesis (devkit):** ship a minimal
`createTokenStudioDAppKit({ rpcUrl, devKeys })` factory in our shared package that pre-bakes the
registry and the typed-hook augmentation. Each new app should write 2–5 lines, not 30+. Also: shared
`useSignAndExecute` mutation wrapper that already calls `invalidateQueries` on success (so each app
doesn't reimplement the pattern).

## 2026-04-28 · Sui v1 → v2 SDK migration drops some legacy method names

**Where:** apps/token-studio/src/lib/coin.ts (listCoins shape),
apps/token-studio/src/components/Balances.tsx (balance shape) **Pain:** v2 core API:

- `client.getCoins({ owner, coinType })` → `client.core.listCoins({ owner, coinType })`, returns
  `{ objects: Coin[] }` instead of `{ data: CoinStruct[] }`. Field is `objectId`/`balance` (string).
- `client.getBalance({ owner, coinType })` → `client.core.getBalance({ ... })`, returns
  `{ balance: { totalBalance, ... } }`. The wrapper used to be the value itself.
- `client.getTotalSupply({ coinType })` (v1) has **no direct equivalent** in core API; have to read
  TreasuryCap object's `total_supply.value` JSON field manually.
- `result.effects?.status.status === 'success'` (v1 JSON-RPC) →
  `result.Transaction ?? result.FailedTransaction` (v2 core API). **Hypothesis (devkit):** thin
  typed helpers like `getTotalSupplyFromTreasury(client, treasuryCapId)` that hide these per-app
  re-derivations.

## 2026-04-28 · ~~Per-app Vite virtual module for dev-keys is duplicated~~ (RESOLVED in M10)

**Where:** apps/token-studio/vite.config.ts (`devKeysPlugin`) **Pain:** Reading `devnet/.keys/*.key`
and exposing them as a virtual module is ~40 lines per app. When we add wallet/private-content/game
apps, each will need this same plumbing. The plugin also has to wire HMR by hand per-app. Trivial to
copy-paste and easy to drift. **Resolution (M10):** `devKeysPlugin` lifted into
`tooling/devkit/src/vite/plugin.ts` and exposed via `devkitVitePlugins()` alongside
`devnetManifestPlugin`. All four apps' `vite.config.ts` collapsed from ~65 LOC each to 18. See M10
section above.

## 2026-04-28 · Move framework `rev` must match docker image tag

**Where:** apps/token-studio/move/managed_coin/Move.toml +
apps/token-studio/devnet/docker-compose.yml **Pain:** `Move.toml` pins `rev = "framework/mainnet"`
and the image is pinned to `mysten/sui-tools:mainnet`. These two strings encode the same coupling
but have to be kept in sync by hand. Bumping one without the other gives obscure "framework version
mismatch" errors at publish time. **Hypothesis:** devkit owns ONE version dial (e.g.
`network: 'mainnet'` or pinned commit SHA) and emits both Move.toml + image tag from it.

## 2026-04-28 · Docker container port mapping shows IPv4 + IPv6, but RPC doesn't respond mid-genesis

**Where:** apps/token-studio/devnet/docker-compose.yml (sui-localnet healthcheck) **Pain:** During
genesis, port 9000 is bound but `curl http://127.0.0.1:9000` returns "Connection reset by peer."
Healthcheck using JSON-RPC works once Sui is fully up, but until then, the only signal "is it
ready?" is a successful JSON-RPC call. There's no `/health` or `/livez` endpoint. Naive readiness
checks (TCP open) will green-light a not-yet-ready node. **Hypothesis:** devkit waits on actual
JSON-RPC success (not TCP open), with exponential backoff + jitter, and surfaces "still warming up,
X attempts in Y seconds" in the CLI so the user knows progress is being made.

---

# Phase 3 (wallet app, second consumer) — duplications surfaced

## 2026-04-28 · Vite `devKeysPlugin` duplicated wholesale across apps

**Where:** apps/wallet/vite.config.ts vs. apps/token-studio/vite.config.ts (~50 LOC each,
near-identical) **Pain:** The plugin that exposes `devnet/.keys/*.key` as the `virtual:dev-keys`
module is the second-consumer-confirmed duplication. Identical resolveId/load/configureServer logic;
only the plugin `name` field and the `keysDir` resolution differ. The HMR watcher wiring is also
identical. A third app would copy the same 50 lines. **Hypothesis (devkit):** ship
`@dev-examples/vite-plugin-devnet` exporting `devnetVitePlugin({ keysDir? })`. Default `keysDir`
resolves relative to the importing config file. One line per app's `vite.config.ts`. Also a
candidate to bundle the dev manifest (rpcUrl, accounts) as `virtual:dev-manifest` so apps don't
import a generated TS file and can avoid the gitignored-vs-generated dance.

## 2026-04-28 · `dapp-kit.ts` boilerplate copied app-to-app

**Where:** apps/wallet/src/dapp-kit.ts vs. apps/token-studio/src/dapp-kit.ts **Pain:**
`createDAppKit({ networks, defaultNetwork, createClient: SuiGrpcClient(...), walletInitializers: createDevWalletInitializer(...) })`
plus the typed-hook augmentation (`declare module '@mysten/dapp-kit-react'`) is the same five-block
recipe in both apps. Only `deployment.rpcUrl` differs, and even that differs only because each app
maintains its own `./generated/deployment.ts`. **Hypothesis (devkit):**
`createDevExamplesDAppKit({ rpcUrl, devKeys, network = 'localnet' })` returning the configured kit +
the augmentation type. App writes 2–3 lines instead of 30+.

## 2026-04-28 · Dockerfile is byte-for-byte duplicated per app

**Where:** apps/wallet/devnet/Dockerfile, apps/token-studio/devnet/Dockerfile **Pain:** Multi-arch
Sui localnet Dockerfile is the second-app's strongest case for extraction — the file is genuinely
identical. Each app builds the same `dev-examples/sui-localnet:devnet-v1.71.0` image (Docker cache
hits on shared layers, but every app still has to maintain the file). **Hypothesis (devkit):**
`tooling/devkit/docker/sui-localnet/Dockerfile` is the single source. Per-app `docker-compose.yml`
references the central image (build context outside the app dir, or pre-built and pushed to a local
registry).

## 2026-04-28 · Per-app `docker-compose.yml` re-encodes the same healthcheck + volumes + env

**Where:** apps/wallet/devnet/docker-compose.yml vs. apps/token-studio/devnet/docker-compose.yml
**Pain:** Compose service definition (image, healthcheck JSON-RPC payload, restart policy, env,
volume mount) is duplicated. Only host-port pair (9000/9123 vs 9100/9223) and container name differ.
Picking a free port pair is manual today — a third app needs to know about both. **Hypothesis
(devkit):** central port allocator emits per-app overrides. App's `devnet.config.ts` declares
`services: ['sui']`; devkit generates a Compose include or per-app docker-compose.override.yml with
allocated ports. `devkit doctor` prints the active port assignments.

## 2026-04-28 · Two Vite ports, picked by hand to avoid collision

**Where:** apps/wallet/vite.config.ts:server.port=5174,
apps/token-studio/vite.config.ts:server.port=5173 **Pain:** Same allocation friction as Sui's RPC
ports — the second app picks the next number. Phase 2's port allocator should cover the dev server,
not just the chain services.

## 2026-04-28 · Deploy script structural overlap is high but the two diverge in shape

**Where:** apps/wallet/devnet/deploy.ts vs. apps/token-studio/devnet/deploy.ts **Pain:**
`waitForRpc`, `loadOrGenerateKeys`, `fundAll`, `faucetRequest`, manifest writer — all
near-identical. The wallet's deploy.ts dropped the Move-build/publish step (no Move package), and
the manifest is a strict subset (no `packageId`, `treasuryCapId`, etc.). Two apps now express
"deploy" with overlapping but divergent code; a third app's needs (Walrus/Seal/DeepBook imports)
will diverge further. There's no shared library for the common pieces. **Hypothesis (devkit):** the
devkit ships a deploy library with composable steps — `bringUpRpc()`, `getOrCreateAccounts()`,
`fundFromFaucet()`, `publishMovePackage()`, `importMovePackage()`, `writeManifest()`. App's
`deploy.ts` becomes a 10-line orchestration: pick steps, pass config.

## 2026-04-28 · `<Card>` UI primitive copy-pasted to second app

**Where:** apps/wallet/src/components/Card.tsx, apps/token-studio/src/components/Card.tsx **Pain:**
A 26-line stylistic primitive — the bordered/rounded/dark-mode-friendly section card — is now
duplicated. Same for the small `<Field>` form-row primitive (label + input wrapper) embedded inside
`SendForm.tsx` and `TransferForm.tsx`. Tiny, but two copies = extract trigger; every new app will
reinvent or copy. **Hypothesis (devkit/ui):** ship a thin `@dev-examples/ui` (or named otherwise)
with `Card`, `Field`, `Button`, `AddressBadge`. NOT a heavy component library — opinionated minimal
primitives sized for example apps. Tailwind classes inline, no theme system.

## 2026-04-28 · TanStack Query `useSignAndExecute` + invalidation pattern duplicated

**Where:** apps/wallet/src/lib/queries.ts vs. apps/token-studio/src/lib/queries.ts **Pain:** Both
apps wrap `dAppKit.signAndExecuteTransaction` in a `useMutation` whose `onSuccess` calls
`invalidateQueries`. The invalidation key (`['balance']` vs predicate-based) differs, but the
surrounding wiring is identical. Every coin-aware app needs this. **Hypothesis (devkit):** export
`useSignAndExecute(options?: { invalidate?: QueryKey[] | 'all' })` from the shared hooks package,
with default invalidation behavior baked in. App opts into specific keys or "all my queries."

## 2026-04-28 · Format helpers (`shortAddress`, `parseSuiAmount` style) duplicated

**Where:** apps/wallet/src/lib/format.ts vs. apps/token-studio/src/lib/coin.ts **Pain:**
`shortAddress(address, head, tail)` and `labelFor(address, accounts)` are byte-identical across
apps. Coin amount parsing (`parseStudioAmount` vs `parseSuiAmount`) is the same algorithm with a
different decimals constant. Three of these and we have a fragmented utility surface across apps.
**Hypothesis (devkit):** expose `shortAddress`, `labelFor`, `formatCoin(raw, decimals)`,
`parseCoinAmount(input, decimals)` from the shared utility package. Coin-specific wrappers stay in
apps; primitives don't.

## 2026-04-28 · Playwright config near-identical across apps

**Where:** apps/wallet/playwright.config.ts vs. apps/token-studio/playwright.config.ts **Pain:**
Only the `baseURL` port and the `webServer.url` differ. `fullyParallel`, `workers`, `forbidOnly`,
`retries`, `reporter`, `trace`, `screenshot`, `projects`,
`webServer.command/reuseExistingServer/timeout` are all identical. **Hypothesis (devkit):** export
`defineDevExamplesPlaywrightConfig({ port })` (or read port from manifest) — one line per app's
`playwright.config.ts`.

## 2026-04-28 · E2E shadow-DOM helpers (`connectAs`, `selectAccount`) duplicated

**Where:** apps/wallet/e2e/send-sui.spec.ts vs. apps/token-studio/e2e/create-coin.spec.ts **Pain:**
The Lit-component-shadow-DOM connect-as-dev-wallet helper and the `selectOption({ label })`
workaround are now in two apps. Every new e2e test will recopy these. **Hypothesis (devkit):** ship
`@dev-examples/test-utils` (or co-locate in the devkit) with `connectAs(page, label)`,
`selectAccount(select, name)`, plus future `waitForBalanceUpdate(page, name, predicate)` once we
figure out the refetch race below.

## 2026-04-28 · Balance UI doesn't reflect on-chain state immediately after `signAndExecuteTransaction` — **resolved by `waitForTransaction` between submit and invalidate**

**Where:** apps/wallet/src/lib/queries.ts (useSignAndExecute), apps/token-studio/src/lib/queries.ts
(same) **Pain:** After alice sends 0.5 SUI to bob, on-chain balances updated correctly (verified via
JSON-RPC), but the displayed balance for alice still read `1000.0000` 10+ seconds later. Cause:
`dAppKit.signAndExecuteTransaction` returns once the node has executed the tx, but the indexer's
commit (which `getBalance` reads) can race the immediate refetch. Token-studio has the same UX issue
— its e2e didn't catch it (only asserted the digest appeared, never asserted the balance changed).
**Resolution:** in `useSignAndExecute`, await `client.waitForTransaction({ digest })` between the
mutation result and the `invalidateQueries` call, so the next refetch is guaranteed to see the new
state. e2e now asserts balances move off their initial values. **Hypothesis (devkit):** the shared
`useSignAndExecute` hook should bake this in by default. Apps should never have to know about the
indexer race.

## 2026-04-28 · `src/generated/deployment.ts` is a per-app convention with divergent shapes

**Where:** apps/wallet/src/generated/deployment.ts vs. apps/token-studio/src/generated/deployment.ts
**Pain:** Same filename, same generator pattern, but the wallet's manifest type omits `packageId`,
`managedCoinType`, `treasuryCapId`, `metadataId`, `upgradeCapId`. App-side code can't write generic
logic against "the deployment" because each app's shape is bespoke. Frontend imports of
`deployment.accounts` work generically; everything else is app-specific. **Hypothesis (devkit):**
typed manifest with `core` (rpcUrl, faucetUrl, accounts) +
`packages: Record<string, PackageDeployment>`. Apps reference `manifest.packages.managedCoin` etc. —
a single shape, additive per app.

## 2026-04-28 · Wallet app needs no Move package yet — but `devnet:up` is wired as if it does

**Where:** apps/wallet/package.json scripts (devnet:down deletes deployment.json/keys),
devnet/deploy.ts shape **Pain:** Wallet v0 has no Move package, so `devnet:up` runs faucet-funding +
manifest-write only. The script structure (deploy.ts as a single file) hardcodes the Move-or-not
decision. A future wallet feature might add an in-app coin package; today's deploy.ts has no
extension point for that. **Hypothesis (devkit):** declarative `devnet.config.ts` lists what each
app needs — `services: ['sui']`, `accounts: ['alice','bob','carol']`, `packages: []`, `imports: []`.
The devkit's deploy harness reads the config and runs only what's declared.

---

# Milestone C — `@mysten/codegen` integration (workarounds in place; upstream fixes pending)

## 2026-04-28 · `@mysten/codegen` prune drops main package when Move.toml `[package].name` ≠ address label

**Where:** `tooling/devkit/src/codegen/run.ts` (uses `--noPrune true` to work around) **Pain:**
Codegen's prune logic identifies the "main" package by string-equality between `Move.toml`'s
`[package].name` (lowercased) and the directory name in `package_summaries/`, which is the address
label. Our `managed_coin` package has `[package].name = "managed_coin"` but the addresses block
defines `token_studio`, so summaries land at `package_summaries/token_studio/managed_coin.json`.
Prune sees `"token_studio" === "managed_coin"` → false and drops our own module's bindings, leaving
only `utils/index.ts`. The relevant code is in `node_modules/@mysten/codegen/dist/index.mjs:51-54`
(the `isMainPackage` closure) and lines 73 + 90 (where prune skips). **Workaround:** invoke
`sui-ts-codegen generate --noPrune true` so all modules emit. Loses tree-shaking of std/sui dep
modules in source; bundlers tree-shake at build time. **Resolved (2026-04-29 on
`@mysten/codegen@0.10.2`):** the `isMainPackage` fix landed in 0.10.1, the `utils/` import path bug
landed in 0.10.2. We dropped `--noPrune true` from `runCodegen`; output is now correctly pruned
(only the user's own modules emit, no std/sui dep modules) and imports resolve.

## 2026-04-28 · `@mysten/codegen` output trips strict TS — empty `arguments` defaults to `{}` even when `package` is required

**Where:** generated `src/generated/sui/move/<pkg>/deps/std/address.ts:18` (and similar for any Move
function with no args) **Pain:** For functions whose Move signature has no arguments, codegen emits
`function fn(options: FnOptions = {}) {...}`. But `FnOptions` always requires `package: string`, so
the `= {}` default is invalid TS. Calling `fn()` without args fails at typecheck. Also a separate
cluster of `noUncheckedIndexedAccess` issues in `utils/index.ts` (e.g.
`const [res] = await getMany(...)` returning `T | undefined` when annotated `Promise<T>`).
**Resolved (2026-04-29 on `@mysten/codegen@0.10.3`):** the FnOptions default, the utils import path,
and the remaining `noUncheckedIndexedAccess` issues in `utils/index.ts` are all fixed. `runCodegen`
no longer post-prepends `// @ts-nocheck` to anything; the wallet app's generated bindings typecheck
strict end-to-end (mock_usdc + mock_weth + std/sui dep modules + utils). All Milestone-C codegen
workarounds are now retired.

---

# M2a — DeepBook v3 import (lessons from MystenLabs/deepbook-sandbox)

## 2026-04-29 · Imported packages with on-chain deps need `--with-unpublished-dependencies`, not `tx.publish()` — **resolved by switching imports to `sui client test-publish`**

**Where:** tooling/devkit/src/deploy/steps/import.ts, tooling/devkit/src/deploy/setup-cli.ts
**Pain:** First attempt at `importedPackages` reused `publishMovePackage` (which builds with
`sui move build --dump-bytecode-as-base64` and submits via programmatic `tx.publish()`). DeepBook
v7.0.0's Move.lock pins its `token` sub-package to testnet/mainnet `published-at` addresses, so the
bytecode produced by build references address `0x36dbef…` which doesn't exist on localnet.
`tx.publish()` failed with "Dependent package not found on-chain". The deepbook-sandbox solves this
by hand-patching `[addresses]` blocks to `[environments]` and rewriting git deps to local paths in
topo order. Sui-cli ≥ 1.71 has a much simpler answer:
`sui client test-publish --build-env <env> --with-unpublished-dependencies` auto-publishes any
unresolved deps as part of the same transaction. **Resolution:** Imported packages now go through a
CLI-based `importMovePackage` that:

1. Clones the repo into `tooling/devkit-state/imports/<owner>__<repo>@<rev>/` (cached across
   deploys).
2. `docker cp`'s the whole cloned tree into the container (not just `subdir`, because sibling
   subdirs may be intra-repo deps).
3. Calls
   `sui client test-publish --build-env <env> --pubfile-path <Pub.env.toml> --with-unpublished-dependencies --json`
   with `RUST_LOG=error` for clean stdout.
4. Parses `objectChanges[]` for the _last_ `published` entry (deps publish first; the user's package
   is last) and applies `capture` substring matches against `objectType`.

A small helper (`setupContainerCli`) imports the publisher key + creates the local env + switches to
it, returning a `restore()` callback to put the active env back. The active env in the container is
sticky, so `sui move build` (used by our in-repo `publishMovePackage`) breaks if we leave it on
`local` — restore unblocks subsequent deploys. **Hypothesis (devkit going forward):** the CLI-based
path is generic across any imported Move package. We should evaluate switching the in-repo
`publishMovePackage` to the same `sui client test-publish` flow once it earns a third consumer;
doing so would let us delete the `--dump-bytecode-as-base64`/`tx.publish()` machinery.

## 2026-04-29 · DeepBook integration is a bundle of 6+ moving parts, every consumer will hand-roll the same setup

**Where:** apps/wallet/devnet.config.ts (importedPackages + movePackages + tokens),
apps/wallet/devnet/seed-pools.ts (post-deploy script), upcoming workers + oracles **Pain:** Standing
up DeepBook v3 against a localnet requires: (1) importing the deepbook package, (2) publishing mock
quote coins (USDC/WETH/etc) with TreasuryCaps, (3) seeding initial coin balances, (4) creating pools
via `pool::create_pool_admin` with the captured `DeepbookAdminCap`, (5) initializing the registry's
BalanceManager map (one-time), (6) running a market-maker worker, (7) wiring Pyth oracles for
non-stub setups. The deepbook-sandbox does all of these and so does the wallet app now. A second
wallet consumer (or a third app that uses DeepBook for AMM-style trading) would re-derive each of
these with cosmetic variations. **Hypothesis (devkit, after 2 consumers):** ship a
`@dev-examples/devkit/presets/deepbook` (or similar) that the user opts into declaratively:

```ts
import { deepbookPreset } from '@dev-examples/devkit/presets/deepbook';

defineDevnetConfig({
  ...deepbookPreset({
    rev: 'v7.0.0',
    coins: [{ name: 'mock_usdc', decimals: 6, faucet: 25_000n }, ...],
    pools: [{ base: 'sui', quote: 'mock_usdc', tickSize: 1_000n, ... }, ...],
    marketMaker: { enabled: true, deposits: { sui: 1_000n, mock_usdc: 25_000n } },
    oracles: 'pyth-stub' | 'real-pyth' | 'none',
  }),
});
```

The preset expands into `movePackages` + `importedPackages` + `tokens` + `workers` + a post-deploy
seed step. Captures of pool / registry / admin-cap object IDs go into a typed manifest namespace
`manifest.deepbook.{registryId, adminCapId, pools}`. **Build first.** Wallet app is consumer #1
(in-progress); revisit when a second app declares it needs DeepBook.

## 2026-04-29 · DeepBook `place_limit_order` aborts EOrderInvalidPrice when price isn't a tick_size multiple

**Where:** apps/wallet/devnet/seed-orders.ts (initial price grid) **Pain:** Posted SUI/mUSDC
bids/asks at mid ± `step=3500n` (~0.1% of mid=3,500,000), but the pool's tick_size is 1000.
`price % tick_size` must be 0 or `order_info::validate_inputs` aborts with code 0
(EOrderInvalidPrice). Aborts surface as `MoveAbort(... function_name: Some("validate_inputs"))` in
the tx error — the error doesn't surface the constant name, so you need to grep the source. Same
trap for `quantity % lot_size != 0`. **Resolution:** make all step/quantity values exact multiples
of the pool's tick_size / lot_size. Annotated in seed-orders.ts. **Hypothesis (devkit + future
deepbook preset):** the preset should expose typed helpers for "tick(n)" and "lot(n)" that return
raw u64 amounts, computed from the pool's spec, so users can't accidentally produce off-tick prices.
Same pattern for any DEX-style adapter we eventually ship.

---

# M0 cleanup — issues surfaced while resuming

## 2026-04-28 · Generated TS manifest in tracked tree dirties git on every `devnet:up` — **resolved by Vite virtual module**

**Where:** apps/{token-studio,wallet}/src/generated/manifest.ts (was committed + overwritten);
tooling/devkit/src/manifest/write.ts **Pain:** Devkit emitted the manifest as both a JSON sidecar
(gitignored at `devnet/.manifest.json`) AND a typed TS file under `src/generated/manifest.ts`
(committed in placeholder shape). Every contributor's first `devnet:up` overwrote the placeholder
with live values, leaving git dirty. The typed shape was duplicated across the placeholder and the
runtime emit. No clean revert path without `git restore`. **Resolution:** Devkit's `writeManifest`
now only writes the JSON sidecar. A new Vite plugin `@dev-examples/devkit/vite` exposes the JSON as
`virtual:dev-manifest`, with a typed empty fallback before first bring-up. The committed
`src/generated/manifest.ts` shim is just
`export { manifest, type Manifest } from 'virtual:dev-manifest'`. Each app's `vite-env.d.ts` carries
the ambient module declaration (inlined to avoid pulling devkit's TS source through app typecheck).
**Hypothesis (devkit):** generated artifacts the frontend consumes belong in virtual modules +
ambient declarations, not committed TS files. Same pattern should cover any future generated content
(codegen Move bindings already live under a fully-gitignored `src/generated/sui/`, which is the more
orthodox shape — manifest now matches).

## 2026-04-28 · Type re-export from `@dev-examples/devkit` walks the whole package source under tsc

**Where:** apps/wallet/src/generated/manifest.ts (initial attempt re-exported `Manifest` from
`@dev-examples/devkit`) **Pain:** Wallet's `tsconfig.app.json` doesn't include `@types/node`;
devkit's source uses `node:fs`, `node:path`, `process`, etc. A single
`import type { Manifest } from '@dev-examples/devkit'` made tsc walk devkit's entry, which
transitively pulls every value-export source file (codegen, deploy, ports, services), tripping ~25
unrelated errors. `skipLibCheck: true` doesn't help because devkit's `types` field points at `.ts`,
not `.d.ts`. **Workaround:** Define the manifest TypeScript shape inline in each app's
`src/vite-env.d.ts` ambient module declaration; no cross-package type import. **Hypothesis
(devkit):** publish a small `@dev-examples/devkit/vite-client` ambient `.d.ts` that apps
`/// <reference />`, OR build a dist `.d.ts` for devkit and point `types` there. Either way, apps
shouldn't pay full tsc cost to consume devkit's type surface.

---

# M3.2 — Seal Open-mode bring-up

## 2026-04-29 · seal Move package's `Move.toml` has no `[environments]` block; rejects `--build-env local`

**Where:** tooling/devkit/src/deploy/steps/import.ts (now patches `Move.toml` in-container before
`test-publish`); MystenLabs/seal/move/seal/Move.toml has only `[package] name = "seal"`, with envs
derived from a sibling `Published.toml` listing only testnet+mainnet **Pain:**
`sui client test-publish --build-env local` aborts: _Package `seal` does not declare a `local`
environment. The available environments are ["testnet", "mainnet"]_. The seal package author never
anticipated a localnet consumer, so devkit's standard import flow breaks on it. Same pattern will
hit any third-party Move package whose authors only ship testnet/mainnet metadata. **Resolution:**
`importMovePackage` now appends `[environments]\nlocal = "0000"` (chain-id placeholder is
informational only) to the cloned package's `Move.toml` if no `[environments]` block exists.
In-container patch — host-side checkout stays clean. Verified: seal publishes cleanly; deepbook
(already had `[environments]`) is untouched. **Hypothesis (devkit + upstream):** generic and useful
— leave in. Optional follow-up: substitute the live chain-id pulled from `sui_getChainIdentifier`
instead of "0000", in case Sui ever starts validating that field.

## 2026-04-29 · Seal's official Dockerfile only builds `key-server`; we need `seal-cli` too for `genkey`

**Where:** tooling/devkit/src/docker/seal/Dockerfile (devkit-owned multi-stage),
tooling/devkit/src/services/seal-build.ts (uses `--file` to override the upstream Dockerfile while
keeping the cloned seal repo as build context) **Pain:** Open-mode bootstrap requires generating a
BLS12-381 master keypair and submitting
`seal::key_server::create_and_transfer_v2_independent_server` with the public key. The cleanest
source of a compatible keypair is `seal-cli genkey` (matches fastcrypto's encoding exactly — no risk
of compressed-G2 byte-order drift between fastcrypto-rs and `@noble/curves`). Upstream's Dockerfile
builds only the key-server binary; their `seal-cli` ships separately and isn't on a multi-arch path.
**Resolution:** ship our own multi-stage Dockerfile under
`tooling/devkit/src/docker/seal/Dockerfile`. Build context is the cloned upstream repo;
`cargo build --bin key-server --bin seal-cli`. Image is `dev-examples/seal:<rev[:12]>`, multi-arch
via `--platform linux/<host arch>` (arm64-native on M-series — same model as walrus).
`docker run --rm --entrypoint seal-cli <image> genkey` is invoked from the bootstrap step.
**Hypothesis (upstream):** ship a multi-arch combined image with both binaries — easier consumer
story for any localnet-style demo. Devkit-side, the `--entrypoint` override pattern is reusable for
any sidecar tool we want from a service image.

## 2026-04-29 · Seal `/v1/service` rejects requests without `service_id` query param

**Where:** tooling/devkit/src/services/seal.ts (healthcheck) **Pain:** Initial healthcheck used
`GET /v1/service` (no query) thinking it was a static service-info route. The handler at
`crates/key-server/src/server.rs:1010` requires `?service_id=<ObjectID>` and returns 400
InvalidServiceId without it. Container kept logging "INFO Request id: ..." (request received) yet
`--wait` deemed it unhealthy. **Resolution:** `?service_id=${sealConfig.keyServerObjectId}` —
round-trips through the on-chain registration cache. Returns 200 with a proof-of-possession once the
key-server has loaded the KeyServer object, which is exactly the readiness signal we want.
**Hypothesis:** the `/v1/service` endpoint name suggests "describe this service" but really means
"describe the registered KeyServer with this id". A `/v1/health` endpoint upstream would simplify
this, but routing through `/v1/service` is fine since we always know the object id at compose-render
time.

## 2026-04-29 · `sui-ts-codegen` exits 0 on failure when `[addresses]` block missing

**Where:** tooling/devkit/src/codegen/run.ts (now sanity-checks output dir presence after CLI exit);
apps/private-content/move/vault/Move.toml (now declares `[addresses] vault = "0x0"`) **Pain:** First
`pnpm devnet:up` for private-content's `vault` package logged `✓ Wrote src/generated/sui` and exited
0, but `apps/private-content/src/generated/sui/` didn't exist. Manually invoking
`sui-ts-codegen generate ./move/vault` reveals it logs
`Command failed, Error: Could not identify main package directory ... expected exactly one [addresses] label in Move.toml to match a summary subdirectory`
to stdout, then exits 0. The wrapper has no way to detect failure short of inspecting stdout
strings. **Resolution (devkit-side):** `runCodegen` now asserts the output dir exists after the CLI
returns 0 — silent fails throw a useful error pointing at the most likely cause (missing
`[addresses]` block). Vault's Move.toml gained `[addresses] vault = "0x0"` to match the
auto-generated summary subdir name. **Hypothesis (upstream):** sui-ts-codegen should propagate the
inner error to its CLI exit code. File against `@mysten/codegen` so 0.10.4 sets a non-zero exit when
prerequisites are unmet.

## 2026-04-29 · Walrus-deploy is non-idempotent across `devnet:up` re-runs (multi-stage compose triggers re-execution) — **resolved by stack-already-healthy detector (M5.1)**

**Where:** tooling/devkit/src/cli/commands/up.ts;
MystenLabs/walrus/docker/local-testbed/files/deploy-walrus.sh **Pain:** M3.2 introduced two
compose-up passes: stage 1 brings up sui+walrus, stage 2 (after the seal bootstrap step) brings up
seal-key-server. On a _fresh_ `devnet:up`, walrus-deploy runs once successfully → Exited(0), then
everything else comes up. But on a _re-run_ of `devnet:up` (without `down --purge`), walrus-deploy
is in Exited(0) state and compose's `up -d --wait` interprets that as "needs to start" — it restarts
walrus-deploy, which then fails because the deploy script mutates `Move.toml` to record published
addresses on first run, so the second run trips "package was already published, modules must all
have 0x0 as their addresses". **Resolution (M5.1):** `up()` now probes `docker inspect <app>-sui`
for `State.Health.Status == "healthy"`. If the stack is already healthy, the initial
`compose up -d --wait` is skipped entirely — walrus-deploy stays in Exited(0), undisturbed.
Stage-2's `compose up seal-key-server` targets only the seal service, so it doesn't recreate
walrus-deploy either. Re-up now works without `down --purge`. Verified via private-content
`pnpm devnet:up` re-run and a follow-up e2e pass on the running stack. **Hypothesis (upstream
walrus, follow-up):** the upstream `deploy-walrus.sh` could detect "already deployed" and exit 0
cleanly — that would let `devkit reset` + `devkit up` work too, not just consecutive `devkit up`.
File against `MystenLabs/walrus`.

---

# M4 — arena (Connect Four)

## 2026-04-29 · `SuiGrpcClient` lacks `queryTransactionBlocks` / `queryEvents`

**Where:** apps/arena/src/lib/queries.ts (instantiates a parallel `SuiJsonRpcClient` for the lookup)
**Pain:** To resolve the spawned `Game` id from the consumed `Lobby` (after `join_lobby` deletes the
Lobby), the frontend needs `queryTransactionBlocks({ filter: { InputObject: lobbyId } })` to find
the join tx and read its `objectChanges`. The dapp-kit `createClient` sets one transport — gRPC for
our apps — but `SuiGrpcClient` only implements the methods proto v2 ships (`getObject`,
`listOwnedObjects`, `listCoins`, `getTransaction`...). Tx-history and event queries aren't on it.
**Workaround:** instantiate a side-channel `SuiJsonRpcClient` next to the gRPC client, both pointed
at the same RPC URL. Two HTTP clients per app for one missing method. **Hypothesis (devkit):** ship
`createDevExamplesDAppKit({ rpcUrl })` that returns both clients (gRPC for everything dapp-kit
consumes, JSON-RPC for the gap-filler queries) and exposes them as paired hooks — apps shouldn't
pick. **Hypothesis (upstream Sui):** add `queryTransactionBlocks` / `queryEvents` to gRPC's
`StateService` so a single client can drive every UI we'd plausibly write.

## 2026-04-29 · localnet's tx index doesn't classify deletions as "changes"

**Where:** apps/arena/src/lib/queries.ts:`useSpawnedGame` (uses `InputObject` filter);
apps/arena/e2e/connect-four.spec.ts (same fix in the test path) **Pain:** First attempt at the
spawned-Game lookup used `filter: { ChangedObject: lobbyId }`. On localnet (sui v1.71.0), once the
lobby is consumed, only the _creation_ tx matches `ChangedObject` — the `join_lobby` tx that deleted
the lobby is invisible to the filter. `AffectedObject` would be the right fit but isn't supported on
localnet (returns "Feature is not supported"). `InputObject` _does_ match: any tx that took the
lobby as an input shows up, deletion or not. **Hypothesis (upstream Sui):** either index deletions
under `ChangedObject` to match the docstring ("created, mutated and unwrapped objects") or enable
`AffectedObject` on localnet. Until then, `InputObject` is the safe default for "what tx touched
this object" on a localnet.

---

# v2 migration (P0–P12, 2026-04-29 → 2026-04-30)

The v1 → v2 rewrite condensed all of M1–M11's pain into a declarative reconciler. The full
Discoveries log lives in [`archive/v2-migration.md`](./archive/v2-migration.md); this section
captures only the items that closed pain in this journal and the items left as deferred TODOs.

## Closed by v2

- **M5.1 walrus-deploy `Exited(0)` on re-up** — the v2 reconciler treats `exited(0)` as healthy via
  `getStatus`, so the second-pass compose no-op problem disappears. Re-running `devnet:up` against a
  healthy stack is the supported flow, not a workaround.
- **§10.1 KeyServer re-registered every up (~12s)** — `seal.register` now defines `getStatus` that
  probes the cached `keyServerObjectId` on-chain. Warm seal-only cycles dropped 7.15s → 1.30s.
- **The "compose render is one big function" architectural smell from M6** — replaced by
  individually-addressable actions. Adding a plugin is one file under `src/plugins/<name>/`, no
  edits to runtime/.
- **M9 copy-pasted `globalSetup.ts` across packages** — solved by the `@dev-examples/devkit/vitest`
  subpath export's `defineDevkitVitestConfig({ chain: true })`.

## Closed post-P12 (commit `f5e9845` + cleanup pass)

- **Sui plugin's docker subnet hardcode.** Added a `before?: string[]` field to `ActionBase` (a
  reverse-direction `needs`) and a new `walrus.network` Build action that pins 10.0.0.0/24 ahead of
  `sui.localnet`. Sui's `ensureNetwork` call dropped its subnet argument, so docker auto-picks.
  Verified: arena + token-studio coexist on 172.19.0.0/16 + 172.20.0.0/16 simultaneously.
- **Reconciler failure isolation now transitive.** `Reconciler.cycle` derives "is blocked" from the
  `statuses` map (`s === 'failed' || s === 'queued'`) instead of a parallel `failedNames` set; one
  upstream failure produces one queued chain instead of cascaded `registry.require()` self-failures.
- **§7.3 doc drift.** Rewrote to describe `getStatus` as the primary skip predicate and the
  input-hash gate as a fallback, matching the P7 implementation and §9.1.

## Phase notes (one paragraph each)

- **P0–P2** built the registry + reconciler + supervisor in isolation (`__scratch__/smoke.ts`). Two
  design changes stuck during this slice: `consumeDirty` on the registry (stops Emit double-firing)
  and `onShutdown` on `ActionRunContext` (lets supervisor LIFO-clean in-process children).
- **P3** added the one-shot deploy path with `cliSigner` / `envSigner` helpers. Filters Service +
  (default) Seed actions for live networks.
- **P4** ported the sui plugin. Surfaced the cold-cycle `getStatus` gap (deferred at P4, fixed at
  P7).
- **P5** hot-swapped `src-v2` → `src` and ported arena. The `bin` field in
  `tooling/devkit/package.json` was dropped because pnpm shims invoke `node`, not `tsx` — apps now
  invoke `tsx ../../tooling/devkit/src/cli/up.ts ./devnet.config.ts --once`.
- **P6** ported walrus. Surfaced the per-app subnet pin (still deferred), the
  `inspectContainer --format` template fragility (fixed: switched to `--format '{{json .State}}'`),
  and the WAL coin type lives in the treasury object's package, not in System's generic.
- **P7** ported seal. Closed the §10.1 KeyServer-re-registration pain. Required two reconciler fixes
  that landed in this phase: `getStatus` runs on cold cycles (was the P4 deferred), and the
  supervisor hydrates the prior manifest on startup (mirrors `runOneShot`).
- **P8** ported token-studio + wallet. Surfaced the `sui client test-publish` signing bug —
  `importMovePackage` now takes a required publisher and `sui keytool import`s it before signing.
  Failure isolation only checks direct deps surfaced here (still deferred).
- **P9** ported private-content. No new architectural surprises — the full sui+walrus+seal+vault
  graph reconciled cold in 76s, warm in 2.3s.
- **P10** added codegen as an Emit plugin. Surfaced the sui CLI 1.71 rejecting `--build-env local`
  issue; `helpers/move-package.ts` now passes `--build-env testnet` explicitly. Diff vs v1 generated
  outputs: byte-identical for all 4 apps.
- **P11** added `devkit console` REPL. Two non-blocking notes preserved here for posterity: Node
  REPL needs `terminal: true` for top-level `await` assignments to persist, and Sui's `getBalance`
  rejects coin types whose package address has a literal leading zero (`0x09b7…`) while `getCoins`
  accepts both forms — likely upstream SDK quirk worth filing.

## 2026-04-30 · Per-app stacks (named environments)

**Where:** `tooling/devkit/src/runtime/active-stack.ts` (new),
`tooling/devkit/src/runtime/migrate-legacy.ts` (new), `tooling/devkit/src/cli/stack.ts` (new), plus
stack-aware updates to manifest writer/reader, sui/walrus/seal plugins, vite plugin, vitest
globalSetup, console, and all four apps' configs/scripts/specs.

**Pain.** Each app had exactly one implicit dev environment — one container set, one manifest at
`devnet/manifests/localnet.json`, one `.keys/` dir. To try out a clean state for an experiment, the
only options were "blow away docker volumes and republish everything" (slow + lossy of the working
main env) or "copy the whole devnet/ dir somewhere safe first" (manual, error-prone). E2e tests
pointed at the same manifest as `pnpm dev`, so a test failure could leave the dev environment in a
half-seeded state.

**Resolution.** Introduced per-app named **stacks**. Each stack maps to a self-contained set of
docker resources (`<app>-<stack>-sui`, `<app>-<stack>-net`, `<app>-<stack>-sui-{data,bin}` volumes,
`<app>-<stack>-walrus-*`, `<app>-<stack>-seal-key-server`) and host-side state at
`<appDir>/devnet/stacks/<stack>/{manifest.json,.keys/,.generated/}`. Pointer file
`<appDir>/devnet/active` records which stack is current; resolution order is `--stack` flag →
`DEVKIT_STACK` env → pointer file → `'main'`. New `devkit stack {list,new,use,down,drop}` CLI
manages the lifecycle. E2e tests default to a reserved `'test'` stack so they never trample `main`.

**Resumability surprise.** First implementation `docker rm`-ed containers on stack switch — turned
out the sui plugin's `--force-regenesis` flag also wipes the chain on container _recreation_, so
switching back to `main` created a brand-new genesis and republished everything. Fix took two bites:
(a) stack-switch now `docker stop`s rather than removing, preserving the container alongside its
volume, and (b) the sui Dockerfile's entrypoint now bootstraps a _persistent_ genesis via
`sui genesis -f --with-faucet` once per volume and resumes via `sui start` (no `--force-regenesis`)
on every subsequent boot. Image tag bumped `-r2` → `-r4`; the plugin's run path also detects
image-tag mismatches and recreates only when the upgrade demands it. After the fix, switching `main`
→ `scratch` → `main` and re-running `devnet:up` keeps `main`'s packageId byte-identical (verified
end-to-end).

**Hypothesis.** This is the first abstraction the devkit grew specifically because the user asked,
ahead of evidence in the journal — i.e. it predates Phase 2 extraction discipline. Worth watching:
if the second/third stack rarely gets used in practice we over-engineered; if it becomes the default
workflow, this entry is the evidence other dev-tool ergonomics decisions can lean on.

**Out of scope (for follow-ups).** Chain-state snapshots (volume export/import); copy-on-switch
branching; workspace-wide stacks that span multiple apps; moving stack state out of the working tree
(e.g. into `~/.devkit/<app>/<stack>/`).

## 2026-04-30 · `tooling/devkit-state/` removed; Docker is the cache

**Where:** deleted `tooling/devkit-state/`. New `tooling/devkit/src/helpers/upstream-source.ts`
(content-addressed source images). Refactored `tooling/devkit/src/helpers/imported-package.ts`,
`tooling/devkit/src/plugins/walrus/build.ts` (+ new `walrus/Dockerfile`),
`tooling/devkit/src/plugins/seal/build.ts` (+ updated `seal/Dockerfile`). Added
`devkit.{app,stack,kind,cache,rev}` labels to every container/image the devkit creates
(`tooling/devkit/src/plugins/sui/docker.ts`'s `runContainer` + `buildImage` accept `labels?`
records).

**Pain.** `tooling/devkit-state/` was a workspace-level cache for git clones of upstream repos
(deepbook for `wallet`, walrus, seal) and an audit-only `ports.json`. Its existence depended on a
`../../../../devkit-state` relative-path resolution from the devkit src tree — only works when
devkit lives inside `tooling/`. Two concrete problems: (1) blocks shipping the devkit as a
standalone npm package, since there's no `tooling/` in a consumer project; (2) two sources of truth
for cache state (host filesystem clones + Docker volumes/images) means no single command nukes
everything for an app, and `git clean -fdx` vs `docker volume prune` give different outcomes.

**Resolution.** Walrus/seal images now build via BuildKit's git build-context
(`docker build https://github.com/.../walrus.git#<rev>` for the upstream image,
`--build-context walrus-src=<git-url>#<rev>` for a thin wrapper that bakes our
`deploy-walrus.sh`/`run-walrus.sh` scripts in via `COPY --from=walrus-src`). The walrus runtime no
longer mounts host scripts at all; they ship inside the image at `/opt/walrus/scripts/`. Seal's Move
package similarly rides inside the seal image at `/opt/seal/move-package/` and is extracted to a tmp
dir at publish time via `docker create + docker cp`. `importMovePackage` (the deepbook flow in
wallet) now goes through `dev-examples/upstream-source:<repo-slug>-<short-rev>` — a
content-addressed image whose `/src` is the git checkout — instead of cloning to host. Stack CLI
filters by `devkit.app`/`devkit.stack` labels rather than name prefix.

**What we kept on host.** Per-stack `manifest.json` and `.keys/` under
`<appDir>/devnet/stacks/<stack>/`, plus `<appDir>/devnet/active`. These are tiny generated
projections that Vite/codegen/test consume as plain files at build time. Going fully docker-resident
here would slow Vite HMR and add `docker exec` to the dev hot path for no real benefit — host
projection of small generated artifacts is not the same kind of cache as a 100MB git clone.

**Hypothesis.** This is the model we'll ship. Follow-ups that get easier afterward:
snapshot-an-image-as-a-fixture, export-a-stack-to-another-machine (volume tar.gz),
`devkit cache prune --label devkit.cache=*`. None of these were asked for, but the labels
infrastructure is the foundation if/when they are.
