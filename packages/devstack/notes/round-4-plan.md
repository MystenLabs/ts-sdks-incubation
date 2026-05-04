# Round 4 — devstack prototype cleanup

This file is the working plan for the round-4 cleanup pass on devstack.
It captures the findings from the architecture review (40+ Opus
sub-agents covering examples, plugins, runtime, adapters, docs, and
hands-on testing), the changes we've shipped against those findings,
and the backlog we still owe.

This is **not** a release plan. Devstack is a prototype, not published
to npm, with no near-term plan to publish. The goal of round 4 is to
get the surface right — bugs fixed, ergonomics tight, contracts
honest — so that whenever a future release happens, we're starting
from a clean shape rather than ratifying scars.

## Operating principle

Devstack is unreleased. **There are no consumers outside this monorepo,
no compatibility surface, no deprecation cycle.** Every change is in
place: rename a function, drop a field, restructure an API — directly.
No aliases, no shims, no migration story, no `@deprecated` markers.
This is the only phase where the cost of getting an API right is just
code edits; once a release ships, redesigns turn into deprecations and
we live with the wart for the project's lifetime. Spend the
prototype-phase optionality.

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

### Phase B: API consolidations (11 PRs, 9 done + 1 deferred + 1 dropped)

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
| B6 | `tokens` demoted from `Registry` core to the `coin.tokens` plugin namespace. New `coinTokens = defineRegistryKind<Token>('coin.tokens')` exported from `@mysten-incubation/devstack`. The `Registry` interface and `RegistryImpl` shrunk to three core kinds (packages, accounts, services). `SerializedRegistry` schema bumped (drops `tokens: Token[]`); apps that need fungible coins read via `manifest.registry.coin?.tokens`. Walrus + deepbook coin-spec migrated; wallet + token-studio configs migrated; wallet's `lib/deployment.ts` casts the new namespace; `devstack-wallet-panels` reads from the new path. Existing manifests round-trip cleanly because plugin namespaces hydrate via the namespace API. |
| B10 | _Dropped._ A separate UI-component package is out of scope for a devstack tool. The existing minimal `react/ui/{Card,Field}` continues to ship from `@mysten-incubation/devstack` for example use; no new components, no extraction. |

---

## What's left (in priority order)

### Phase B — done

All Phase B PRs are landed, deferred (B7), or dropped (B10).

### Phase C — distribution (mostly deferred — see status note below)

**Deferred:** publishing to npm is not on the near-term roadmap. The
prototype lives in this monorepo; consumers use `workspace:*`. C2 +
the version-bump prep work it gates are deferred until there's a
concrete release decision.

- **C1** — _Done._ `sync-template.ts` (run as part of
  `create-devstack-app`'s build) now walks `template/package.json`
  and rewrites `workspace:*` specifiers to `^<workspace-pkg-version>`
  and `catalog:` specifiers to the version recorded in
  `pnpm-workspace.yaml`. The scaffolder produces an installable
  `package.json`; the actual `pnpm install` will work once the
  workspace packages are publishable, which is a future-release
  concern.
- **C2** — _Deferred._ Publish to npm. No near-term plan; revisit
  when there's a release decision.
- **C3** — _Done (qualitative pass)._ Stripped specific cycle-time
  numbers from `packages/devstack/README.md`,
  `packages/docs/content/devstack/index.mdx`, and the Getting
  Started page. The architecture review surfaced that the README's
  "warm cycle 1–3 s / cold private-content 76 s on Apple Silicon"
  claims didn't reproduce in practice (verified: 9.4 s best-run,
  2 min worst-run pre-A1). Replaced with qualitative framing
  ("warm cycles short-circuit through `getStatus`", "tens of
  seconds for sui-only", "cold runs depend on what's on the plugin
  list") and a steer to file actual measurements as friction-journal
  notes. Pinpoint timings can come back once they're benchmarked
  on a fixed hardware profile.

### Phase D — Debug Packages UI — _Dropped._

A scaffold-eth-2-style auto-rendered Move-function form panel + block
explorer would be the biggest single-feature differentiator for new
users, but it's UI work — out of scope for what devstack should own
as a tool. The dev wallet (`@mysten-incubation/dev-wallet`) is where
that kind of UI belongs if it gets built; devstack stops at the
typed-manifest layer.

### Phase E — test isolation (2 PRs, both deferred)

- **E1** — _Deferred._ `loadFixture()` over `runtime/snapshot.ts`
  plumbing. The architecture review wanted this so example e2e
  suites could drop `test.describe.configure({ mode: 'serial' })`,
  but every plausible mechanism trades off against a different
  pain point: per-test snapshot restore is ~15 s on `docker
  commit`-based snapshots (too slow); per-stack-per-test means N
  containers spinning up in parallel; in-memory revert needs a
  Sui-side checkpoint API we don't have access to. Capture-only
  for now — revisit when there's a concrete e2e suite that's
  measurably bottlenecked by serial mode.
- **E2** — _Deferred._ Per-action manual triggers in the
  supervisor TUI. Useful but lower-priority; the friction journal
  has the original observation.

### Phase F — per-plugin polish (8 PRs, 7 done + 1 partial, parallelizable)

| | Highlights |
|---|---|
| F1 sui | _Done._ Dropped redundant `sui-grpc` registry entry. Added `image?: string` (use a pre-built tag instead of building from `dockerContextDir` — `sui.build` becomes a verify-only probe in this mode), `volumes?: string[]` (extra `--volume` mounts for custom `fullnode.yaml` / certs / snapshot scratch — chain state still lives in the writable layer), `logLevel?: string` (override RUST_LOG; default unchanged). New `requireDockerDaemon()` helper in `plugins/sui/docker.ts` runs at the top of `sui.localnet.run` and throws a clear "start Docker Desktop / colima start / systemctl start docker" message instead of letting downstream `docker run` fail incoherently. The `genesis` opt deferred — the upstream container generates genesis on `--force-regenesis`; bind-mounting a pre-baked genesis is an advanced case worth a friction-journal entry first. |
| F2 walrus | _Partial._ Added `suiVersion?: string` option — was hardcoded to `SUI_DEFAULT_VERSION`, now configurable so an app pinning a sui version through `sui({ version })` can match it through `walrus({ suiVersion })`. The `appendLog`/`nodeCount`/`verify()` items deferred — walrus's existing build path already streams to stderr (the appendLog equivalent without the supervisor TUI plumbing), nodeCount is a 8-site refactor (subnet + ports + container names + config gen all keyed off `NODE_COUNT = 4`), and per-node verify actions are real new actions worth a focused PR. |

| F3 seal | _Done._ Fixed README option name (`apiPort` → `port` + listed all options); documented master-key persistence path + first-run/cached-run flow; dropped dead `SealKeyServer.publicKey` field; added `localnetSealOptions(manifest)` exported alongside `localnetMvrOverrides` / `localnetDappKitConfig`. |
| F4 codegen | _Done._ `getStatus`/`run` now detect + clean up stale per-package binding subdirs when an app removes a `publishMove` entry. `runCodegenForPackage` switched from `execSync` to async `runShell` so `Promise.all` parallelizes the per-package codegen pass (~3× speedup on a 4-package app). |
| F5 imports | _Done._ Dropped dead `withRecursiveDeps` (and its public re-export). Added a rev-conflict warning: `imports({ packages })` walks the specs at config time and prints a stderr warning when a single repo is pinned to multiple revs across entries (silent footgun otherwise — produces two on-chain copies of the same Move package). |
| F6 deepbook | _Done._ Deleted `swap.ts` (duplicate of each app's local `buildDeepbookSwapTx`); dropped public re-exports for `buildDeepbookSwapTx`, `BuildSwapTxOptions`, `deepbookNs`, `DeepbookPool`, `DeepbookNamespace`, `resolveCoinType`, `SUI_COIN_TYPE` — none had source-level external consumers. Kept `DeepbookPoolSpec` and `DeepbookMarketMakerSpec` (referenced from `DeepbookPluginOptions`). |
| F7 wallet-server | _Done._ The `src/wallet-panels/` stub the plan flagged was already removed in earlier work. New: `WalletServerHandle.setAccounts(accounts)` swaps the AccountsContext the listener builds its per-request snapshot from. The `serve` action's `getStatus` compares `ctx.accounts.names()` to the listener's last-seen list; on drift it returns `ok: false` with detail `accounts changed; hot-reloading`, and `run` calls `setActiveAccounts(ctx.accounts)` against the still-listening server. Adding an account to `devstack.config.ts` now flows into a running supervisor without restarting the listener (or invalidating the bearer token apps already cached). 2 new tests cover the API + sign-transaction signer resolution. |
| F8 frontend | _Done — covered by A12's `plugin-authoring.mdx`._ |

### Phase G — monorepo / governance (8 PRs, 7 done + 1 deferred)

| | Highlights |
|---|---|
| G1 | _Done._ Catalog extended with `@mysten/codegen`, `@mysten/signers`, `@tailwindcss/postcss`, `@types/node`. Swept 10 of 11 workspace `package.json` files to use `catalog:` references where catalog ≥ explicit version. `dev-wallet` (published) keeps explicit `vite ^7.3.1` / `vitest ^4.0.17` / newer React types — its toolchain is intentionally ahead of the catalog; only `@mysten/sui`, `@mysten/signers`, `@mysten/wallet-standard` switched there. `private-content` skipped (its `@types/node ^22.19.17` is already newer than catalog `^22.10.0`). All 12 packages typecheck clean post-sweep. |
| G2 | _Done._ All four CI workflows (changesets-ci, changesets, turborepo, devstack-e2e) bumped to Node 24, matching the `engines.node: ">=24"` requirement that comes from devstack's reliance on native TypeScript stripping. |
| G3 | _Done._ `devstack-e2e.yml` rewritten as a `(example, shard)` matrix over `[arena, private-content, token-studio, wallet]` × `[1, 2]`. Each example seeds independently (cold cache), caches its snapshot bundle by `example` + `snapshot-id`, and runs e2e shards in parallel. Per-example snapshot IDs flow through job outputs into the e2e job. |
| G4 | _Done._ Added root `LICENSE` (copied from `packages/devstack/LICENSE` — Apache 2.0), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`. CONTRIBUTING calls out the prototype-vs-published split (no changeset needed for prototype changes); SECURITY routes to `security@mystenlabs.com` with two-day ack window; COC is short-form with the standard scope + reporting flow. |
| G5 | _Deferred._ Move `packages/docs` → `apps/docs`. The Vercel deployment is rooted at `packages/docs/` via the project's UI-set Root Directory; an in-place move from this side would break deploys until someone with Vercel UI access updates the path. Cosmetic alignment only — defer until there's a release decision that makes the deployment churn worthwhile. |
| G6 | _Done._ Added `typecheck` task to `turbo.json` (plus dropped the `devstack` peerDep/devDep from `devstack-wallet-panels` to break a pre-existing build cycle that was hidden by turbo not running typecheck). `pnpm turbo run typecheck` now covers all 12 packages. |
| G7 | _Done._ `concepts/setup.mdx` gained an "action graph is the lifecycle" section explaining why devstack deliberately doesn't expose `afterStackUp` / `afterPublish` / `beforeShutdown` hooks (with a "you want X → use Y" mapping table). The "no third helper" rationale was sharpened to match CLAUDE.md's framing — capture the friction in the journal first, write the raw action, defer the helper decision until there are three concrete instances. `runsAs` discussion stays in `concepts/actions.mdx` where it belongs; `setup.mdx` cross-links. |
| G8 | _Done._ Deleted `examples/myapp-smoke/` — leftover runtime state from a scaffolder smoke test, never tracked in git. |

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

## Done criteria for "round 4 closed" (not a release)

These are the criteria that mean the prototype is in a clean
state — not that it's ready to publish. Publishing is its own
future decision (see Phase C above).

1. All 12 review-surfaced bugs have regression tests.
2. Three sequential `apply` runs healthy on arena (proves PR A1 + A3 +
   PR 0 hydration).
3. `devstack console`'s `packages.<name>` works after a fresh apply.
4. README + docs claims verified by hands-on (warm cycle ≤3s with
   state hydration).
5. All 4 examples build + e2e pass in expanded CI matrix.
6. Friction journal contains the capture-only items below.
7. `pnpm create @mysten-incubation/devstack-app smoke` produces a
   correctly-shaped scaffolded app — `pnpm install` actually
   succeeding is a publish-time concern.

The Debug Packages UI (Phase D) is the biggest remaining
differentiator vs. scaffold-eth-2 but is independent of round 4.

---

## Status snapshot

- **38 PRs landed** (PR 0, A1–A12, B1–B6, B8, B9, B11, C1, C3, F1, F2
  partial, F3–F7, G1, G2, G3, G4, G6, G7, G8)
- **5 PRs deferred** (B7 with rationale; C2 publishing has no near-term
  plan; G5 docs-move blocked on Vercel UI; E1 loadFixture awaits a
  concrete bottleneck; E2 manual triggers lower-priority)
- **2 PRs dropped** (B10 UI components; D1–D3 Debug Packages UI — out
  of scope for a devstack tool)
- **0 PRs pending.** Round 4 is closed end-to-end.

397 tests passing in `packages/devstack`; all 5 examples typecheck
clean against the new shapes.
