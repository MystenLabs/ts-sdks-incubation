# Dynamic ports + wallet-server Register split + setup ergonomics polish

Follow-up plan to the state-and-snapshots work. Three friction items
surfaced during e2e verification and are now in
`packages/devstack/notes/friction.md`; this plan turns them into a
sequence of small, contained PRs and pins the open design questions
about app-level setup along the way.

## Context

What's already shipped (state-and-snapshots-plan.md, all on
`integrate-devstack`):
- Container-layer + host-fs state model (no named volumes)
- `devstack snapshot save/restore/list/rm/hash --push`
- `containerService.snapshot` plugin contract via labels
- App-level `setup:` ergonomic field with `publishMove()` + `runTransaction()`
- Playwright `AccountPool` fixture
- GHA workflow recipe

What didn't work end-to-end on token-studio:
1. **Port collision**: `main` and `test` stacks both want `rpcPort: 9059`.
   Can't run them concurrently. Hardcoded ports in every example app's
   config are the root cause; CLAUDE.md anti-pattern explicitly calls
   this out but the allocator doesn't exist.
2. **Wallet-server cold-first-run race**: PR 1's `applyTestSetupFilter`
   skips HostProcess in globalSetup. So globalSetup writes the manifest
   without a wallet-server entry. `pnpm dev`'s supervisor then races
   the browser's `virtual:devstack-manifest` import. On cold first-run,
   the bundle's `createDevstackAdapterFromManifest` returns undefined,
   no Dev Wallet appears, `connectAs` fails. Subsequent runs work
   because manifest hydration preserves the prior entry.

What worked but has rough edges:
3. **`runTransaction` marker-file idempotence** — the marker is keyed
   only by action name. If a developer changes the build callback, the
   marker stays stale and the new code doesn't re-run. Confusing.

## Design question: setup hook timing + helpers vs raw actions

Before scoping the PRs, the design question raised in the
state-and-snapshots verification: do plugins/services need lifecycle
hooks that fire at different times? Do we keep predefined helpers like
`publishMove()`/`runTransaction()`, or expose only generic hooks that
run arbitrary code against the running services?

### "Setup hooks at different lifecycle stages" — not needed

A natural API would be something like:

```ts
{
  setup: {
    afterStackUp: async (ctx) => { /* run after every Service is healthy */ },
    afterPublish: { 'my-package': async (ctx, pkg) => { /* ... */ } },
    test: { afterStackUp: async (ctx) => { /* test-stack-only */ } },
  },
}
```

Tempting because each hook reads cleanly. But this would be a **second
lifecycle-coordination system** running alongside the existing action
graph. Concretely, hooks would have to:
- Choose when in the cycle to fire (a parallel topo decision)
- Re-run on every reconcile cycle (no built-in idempotence)
- Either re-run on snapshot restore (wasteful — restore already brings
  the post-setup state back) or NOT re-run (then they're not really
  "hooks", they're one-shot actions)

The action graph already does all of this:
- `needs: ['sui.accounts']` → "after sui's accounts are funded"
- `needs: ['my-package']` → "after the publish action completed"
- `needs: ['walrus.proxy']` → "after walrus storage is reachable"
- `getStatus` provides per-step idempotence; snapshot restore makes the
  whole graph short-circuit
- Topo + skip predicates already coordinate "fire when ready"

A separate hooks API would either duplicate this or sit awkwardly
beside it. **Recommendation: don't add lifecycle hooks. Setup actions
ARE the lifecycle.**

What we should improve: make the common patterns easier to express in
the action-graph idiom (see PR 12 below).

### Predefined helpers vs raw seed/register/publish

I shipped `publishMove()` + `runTransaction()` in PR 5. These are sugar
over `definePublishAction()` and `seed()` — same primitives the
framework's own plugins use. Users can also drop into the raw
factories from `setup:` directly.

The case for keeping them:
- Two helpers cover ~90% of app-level setup (publish a package; sign a
  transaction). Beyond that, raw `seed()` / `definePublishAction()` /
  `register()` are escape hatches.
- Each helper bakes in a sensible idempotence default
  (`runTransaction` marker file; `publishMove` source-digest-aware
  on-chain probe via `definePublishAction`).
- The factories carry minimal type/option surface — no risk of growing
  unbounded.

The case against:
- Indirection (look-up cost: "what does `runTransaction` actually do?").
- Yet-another-API to learn alongside `seed` / `definePublishAction`.
- Every helper is a place where the abstraction can leak.

**Recommendation: keep the two existing helpers, freeze the helper
surface there, and document the escape hatches.** Don't grow a helper
catalog. Instead, document the pattern: "if a helper doesn't fit your
case, drop into `seed()` / `definePublishAction()` / `register()` and
write the action yourself; both forms are first-class in `setup:`."

The one remaining ergonomic gap (PR 12 below): `runTransaction`'s
marker file is keyed by action name only. Fix: include an inputs hash
so changes to the build callback's signature/inputs invalidate the
marker.

## Phased rollout (three PRs)

```
PR 8   Port allocator: dynamic per-stack port resolution                ~400 lines
PR 9   Wallet-server: split into Register + HostProcess                 ~120 lines
PR 10  setup: polish — runTransaction input-hash marker + docs          ~80 lines
```

PR 8 is the largest because it touches every plugin's port option. PRs
9 and 10 are contained. Land in any order — PR 9 unblocks the e2e
flake immediately; PR 8 unblocks parallel test/dev stacks; PR 10 is
quality-of-life.

---

## PR 8 — Port allocator

**Goal**: every plugin port becomes dynamically allocated per-stack on
first `devstack up`, persisted in a sidecar file, and surfaced via the
manifest. No app needs to hand-pick port numbers; `main` and `test`
stacks coexist freely. Backwards-compatible: pinned ports still work
(opt-out for ports that need to be stable, e.g., a frontend dev URL
the user bookmarks).

### Mechanism

A new module, `packages/devstack/src/runtime/port-allocator.ts`:

```ts
export interface PortRequest {
	/** Plugin-namespaced slot name (e.g. 'sui.rpc', 'walrus.node-0',
	 *  'frontend.vite'). The allocator returns a stable port for this
	 *  slot for the lifetime of the stack. */
	slot: string;
	/** Preferred port (e.g. legacy hardcoded value). Used if free; else
	 *  the allocator picks any free port. */
	preferred?: number;
	/** Number of contiguous ports needed. Default 1. Walrus's storage
	 *  nodes use this (4 contiguous on `nodeHostPortBase`). */
	count?: number;
}

export interface PortAllocator {
	/** Resolve a slot to one or more concrete ports. Idempotent —
	 *  returns the same port(s) for the same slot across calls. */
	allocate(req: PortRequest): Promise<number[]>;
	/** Persist the current allocation to disk. Called by the supervisor
	 *  at end of cycle; writes alongside the manifest. */
	persist(): Promise<void>;
}

export function createPortAllocator(opts: {
	appDir: string;
	stack: string;
}): PortAllocator;
```

Allocations live at `<stackDir>/ports.json`:

```json
{
  "sui.rpc": 9059,
  "sui.faucet": 9984,
  "walrus.node": [19185, 19186, 19187, 19188],
  "wallet-server.http": 9422,
  "frontend.vite": 5173
}
```

This file is part of the host snapshot capture (rides along with
`<stackDir>/manifest.json`). Restore brings back the same port
assignments — important so a snapshot taken on stack `test-shard-3`
restores to the same slots and the manifest's URLs stay valid.

### Allocation algorithm

On `allocate(req)`:
1. If `<stackDir>/ports.json` already has `req.slot`, return it. (Idempotent.)
2. If `req.preferred` is set and not already allocated to another slot,
   try to bind to it. If free, claim it. Else fall back to step 3.
3. Bind to `:0` (kernel chooses), read back the resolved port via
   `getsockname`, close the socket, claim it.
4. Persist the new allocation.

For `req.count > 1`: bind `count` sequential ports starting from a
candidate (preferred + i, or kernel-chosen). If any in the range is
busy, retry from another candidate.

### Plugin migration

Each plugin's port options become **hints** rather than absolutes:

**Before** (`plugins/sui/index.ts`):
```ts
const rpcPort = opts.rpcPort ?? 9000;
const faucetPort = opts.faucetPort ?? 9123;
```

**After**:
```ts
const [rpcPort] = await ctx.ports.allocate({ slot: 'sui.rpc', preferred: opts.rpcPort });
const [faucetPort] = await ctx.ports.allocate({ slot: 'sui.faucet', preferred: opts.faucetPort });
```

The `ctx.ports` is added to `LocalnetActionRunContext`. Plugins call
`allocate` inside their `run` (and inside `getStatus` if they need the
port for a probe — the second call is idempotent).

### Walrus's contiguous range

```ts
const nodePorts = await ctx.ports.allocate({
	slot: 'walrus.node',
	count: NODE_COUNT,
	preferred: opts.nodeHostPortBase,
});
const nodeHostPort = (idx: number) => nodePorts[idx];
```

### Manifest exposure

Per-port allocation goes into `manifest.registry.services` (already the
case for sui-rpc / wallet-server / etc.). The manifest already carries
URLs, so consumers don't need to read `ports.json` directly — they
read manifest. `ports.json` is just the canonical store.

### Files (PR 8)

- **NEW** `packages/devstack/src/runtime/port-allocator.ts` — allocator
- **NEW** `packages/devstack/src/runtime/port-allocator.test.ts` — unit tests (binding to :0, conflict resolution, persistence)
- **MODIFY** `packages/devstack/src/core/types.ts` — add `ports: PortAllocator` to `LocalnetActionRunContext`
- **MODIFY** `packages/devstack/src/runtime/supervisor.ts` — instantiate allocator; pass via ctx; persist on cycle end
- **MODIFY** `packages/devstack/src/runtime/one-shot.ts` — same plumbing for apply/deploy paths
- **MODIFY** `packages/devstack/src/plugins/sui/index.ts` — migrate `rpcPort`/`faucetPort` to allocator with `preferred`
- **MODIFY** `packages/devstack/src/plugins/walrus/index.ts` — migrate `nodeHostPortBase` to `count: 4` allocation
- **MODIFY** `packages/devstack/src/plugins/seal/index.ts` — migrate `port`
- **MODIFY** `packages/devstack/src/plugins/wallet-server/index.ts` — migrate `port`
- **MODIFY** `packages/devstack/src/plugins/frontend/index.ts` — migrate `port`
- **MODIFY** `packages/devstack/src/runtime/snapshot.ts` — include `ports.json` in host capture (already covered by `<stackDir>` recursive copy; verify)

### Verification (PR 8)

1. `cd examples/token-studio && pnpm devstack up --stack main` — port file exists; sui RPC reachable at the resolved port; manifest URL matches.
2. `pnpm devstack up --stack test` (concurrent) — different ports allocated; both stacks healthy.
3. `pnpm devstack stack drop test --force --yes` — `ports.json` for `test` deleted along with the stack dir.
4. Snapshot save/restore round-trip preserves port assignments — restore brings back the same `ports.json`.
5. App that pins `rpcPort: 9000` — allocator honors the hint when free.

### Risks

- **Port-bind race**: between `:0` resolve and the actual `docker run`, another process could grab the port. Allocator should validate on first use and re-allocate on collision (rare).
- **Backwards compat**: existing apps with hardcoded ports keep working via `preferred`. But the manifest format changes (port numbers no longer match the config's `rpcPort`). Apps that read ports straight from config instead of manifest break — none in tree do this.
- **Test framework expectations**: Playwright config currently passes a fixed `port: 5173`. With dynamic allocation, the port becomes whatever the allocator picks. The `defineDevstackPlaywrightConfig` helper's `port` option becomes a hint; the test runner should resolve from the manifest at globalSetup time. Update `defineConfig.ts` to read `manifest.registry.services.find(s => s.name === 'frontend')?.url` instead of relying on the option.

---

## PR 9 — Wallet-server: Register + HostProcess split

**Goal**: fix the cold-first-run manifest race documented in
`notes/friction.md`. The wallet-server's URL+token entry must land in
the manifest deterministically during `apply` mode, regardless of
whether the actual listener has started.

### Mechanism

Split `walletServer()` plugin into two actions:

1. **`wallet-server.register`** (Register action; runs in apply path)
   - Resolves the bind URL via the port allocator (PR 8). If PR 8 not
     yet shipped, uses `opts.port ?? 9420`.
   - Reads or mints the bearer token. If `<stackDir>/wallet-token`
     exists, reuses that. Else generates one and persists it.
   - Registers `wallet-server` in `ctx.registry.services` with the
     deterministic URL + token.
   - **Does not start the server.** Pure metadata work.

2. **`wallet-server.serve`** (HostProcess action; runs only in
   long-running supervisor / `pnpm dev`)
   - Reads URL + token from `ctx.registry.services.require('wallet-server')`
     (registered by step 1) — they're guaranteed to be there.
   - Spawns the Node `http.Server` on the registered URL with the
     registered token.
   - Registers shutdown hook to close the server.

### Why this fixes the race

- Playwright globalSetup uses `applyTestSetupFilter` (PR 1) which runs
  Register but skips HostProcess.
- After globalSetup: manifest contains `wallet-server` entry with the
  deterministic URL + token. The actual server isn't running yet, but
  the FRONTEND BUNDLE doesn't care about that — it only reads the URL+
  token from the manifest at request time.
- `pnpm dev` then starts. Its supervisor runs HostProcess too. The
  serve action reads the same URL+token from the registry (already
  populated by Register; survived through manifest hydration), spawns
  the server.
- Any browser navigation between globalSetup completion and serve
  startup gets a `Connected as` UI but a brief connection refused on
  the actual API call — Playwright retries naturally.

### Files (PR 9)

- **MODIFY** `packages/devstack/src/plugins/wallet-server/index.ts`
  - Split into two actions inside the same `definePlugin({ actions })` callback.
  - `register()` action: deterministic URL+token, registers in registry.
  - `hostProcess()` action: reads from registry, spawns server.
  - Shared closure state for `activeServer` (still per-plugin-instance).
- **MODIFY** `packages/devstack/src/plugins/wallet-server/server.ts`
  - Accept the token as a parameter instead of generating it; the
    Register action owns generation.

### Verification (PR 9)

1. Cold-first-run e2e (the failure I hit during state-and-snapshots
   verification): `cd examples/token-studio && rm -rf .devstack && pnpm test:e2e`. globalSetup completes; manifest has wallet-server
   entry; tests start; `connectAs(page, 'alice')` succeeds.
2. Concurrent `devstack watch` + `pnpm test:e2e`: token from prior
   `devstack watch` is honored; webServer's supervisor adopts the
   running listener instead of double-binding.
3. Snapshot restore preserves the wallet-token (already in
   `<stackDir>/wallet-token`); next apply registers the same URL+token.

### Risks

- **Token-rotation discipline**: today, the in-process `activeToken`
  cache lets a re-bring-up reuse the same token without disk read. With
  the split, the Register action reads from disk on every apply cycle.
  Negligible cost (one fs.readFileSync), but documented.
- **Plugin-instance separation**: two actions sharing module-level
  closure state. Already the pattern in `walletServer()` today. Both
  actions live in the same `walletServer()` factory call, so the
  closure is per-invocation as before.

---

## PR 10 — `runTransaction` input-hash marker + setup docs

**Goal**: close the marker-file footgun where changing a setup
transaction's build callback doesn't invalidate the marker. Also
document the setup design philosophy clearly so app authors know when
to use helpers vs raw `seed()` / `definePublishAction()`.

### Mechanism

`runTransaction` today writes a marker at
`<stackDir>/setup/<actionName>.done`. Change the action's build
callback → marker stays → action skips → user is confused.

Fix: marker content includes an inputs hash. Default `getStatus`
checks both presence AND hash match.

```ts
// runTransaction
const inputs = {
	signer: opts.signer,
	build: opts.build.toString(), // function source as a hash input
	scope: opts.scope ?? 'always',
	needs: opts.needs ?? [],
};
const expectedMarker = stableHash(inputs);

getStatus: opts.getStatus ?? (async (ctx) => {
	const path = markerPath(ctx, opts.name);
	if (!existsSync(path)) return { ok: false, detail: 'marker absent' };
	const observed = readFileSync(path, 'utf8').trim();
	if (observed !== expectedMarker) return { ok: false, detail: 'inputs changed since marker' };
	return { ok: true, detail: 'marker matches' };
});

run: async (ctx) => {
	// ... existing tx execution ...
	writeMarker(ctx, opts.name, expectedMarker);
};
```

### Hashing the build callback

`opts.build.toString()` returns the function source as a string. Same
function source → same hash. Function changes → different hash → marker
mismatch → re-run. Edge cases:
- Closure-captured variables don't show up in `toString()` (e.g., a
  hashed constant defined outside the callback). User who wants those
  to invalidate must lift them into the inputs by referencing them in
  the closure body — the function source captures the reference.
- Whitespace changes: source serialization is whitespace-sensitive, so
  a re-format triggers re-run. Acceptable trade-off; any "false re-run"
  is just a one-time recovery.

### Setup docs

Add a section to `packages/devstack/CLAUDE.md` (anti-patterns) and
`packages/devstack/notes/state-and-snapshots-plan.md` (architectural
notes) reaffirming:

1. **Setup is the action graph.** No parallel hook system. App authors
   express ordering via `needs`, idempotence via `getStatus`. Plugins
   that want lifecycle injection define their own actions with the
   right `needs`.
2. **Helpers are sugar, not the only path.** `publishMove` and
   `runTransaction` cover the common cases. Anything outside →
   `seed()` / `definePublishAction()` / `register()` directly in
   `setup:`.
3. **Helpers won't grow.** Two helpers is enough; we won't ship a
   third without a friction journal entry showing repeated need.

### Files (PR 10)

- **MODIFY** `packages/devstack/src/actions/transaction.ts` — input-hash
  marker; expose `markerPath` and `writeMarker` for tests.
- **NEW/MODIFY** `packages/devstack/src/actions/transaction.test.ts` —
  add tests for marker invalidation on build-callback change.
- **MODIFY** `packages/devstack/CLAUDE.md` — anti-pattern note about
  parallel lifecycle hook systems.
- **MODIFY** `packages/devstack/notes/state-and-snapshots-plan.md` —
  append a "Setup design rationale" section anchoring the action-graph-
  is-the-lifecycle decision.

### Verification (PR 10)

1. `setup: [runTransaction({ name: 'mint', signer: 'alice', build: (ctx, tx) => tx.moveCall(...) })]` →
   first run mints + writes marker.
2. Edit the `build` callback (e.g., change the amount) → next `apply`
   detects mismatch, re-runs, updates marker.
3. Snapshot save → restore → apply: marker survives in `<stackDir>`,
   matches, action skips. ✓ (already works today.)

---

## Open questions / tradeoffs

### Should port allocator persist in the manifest instead of a sidecar?

Argument for sidecar (`ports.json`): the allocator runs early in the
cycle (action's `run` calls it), well before manifest write. A sidecar
is the simplest write-path. Manifest is the read-path for consumers.

Argument for manifest-only: one less file to reason about; everything
in the manifest. But then the allocator has to mutate the manifest
mid-cycle (today's manifest is written atomically at end of cycle).

**Recommendation: sidecar.** Keep manifest write atomic, allocator
file gets persisted on every `allocate` call.

### Should the allocator support port ranges per stack?

Some users might want `test` stacks to use 19000-19999 and `main` to
use 9000-9999 for ergonomic reasons. The allocator could accept a
`range: [low, high]` option per stack.

**Recommendation: defer.** Default behavior (kernel-chosen ports) is
fine for now. Add the option if a friction entry surfaces.

### Should `runTransaction` support an explicit `idempotent: false`?

If a user knows their transaction is intentionally non-idempotent
(e.g., "mint a fresh blob every time this runs"), the marker file is
wrong. Today's escape: provide a custom `getStatus` that always
returns `ok: false`.

**Recommendation: keep the escape hatch as the only path.** A boolean
opt-out is one more API surface that adds little. Document the
custom-`getStatus` pattern in CLAUDE.md.

### Considered and rejected: named auto-checkpoints during `up`

Sketched a `checkpoint('name')` action factory that would auto-`docker
commit` at declared graph positions, with a `resumeFrom(name)`
Playwright fixture for tests. Two reasons it doesn't fit:

1. The primary win (per-test resume to different states) requires
   per-test container churn (`docker rm` + `docker run` from the
   checkpoint image) — directly contradicts the "shared containers
   across tests" hard constraint that drove the state-and-snapshots
   design.
2. The remaining use cases are already covered: `devstack apply
   --actions <name>` runs only up to a named action, then `devstack
   snapshot save <alias>` captures it. Naming convenience doesn't
   justify a parallel orchestrator path.

Re-evaluate if a friction journal entry surfaces a real "I needed to
save state mid-setup" case — current journal has zero such entries.

### Should we ship `runTransaction` with retry logic for the faucet flake?

The faucet 500 we hit during verification is a real CLAUDE.md anti-
pattern ("don't use flat polling"). The fix lives in `plugins/sui/keys.ts`'s
`ensureFunded`, not in `runTransaction`. Out of scope for this plan.

**Add to friction journal.** Already implicitly there ("faucet 500 on
fresh chain") — make it explicit.

---

## End-to-end verification

After all three PRs:

1. **Port collision gone**: `pnpm devstack up --stack main` and
   `pnpm devstack up --stack test` run concurrently with no port-bind
   errors. `<stackDir>/ports.json` exists for each.
2. **Cold-first-run e2e works**: fresh checkout + `pnpm test:e2e` on
   token-studio passes. Dev wallet UI connects on first attempt.
3. **runTransaction invalidates on edit**: change a `build` callback,
   `devstack apply` re-runs the transaction without manual `stack drop`.
4. **Snapshot story unchanged**: cold seed → snapshot save → drop →
   restore → apply still works in <15s. Port assignments and marker
   files survive the round-trip.
5. **Hardcoded port hints honored**: app that pins `rpcPort: 9000`
   gets 9000 when free; falls back to allocator when not.

## Friction journal additions

Append to `packages/devstack/notes/friction.md` after PR 9:
- Faucet-flake-on-cold-genesis (the ensureFunded retry gap surfaced
  during verification).
- (PR 8 closes the dynamic-port entry.)
- (PR 9 closes the wallet-server-manifest-race entry.)

---

## Architectural notes carried forward

From the state-and-snapshots plan, all still hold:

- State lives in container layer OR `<stackDir>/<plugin>/`. **Ports
  follow this rule too** — `<stackDir>/ports.json` is host state,
  rides along with snapshot capture.
- `getStatus` checks content, not metadata.
- Setup is the action graph. No parallel hook system.
- Helpers are sugar; `seed`/`definePublishAction`/`register` are
  first-class in `setup:`.
- Image tag is the seam where local-build, release-pull, snapshot-tag,
  and pre-seeded-image converge.
