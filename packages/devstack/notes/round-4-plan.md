# Round 4 — devstack pre-release cleanup

This file is the working plan for shipping devstack as `0.1.0`. It
captures the findings from the architecture review (40+ Opus sub-agents
covering examples, plugins, runtime, adapters, docs, and hands-on
testing), the changes we've shipped against those findings, and the
backlog we still owe.

## Operating principle

Devstack is unreleased. There are no prior consumers, no compatibility
surface, no deprecation cycle to honor. Every change is in place: rename
a function, drop a field, restructure an API — directly. No aliases, no
shims, no migration story.

The bar is "scaffold-eth-2 for Sui." Build quality matters; cute matters.
The friction journal at `notes/friction.md` continues to accumulate
paper-cuts; this plan turns the high-leverage ones into landed code.

---

## What the review found

The review came back overwhelmingly positive on the architecture — the
action graph + reconciler + plugin model + per-stack snapshots + concurrent
named stacks are genuinely best-in-class for the chain-dev space. The
gaps were concentrated and specific:

### Real bugs (12 of them)

- **`devstack apply` reliably hangs `sui.accounts` for 2 min when the
  localnet has stuck-tx state.** Two combining bugs in
  `plugins/sui/keys.ts`: `ensureAddressBalance` over-deposits unbounded
  because gas burn lands AB just-under target; the deposit tx uses
  `tx.gas` which forces SDK coin-mode gas that races on stale
  `listCoins` snapshots.
- **`devstack console`'s `packages.<name>` REPL feature is broken on
  every fresh app.** Loader looked for `<root>/<pkg>/<pkg>.ts` but
  codegen emits `<root>/<pkg>/<module>.ts`. Plus `await import('./game.ts')`
  fails on `.js` import specifiers in `.ts` codegen output.
- **`getStatus` throws are mistreated as permanent failures** — should
  be transient (`{ok: false}` so `run` gets a chance).
- **Corrupt manifest crashes the REPL with raw `SyntaxError`** instead
  of an actionable "run `devstack reset`".
- **Wallet-server binds to `0.0.0.0` with `Access-Control-Allow-Origin:
  *`.** LAN-reachable signing endpoint with bearer tokens that leak via
  manifests baked into the dev bundle.
- **`SnapshotMeta.capture/restore` callbacks are advertised but never
  invoked** — dead public API.
- **No supervisor lockfile.** Two concurrent `devstack up` against the
  same stack fight over container names + manifest writes.
- **`apply --json` STDERR contract was undelivered.**
- **`apply --help` lies about Service skip.**
- **`up --help` doesn't document `--once`** but every example's
  `package.json` `localnet:up` script uses it.
- **`console --help` and `stack --help` ignore `--help`** and run the
  action with confusing errors instead.
- **`create-devstack-app` is structurally broken end-to-end** —
  `template/package.json` ships unresolved `workspace:*` and `catalog:`
  specifiers, so `pnpm create @mysten-incubation/devstack-app my-app`
  outside this monorepo fails on `pnpm install`.

### API/abstraction simplifications

The review found ~15 places where the API was wider than necessary or
the contract was unclear:

- **`getStatus` was overloaded.** It served three different purposes
  (liveness probes, idempotence checks, invariant probes) but the
  reconciler treated all three the same. Setup actions (Publish, Seed,
  etc.) routinely shipped 30-line `getStatus` methods that just verified
  what the input-hash already encoded — except when state didn't carry
  across processes, they had to.
- **Action factory proliferation.** 8 action types, three publish
  factories (`publish`, `definePublishAction`, `publishMove`), `job()`
  byte-identical to `service()`, `:after` capability suffix with zero
  callers. Every example's `accounts: { alice: {}, bob: {} }` was
  awkward boilerplate.
- **Boilerplate per example.** Byte-identical `dapp-kit.ts` across 4
  apps. 78-line `seedTokens` action in wallet that's mostly mechanical.
  Hand-written `deployment.ts` projection per app re-typing
  `manifest.registry` from `unknown[]`.
- **Registry contract leaked.** `tokens` was a "core kind" but used by
  only some apps. `isDirty/flushDirty/consumeDirty` were public on the
  `Registry` interface despite being reconciler-internal. `ns<T>(name).x`
  required a heavy double-generic at every call site.

### Distribution

- **Nothing is published.** `create-devstack-app` is broken; npm names
  are not yet claimed.
- **README claims drift.** "Warm cycle 1-3s" doesn't hold (verified:
  9.4s on best run, 2:00 on second run pre-bug-fix). "76s on Apple
  Silicon" contradicts the docs site's "10 minutes". The docs link in
  the README points at a non-existent GitHub anchor.

### Missing UI features (vs. scaffold-eth-2)

- No Debug Packages page (auto-rendered UI for browsing every deployed
  Move function).
- No Block Explorer panel (recent txs, object lookup).
- Curated component library is `Card` + `Field` only; scaffold-eth-2
  ships a dozen.
- `loadFixture`-equivalent missing for chain-state test isolation; tests
  rely on `mode: 'serial'` to avoid leaks.

---

## Changes shipped

These reflect the work landed in this branch. Each entry briefly states
what changed and why; the diff is the source of truth.

### Foundation: PR 0 — getStatus is now liveness-only

- `getStatus` is required only for `Service`, `HostProcess`, and
  `Verify` actions. For setup actions (Build, Publish, Register, Seed,
  Emit), it is optional and only consulted when defined.
- Setup actions skip on input-hash match alone. The reconciler's
  `state` map persists into `Manifest.actionStates` at end of cycle and
  hydrates back on supervisor / one-shot startup.
- `publish()`'s `inputs` now bake in a `sourceDigest` (computed at
  action-construction time over the on-host Move source dir) so a Move
  source edit busts the hash even when no other input changed.
- Arena's `openLobby` seed converted to a `verify()` invariant — that's
  what it semantically was.
- New `runtime/state-hydration.test.ts` (8 tests) pins the
  cross-process skip behavior.

This deletes the default `getStatus` from `publish.ts`,
`actions/transaction.ts`, and `plugins/imports/index.ts`. It is the
load-bearing prerequisite for everything else in Phase B.

### Phase A: correctness + security (12 PRs, all done)

| PR | What changed |
|---|---|
| A1 | `ensureAddressBalance` now uses a 1-SUI tolerance band so post-fee AB doesn't trigger unbounded re-deposits. Submission has a 30s `Promise.race` timeout with an actionable "try `devstack reset --yes`" message. `sui.accounts` `getStatus` is now a true read-only probe (no chain mutation). New `keys.test.ts` (13 tests). |
| A2 | `console` codegen loader walks each package's directory and merges per-module exports. Codegen emits `.ts` import specifiers (not `.js`) so Node 24's native type-stripping resolves the in-tree imports without a custom loader. `allowImportingTsExtensions: true` in the shared tsconfig. New `console.test.ts` (10 tests). |
| A3 | `getStatus` throws now produce `{ok: false}` instead of a permanent action failure — transient probe failures don't block dependents. |
| A4 | Corrupt-manifest reads now throw with "manifest at `<path>` is corrupt — run `devstack reset` to regenerate" instead of a raw `SyntaxError`. |
| A5 | Wallet-server defaults to `127.0.0.1` bind (no LAN exposure). CORS is an explicit allowlist seeded with the dev-server origin from the manifest; `'*'` is rejected with a clear error. `startWalletServer` is now async (awaits the listening event). |
| A6 | `--help` early-exit in `console` and `stack` subcommands with full USAGE strings. |
| A7 | Deleted unused `SnapshotMeta.capture/restore` callbacks — the host-fs + container-layer model covers every plugin. |
| A8 | Supervisor PID lockfile under `<stackDir>/supervisor.pid` (O_EXCL acquisition + `process.kill(pid, 0)` liveness check). `stack use` consults it before switching. Atomic active-stack pointer write. New `supervisor-lock.test.ts` (13 tests). |
| A9 | `--once` documented in `up --help`. |
| A10 | `apply --json` streams per-action transitions (`[<action>] running` / `healthy` / `failed — <error>`) to stderr via the reconciler's progress callback. |
| A11 | `apply --help` "Skips: Service" wording fixed to reflect actual behavior. |
| A12 | New `authoring/plugin-authoring.mdx` walks through building a hypothetical `walrusBridge()` plugin end-to-end (action types, `getStatus` principles, cross-plugin ordering, `runsAs`, registry, snapshot meta, helper surfacing, testing). `define-plugin.mdx` cross-links to it. Subsumes F8. |

### Phase B: API consolidations (11 PRs, 8 done + 1 deferred + 1 dropped)

| PR | What changed |
|---|---|
| B2 | Action-type collapse: deleted `actions/job.ts` (byte-identical to `service`); deleted the bare `publish()` factory; renamed `definePublishAction` → `publish`; added `scope?: SetupActionScope` to `seed()` so callers don't need post-construction mutation. |
| B3 | New `defineRegistryKind<T>('plugin.kindname')` factory in `@mysten-incubation/devstack` — pin the kind type at module top-level, no double-generic. Hidden `isDirty/flushDirty/consumeDirty` from the public `Registry` interface (only the reconciler reaches them, via `RegistryImpl` cast). Arena example uses `defineRegistryKind` for its shared-objects kind. |
| B4 | `accounts` config accepts a string-array shorthand (`accounts: ['publisher', 'alice']`) in addition to the per-network map. Dropped the `Signer | AccountFactory | AccountNetworkSpec` union; `AccountSpec` is now a clean per-network record. The `isSignerLike` duck-typing footgun is gone. |
| B7 | _Deferred._ Deepbook's `poolNeeds` would auto-derive from `@reg/<name>` references in pool specs, but token registration happens at run time inside `onPublished` hooks — there's no clean way to map references to registering actions at expansion time without a fragile convention. Manual `poolNeeds` continues to work; recorded as a friction-journal item. |
| B8 | Deleted the `:after` capability suffix from the topo sorter — zero production callers, simplifies the mental model to "providers run before consumers via `:before`". Throws actionable error if encountered. |
| B9 | Merged `@mysten-incubation/devstack-app-setup` into `@mysten-incubation/devstack/app-setup` subpath. `createWalletApp`'s `exposeForPlaywright` defaults to true under DEV (Vite dev server) and false in production. HMR cleanup hook drops the stale `__devstackDAppKit__` global on module re-evaluation. The 5 examples + create-devstack-app template now import from the subpath; the standalone package was deleted. |
| B11 | New `mintCoinDistribution()` setup helper. Wallet's 78-line `seedTokens` action collapses to ~6 lines: `mintCoinDistribution({ name, distributions: [{ package, module, distribution }] })`. Idempotence comes from input-hash skip; `treasuryCapId` is read from the package's `captured` map by convention. |
| B5 | Extracted `sui.accounts` action into its own `accounts()` plugin under `plugins/accounts/`. Sui plugin shrunk to `build` + `localnet`; the accounts plugin reads sui-rpc + sui-faucet URLs from the registry (not from sui's closure scope). All 5 examples + scaffolder template explicitly include `accounts()` in their plugin list. `'sui.accounts'` → `'accounts.fund'` everywhere. |
| B1 | `SerializedRegistry` schema bumped to use `Token`/`Package`/`Account`/`Service` instead of `unknown[]` — `Manifest` is now exported from `@mysten-incubation/devstack`. Codegen's `Emit` action gained a second output: `<appDir>/src/generated/manifest.ts`, a re-projection of the registry snapshot with a `: Manifest` annotation. `dependsOnKind` widened to all four core kinds; `getStatus` content-hash-checks the typed manifest on every cycle so any registry change regenerates. The 4 examples deleted their hand-written `src/generated/deployment.ts` files; per-app projections moved to `src/lib/deployment.ts` (each example's lib version casts plugin namespaces inline since those stay `unknown` on the manifest schema). 5 new tests cover the typed-manifest branch. |
| B6 | _Pending._ Demote `tokens` from `Registry` core kinds to a plugin namespace. `Token` lives in a `coin()` plugin (or extras module). Walrus, wallet, and token-studio update. |
| B10 | _Dropped._ A separate UI-component package is out of scope for a devstack tool. The existing minimal `react/ui/{Card,Field}` continues to ship from `@mysten-incubation/devstack` for example use; no new components, no extraction. |

---

## What's left (in priority order)

### Finish Phase B (1 PR)

1. **B6 — demote `tokens` from core.** Cosmetic-ish. The registry
   contract is more honest after, but no functional behavior changes.

### Phase C — distribution (3 PRs, all pending)

- **C1** — sync-template version rewriting in `create-devstack-app`.
  Without this the scaffolder is broken end-to-end.
- **C2** — publish to npm at `0.1.0`. Gated on B-phase finishing so
  shapes are stable.
- **C3** — README accuracy pass.

### Phase D — Debug Packages UI (3 PRs, all pending)

The single biggest "scaffold-eth-2 for Sui" gap. The agent's
recommendation, which I endorse: **if we build ONE UI feature in the
next 90 days, build this.** It's the conversion moment for new users
— clicking `mint(amount, recipient)` from a UI within 60 seconds of
`pnpm dev` is the entire pitch.

- **D1** — persist `sui move summary` JSON in
  `registry.packages[].summary` (the data already produced inside
  codegen, currently discarded after the per-package builder pass).
- **D2** — Lit panel in `devstack-wallet-panels` rendering forms
  dispatched on Move type kind.
- **D3** — Block Explorer panel (polling-based, ~580 LOC).

### Phase E — test isolation (2 PRs, all pending)

- **E1** — `loadFixture()` over `runtime/snapshot.ts` plumbing.
  Drops `test.describe.configure({ mode: 'serial' })` from the example
  e2e suites.
- **E2** — per-action manual triggers in supervisor TUI.

### Phase F — per-plugin polish (8 PRs, 1 done, parallelizable)

| | Highlights |
|---|---|
| F1 sui | drop `sui-grpc` redundant entry; add `image`/`volumes`/`logLevel`/`genesis` opts; pre-flight Docker check |
| F2 walrus | `appendLog` for build progress; `nodeCount`/`suiVersion` opts; `verify()` actions for node liveness |
| F3 seal | fix README option name; document master-key persistence; drop dead `publicKey` field; add `localnetSealOptions(manifest)` |
| F4 codegen | deletion cleanup on package drop; `Promise.all` parallelization |
| F5 imports | delete dead `withRecursiveDeps`; warn on rev-conflicts |
| F6 deepbook | drop dead public exports |
| F7 wallet-server | delete empty `src/wallet-panels/` stub; account hot-reload |
| F8 frontend | _Done — covered by A12's `plugin-authoring.mdx`._ |

### Phase G — monorepo / governance (8 PRs, rolling)

| | Highlights |
|---|---|
| G1 | catalog drift cleanup |
| G2 | CI Node version harmonization (Node 24 across all workflows) |
| G3 | e2e CI matrix expansion to all 4 examples |
| G4 | top-level governance — `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, root `LICENSE` |
| G5 | move `packages/docs` → `apps/docs` (per AGENTS.md convention) |
| G6 | add `typecheck` task to `turbo.json` |
| G7 | promote CLAUDE.md content into user-facing `concepts/setup.mdx` |
| G8 | delete scratch artifacts (`examples/myapp-smoke/` from review) |

---

## Friction-journal items (capture-only, no PRs)

The review surfaced observations that don't justify a dedicated PR but
should land in `notes/friction.md` so future-us has breadcrumbs:

- inotify watch-cap on Linux >8192 files — file-watcher silently
  fails on large monorepos.
- snapshot bundle non-atomicity (`host/` copy + `snapshot.json` write
  are individually atomic but not jointly).
- cross-host snapshot port collisions on `--push`.
- live-net seed snapshot (`--fork-url` style for forking real-network
  state into localnet).
- plugin source-hash in snapshot id — currently `inputs` is the
  contract; if a plugin author changes implementation without bumping
  `inputs`, stale snapshots restore.
- HostProcess pause/resume during snapshot quiesce.
- multi-instance plugin support (`imports() ×2`) — same-name plugins
  collide on action expansion.
- token bearer leaks via manifest baked into bundle — long-term think
  about per-session tokens.
- B7: token registration happens at run time inside `onPublished`
  hooks; deepbook's `poolNeeds` can't be auto-derived without a
  fragile convention.

---

## Done criteria for `0.1.0`

1. `pnpm create @mysten-incubation/devstack-app smoke && cd smoke && pnpm
   dev` works on a fresh clone outside the monorepo, no manual edits.
2. All 12 review-surfaced bugs have regression tests.
3. Three sequential `apply` runs healthy on arena (proves PR A1 + A3 +
   PR 0 hydration).
4. `devstack console`'s `packages.<name>` works after a fresh apply.
5. README claims verified by hands-on (warm cycle ≤3s with state
   hydration).
6. All 4 examples build + e2e pass in expanded CI matrix.
7. Friction journal contains the capture-only items above.

The Debug Packages UI (Phase D) is the biggest remaining
differentiator vs. scaffold-eth-2 but isn't strictly required for
`0.1.0` — defer to `0.2.0` if Phases A–C take longer than expected.

---

## Status snapshot

- **20 PRs landed** (PR 0, A1–A12, B1, B2, B3, B4, B5, B8, B9, B11)
- **1 PR deferred** (B7, with rationale)
- **1 PR dropped** (B10 — UI components out of scope)
- **24 PRs pending** across B–G (F8 subsumed by A12; B10 dropped):
  - Phase B: B6 (demote tokens)
  - Phase C: C1–C3 (publish to npm)
  - Phase D: D1–D3 (Debug Packages UI)
  - Phase E: E1–E2 (loadFixture, manual triggers)
  - Phase F: F1–F7 (per-plugin polish; F8 done as part of A12)
  - Phase G: G1–G8 (monorepo hygiene)

394 tests passing in `packages/devstack`; all 5 examples typecheck
clean against the new shapes.
