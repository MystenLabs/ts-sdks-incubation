# Architecture review — remaining work

Companion to `architecture-review/` (the 30-part review committed
2026-05-01) and the eight-phase integration plan executed across
commits `c3a571b…07f2793` on `integrate-devstack`. This note tracks
what was deliberately deferred so the next contributor doesn't have
to re-derive it from commit messages.

## Status as of 2026-05-01

- 8 phases shipped, one PR-equivalent commit each.
- Tests: 183 → 289 (+106), build smoke test added.
- 13 of the 30 reviews fully closed; the remaining 17 each have at
  least their highest-impact item shipped, with the lower-priority
  items recorded below.

## Deferred — by review

### 22 react adapter — finish removing `globalThis.__devstackDAppKit__`

Phase 6 added `<DevstackProvider dAppKit={...}>` and switched the
hooks to read from context. `createDevstackDappKit` still writes to
the global slot for back-compat with apps that don't pass `dAppKit`
through the provider yet.

- Remove the `globalThis.__devstackDAppKit__` write from
  `packages/devstack/src/react/create-devstack-dapp-kit.ts`.
- Remove the global-fallback read from
  `packages/devstack/src/react/use-devstack-sign-and-execute.ts`
  (`lookupSignAndExecute`).
- Bump `@mysten-incubation/devstack` major.

### 22 react adapter — codify the codegen-builder marker symbol

Replace the arity-`<=1` heuristic in `react/bind-package.ts` with
`Symbol.for('codegen.builder')`. Decouples from `@mysten/codegen`'s
0.10.x emitter shape. Single-file change; needs a coordinated bump
when the codegen package emits the marker.

### 26-27 examples — lift the per-app boilerplate

The four examples still each carry a byte-identical `src/dapp-kit.ts`
(31 lines). Lifting it requires deciding where the helper lives:

- Option A: new `packages/devstack-app-setup/` that depends on
  `dev-wallet` + `devstack-wallet-panels`. Cleanest separation; one
  more package to publish.
- Option B: extend `@mysten-incubation/devstack-wallet-panels` (it
  already brokers the panels and is devstack-aware). Smaller surface
  but mixes two concerns.

`Card.tsx` and `lib/format.ts` are NOT byte-identical across apps —
they've drifted. A meaningful dedup needs a diff pass per file +
extracting the common subset into a shared `react/ui/`.

### 30 app authoring — `examples/_template/` + `pnpm create devstack-app`

Phase 6 shipped `examples/README.md` (the recipe). The full template
+ scaffolder remain. The scaffolder shape:

- New `packages/create-devstack-app/` (pnpm `create-` convention).
- `pnpm create @mysten-incubation/devstack-app my-app` generates
  `examples/<name>/` (or sibling, configurable) with the 12
  boilerplate files + a Move-package skeleton.
- Auto-allocate ports from `hashString(appName)` so a fresh scaffold
  doesn't collide with sibling examples — careful here, the existing
  examples' explicit ports are stable for users with running stacks.

### 27 examples — NFT example (`examples/nft/`)

Kiosk + display. The biggest missing demo for the Sui audience
(token-studio is fungible-only). Substantial work — a real Move
package, UI flows for mint/list/transfer, e2e tests. Ideally added
AFTER the boilerplate consolidation above so the new example doesn't
inherit the duplicated wiring.

### 16 status renderer — JSON output mode

`runtime/status-renderer.ts` currently has only TTY + headless log
output. Adding `format: 'json'` gives CI consumers structured
events instead of regex-parsing the panel text. Pair with `cli/up.ts
--json` and `cli/apply.ts --json` flags. Plumbing needed:

- `Reconciler` already has the `progress` callback with statuses +
  failures. The renderer just needs a per-event JSON-line emitter
  that runs in lieu of the panel.
- Skip-reason classification (review 12) is the natural companion —
  the JSON output is more useful when each cell carries why it was
  skipped (`hash-match`, `status-ok`, `cascade-unaffected`,
  `filter-dropped`).

### 24 vitest integration — testcontainers-per-file + worker partition

The M9-era promise of fresh-localnet-per-test-file via
testcontainers is still a punt. Implementing it requires:

- A way to spawn a sui localnet container scoped to a file's
  lifetime (vitest's `globalSetup` runs once; per-file isolation
  needs the test runner's `setupFiles` hook + a containerized RPC).
- Per-worker address-space partition in `account-pool.ts` so two
  workers can't lease the same account.
- A `declare module 'vitest'` augmentation for `expect.extend`
  helpers so consumers don't write it themselves.

Plus: at least one in-tree consumer with `chain: true` so the pool
is exercised by CI — the pool's load-tested behavior is unverified
beyond design intent.

### 14 manifest — schema-migration smoke test

The migration table in `runtime/manifest-reader.ts` is empty today
(every writer emits v2). The first real upgrade will be the first
test of the loop. When v3 lands, add a no-op v2→v3 fixture to
`runtime/manifest-types.test.ts` so the migration mechanism is
known-good before it's depended on.

### 28 docs — code-fence regex check + new pages

- Add a `^```ts\n\s*$` regex check to `packages/docs/scripts/
  validate-llm-docs.ts` — flags the truncated code blocks the docs
  build silently produces today.
- New pages in `packages/docs/content/devstack/`:
  - `plugin-authoring.md` — "write a plugin from scratch" recipe.
  - `troubleshooting.md` — common docker/RPC/faucet failure modes.
  - Document `createDevstackWalrusClient`, `useDevstackDeployed`,
    `bindPackage` on the existing `react.md` page (currently absent).

### 11 register/seed/emit — split `Register` into Register/Bootstrap/Configure

Or rename `Register` → `Action` (catch-all). The current Register
type is a residual category for "anything that isn't Build/Service/
Publish/Seed/Emit" — naming would clarify intent. Add `liveNetworks`
to Register symmetrically with Seed.

This is a typed-API change with broad blast radius; defer until a
specific use case forces the split.

### 10 publish — `upgrade()` action

The `capture` filter records UpgradeCap object IDs but the action
graph has no first-class `upgrade()` factory. Adding one would let
plugins express "upgrade this package on bump" without hand-rolling
a Register that wraps the upgrade tx.

### 19 imports — patch / transform hook on `ImportSpec`

Hook fires before publish; lets the spec rewrite Move.toml or
sources for upstream packages that need adjustment (deepbook's
admin-cap recipient, etc.) without forking the upstream repo. ABI
is straightforward (`(ctx, sourceDir) => Promise<void>`); decision
point is whether the hook runs against the host tmp dir before the
docker-cp into the sui container, or after.

### 19 imports — exponential-backoff retry inside `publishMovePackage`

Transient chain warmup errors during the first publish currently
surface as full failures. A small retry loop with jitter would
cover the common case. Localize to `helpers/imported-package.ts`.

### 18 helpers — `seedSharedObjects` (plural)

Multi-shared-object Move calls currently hand-roll the shared-input
list. A small wrapper around `seedSharedObject` taking an array
would be a clean idiom. Add to `helpers/seed-shared-object.ts`.

### 15 accounts — async-factory path + env shortcut

- Async signers (KMS / Ledger / passkey) currently fail early in
  `runtime/accounts.ts` because `resolveAccounts` is sync-only.
  Adding a lazy-async path is straightforward but invalidates the
  current "every account materialized at startup" guarantee — needs
  thought about how `ctx.accounts.get()` handles in-flight
  resolution.
- `DEVSTACK_<ACCOUNT>_KEY` env shortcut: a top-level env-override
  layer that runs before per-network spec resolution. Useful for
  CI; design needs to spell out the precedence vs. an explicit
  per-network spec.

### 17 core types — namespace schema registration

`Registry.ns(name, { kinds: [...] })` — opt-in schema declaration
so typo'd kind names surface as runtime errors instead of silently
creating empty namespaces. Pure addition; doesn't break existing
plugins. The `unregister` method shipped in Phase 8 covers part of
the same review's scope; the schema piece is independent.

### 21 cli — `--filter` escape hatch on `apply`

Allow `apply` to run with a custom filter (today the choice is
applyFilter vs. deployFilter; nothing in between). Useful for
"deploy + run a specific Seed on testnet" workflows.

### 14 manifest — per-entry `registeredAt` timestamps in v3

When v3 lands, add a `registeredAt` field to each registry entry
so the renderer can surface "stale manifest" UX (e.g. mtime older
than the dev-server PID).

## Cross-cutting hygiene

- Glob-based `copy` in `packages/devstack/tsdown.config.ts` so new
  plugin assets aren't silently dropped from the published build.
  Phase 5's smoke test catches this class of regression at CI time;
  a glob would close the gap proactively.
- Document CJS-not-supported in `packages/devstack/README.md`. The
  package is ESM-only; consumers occasionally hit the dual-package
  hazard.
- Optional `"development"` condition in `package.json:exports`
  mapping to `src/*.ts` so workspace devs don't need a sidecar
  `build:watch` terminal. Nice but invalidates published-only
  testing flows; trade-off worth thinking about before shipping.

## Methodology — extract from evidence, not anticipation

Every deferred item above was deliberately left for a future cycle
because either (a) the change has substantial blast radius and no
specific consumer is currently pushing on it, or (b) shipping it
without a real consumer would be guess-driven design — exactly what
the `CLAUDE.md` build-then-extract methodology cautions against.

When you reach for one of these, look for the consumer first. If
there isn't one, the item probably stays here.
