# API Simplification (devstack) — historical archive

**Status (2026-05-19): TRIMMED.** Phases 1, 2, 4 implementation is complete;
Phase 3, 5, 6 sections have been removed (sections §5, §7, §8). All §11
Open Questions and §12 Flips have been DECIDED; verification status of
each is recorded in `notes/post-launch-sweep.md` §8 (confirmed shipped)
and §10 (decisions settled).

**Remaining work from this plan** is folded into `notes/post-launch-sweep.md`:
- Phase 3 closeout items (3.4–3.7) → post-launch-sweep Wave 1, 3
- Phase 5 closeout items (5.3–5.8) → post-launch-sweep Wave 1, 3, including Flip 6/7 deletions
- Phase 6 documentation rules → shipped per `AGENTS.md` updates

This document is preserved for the **§10 Finding ledger** (~150 W/O/N/D/etc.
findings with their dispositions), **§11 Open Questions**, **§12 Flips**,
and **§15 Decision log** — the only place outside the deleted
`.review-plans-fold/` where those records exist.

Original scope: addressed every finding in `.review-plans-fold/` (~150
findings). Did not duplicate work in the existing three plans
(`coin-auto-discovery.md`, `deepbook-plugin-expansion.md`,
`sui-fork-integration.md`); §13 recorded the intersection.

---

## §1 Goals & priorities

In order:

1. **Simplify for the basic use case.** Reduce the surface a user reads
   when writing `devstack.config.ts`. Today examples span 46–237 LOC and the
   root barrel exports ~59 symbols; the basic user is invited to learn
   patterns (`registerCoin` vs `Package({coins})`, `capture:`,
   `pickCreatedByType*`, the 5 interface tags) that don't carry their weight.
2. **Simplify for external plugins.** Make `/advanced` complete: today every
   long-lived in-tree service (sui, walrus, seal, deepbook, planned postgres,
   planned fork) bypasses `/advanced` into engine internals because no
   `dockerContainer` primitive exists. The published boundary is a fiction.
3. **Simplify for internal plugins.** Today adding one endpoint touches 5+
   files (`endpoint-names.ts`, `conventional-routes.ts`, `service.ts` grouper,
   `manifest-schema.ts`, `ROUTER_ENTRYPOINTS`); adding one service adds a
   `publishX` + `requireX` + Registry + Live layer + `groupX` projection. With
   the deepbook plan adding 5 services, that's ~25 file edits without
   consolidation.

**Constraints:**

- **Good abstractions; don't share too much.** Prefer one shape per concept.
  Resist generic helpers that bridge unrelated services.
- **Tree-shaking is not a priority for the devtool itself** (it matters for
  codegen-emitted user code, but not for `@mysten-incubation/devstack`).
  This invalidates the review's defense of the 8-→-13 parallel registries
  (W2/D2) and 5-→-10 `groupX` helpers (D5).
- **Subpath count holds at 6.** `/runtime` dies; `/advanced`, `/vitest`,
  `/playwright`, `/vite`, `/dapp-kit` stay (decided 2026-05-18).
- **Root remains flat.** All factories at root, no `/protocols` namespace
  (decided 2026-05-18). Implication: root will grow from ~12 factories to
  ~18-20 after deepbook plan; the simplification value comes from each
  factory being well-shaped, not from organizing them by domain.
- **Snapshot participation: backfill, don't delete the rule** (decided
  2026-05-18). All six container-backed services get the docstring block.

---

## §2 Phase ordering

The review's recommended order (Plan A: substrate first) is wrong for these
priorities. Substrate hardening (StateStoreKeys, SnapshotMeta bucket) is
invisible to users; deletions are visible and unblock the basic-use win.
Coin plan Phases 1-4 (the biggest user-facing simplification) is currently
**blocked by parallel work** — Phase 2 below executes when it unblocks.

Ordering (each independent unless noted):

| # | Phase                                              | Blocking?   | LOC delta | Days |
|---|----------------------------------------------------|-------------|-----------|------|
| 1 | Pure deletions (basic-use surface shrink)          | independent | -~336     | 1    |
| 3 | External plugin surface (`dockerContainer` etc.)   | independent | +~280     | 2    |
| 4 | Internal plugin cookbook (`defineEndpoint`)        | before deepbook P2 | -~150 net | 2 |
| 6 | Documentation rules (naming/phase/spans/etc.)      | independent | +~80 docs | 1    |
| 5 | Substrate hardening (StateStoreKeys, SnapshotMeta) | before deepbook P2 / fork P2 | +~160 | 1 |
| 2 | User-facing simplification (coin Phases 1-4 land)  | blocked     | per coin plan | per plan |
| 7 | Long tail (deferred / WONT-FIX rationale)          | n/a (ledger) | 0        | 0    |

Phases 1, 3, 4, 5, 6 can be PR'd in parallel by different agents. Phase 2
threads in when the coin plan unblocks. Phase 7 is the residue.

---

## §3 Phase 1 — Pure deletions

**Goal:** shrink the root barrel from ~59 exports to ~40 + kill the
`/runtime` subpath. Each deletion has zero behavioral consequence (verified
in the dead-code synthesis pass).

### 1.1 — Kill the `/runtime` subpath

- [x] **1.1.1** Delete `packages/devstack/src/runtime/index.ts`.
- [x] **1.1.2** Remove `"./runtime"` from `packages/devstack/package.json#exports`.
- [x] **1.1.3** Drop `src/runtime/index.ts` from `tsdown.config.ts`'s entry
      list (the subpath was bundled via tsdown, not the dts-subpaths config).
- [x] **1.1.4** Delete `Devstack`, `DevstackLive`, `DevstackShape` from
      `runtime/service.ts` — no Effect-native consumer; emitters use
      `gatherManifest` directly. File shrinks to just `gatherManifest`.
- [x] **1.1.5** Delete `runtime/manifest-loader.ts` and
      `runtime/manifest-loader.test.ts` outright. `fromManifest` /
      `FromManifestOptions` / `decodeManifestV5` plumbing go with it.
- [x] **1.1.6** Inline a `JSON.parse(readFileSync(p, 'utf-8')) as Manifest`
      at the one remaining caller (`playwright/web-server.ts`). The v5
      schema is all-strings so no bigint reviver is needed today.
- [x] **1.1.7** Delete `ManifestEncoded` from
      `runtime/manifest-schema.ts` — identical to `Manifest`, no callers.
- [x] **1.1.8** Add `gatherManifest`, `EndpointName`, `EndpointNameValue`,
      and the `ExtrasInput` type to `/advanced` (the only remaining
      plugin-author surface that needed runtime/ entries).
- [x] **1.1.9** Trim root `src/index.ts`: drop `Devstack`, `DevstackLive`,
      `fromManifest`. `WalletHttpPath` + manifest sub-types already at
      root and stay. Update header comment.
- [x] **1.1.10** Update `src/index.test.ts` PUBLIC_EXPORTS to drop the
      three removed names. Touch the public-surface comment.
- [x] **1.1.11** Update `runtime/service.test.ts`: remove the
      `DevstackLive` integration test and rewrite the late-registration
      regression to drive `gatherManifest` directly (same property —
      successive calls reflect late `eps.register` writes).
- [x] **1.1.12** `discoverManifestPath` stays at `runtime/discover-manifest.ts`
      (NOT moved to `cli/internal/`). The plan's "3 internal callers" was
      stale — `playwright/web-server.ts` is also a live caller, so the
      file remains shared between cli/ and playwright/. The subpath
      removal demotes it to internal-only without relocating it.
- [x] **1.1.13** Cascade docstring updates: `dapp-kit/index.ts` (drop
      `fromManifest` reference), `engine/extras.ts` (drop "re-exported
      from /runtime"), `engine/supervisor.ts` (drop `Devstack` Service
      cross-reference), `engine/shared.ts` (drop pickCreatedByType
      sibling reference — covered in 1.6), example/template config
      headers, `AGENTS.md` manifest-section + helper-table.

LOC delta: -~250 (subpath barrel + manifest-loader + DevstackLive
service block + its dedicated test + ManifestEncoded + docstring
churn).

Tests:
- [x] `index.test.ts` PUBLIC_EXPORTS pin updated to the trimmed surface.
- (no `runtime-subpath-gone.test.ts` — the public-surface pin already
  catches a re-add at root, and a new file just for the subpath path
  is busywork; the package.json + tsdown delete is the contract).

### 1.2 — Delete dead root re-exports

Files touched: `packages/devstack/src/index.ts`.

Symbols deleted:
- `ManifestEncoded` (O3) — already covered in 1.1.
- Six `@mysten/sui` convenience re-exports (O6): `SignAndExecuteError`,
  `SignAndExecuteOptions`, `SuiObjectChange`, `SuiTransactionBlockResponse`,
  `Transaction`, `TxResult`. Every example imports these directly from
  `@mysten/sui/transactions`. Lines 138-150 of root barrel removed.
- Three deployment record types (O7): `DeepbookDeployment`, `SealDeployment`,
  `WalrusDeployment`. Zero callers. Users who write `override:` literals
  go through the high-level options. Lines 108-118 removed.
- `RegisterCoinOptions`, `RegisterCoinResult` (O10) — type-only;
  inferred everywhere. (`registerCoin` itself stays until coin Phase 3 lands.)
- `DEFAULT_KEY_SERVER_PORT = 2024` (O31) — self-documented as "ignored
  per Traefik routing." Delete.
- Sealed/Walrus dead schema fields (O23, O24): `apiKeyName`, `apiKey` on
  `SealKnownKeyServerOptions`; `subsidiesPackageId` on Walrus options +
  deployment record. Never read.

LOC delta: -~50.

Risk: low. Whole-repo greps in `.review-plans-fold/synthesis/05-overbuild-and-dead-code.md`
confirm zero external consumers.

Tests:
- `index.test.ts` PUBLIC_EXPORTS pin updates.
- No new tests needed (deletions of dead exports).

### 1.3 — Move 5 interface tags from root → `/advanced`

Files touched: `packages/devstack/src/index.ts`,
`packages/devstack/src/advanced/index.ts`.

Symbols moved:
- `CoinTag` + `Coin` type
- `WalrusNetworkTag`, `WalrusNetwork`
- `WalrusNodesTag`, `WalrusNodes`
- `WalrusProxyTag`, `WalrusProxy`
- `DeepbookCoreTag`, `DeepbookCore`

Kept at root: `SealKeyServerTag` (only example consumer, `examples/private-content`).

Update `examples/private-content/devstack.config.ts` — no change (still
imports `SealKeyServerTag` from root).

LOC delta: ~0 (move).

Risk: low. None of the 5 has an example consumer per dead-code synthesis.

Tests: `index.test.ts` PUBLIC_EXPORTS pin updates.

### 1.4 — Delete dead `/advanced` exports

Files touched: `packages/devstack/src/advanced/index.ts` and source files.

Symbols deleted (per O19 in dead-code synthesis):
- `shortId` (no consumers anywhere, not even tests)
- `CurrentTagKey` (only used inside `advanced/tag.ts` itself)
- `WalExchangeHandle`, `WalExchangeStrategyOptions`,
  `TreasuryCapMintStrategyOptions`
- `TagRequires`, `TagErrors`, `TagProvides` (three utility types nobody
  spells out)
- `BindingsEmitterOptions`, `DappKitConfigEmitterOptions` (type aliases
  for default-empty options)

LOC delta: -~30.

Risk: low. Verified zero consumers.

### 1.5 — Pick one home for duplicated error re-exports

Per O35, three error classes are re-exported at both root and `/advanced`:
- `CodegenError` — keep at root (app-level `catchTag` is the documented
  consumer pattern); delete `/advanced` re-export.
- `FaucetRequestError` — keep at root; delete `/advanced` re-export. Coin
  Phase 5 demotes `Faucet` to `/advanced`; the error re-export moves with it
  in that same change.

LOC delta: -~6.

Risk: low.

### 1.5b — Delete `waitForBalanceUpdate` (Q9, O21) — DECIDED: delete (2026-05-18)

The `/playwright` helper has zero spec consumers. Delete from
`src/playwright/helpers.ts` and `src/playwright/index.ts`.

If a flow needs balance-update assertion in the future, re-add with a
real spec exercising it. Today's investment doesn't earn its keep.

LOC: -~30.

### 1.6 — Collapse `pickCreatedByType*` to one function (DECIDED: ACT, 2026-05-18)

Replace `pickCreatedByTypeSuffix`, `pickCreatedByTypeIncludes`, and
`pickAllCreatedByTypePrefix` with one parameterized `pickCreatedByType`
on `/advanced`. Return-type narrowing is via conditional types: default
form returns `string | undefined` (first-match objectId — backwards
compatible with the 90% of callsites that took `.objectId`); the
`{ prefix, all: true }` form returns
`ReadonlyArray<CreatedObjectEntry>` for the enumerating shape coin
discovery needs.

- [x] **1.6.1** Rewrite `engine/sui-helpers.ts` to export the unified
      `pickCreatedByType(changes, filter)` plus its `PickCreatedByTypeFilter`
      and `PickCreatedByTypeResult` type helpers. Keep `CreatedObjectEntry`
      and `parseCoinTypeFromGeneric`. Delete the three named pickers and
      `pickAllCreatedByTypePrefix`.
- [x] **1.6.2** Rewrite `engine/sui-helpers.test.ts` to cover the four
      branches (suffix, includes, prefix first-match, prefix all:true).
- [x] **1.6.3** Migrate the example: `examples/arena/devstack.config.ts`
      switches to `pickCreatedByType(r.objectChanges, { suffix: '::game::Lobby' })`
      and imports `pickCreatedByType` from `/advanced`. (No other example
      app uses the helper — `examples/wallet` doesn't import it.)
- [x] **1.6.4** Migrate every internal callsite to the new shape:
      `services/coin.ts` (1), `services/package.ts` (1 in `compileCapture`),
      `services/package/internal.ts` (1 for upgradeCapId),
      `services/coin/discovery.ts` (2 for `{ prefix, all: true }`),
      `services/seal/internal.ts` (3 sites), `services/pyth/local-deploy.ts`
      (2 sites in capture lambda), `services/deepbook/local-deploy.ts` (4
      sites), `services/deepbook/margin.ts` (4 sites),
      `services/deepbook/margin-seed.ts` (1 site). Update
      `services/deepbook/market-maker.ts` comment.
- [x] **1.6.5** Land the picker on `/advanced` (it's plugin-author
      surface — `Action.build` callbacks). Drop it from the root barrel.
      Update root + advanced barrel docstrings to reflect the move.
- [x] **1.6.6** Drop `pickCreatedByTypeIncludes` / `pickCreatedByTypeSuffix`
      from `src/index.test.ts` PUBLIC_EXPORTS. `pickCreatedByType` is
      NOT added at root.
- [x] **1.6.7** Update AGENTS.md helper table and `engine/shared.ts`
      reader docstring to reference the unified picker.

LOC: ~120 new helper (with overloads + doc) − ~140 LOC across 3 named
exports + 3 callsite-shape branches ≈ −20 net.

Risk: breaking for external consumers of the 3 named exports (none
observed in this monorepo).

### 1.7 — Delete dead `hostPort` option on `sealLocalKeygen`

Surface-cleanup task: the `hostPort` option on `sealLocalKeygen` in `packages/devstack/src/services/seal/internal.ts:328` is already documented as ignored (Traefik router dispatch replaced it). Delete the option from the public surface; nothing reads it.

- [x] **1.7.1** Remove `hostPort?: number` from `SealLocalKeygenOptions` (and its callsite in the factory) at `packages/devstack/src/services/seal/internal.ts:328`. Drop the inline "ignored — see router dispatch" comment with it.
- [x] **1.7.2** Grep + delete any test or example fixture that spells `hostPort:` against `sealLocalKeygen`. `grep -rn "hostPort" packages/devstack/src/services/seal/ examples/private-content` should return 0 hits afterward.

LOC delta: -~10. Risk: low (already ignored at runtime; deleting the option is type-only).

### 1.8 — Delete dead `onPortConflict` callback infrastructure

Surface-cleanup task: `onPortConflict` callback infrastructure in `packages/devstack/src/engine/docker/core.ts` ships unwired — no production primitive ever passes a callback. `reallocatePortsOnConflict` at `packages/devstack/src/engine/docker/port-conflict.ts` is exported and tested but has no live consumer.

- [x] **1.8.1** Delete the `onPortConflict?: (...) => Effect<...>` option from `Docker.run`'s option shape in `packages/devstack/src/engine/docker/core.ts` and the dispatch-on-presence branch in the body. Grep `grep -rn "onPortConflict" packages/devstack/src` returns 0 hits after.
- [x] **1.8.2** Delete `reallocatePortsOnConflict` (function + export) from `packages/devstack/src/engine/docker/port-conflict.ts`. If the whole file becomes empty (only the dead function lived there), delete the file and its barrel re-export.
- [x] **1.8.3** Delete the corresponding test cases in `packages/devstack/src/engine/docker/port-conflict.test.ts` (or the whole file if it tests only the dead helper). Do not preserve as `it.todo` — port-conflict reallocation is not a planned future feature; if it becomes one, the test is written fresh.

LOC delta: -~80 (callback infra + helper + tests). Risk: low; both pieces are dead.

### 1.9 — Delete dead `tui/render.ts` re-export shim

Surface-cleanup task: `packages/devstack/src/tui/render.ts` is a re-export shim with no callers — verified by `grep -rn "from .*tui/render" packages/devstack/src examples/` returning 0 hits.

- [x] **1.9.1** Delete `packages/devstack/src/tui/render.ts` outright. Remove the file's barrel re-export from `packages/devstack/src/tui/index.ts` if present.
- [x] **1.9.2** Confirm `packages/devstack/src/tui/` still exposes the live render entrypoint via its real path (the one with callers). If the file was the *only* member of `tui/`, fold the directory up; otherwise leave the rest alone.

LOC delta: -~30 (re-export shim). Risk: low.

### Phase 1 summary

| Item | LOC | Risk |
|---|---|---|
| 1.1 Kill /runtime | -120 | low |
| 1.2 Delete dead root re-exports | -50 | low |
| 1.3 Move 5 interface tags to /advanced | 0 | low |
| 1.4 Delete dead /advanced exports | -30 | low |
| 1.5 Pick one home for duplicated error re-exports | -6 | low |
| 1.5b Delete `waitForBalanceUpdate` | -30 | low |
| 1.6 Collapse `pickCreatedByType*` to one fn | +20 net | low |
| 1.7 Delete dead `hostPort` on `sealLocalKeygen` | -10 | low |
| 1.8 Delete dead `onPortConflict` + `reallocatePortsOnConflict` | -80 | low |
| 1.9 Delete dead `tui/render.ts` re-export shim | -30 | low |
| **Total** | **-~336** | low |

Public root barrel shrinks from ~59 to ~40. `/runtime` subpath gone. Three dead-code surfaces (sealLocalKeygen `hostPort`, port-conflict callback infra, tui/render shim) shipped during Stages A-D are removed.

### Phase 1 test gate (covers 1.1–1.9)

- [ ] `pnpm typecheck` clean for devstack + every example app after all of 1.1–1.9 land. (Pre-existing breakage from concurrent coin-auto + Pyth + fork work blocks this; not caused by 1.1-1.9 deletions.)
- [x] `pnpm exec vitest run --exclude '**/*.docker.test.ts'` — 0 failures across the devstack package after deletions. `port-conflict.test.ts` did not exist (the helper was tested via `port-allocator.test.ts`; those test cases are gone).
- [x] `grep -rn "hostPort\|onPortConflict\|reallocatePortsOnConflict" packages/devstack/src` — `onPortConflict` and `reallocatePortsOnConflict` return 0 hits. `hostPort` matches remain for legitimate uses (the `hostPorts` record on `DockerRunResult` / `dockerContainer` handle, and the `hostPort` local variable in fork testkit). The dead `hostPort` option on `SealLocalKeygenOptions` is gone.
- [x] `find packages/devstack/src/tui/render.ts` returns nothing.

---

## §4 Phase 2 — User-facing simplification (coin plan lands)

**Status (2026-05-18): all three sub-items landed.** Coin Phases 0-6 in
`notes/coin-auto-discovery.md` are complete; 2.2 (`from` → `kind`) and 2.3
(wallet singleton) executed in this pass.

- [x] **2.1** Coin plan Phases 1-4 (per existing `notes/coin-auto-discovery.md`)
- [x] **2.2** Discriminator naming convention (`from` → `kind`; doc in
  AGENTS.md + `advanced/tag.ts`)
- [x] **2.3** Wallet singleton — `options.name` removed from
  `WalletOptions` + `WalletAppOptions`; factory pinned to
  `EndpointName.WALLET_APP`.

### 2.1 — Coin plan Phases 1-4 (per existing `notes/coin-auto-discovery.md`) — DONE (2026-05-18)

Coin plan landed end-to-end. Addresses W1 (four coin shapes), D12 (per-coin
RPC waterfalls), D13 (registerCoin triple-duplication), E2 (coin example
duplication), N3 (Coin name collision).

What landed:
- `examples/wallet/devstack.config.ts` shrank to ≤160 LOC.
- `registerCoin`, `RegisterCoinOptions`, `RegisterCoinResult` exited root.
- `Coin()` is the overloaded factory (`Coin('SYMBOL')`,
  `Coin.fromPackage(pkg, 'WITNESS')`, `Coin('0x...::T')`,
  `Coin.builtin('sui')`).
- `Package({coins})` and `Package({capture})` exited root API. `capture`
  moved to `/advanced` via `PackageWithCapture`.
- `pickCreatedByType*` moved to `/advanced` (paired with the `capture` move).

### 2.2 — Discriminator naming convention (W4/N7) — DONE (2026-05-18)

The convention going forward:

- Use `kind` for newly-introduced tagged-union discriminators.
- `AccountSource.from` renamed to `kind` in this pass; every callsite
  migrated. No legacy alias.
- `Coin()` factory uses input-shape dispatch (not a discriminator field);
  ratified as the precedent for "this thing has one job; overload on
  input shape" (S5).

Documented in `packages/devstack/AGENTS.md` (new "Discriminator naming"
section under "Service factory shape") and
`packages/devstack/src/advanced/tag.ts` JSDoc on `composeLayers`.

Files migrated:
- `services/account.ts` — `AccountSource` union, all `source.from`
  accesses, `Extract<…, {kind: '…'}>` types, every error message
  citing the field, the `kindOmitted` local.
- `services/account.test.ts`, `services/account.fork.test.ts` — every
  `{from: '…'}` fixture rewritten as `{kind: '…'}`.
- `services/sui/impersonate.ts` — JSDoc updated.
- `examples/effect-app/src/main.ts` + `README.md` — only example
  using the discriminator field literally.

### 2.3 — Wallet endpoint `'wallet'` decision (W8) — DONE (2026-05-18)

`options.name` dropped from `WalletOptions`. Wallet is one-per-stack by
design. The hardcoded `EndpointName.WALLET_APP` sites are now the
documented contract.

Files touched:
- `services/wallet.ts` — removed `name?` from `WalletOptions`;
  factory body no longer forwards it; JSDoc + header comment cite the
  singleton invariant.
- `services/wallet/internal.ts` — removed `name?: Name` parametric
  field from `WalletAppOptions`; dropped the `<const Name>` generic on
  `walletApp`; pinned the local `name` constant to
  `EndpointName.WALLET_APP`.
- `AGENTS.md` — added a "singleton factories do NOT accept a `name?:`
  override" paragraph under "Service factory shape."

LOC: ~-10. Risk: zero (no example sets `options.name`; verified
across `examples/{wallet,token-studio,private-content,deepbook-full,
arena,_template}` — all call `Wallet({accounts, allowedOrigins?})`
only).

### Phase 2 summary

Surface delta after Phase 2:
- `registerCoin` removed; `Coin()` family is the replacement.
- `Package` narrowed (no `coins:`, no `capture:` on the root API).
- `AccountSpec.from` → `AccountSpec.kind`; convention pinned in
  AGENTS.md + `advanced/tag.ts`.
- `WalletOptions` lost its `name?` field; factory is a singleton.

---

## §6 Phase 4 — Internal plugin cookbook

**Goal:** make "add a service" / "add an endpoint" mechanical. Today the
cookbook is 5 file edits per endpoint; with deepbook Phase 2 adding 5
services that's ~25 edits. Resolves W2/W3/D2/D5/D6.

### 4.1 — `defineEndpoint(...)` declarator (D6/W3) — DONE (2026-05-18)

New: `packages/devstack/src/engine/define-endpoint.ts`.

Takes a single declaration; emits:
- `EndpointName` constant entry
- `conventional-routes.ts` entry
- `ROUTER_ENTRYPOINTS` registration (via Phase 3.2)
- `runtime/service.ts` grouper participation (auto)
- `manifest-schema.ts` field (via a schema-extension hook)

API sketch:

```ts
defineEndpoint({
  name: 'POSTGRES',
  port: 5432,
  protocol: 'tcp',
  service: 'postgres',
  manifestField: { in: 'services.postgres', shape: PostgresEndpointSchema },
  routing: { entrypoint: 'postgres' },
});
```

LOC: ~120 new + ~-200 LOC across the 5 manual touchpoints × 8 endpoints
= net -80 LOC. Deepbook Phase 2's 5 new endpoints become 5 declarations,
not 25 file edits.

Risk: medium. Schema extension hook is the tricky part — must compose with
the existing `ManifestSchema` typing.

Tests:
- `define-endpoint.test.ts` round-tripping a declaration through to all
  five derived artifacts.

### 4.2 — `defineRegistry<T>()` extraction (W2/D2) — DONE (2026-05-18)

Extract `defineRegistry<TName, TRecord>()` at `engine/define-registry.ts`.
Produces `{Tag, Live, publish, require?, snapshot}` from one declaration.

Today: 8 registries × ~35 LOC each = ~280 LOC of trio boilerplate.
After: 8 × 5 LOC declaration + 100 LOC factory = ~140 LOC. Deepbook adds
5 more cleanly.

Trade-off accepted: per-call type narrowing degrades slightly (one generic
call site vs 8 monomorphic free functions). Tree-shaking irrelevant for
the devtool itself, so the legibility win dominates.

API sketch:
```ts
export const CoinRegistry = defineRegistry({
  name: 'CoinRegistry',
  record: CoinRecordSchema,
});

// → produces
//   CoinRegistry.Tag        // Context.Tag
//   CoinRegistry.Live       // Layer.scoped(...)
//   CoinRegistry.publish    // (rec) => Effect.gen(...)
//   CoinRegistry.require?   // (or `snapshot`-only for state registries)
//   CoinRegistry.snapshot   // gather for manifest
```

Tag identity is preserved (one Tag per name). The factory's outputs are
strongly typed per name; "narrowing within the macro" replaces "narrowing
between 8 hand-written functions."

### 4.3 — `groupX` projection helpers — derived (D5) — DONE (2026-05-18, partial)

The Sui field-name table (`SUI_FIELDS`) is now derived from the
`defineEndpoint` declarations via a `manifestLeafUnder` helper in
`runtime/service.ts`. Remaining `group*` helpers (`groupSeal`, `groupWalrus`,
`groupApp`, the deepbook/pyth/postgres state foldings) stay hand-rolled because
their projection shape is genuinely heterogeneous — state record + endpoint URL
merged into one block, multiple endpoints aliased onto the same field
(`DEV_SERVER_PRIMARY` / `DEV_SERVER_FALLBACK`), etc. The declarations carry
the metadata that those groupers consult when they need a field name; the
hand-rolled body shape stays for the merge logic.

Today: 5 hand-written groupers in `runtime/service.ts:81-144`. With D6's
`defineEndpoint` data-driving the projection, groupers become trivially
derived from the declarations. Delete the hand-written groupers; replace
with a single `gatherManifest()` body that walks the declarations.

LOC: ~-120 LOC (5 groupers gone).

Risk: low if 4.1 lands first.

### 4.4 — `acquireFileLock(...)` consolidation (D1) — DONE (2026-05-18, partial)

`engine/file-lock.ts` extracted with `tryClaimLockSync` / `releaseLockSync` /
`parseLockBody` / `serializeLockBody` + 12-test unit suite. Two of three call
sites migrated:
- `engine/port-allocator.ts` — uses `tryClaimLockSync` + `releaseLockSync`
  (sync, no instanceId, equality-on-holder release).
- `engine/sui-fork/file-lock.ts` — uses the same primitives via the SuiError
  envelope (with `instanceId` for ownership-after-reclaim).

State-store stays on its own Effect-platform retry loop because its
jittered-exponential-backoff acquire is fundamentally async and the
test-suite there has been hardened against ~30s legitimate-stale-recovery
windows. The shared `parseLockBody` is available to it; left in place to
limit blast radius during concurrent agent work.

Three implementations of "wx-mode file lock + stale-PID reclaim":
- `engine/port-allocator.ts:133-196`
- `engine/state-store.ts:286-405`
- (planned) `services/sui-fork/file-lock.ts:75-184` (fork plan; absorbed)

Extract `engine/file-lock.ts::acquireFileLock` from 2 existing call sites
now. Fork plan Phase 1 uses the helper (saves ~50 LOC there).

API sketch:

```ts
export function acquireFileLock<E>(options: {
  path: string;
  holderType: string;           // 'port-allocator', 'state-store', 'sui-fork'
  retry?: {
    cadenceMs: number;          // port: 50; state: 200; fork: 1000
    maxAttempts?: number;       // default infinite
  };
  errorMap?: (cause: unknown, attempt: number) => E;
}): Effect.Effect<LockHandle, E | FileLockError, Scope>;
```

The variance (retry cadence, error mapping) is parameterizable; the
behavior (wx-mode write, stale-PID kill -0 check, finalizer release) is
shared.

LOC: ~100 new helper + -~120 at 2 existing sites = -20 net. Fork plan
Phase 1 saves ~50 additional LOC when it uses this.

Risk: medium. Need integration tests across all 3 holder types before
fork plan Phase 1 lands.

Coordination: post a note on fork plan Phase 1 D1.1.

Tests:
- `engine/file-lock.test.ts` — stale-PID reclaim, concurrent acquire,
  finalizer release, retry exhaustion.
- Migrating tests in `port-allocator.test.ts`, `state-store.test.ts`
  pass against the new shared helper.

### 4.5 — `resolveAppDir()` trivial extraction (D11) — DONE (2026-05-18)

11 sites of `process.env.DEVSTACK_APP_DIR ?? process.cwd()`. Trivial.

LOC: ~5 new + -~22 at 11 sites = -17 net.

### 4.6 — Document the 5-step → 1-step transition — DONE (2026-05-18)

Update `packages/devstack/AGENTS.md` "Adding a service" / "Adding an endpoint"
sections to point at the new declarators.

LOC: ~50 doc lines.

### Phase 4 summary

| Item | LOC | Risk |
|---|---|---|
| 4.1 defineEndpoint | -80 net | med |
| 4.2 defineRegistry (FLIP) | -140 net | low (if flip is taken) |
| 4.3 groupX → derived | -120 | low |
| 4.4 acquireFileLock | -70 net | med |
| 4.5 resolveAppDir | -17 net | low |
| 4.6 AGENTS.md update | +50 doc | low |
| **Total** | **-~377 LOC** | low-med |

Closes W2, W3, D1, D2, D5, D6, D11 from the review.

---

## §9 Phase 7 — Long tail (defer / WONT-FIX)

Items captured in §10 Ledger with disposition `DEFER` or `KEEP`. No PR.

---

## §10 Finding ledger

All ~150 findings from the review with disposition. ACT items reference
their Phase; DEFER items have a trigger; KEEP items have rationale.

### W series (Wrong abstractions, synthesis/01) — 17 findings

| ID | Disposition | Where / Why |
|---|---|---|
| W1 — Four coin shapes | ACT | Phase 2 via coin plan |
| W2 — 8 registries | ACT (Flip 1 = ACT) | Phase 4.2 |
| W3 — groupX + ROUTER_ENTRYPOINTS | ACT | Phase 3.2 + Phase 4.1 + 4.3 |
| W4 — Discriminator drift | ACT | Phase 2.2 + 6.1 |
| W5 — LongLivedScope opt-in | ACT (via dockerContainer default) | Phase 3.1 |
| W6 — dockerContainer missing | ACT | Phase 3.1 |
| W7 — Two manifest readers | KEEP partial | Phase 1.1 deletes `fromManifest` (no consumer); Devstack Service deleted too. The asymmetry vanishes. |
| W8 — Wallet endpoint hardcoded | OPEN | Phase 2.3 / §11 Q3 |
| W9 — StateStoreKeys gap | ACT | Phase 5.1 |
| W10 — Snapshot participation missing | ACT | Phase 5.3 |
| W11 — Single vs composite tag rule | ACT (doc) | Phase 6.3 |
| W12 — provide() Object.assign mutation | DEFER (KEEP, doc invariant) | Trigger: a 4th `Object.assign` site. Until then, keep + comment. |
| W13 — `pairUrl` wallet-specific name, generic shape | ACT (doc) | Rename to `walletPairUrl` in 5.2 schema bump (alongside SnapshotMeta) |
| W14 — Codegen "second manifest" | KEEP | Earned abstraction per synthesis/01 §W14. No action. |
| W15 — Faucet lifecycle ambiguous | DEFER | Coin Phase 5 pins lifecycle. Tracked there. |
| W16 — pickCreatedByType naming | KEEP | Defensible split per R1/04 §5.5. Naming hides parameterization but only 3 functions. |
| W17 — runtime vs network-suffix fork signal | ACT (Flip 3 = ACT) | Phase 6 doc; affects fork plan Phase 1 |

### O series (Overbuild, synthesis/05) — 46 findings

Condensed; all ACT items in Phase 1 unless noted. Numbers without disposition
are KEEP/DEFER.

| ID | Disposition | Where |
|---|---|---|
| O1 — Devstack + DevstackLive | ACT | 1.1 |
| O2 — fromManifest + FromManifestOptions | ACT | 1.1 |
| O3 — ManifestEncoded | ACT | 1.2 |
| O4 — WalletHttpPath duplicate re-exports | ACT (delete /runtime; root stays for dev-wallet contract intent) | 1.1 |
| O5 — pickCreatedByTypeIncludes at root | OPEN | 1.6 / §11 Q4 |
| O6 — 6 @mysten/sui re-exports | ACT | 1.2 |
| O7 — 3 Deployment type re-exports | ACT | 1.2 |
| O8 — 5 interface tags at root | ACT (move to /advanced; SealKeyServerTag stays at root) | 1.3 |
| O9 — KnownPackage | DEFER | Fork plan Phase 3 lands example; revisit then |
| O10 — RegisterCoinOptions/Result types | ACT | 1.2 |
| O11 — Coin type | DEFER | Coin Phase 3 reuses name; track collision in Phase 2 |
| O12 — /runtime subpath | ACT | 1.1 |
| O13 — gatherManifest location | ACT (move to /advanced) | 1.1 / 3.3 |
| O14 — discoverManifestPath location | ACT (demote to internal) | 1.1 |
| O15 — EndpointName/Value location | ACT (move to /advanced) | 1.1 / 3.3 |
| O16 — Extras plumbing | ACT (demote to internal; ExtrasInput stays on /advanced) | 1.1 |
| O17 — ManifestV4 Schema re-export | ACT | 1.1 |
| O18 — DevstackShape type | ACT | 1.1 |
| O19 (×6) — dead /advanced exports | ACT | 1.4 |
| O20 — withDevstack (/vitest) | DEFER | Trigger: a real chain-mode unit test in `_template`. Until then, keep (20 LOC). |
| O21 — waitForBalanceUpdate | OPEN | §11 Q9: write a spec or delete |
| O22 — standalone playwright exports | DEFER | Trigger: real third-party playwright config |
| O23 — apiKey/apiKeyName | ACT | 1.2 |
| O24 — subsidiesPackageId | ACT | 1.2 |
| O25 — metadataId capture leaf | DEFER (wire in coin Phase 5) | Coin plan |
| O26 — Sui localnet ports override | KEEP | Escape hatch; untested but cheap |
| O27 — Package({mvr}) override | KEEP | Same |
| O28 — upgradeCapId | DEFER | Fork Phase 3 |
| O29 — Account({funding}) | DEFER | Coin Phase 5 makes it central |
| O30 — Wallet({network}) | KEEP | resolveNetwork() default works |
| O31 — DEFAULT_KEY_SERVER_PORT | ACT | 1.2 |
| O32 — walrus registerCommittee no-op | KEEP (6-month checkpoint) | Per review |
| O33 — publishSealMoveInline | KEEP | Load-bearing per round 1 |
| O34 — internal pickCreatedByTypeIncludes | covered by O5 | 1.6 |
| O35 — duplicate error re-exports | ACT | 1.5 |
| O36 — LayeredTag root re-export | KEEP | Real TS2742 guard |
| O37 — stdlib re-impl | KEEP | Confirmed none |
| O38 — /advanced plugin-author no example | ACT | 3.4 |
| O39 — Hidden-tag tests | ACT | 5.6 |
| O40 — composeLayers ordering tests | ACT | 5.6 |
| O41 — registerCoin e2e test | DEFER | Coin Phase 3 deletes the family |
| O42 — Sui buildCustom | KEEP | Per R1/03 |
| O43 — Devnet builder | KEEP | Real Sui network |
| O44 — decodeManifestV4 | ACT (deletes with O2) | 1.1 |
| O45 — state-store v1 | KEEP | No dead code |
| O46 — three default emitters | KEEP (doc in 6.6) | Phase 6.6 |

### N series (Naming inconsistencies, synthesis/02) — 11 findings

| ID | Disposition | Where |
|---|---|---|
| N1 — TagClass singular vs plural | ACT (doc) | 6.3 |
| N2 — Factory vs Tag-class collision | ACT (doc) | 6.1 |
| N3 — Coin name collision | covered | Phase 2 (coin plan) |
| N4 — Factory verb-form | ACT (doc only) | Already enforced; covered in 6.1 |
| N5 — Faucet tag-key matcher | DEFER | Coin Phase 5 changes the auto-mount predicate; revisit then |
| N6 — Error suffix `Error` | ACT (lint) | 6.2 |
| N7 — Discriminator drift | covered | Phase 2.2 / 6.1 |
| N8 — Span-name capitalization | ACT (doc + codemod opt-in) | 6.5 |
| N9 — Annotation key prefix | ACT (helper + doc) | 6.5 |
| N10 — State-store key prefix | covered | Phase 5.1 |
| N11 — Env var prefix | ACT (doc carve-out) | 6.5 |

### S series (Signature inconsistencies) — 7 findings

| ID | Disposition | Where |
|---|---|---|
| S1 — Parametric-on-Name rule | ACT (doc) | 6.3 |
| S2 — Image source shape | covered | 3.8 / 6.4 |
| S3 — Signer shape | OPEN | §11 Q7: pin to `LayeredTag<any, Account>` everywhere? |
| S4 — Ready timeout | KEEP | Category clean |
| S5 — Overloaded factory precedent | ACT (doc) | 6.1 (ratify Coin precedent) |
| S6 — Sui network-in-options asymmetry | ACT (doc) | 6.4 / 6.7 |
| S7 — Codegen output collision | ACT (doc) | 6.7 |

### E series (Error model) — 4 findings

| ID | Disposition | Where |
|---|---|---|
| E1 — Phase field shape | ACT | 6.2 |
| E2 — Cause-chain rewrap | ACT (doc) | 6.2 |
| E3 — Candidates array shape | ACT (pre-model `Record<string, unknown>` before CoinAmbiguousError lands) | 6.2 |
| E4 — Public re-export discipline | ACT (doc) | 6.2 |

### P series (Patterns) — 8 findings

| ID | Disposition | Where |
|---|---|---|
| P1 — Single vs composite | covered | 6.3 |
| P2 — Long-lived bypass | covered | 3.1 |
| P3 — Snapshot participation | covered | 5.3 |
| P4 — registerX / requireX symmetry | ACT (doc only: "state registries are read-only at finalization") | 6.2 |
| P5 — Wallet provide() Object.assign one-off | **FLIP candidate** | §10 Flip 7 |
| P6 — Per-cycle vs long-lived classification | covered | 3.1 (auto-default via dockerContainer) |
| P7 — Wallet server per-cycle vs long-lived | DEFER | Coin Phase 5 + 2.3 decision |
| P8 — Default-fill predicate shape | DEFER | Coin Phase 5 lands; table-drive then |

### PS series (Public surface) — 6 findings

| ID | Disposition | Where |
|---|---|---|
| PS1 — pickCreatedByType* at root | OPEN | 1.6 / §11 Q4 |
| PS2 — Duplicated re-exports doc | ACT (doc) | 6.4 |
| PS3 — TagIdentity TS2742 doc | KEEP (well-documented already) | — |
| PS4 — Root vs /advanced placement | ACT (doc policy) | 6.4 (one paragraph) |
| PS5 — Subpath audience doc | ACT (doc) | 6.4 |
| PS6 — Devstack/devstack/DevstackLive name trio | resolved by 1.1 (delete the latter two) | 1.1 |

### G series (Generated-code) — 7 findings

| ID | Disposition | Where |
|---|---|---|
| G1 — `as const` discipline | ACT (doc) | 6.6 |
| G2 — File mode 0o600 vs 0o644 | ACT (table in JSDoc) | 6.6 |
| G3 — Output path pin | covered | 6.7 |
| G4 — Fingerprint cache asymmetry | DEFER (doc only) | Per review |
| G5 — Network translation locality | KEEP (doc) | Per review |
| G6 — Default emitter policy | covered | 6.6 |
| G7 — gatherManifest call duplication | DEFER (low cost) | Trigger: 5th emitter |

### D series (Duplications, synthesis/03) — 23 findings

| ID | Disposition | Where |
|---|---|---|
| D1 — wx file lock | ACT | 4.4 |
| D2 — publishX registries | ACT (Flip 1 = ACT) | 4.2 |
| D3 — writeIfChanged duplication | ACT | 5.4 |
| D4 — Network-conditional facade | ACT | 3.5 |
| D5 — groupX projections | ACT (derived) | 4.3 |
| D6 — "Add a service" cookbook | ACT | 4.1 |
| D7 — State-store key construction | covered | 5.1 |
| D8 — wrapDocker rewrap | ACT | 3.6 |
| D9 — pickCreatedByType inlines | KEEP | Already extracted; inlines are different ops |
| D10 — contentHash | ACT | 3.7 |
| D11 — resolveAppDir | ACT | 4.5 |
| D12 — Per-coin RPC waterfalls | DEFER | Coin Phase 5 |
| D13 — registerCoin triple-duplication | DEFER | Coin Phase 3-4 |
| D14 — Long-lived Docker.run bypass | covered | 3.1 |
| D15 — Forked fiber + Schedule.spaced | KEEP | Idiomatic Effect |
| D16 — Snapshot participation blocks | covered | 5.3 |
| D17 — `ExtraRuntimePaths.addExtra` zero callers | **FLIP candidate** | §10 Flip 8: delete |
| D18 — buildWrapperImage vs dockerImage | ACT (widen dockerImage) | 3.1 (via dockerContainer surface) |
| D19 — String(cause) vs stringifyCause | KEEP | Two correct APIs |
| D20 — Tagged-error class shape | KEEP | Variance is real |
| D21 — Manifest-reading in emitters | KEEP | Serial, cheap |
| D22 — Inline SuiGrpcClient | KEEP | Branches-are-the-API |
| D23 — Sibling vite/playwright/vitest configs | KEEP | Already 3-line shims |

### Cross-cutting (synthesis/04) — A/W/N/D/B/M/E/P series, ~50 entries

The cross-cutting findings cover overlap with the W/N/D series above
and add some unique items. Listed here only where not already dispositioned:

| ID | Disposition | Where |
|---|---|---|
| Cross W1 — Wallet HTTP wire contract | ACT (integration test) | 5.5 |
| Cross W4 — Generated codegen import path | covered | 6.7 |
| Cross W5 — Docker label scheme | ACT (extract `engine/labels.ts`) | 4.6 (light) |
| Cross W7 — Endpoint-name registry as lint | ACT | 4.1 (declarator obviates the lint) |
| Cross W8 — WalletAppAccountInfo response shape | ACT | 5.5 |
| Cross A1-A5 — Accumulating debt | covered | 5.2 (SnapshotMeta), 5.1 (state keys), 3.1 (dockerContainer), 2.1 (coin) |
| Cross A6 — /advanced barrel growth | DEFER | Re-audit post-Phase 4 |
| Cross A7 — Error taxonomy growth | covered | 6.2 |
| Cross A8 — groupX proliferation | covered | 4.3 |
| Cross N1-N3 — Lifecycle classification | covered | 3.1 (auto via dockerContainer) |
| Cross N4 — Fork data-dir lock | covered | 4.4 |
| Cross N5 — Fiber forkScoped | KEEP | Idiomatic; doc in 6.5 if PythPusher needs it |
| Cross D1 — Snapshot participation block | covered | 5.3 |
| Cross D2 — Effect.withSpan presence | DEFER (codemod opt-in) | 6.5 trigger |
| Cross D4 — State-store key convention | covered | 5.1 |
| Cross D5 — `as const` discipline | covered | 6.6 |
| Cross B1-B4 — Browser-vs-node boundary | KEEP | Real boundary, no action |
| Cross M1 — Concurrent codegen collision | ACT (doc) | 6.7 (warn on shared output dirs) |
| Cross M2 — DEVSTACK_PORT_LOCK_DIR | KEEP (doc) | Already enforced |
| Cross M3 — Traefik YAML collision | KEEP | Hostname-prefix already mitigates |
| Cross M4 — Fork data-dir lock | covered | 4.4 |
| Cross M5 — Vitest pool:'forks' | KEEP | Load-bearing; doc in 6.5 |
| Cross M6 — Manifest emission single-writer | KEEP | State-store lock guards |
| Cross E1-E5 — Example-apps | KEEP | What's working |
| Cross P1-P11 — What works | KEEP | Don't disturb |

### Architecture friction (synthesis/00) — 20 entries

Most overlap with W/N/D series. Unique items:

| ID | Title | Disposition | Where |
|---|---|---|---|
| F4 — StackMember vs LayeredTag | ACT (doc) | 6.3 |
| F7 — 7 hardcoded Traefik entrypoints | covered | 3.2 |
| F11 — gRPC mid-migration status | DEFER | Fork plan Phase -1 completes |
| F13 — Four capture passes | KEEP | Architecture description; no action |
| F14 — h2c protocol field | covered | 3.1 (dockerContainer.routing.protocol) |
| F17 — Postgres PGDATA env override | KEEP | Documented workaround |
| F18 — Fork upstream-cache directory | DEFER | Fork plan to decide refcount/GC |
| F19 — Annotation/span style | covered | 6.5 |
| F20 — provide() mutation pattern | covered | W12 |

---

## §11 Open questions — all DECIDED (2026-05-18)

| # | Topic | Decision | Where in plan |
|---|---|---|---|
| Q1 | SnapshotMeta `services` typing | TS interface via declaration merging | Phase 5.2 |
| Q2 | dockerContainer API shape | Integrated single call | Phase 3.1 |
| Q3 | Wallet `options.name` | Singleton — drop the param | Phase 2.3 |
| Q4 | `pickCreatedByTypeIncludes` fate | Collapse with siblings (Flip 5) | Phase 1.6 |
| Q5 | dockerContainer parametricity | `LayeredTag<Name, Handle>` | Phase 3.1 |
| Q6 | `acquireFileLock` consolidation | Extract now | Phase 4.4 |
| Q7 | Signer shape | Standardize on `LayeredTag<any, Account>` | Phase 6.9 |
| Q8 | Image source narrowing | `string` → `{pull: string}` | Phase 3.8 |
| Q9 | `waitForBalanceUpdate` | Delete | Phase 1.5b |
| Q10 | Coin plan coordination | Phase 1 deletes types only; function waits for coin P3 | Phase 1.2 |

---

## §12 Flips to decide

Each flip is "my recommendation differs from the review's verdict." You
decide each one before the relevant phase commits.

### Flip 1 — `defineRegistry<T>()` extraction (W2/D2, Phase 4.2) — DECIDED: ACT (2026-05-18)

Extract `defineRegistry<TName, TRecord>()`. -140 LOC net. See Phase 4.2.

### Flip 2 — `groupX` projections become derived (D5, Phase 4.3)

**Review verdict**: STAY (Tier C). Rationale: 5 hand-written groupers are
defensible.

**My recommendation**: ACT. After 4.1's `defineEndpoint` lands, groupers
are trivially derived from declarations; the hand-written ones become dead.

**Rationale for flip**: This is a consequence of 4.1, not an independent
flip. If 4.1 lands, 4.3 is free.

→ DECIDE: [STAY | ACT | depends on 4.1]

### Flip 3 — Fork `runtime` derived from network (W17) — DECIDED: ACT (2026-05-18)

Pick network-string as source of truth. `runtime` becomes a computed
property on the `Sui` interface:

```ts
type Sui = {
  network: string;
  fork?: ForkControl;
  get runtime(): 'bundled' | 'external' | 'forked';
  // computed: this.fork ? 'forked'
  //         : network.startsWith('external:') ? 'external'
  //         : 'bundled'
};
```

User API unchanged: `Sui({network: 'mainnet-fork', fork: {...}})`.

**Impact on fork plan**: Phase 1 must stop declaring `runtime` as a separate
option on the `Sui` factory. The internal `Sui` interface still exposes
`runtime` (now as a getter); consumers (codegen, DappKitConfigEmitter)
read it the same way. No external API change.

→ Coordinate edit to fork plan Phase 1 D1 before fork lands its
runtime-option work.

### Flip 4 — Plan ordering — DECIDED: ACT (visible-first, 2026-05-18)

Phase 1 / 3 / 4 / 6 land first (visible to users + plugin authors).
Phase 5 (substrate) lands in parallel but is required before deepbook
Phase 2 + fork Phase 2 (those plans depend on SnapshotMeta bucket +
StateStoreKeys being in place).

### Flip 5 — `pickCreatedByType*` collapse — DECIDED: ACT (2026-05-18)

Collapse 3 named pickers into one `pickCreatedByType(changes, {suffix?,
includes?, prefix?, all?})` at `/advanced`. See Phase 1.6.

### Flip 6 — Wallet `Object.assign` mutation — DECIDED: ACT (2026-05-18)

Replace `services/wallet.ts:35` `Object.assign(walletApp(...), {__kind:
'app'})` with `provide(WalletAppTag, ...)`. See Phase 5.7.

### Flip 7 — `ExtraRuntimePaths.addExtra` — DECIDED: delete (2026-05-18)

Delete the mutator; `extras` becomes a readonly constructor-set field.
See Phase 5.8.

---

## §13 Relation to existing three plans

### coin-auto-discovery.md (5 phases, blocked)

| Coin phase | This plan's relation |
|---|---|
| Phase 0 (discovery primitives — done) | none |
| Phase 1 (widen CoinRecord/CoinEntry) | depends on Phase 5.2 (SnapshotMeta) landing first if the manifest bump happens together |
| Phase 2 (publishMove uses discovery) | independent |
| Phase 3 (Coin factory replaces registerCoin) | Phase 1.2 leaves `registerCoin` until coin Phase 3 lands; coin Phase 3 drives its own deletion |
| Phase 4 (drop options.coins/capture) | this plan's 1.6 + 1.3 align with coin Phase 4's `capture` move |
| Phase 5 (Faucet to /advanced; CoinsEmitter) | this plan's 6.6 documents the default-emitter policy CoinsEmitter slots into |

### deepbook-plugin-expansion.md (6 phases, ~7900 LOC)

| Deepbook phase | This plan's relation |
|---|---|
| Phase 0 (DX foundations — done) | none |
| Phase 1 (Pyth — done) | none |
| Phase 2 (Postgres + Indexer) | **depends on this plan's 3.1 + 4.1 landing first.** With dockerContainer + defineEndpoint, Phase 2's 5 new services become 5 declarations, not 25 file edits. |
| Phase 3 (DeepbookServer) | depends on Phase 4.1 (defineEndpoint) |
| Phase 4 (Margin) | depends on coin Phase 3 (Coin factory) for asset typing |
| Phase 5 (codegen + reference app) | independent |

### sui-fork-integration.md (5+1 phases)

| Fork phase | This plan's relation |
|---|---|
| Phase -1 (gRPC migration — done) | none |
| Phase 1 (minimal fork mode) | **affected by Flip 3** (runtime discriminator). If flip taken, this phase's `runtime: 'forked'` option becomes inferred. |
| Phase 2 (impersonation accounts) | independent |
| Phase 3 (plugin compat) | independent; benefits from 3.5 (`resolveDeploymentNetwork`) |
| Phase 4 (CLI + snapshots + doctor) | benefits from Phase 5.2 (SnapshotMeta `services.fork` slice replaces 3 loose optionals) |
| Phase 5 (opt-in exploration) | independent |

---

## §14 Risks & test impact

**Highest-risk items:**

1. **Phase 3.1 dockerContainer finalizer scoping**. Migrating sui/walrus/seal
   to long-lived-by-default may surface latent bugs in services that today
   are silently per-cycle. Each migrated service needs a hot-restart
   integration test pass.
2. **Phase 5.2 SnapshotMeta v5 → v6 schema bump**. The loader rejects v5
   outright; snapshot capture/restore tests cover only v6. Pre-existing v5
   snapshots are invalidated; the user re-runs `apply` to regenerate.
3. **Phase 4.1 defineEndpoint schema extension hook**. The schema-extension
   composition must type-check correctly for both `services.postgres`
   (deepbook Phase 2 user) and existing `services.{sui,seal,walrus,deepbook}`
   incumbents.
4. **Phase 1.3 interface-tag relocation**. Moving `CoinTag` etc. from root
   to `/advanced` is breaking; the package is unreleased so no migration
   overlap is needed. The example apps move in the same pass.

**Test changes by phase:**

| Phase | New tests | Modified |
|---|---|---|
| 1 | runtime-subpath-gone.test.ts | index.test.ts PUBLIC_EXPORTS pin (multi-line) |
| 3 | docker-container.test.ts + plugin-author example e2e | snapshot.docker.test.ts (verify no regression) |
| 4 | define-endpoint.test.ts + define-registry.test.ts | runtime/service.test.ts (groupers gone) |
| 5 | wallet protocol integration + hidden-tag + composeLayers + state-keys | snapshot tests for v5→v6 bump |
| 6 | TaggedErrorClass-phase-shape lint test | — |

---

## §15 Decision log (all 17 dispositioned as of 2026-05-18)

| ID | Topic | Decision |
|---|---|---|
| Q1 | SnapshotMeta `services` typing | TS interface via declaration merging |
| Q2 | dockerContainer API shape | Integrated single call |
| Q3 | Wallet `options.name` | Singleton — drop the param |
| Q4 | pickCreatedByType* fate | Collapse (Flip 5) |
| Q5 | dockerContainer parametricity | `LayeredTag<Name, Handle>` |
| Q6 | `acquireFileLock` extraction timing | Now (2 existing + fork sig) |
| Q7 | Signer shape | Standardize on `LayeredTag<any, Account>` |
| Q8 | Image source narrowing | `string` → `{pull: string}` |
| Q9 | `waitForBalanceUpdate` | Delete |
| Q10 | Coin plan coordination | Phase 1 deletes types; function waits for coin P3 |
| Flip 1 | `defineRegistry<T>()` extraction | ACT |
| Flip 2 | `groupX` projections derived | ACT (auto from Flip 1) |
| Flip 3 | Fork `runtime` discriminator | ACT — derive from network |
| Flip 4 | Phase ordering | ACT — visible-first |
| Flip 5 | `pickCreatedByType*` collapse | ACT |
| Flip 6 | Wallet `Object.assign` | ACT — `provide(WalletAppTag, ...)` |
| Flip 7 | `ExtraRuntimePaths.addExtra` | Delete |

All flips closed. All open questions dispositioned. The plan is ready to
execute when:
- Coin plan unblocks (Phase 2)
- Fork plan owner ratifies Flip 3 edit (the only cross-plan dependency)

Plan-mode handoff: see `~/.claude/plans/resume-fluffy-koala.md` for the
plan-mode shell that drove this document's final edits.

---

## §16 Numbered findings index

For navigation:

- W = Wrong abstractions (synthesis/01); 17 findings
- O = Overbuild/dead code (synthesis/05); 46 findings
- N = Naming inconsistencies (synthesis/02); 11 findings
- S = Signature inconsistencies (synthesis/02); 7 findings
- E = Error model (synthesis/02); 4 findings
- P = Patterns (synthesis/02); 8 findings
- PS = Public surface (synthesis/02); 6 findings
- G = Generated-code (synthesis/02); 7 findings
- D = Duplications (synthesis/03); 23 findings
- Cross = Cross-cutting (synthesis/04); ~50 entries
- F = Architecture friction (synthesis/00); 20 entries

Total dispositioned: ~199 (some are duplicates across syntheses; net unique
~150).
