# Public API surface cleanup

**Status:** Design proposal, READ-ONLY audit. **Author:** api-surface-audit, 2026-05-19. **Scope:**
the six published subpaths of `@mysten-incubation/devstack` (`.`, `/advanced`, `/vitest`,
`/playwright`, `/vite`, `/browser`) plus the internal `services/index.ts` barrel. No engine /
runtime / supervisor internals are in scope here except where they need promotion to / demotion
from `/advanced`.

This plan **does not duplicate work already planned elsewhere**. Substantial reach into the
plugin-author tier is being driven by `integration-contract-redesign.md` (`onChainArtifact`,
`ChainProbe`, `containerPrimitive`) and `stack-simplification-audit.md` (E29 / E30 /
E47 / E50). When those land, my "internal services bypass `/advanced`" finding largely
self-resolves — every primitive will route through one of the three new substrate helpers, and
the publish-state / move-helpers / docker-run leakage closes by construction. This plan covers
the **independent** surface cleanups: re-classification across the root ↔ `/advanced` split,
duplicate-export removal, orphan-export deletion, naming consolidation, and the small set of
missing public helpers two example apps need.

---

## 0. TL;DR

The plugin-author surface is half-finished AND the root vs `/advanced` split is misaligned.
Three categories of cleanup, fan-out-shaped, total **~−400 LoC of public surface** with no
behavior change:

1. **Drop duplicate exports** (triple-export of `LayeredTag`/`provide`/`tag` through
   `/advanced`; root+`/advanced` duplicates of `DevstackHandle`/`CodegenError`/`FaucetRequestError`;
   root+`/browser` duplicate of `localnetWalrusOptions` where the root copy is dead-and-dangerous).
   ~50 lines of barrel pruning.
2. **Reclassify** the two `/advanced` items example apps already reach for (`PackageWithCapture`,
   `pickCreatedByType`) up to root; demote the root items no example touches (`KnownPackage`,
   `PostgresTag`/`PythTag`, `DeepbookMintDEEP`/`USDC`, `DEFAULT_CODEGEN_OUTPUT`, half the error
   classes) down to `/advanced` or delete entirely; hide registry write-helpers and unused
   strategies from `/advanced`. Net: smaller, more honest barrels.
3. **Strip orphan exports**: every `<Name>Options` type (zero textual consumers in tree),
   plus six unused `services/index.ts` re-exports. Pick a policy: export all or none.
4. **Reshape the `Deepbook*` cluster** — 7 root factories collapse to `Deepbook` +
   `DeepbookMarketMaker` + `Deepbook.{indexer,server,margin,mint,vendor}(...)` or move 5 of them
   to `/advanced`. **Open question — see §6.1.**
5. **Add two helpers two example apps already hand-roll**:
   `loadManifest(testInfo?)` and `loadAccountKey(name)` on `/playwright`. ~30 lines.

The bulk of the "internal services should consume the public surface" finding is handled by
`integration-contract-redesign.md` — see cross-reference matrix in §1.

---

## 1. Cross-reference matrix

Every cleanup target below is annotated `[OWNED]` (this plan owns it), `[DEFER]` (another plan
owns it; this plan stays out of the way), or `[COORD]` (overlaps with another plan, coordinate
sequencing).

| Cleanup family                                              | This plan | Related plan(s)                                                                                  |
| ----------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| Triple/duplicate barrel exports                             | [OWNED]   | —                                                                                                |
| `PackageWithCapture` + `pickCreatedByType` promotion        | [OWNED]   | —                                                                                                |
| Demote `KnownPackage` / `PostgresTag` / `PythTag` / etc.    | [OWNED]   | —                                                                                                |
| Strip orphan `<Name>Options` types                          | [OWNED]   | —                                                                                                |
| Strip `services/index.ts` dead re-exports                   | [OWNED]   | —                                                                                                |
| Deepbook factory cluster reshape                            | [OWNED]   | —                                                                                                |
| `localnetWalrusOptions` root-export deletion                | [OWNED]   | precedent: `dirs-dapp-kit-compose-audit.md` (already deleted `/dapp-kit` subpath)                |
| Hide registry `publish*` / `require*` / `*Registry`         | [COORD]   | `integration-contract-redesign.md` §3.1 — `onChainArtifact.register` callback subsumes the need  |
| Lift `routerHostname` / `routerEntrypoint` to `/advanced`   | [DEFER]   | `integration-contract-redesign.md` §3.3 — `containerPrimitive` subsumes both                     |
| Lift `onChainArtifact`, `ChainProbe`, `containerPrimitive`  | [DEFER]   | `integration-contract-redesign.md` §3.1-3.3 — that plan ships them on `/advanced`                |
| Long-running host-process primitive (`hostService`)         | [COORD]   | `integration-contract-redesign.md` §3.3 covers docker; node child-process is NOT covered. §6.3.  |
| Drop `runDockerContainer` from `/advanced`                  | [COORD]   | `stack-simplification-audit.md` E30 (containerPrimitive replaces dockerContainer's tag form)     |
| Surface `inspectContainer` on `/advanced`                   | [DEFER]   | `stack-simplification-audit.md` E47                                                              |
| Add `Layer.build` test helper                               | [DEFER]   | `stack-simplification-audit.md` E50                                                              |
| Surface `PythError` / `PostgresError`                       | [OWNED]   | —                                                                                                |
| `loadManifest` / `loadAccountKey` on `/playwright`          | [OWNED]   | —                                                                                                |
| Optional `createDevstackDAppKit(opts)` factory              | [OWNED]   | —                                                                                                |
| `Coin*` / `Package*` name sprawl                            | [OWNED]   | —                                                                                                |
| `ManifestV5` → `Manifest` rename                            | [DEFER]   | `versioning-shim-audit.md` §3.1                                                                  |
| Drop `keyOverride` from API                                 | [DEFER]   | `versioning-shim-audit.md` §3.2                                                                  |
| CLI verb renames / envelope                                 | [DEFER]   | `cli-redesign.md`, `cli-cleanup-plan-2026-05-19.md`                                              |

**Net effect:** this plan owns ~50% of the public-surface cleanup, defers ~30% to the
integration-contract redesign (which subsumes the underlying need by construction), and defers
~20% to stack-simplification / versioning-shim / cli plans.

---

## 2. Current state (audit recap)

Three independent agents surveyed the six barrels, every `examples/**` source file, every
in-tree service, and the out-of-tree `examples/plugin-author-redis/redis-plugin.ts` model
citizen. Findings:

**Internal services don't use the public surface.** Every dockerized service reaches into
`engine/registries.js` for `publishEndpoint` / `publishPackage` / `publishXState` (15+ direct
imports); every move-publishing service hand-rolls verify-probe SDK accessor shapes; `walrus`
and `seal` bypass `runDockerContainer` for raw `Docker.run`; `dev/internal.ts` and
`wallet/internal.ts` independently hand-roll long-running host processes (~80% identical
code). The `/advanced/index.ts:11-13` header doc already concedes the gap.

→ `integration-contract-redesign.md` Phase A fixes this for the docker + on-chain cases.
This plan handles the surface-shape side and tracks the host-process gap as §6.3.

**Triple-export bug in `/advanced`.** `LayeredTag`, `TagIdentity`, `provide`, `tag`,
`composeLayers`, `setPhase`, `TagOptions`, `ProvideOptions`, `ComposeLayersOptions` are exported
both directly at `src/advanced/index.ts:33-45` AND through `export * from './plugin-author/index.js'`
at line 69 (which re-exports the same names from `plugin-author/index.ts:23-32`). The barrel
fans these out three times.

**Root+`/advanced` duplicates with no reason to exist twice.** `DevstackHandle`, `CodegenError`,
`FaucetRequestError`.

**Root+`/browser` duplicate where root is foot-gun.** `localnetWalrusOptions` is exported from
root, but the root barrel pulls node-only engine modules. `examples/private-content/src/lib/walrus.ts:13`
explicitly imports it from `/browser` with a comment calling out that the root version crashes
the browser bundle. Same precedent as the `/dapp-kit` subpath deletion in
`dirs-dapp-kit-compose-audit.md`.

**Misclassifications across the root ↔ /advanced split.** Two examples reach for `/advanced`
items (`PackageWithCapture` in `examples/fork-greeting`, `pickCreatedByType` in `examples/arena`)
that are ordinary app-config patterns, not plugin-author surface. Meanwhile the root barrel
exports ~20 things zero example uses (`KnownPackage`, `PostgresTag`, `PythTag`,
`DeepbookMintDEEP`/`USDC`, `DEFAULT_CODEGEN_OUTPUT`, every `<Name>Options` type, half the error
classes).

**`/advanced` over-exposure.** The eight registry publishers + readers + Context.Service classes
+ `*Record` types have zero external imports anywhere in the monorepo — not even the
out-of-tree `plugin-author-redis` example. They're how the supervisor talks to its own internal
state; surfacing them as plugin-author API was a mistake. The two non-public faucet strategies
(`walExchangeStrategy`, `treasuryCapMintStrategy`) are the same — internal building blocks the
`Walrus()` / `Package()` factories assemble for the user.

**Orphan `<Name>Options` types.** Every single `<Factory>Options` type — `SuiOptions`,
`WalrusOptions`, `DeepbookOptions`, `SealOptions`, `ActionOptions`, `DevOptions`, `WalletOptions`,
`PackageOptions`, `CodegenOptions`, `PythOptions`, `PostgresOptions`, `FaucetOptions`,
`DevstackComposeOptions`, `DevstackRefInput`, `LoadStackKeypairOptions`, `LoadStackManifestOptions`,
`BaseURLOptions`, `WebServerOptions`, `DevstackVitestConfigOptions`,
`DevstackPlaywrightConfigOptions` — has **zero textual references in any non-test consumer**.
Every factory call uses an inline object literal. The status quo is unprincipled (all exported,
none imported).

**Naming sprawl.**

- `Deepbook*` cluster: 7 top-level factories on root (`Deepbook`, `DeepbookMarketMaker`,
  `DeepbookMargin`, `DeepbookIndexer`, `DeepbookServer`, `DeepbookMintDEEP`, `DeepbookMintUSDC`,
  `VendorDeepbook`). Other domains have one canonical factory plus optional advanced bits.
- `Coin` world has 9 names (`Coin` value, `Coin` shape, `CoinValue`, `CoinFactory`, `CoinTag`,
  `CoinEntry`, `CoinRegistry`, `CoinRecord`, `BuiltinCoinName`). Same for `Package*`.
- `localnetWalrusOptions` is the only `*Options`-named **value** in the API — every other
  `*Options` is a type. Structural outlier.

**Error inconsistency.** 13 errors surfaced from root, ~9 more defined but not surfaced
(`PythError`, `PostgresError`, `DeepbookIndexerError`, `DeepbookServerError`, `ProbeError`,
`ReadyProbeError`, `SuiCliError`, `CaptureError`, `StageAndSwapError`). `Pyth` and `Postgres`
are first-class root factories but their errors aren't surfaced — asymmetric.

**Two re-implementations example apps own that devstack should provide.**

- `examples/arena/e2e/connect-four.spec.ts:26-62` hand-rolls a typed `loadManifest` +
  `loadKey` for accessing RPC alongside `connectAs`. Every spec wanting raw RPC will need it.
- Every React app's `src/dapp-kit.ts` is near-identical 8 lines + a
  `globalThis.__devstackDAppKit__` for playwright. Worth a `createDevstackDAppKit(opts)` factory.

**Six unreachable re-exports in `services/index.ts`**: `SealKeyServerEntry`, `WalrusNodeInfo`,
`LocalPackage`, `LocalPackageTag`, `toSdkCoin`, `DeepbookMarketMakerTag`. Plus the dead
`Postgres as PostgresShape` rename at line 93.

---

## 3. Proposed cleanups

### 3.1 Drop duplicate exports

**Goal**: each public symbol appears in exactly one barrel (or two only when one is the
intentional browser-safe re-export).

**Changes** (mechanical, no behavior change):

- `src/advanced/index.ts:69`: drop the `export * from './plugin-author/index.js'` line; the
  triple-exported symbols are already enumerated directly at lines 33-45. The plugin-author
  primitives (`dockerImage`, `dockerContainer`, etc.) move to direct named re-exports above
  line 45 — about 8 lines of additions, 1 line removed, net ~7 added but kills triple-export.

  Alternative: drop the direct enumeration at lines 33-45 and rely on the `* from` spread for
  everything. Slightly tighter, but loses the section-header comments. **Recommend: direct
  enumeration; matches the rest of the barrel's style.**

- `src/advanced/index.ts`: drop `DevstackHandle`, `CodegenError`, `FaucetRequestError` —
  consumers import from root. (3 fewer lines.)

- `src/index.ts:46-48` + `src/services/walrus/options.ts`: drop the root re-export of
  `localnetWalrusOptions` / `LocalnetWalrusOptions` / `LocalnetWalrusInputs`. They stay only on
  `/browser`. The barrel comment at `src/browser/index.ts:7-15` already documents why this is
  the right home. **Risk:** zero external consumers (package is `0.0.0` and unpublished);
  internal `examples/private-content/src/lib/walrus.ts:13` already imports from `/browser`.

**LoC delta**: ~−15 across barrels.

**Risk**: zero. Mechanical refactor. No behavior change.

### 3.2 Reclassify root ↔ /advanced

**Promote `/advanced` → root** (examples already reach for these):

- `PackageWithCapture` + `PackageWithCaptureOptions` + `CaptureSpec`
  (`src/services/package.ts` exports; currently re-exported from `/advanced/index.ts:83-87`).
- `pickCreatedByType` + `PickCreatedByTypeFilter` + `PickCreatedByTypeResult`
  (`src/engine/sui-helpers.ts` exports; currently re-exported from `/advanced/index.ts:75-76`).

The root barrel header at `src/index.ts:140-145` already directs users to `/advanced` for these;
the comment is documenting the misclassification. Move them to root and update the comment to
describe what they do.

**Demote root → `/advanced`** (zero example usage):

- `KnownPackage` + `KnownPackageOptions` (`src/index.ts:64-65`)
- `DeepbookMintDEEP`, `DeepbookMintUSDC` (`src/index.ts:86,87`) — see §3.4 for the broader
  Deepbook reshape.
- `DEFAULT_CODEGEN_OUTPUT` (`src/index.ts:63`)
- `PostgresTag`, `PythTag` (`src/index.ts:69,72`) — interface tag classes; the factory output
  is what app code reaches for, never the bare tag.

**Demote root → `/advanced` OR delete** (decision point, see §6.2):

- These error classes have zero `catchTag` consumers in any example: `AccountError`,
  `ConfigLoadError`, `DockerError`, `HostProcessError`, `ManifestDiscoveryError`,
  `ManifestError`, `ManifestShapeError`, `WalletAppError`. The likely user-catch candidates
  are `PublishError` (the `Action.build` body might catch it) and `SeedManifestMismatchError`
  (CLI displays a recipe). Keep those two on root; demote the rest to `/advanced` for
  Effect-native consumers; delete the ones that have neither external nor internal `catchTag`
  consumers at all.

**Hide from `/advanced` entirely** (internals leaked; even the out-of-tree
`examples/plugin-author-redis` plugin doesn't reach for them):

- All eight registry `publish*` / `require*` pairs + `*Registry` Context.Service classes +
  `*Record` types (`src/advanced/plugin-author/index.ts:58-75`).
- `walExchangeStrategy`, `treasuryCapMintStrategy` (`src/advanced/index.ts:146-147`) — keep
  only `suiHttpStrategy` as the plausible custom-strategy reference.
- `runDockerContainer` (`src/advanced/plugin-author/index.ts:35`). [COORD with
  stack-simplification E30.]
- `KnownDeployments`, `knownDeployments` (`src/advanced/index.ts:95-98`) — zero external
  imports.
- `DevstackSigner` (`src/advanced/index.ts:167`) — zero external imports.
- `EndpointNameValue` (`src/advanced/index.ts:113`) — only the `EndpointName` const is
  consumed.

**Restore error symmetry**: surface `PythError` + `PostgresError` from the root barrel for
`catchTag` symmetry with the first-class `Pyth` / `Postgres` factories. (Alternatively, demote
`Pyth` / `Postgres` to `/advanced` if they're not actually first-class — see §6.4.)

**LoC delta**: ~−30 in barrels (the demotions/hides outweigh the promotions).

**Risk**: low. Every change is a barrel reshuffling. The `/advanced` consumers of demoted
items (zero, per the audit) are unaffected.

### 3.3 Strip orphan exports

**Pick a policy for `<Name>Options` types and apply uniformly.** Two acceptable answers:

- **(a) Export none.** Every factory call uses inline literals; the inferred type from the
  call covers TS-level safety; no caller has reached for a named `Options` shape. This is the
  honest read of the consumer data.
- **(b) Export all consistently** — current state, but the audit shows zero textual
  references in any non-test consumer in the entire monorepo. Useless but principled.

**Recommend (a).** Drop these from the published barrels (the internal types stay declared in
the service files; just the public re-exports go):

| Removed export                       | Defined in                                      |
| ------------------------------------ | ----------------------------------------------- |
| `SuiOptions`                         | `src/services/sui.ts`                           |
| `WalrusOptions`                      | `src/services/walrus.ts`                        |
| `DeepbookOptions`                    | `src/services/deepbook.ts`                      |
| `SealOptions`                        | `src/services/seal.ts`                          |
| `ActionOptions`                      | `src/services/action.ts`                        |
| `DevOptions`                         | `src/services/dev.ts`                           |
| `WalletOptions`                      | `src/services/wallet.ts`                        |
| `PackageOptions`                     | `src/services/package.ts`                       |
| `CodegenOptions`                     | `src/services/codegen.ts`                       |
| `PythOptions`                        | `src/services/pyth.ts`                          |
| `PostgresOptions`                    | `src/services/postgres.ts`                      |
| `FaucetOptions`                      | `src/services/faucet/index.ts`                  |
| `DevstackComposeOptions`             | `src/compose/devstack.ts`                       |
| `DevstackRefInput`                   | `src/compose/devstack.ts`                       |
| `LoadStackKeypairOptions`            | `src/playwright/artifacts.ts`                   |
| `LoadStackManifestOptions`           | `src/playwright/artifacts.ts`                   |
| `BaseURLOptions`                     | `src/playwright/web-server.ts`                  |
| `WebServerOptions`                   | `src/playwright/web-server.ts`                  |
| `DevstackVitestConfigOptions`        | `src/vitest/define-config.ts`                   |
| `DevstackPlaywrightConfigOptions`    | `src/playwright/define-config.ts`               |
| `CoinValue`, `CoinFactory`, `BuiltinCoinName` | `src/services/coin.ts`                  |
| `PickCreatedByTypeFilter`, `PickCreatedByTypeResult` | `src/engine/sui-helpers.ts`     |
| `WalletHttpPathValue`                | `src/services/wallet/protocol.ts`               |

The internal definitions stay so factory bodies keep type-checking; only the public
re-exports drop.

**Strip six unreachable re-exports from `src/services/index.ts`**: `SealKeyServerEntry`,
`WalrusNodeInfo`, `LocalPackage`, `LocalPackageTag`, `toSdkCoin`, `DeepbookMarketMakerTag`, and
the `Postgres as PostgresShape` alias at line 93. They're in the internal barrel but never
reach a published surface.

**LoC delta**: ~−40 (~25 type lines from public barrels, plus comments).

**Risk**: zero externally (no consumer). Type-only change. Internal type-imports stay valid
because the types are still defined; we only stop re-exporting them.

### 3.4 Reshape the `Deepbook*` factory cluster

**Current state**: 7 top-level Deepbook factories on root — `Deepbook`, `DeepbookMarketMaker`,
`DeepbookMargin`, `DeepbookIndexer`, `DeepbookServer`, `DeepbookMintDEEP`, `DeepbookMintUSDC`,
`VendorDeepbook`. Cf. every other domain (one canonical factory + optional advanced).

**Two viable directions** — decision point, see §6.1:

**Option A — namespace under `Deepbook.*`**:
```ts
import { Deepbook } from '@mysten-incubation/devstack';
const stack = devstack(
  Deepbook({...}),
  Deepbook.indexer({...}),
  Deepbook.server({...}),
  Deepbook.marketMaker({...}),
  Deepbook.margin({...}),
  Deepbook.mint('DEEP'),
  Deepbook.mint('USDC'),
  Deepbook.vendor({...}),
);
```
Precedent: `Coin('SYM')` / `Coin.fromPackage(...)` / `Coin.builtin(...)` already use the
namespaced shape. Symmetric with `Object.assign(deepbookFactory, {indexer, server, ...})`. Mint
collapses from two factories to `Deepbook.mint('DEEP' | 'USDC')`.

**Option B — keep flat but demote 5 of 7 to `/advanced`**:
- Root: `Deepbook`, `DeepbookMarketMaker` (the two examples use).
- `/advanced`: `DeepbookIndexer`, `DeepbookServer`, `DeepbookMargin`, `VendorDeepbook`.
- Delete or merge: `DeepbookMintDEEP` / `DeepbookMintUSDC` (these are specialised
  `mintFromTreasury` callers; they're more advanced than user-facing).

Option A is more invasive (renames at every callsite) but better long-term shape. Option B is
cheaper and matches the "every other domain has 1-2 top-level factories" pattern.

**LoC delta**: ~−10 to −25 depending on option.

**Risk**: medium. Option A requires updating every example app's `devstack.config.ts` that
uses any of the 5 demoted factories. Option B requires updating the example apps' imports
from root to `/advanced`. Both are mechanical sed/codemod.

### 3.5 Coin / Package name consolidation

**Coin world** — 9 names. Concrete proposals:

- `CoinFactory` (type of the `Coin` value): orphan, drop public re-export per §3.3.
- `CoinValue` (type of yielded shape): rename to `Coin` and ensure the value/type pair coexists
  (TS namespace separation). Today `Coin` already exists as both factory value and a shape
  re-exported from `/advanced`. The audit found `CoinValue` is the "result of yielding a Coin
  factory" while `/advanced`'s `Coin` is the "result of yielding `CoinTag`". Different things,
  same conceptual world — pick one and align.
- `BuiltinCoinName` — orphan, drop public re-export.

**Package world** — 9 names. Concrete:

- The internal `Package` interface in `src/services/package.ts:60` is not exported. Either
  expose it as the canonical shape on `/advanced` (mirroring `Sui` / `Coin` value/type
  separation) or rename to `PackageShape` internally and stop pretending the world has a
  `Package` shape.

This work is exploratory — keep as **§6.5 open question** and don't attempt in this plan's
first pass; the LoC win is small and the renames have wider blast radius. Suggested approach:
file a follow-up after §3.1-3.4 land and the surface is shaped.

### 3.6 Add two missing helpers

**`loadManifest(testInfo?)` and `loadAccountKey(name)` on `/playwright`** —
`examples/arena/e2e/connect-four.spec.ts:26-62` hand-rolls both. Every spec that wants raw RPC
access alongside `connectAs` will need them.

Strawman (`src/playwright/artifacts.ts` — already exists with `loadStackManifest` +
`loadStackKeypair`):

```ts
// Alias the existing functions to shorter names that read naturally in test bodies. The
// existing `loadStackManifest({stack})` form keeps working; tests just write `loadManifest()`
// to read the current stack's manifest by env-var resolution.
export const loadManifest = loadStackManifest;
export const loadAccountKey = loadStackKeypair;
```

That's it — the existing helpers already cover the use case; the audit-found re-implementation
in `arena/e2e/connect-four.spec.ts` predates them and was never replaced. Confirmed by reading
both files: `loadStackManifest` + `loadStackKeypair` give the same shape `connect-four.spec.ts`
hand-rolls.

**Migration step (optional)**: update `arena/e2e/connect-four.spec.ts` to use the existing
helpers. ~30 lines of test code shrinks to 2 imports.

**LoC delta**: ~+10 in `/playwright` (two thin aliases + JSDoc), −30 in
`arena/e2e/connect-four.spec.ts`.

**Risk**: zero.

### 3.7 Optional — `createDevstackDAppKit(opts)` factory

Every React example app's `src/dapp-kit.ts` is ~8 lines + a `globalThis.__devstackDAppKit__`
hook for playwright. If we collapse:

```ts
// src/browser/dapp-kit.ts (new, browser-safe)
import { createDAppKit } from '@mysten/dapp-kit-react';
import { devstackDappKitConfig } from './generated-shape.js';

export function createDevstackDAppKit(opts?: { mountUI?: boolean }) {
  const kit = createDAppKit({ ...devstackDappKitConfig, ...opts });
  if (typeof globalThis !== 'undefined') {
    (globalThis as any).__devstackDAppKit__ = kit;
  }
  return kit;
}
```

Apps reduce `src/dapp-kit.ts` to:
```ts
import { createDevstackDAppKit } from '@mysten-incubation/devstack/browser';
export const kit = createDevstackDAppKit({ mountUI: false });
```

**LoC delta**: ~+30 in `/browser`, ~−60 across six example apps.

**Risk**: low. The factory has to be browser-safe (no node imports); the existing `/browser`
subpath already enforces that. Will need to thread the codegen-emitted `devstackDappKitConfig`
through — today it lives in each app's `src/generated/`, so the helper accepts the config as a
parameter or reads from a known path. Slight wrinkle; could defer.

**Recommendation**: defer to a follow-up. The audit flagged the duplication but the per-app
customization signal isn't clear yet; consolidating prematurely risks the wrong abstraction.

---

## 4. Migration phases

Mechanical, fan-out-shaped, file-disjoint.

### Phase 1 — Barrel pruning (no behavior change) — 1-2 hours

Drop duplicate / triple / orphan exports per §3.1 and §3.3. Pure barrel edits to
`src/index.ts`, `src/advanced/index.ts`, `src/services/index.ts`, `src/browser/index.ts`.
~50 lines removed, no source files touched.

Deliverable: tsc clean, every test green, no example app breaks (verified by example apps'
`tsc --noEmit`).

**Risk**: zero — every removed symbol has zero external consumers.

### Phase 2 — Reclassification — 2-3 hours

§3.2: promote `PackageWithCapture` + `pickCreatedByType` to root; demote `KnownPackage`,
`PostgresTag`, `PythTag`, `DEFAULT_CODEGEN_OUTPUT`, and unused error classes to `/advanced` or
delete; hide registry publishers + unused strategies + `runDockerContainer` + `KnownDeployments`
from `/advanced`. Surface `PythError` + `PostgresError` from root.

Also: update `examples/fork-greeting/devstack.config.ts:24` and `examples/arena/devstack.config.ts:18`
to import the now-root symbols from root instead of `/advanced`. ~4 import-line edits across
two example apps.

Deliverable: same as Phase 1.

**Risk**: low. Mechanical reclassification + 4 line edits in examples.

### Phase 3 — Deepbook factory cluster reshape — 4-6 hours

§3.4. Decide Option A vs Option B (see §6.1). Apply, update `examples/deepbook-full` and
`examples/wallet` to match.

**Risk**: medium-low. All edits are mechanical but blast radius reaches every Deepbook example.

### Phase 4 — `/playwright` helpers + arena cleanup — 1 hour

§3.6. Add `loadManifest` / `loadAccountKey` aliases; update `arena/e2e/connect-four.spec.ts` to
use them. Drop the hand-rolled implementation.

**Risk**: zero — aliases over existing functions.

### Phase 5 — Coordinate with integration-contract-redesign — N/A

When `integration-contract-redesign.md` Phase A lands, audit the new `/advanced` exports
(`onChainArtifact`, `ChainProbe`, `containerPrimitive`) for naming consistency with the rest of
the barrel (lowercase factory, `<Name>Tag` Context.Service, error symmetry). Drop
`runDockerContainer` if E30 also lands. No work needed in this plan.

---

## 5. LoC delta

| Phase | Surface delta | Example apps delta |
| ----- | ------------- | ------------------ |
| 1     | ~−50          | 0                  |
| 2     | ~−30          | ~+10 / ~−5 (imports) |
| 3     | ~−10 to −25   | ~−10 to ~+15 (renames) |
| 4     | ~+10          | ~−30               |
| 5     | (other plan)  | (other plan)       |
| **Total** | **~−80 to −95** | **~−15 to −20**    |

About **−95 LoC of public surface** (mostly barrel + dead type exports), with **two new helpers
added** (`loadManifest` + `loadAccountKey` aliases) and a net **~−20 LoC across example apps**.

---

## 6. Open questions

### 6.1 Deepbook reshape — Option A or Option B?

Option A (`Deepbook.indexer(...)`, `Deepbook.mint('DEEP')`) is the cleaner long-term shape but
requires a codemod across every example app's `devstack.config.ts`. Option B (5 demotions to
`/advanced`) is cheaper and matches "one canonical factory per domain" but feels less
discoverable for the deepbook-full example which uses 5 of the 7.

Recommend the user picks during plan review. Defaults: **Option A** if we're optimizing for
long-term surface clarity, **Option B** if we're optimizing for minimum diff.

### 6.2 Error classes — demote or delete?

`AccountError`, `ConfigLoadError`, `DockerError`, `HostProcessError`, `ManifestDiscoveryError`,
`ManifestError`, `ManifestShapeError`, `WalletAppError` have zero `catchTag` consumers in
examples. Two options:

- **Demote to `/advanced`** — Effect-native consumers writing their own factories might
  legitimately catch them. The redis plugin doesn't, but the *hypothetical* future plugin
  might.
- **Delete from public surface** — the catch-target audience is "future plugin authors", and
  the YAGNI argument says wait until someone needs them.

Recommend **demote to `/advanced`**. They're already defined; deleting from the public surface
costs nothing semantically (the class remains usable internally and can be re-exported later);
demoting is the conservative move.

### 6.3 Long-running host-process primitive (`hostService`)

`integration-contract-redesign.md` §3.3 covers the docker case (`containerPrimitive`). The
`dev` and `wallet` services use **node child processes**, not docker. `dev/internal.ts` and
`wallet/internal.ts` independently hand-roll a long-running host-process shape (PortAllocator
+ line-draining + endpoint publish + ready probe).

The integration-contract-redesign plan doesn't explicitly cover this. Three options:

- **(a) Out of scope** for this plan and integration-contract-redesign — file a separate
  `host-service-primitive.md` follow-up.
- **(b) Lift into integration-contract-redesign** — add a §3.5 `hostService` primitive
  alongside `containerPrimitive`.
- **(c) Do it here** — this plan is about the API surface; if the API needs a `hostService`
  export, it's reasonable to scope here.

Recommend (a). The substrate work overlaps integration-contract's `containerPrimitive` design
(both want lifecycle + scope + ready probe + endpoint publish); it should live in the same
plan family. Cross-link to the §6.3 of that plan family when it's written.

### 6.4 Are `Pyth` and `Postgres` first-class on root?

If yes, surface `PythError` + `PostgresError` per §3.2. If they're really `/advanced`
factories that leaked to root, demote them with the rest.

Recommend keeping on root. They're consumed by `examples/deepbook-full/devstack.config.ts` as
ordinary factories; demoting would be a regression.

### 6.5 Coin / Package name sprawl — defer

§3.5 sketches the issue but doesn't propose concrete renames. The blast radius is wider than
this plan can absorb in one cycle. Defer to a follow-up `naming-consolidation-<date>.md` after
§3.1-3.4 land.

### 6.6 Should the audit-found agents be re-run after Phases 1-4 land?

The audit was three independent agents (internal-services bypass, example-app reach, barrel
hygiene). After Phases 1-4 the barrel-hygiene findings shrink to ~zero; the example-app
findings shrink to ~zero; the internal-services bypass remains until
integration-contract-redesign lands.

Recommend re-running the example-app + barrel-hygiene agents after Phase 4 as a
verification pass. The internal-services audit stays open until integration-contract-redesign
Phase C completes.

---

## 7. Coordination with other plans

When this plan's Phase 1 starts:

- **`integration-contract-redesign.md`** can run in parallel. The barrel edits don't touch the
  primitive substrate; the substrate's new exports get added when its Phase A completes (and
  Phase 5 of this plan checks naming consistency).
- **`stack-simplification-audit.md`** is a different scope (engine + supervisor internals).
  E29 / E30 / E47 / E50 / E37 affect the plugin-author surface; coordinate with this plan's
  Phase 1-2 for naming, but the work is otherwise independent.
- **`versioning-shim-audit.md`** is orthogonal — it cleans up `ManifestV5` / `Phase X` /
  `keyOverride` etc., which is a different kind of surface noise.
- **`cli-redesign.md` + `cli-cleanup-plan-2026-05-19.md`** are orthogonal — they touch only
  `cli/`, not the public API.
- **`dirs-dapp-kit-compose-audit.md`** has already shipped (the `/dapp-kit` subpath is gone;
  `localnetWalrusOptions` now lives in `services/walrus/options.ts` and is re-exported from
  `/browser`). This plan's §3.1 root-deletion of `localnetWalrusOptions` is the natural
  follow-up.
- **`long-acquire-progress.md`** is orthogonal — adds heartbeat narration to the plain
  renderer + phase streaming inside `dockerImage`. Doesn't touch barrel exports.

No conflicts. Phase 1-4 can ship in their own PR train without blocking anything.

---

## 8. Opportunities noticed

Adjacent cleanups spotted during the audit, worth filing separately:

- **`services/postgres.ts` is the cleanest large service** (uses `tag`/`provide`/`setPhase`/`makeService`/`runDockerContainer` end-to-end). Use it as the reference implementation when grading other services' adoption of integration-contract-redesign's primitives.

- **`examples/deepbook-full/devstack.config.ts:129` casts `pyth as any` and `:226,234` pass `undefined as any` for `sui`** with TODO-style comments. Signal of a missing constructor overload or missing default-fill rule. Root-cause worthy when `Deepbook*` reshape happens (§3.4) — the user-facing example shouldn't need `as any`.

- **`examples/deepbook-full/devstack.config.ts:173-186` defines two placeholder helpers** (`deepbookPackagePlaceholder`, `usdcCoinTypePlaceholder`) returning literal `'__DEEPBOOK_PACKAGE_ID__'` strings. Implies the deepbook factory should accept `Coin` refs for `pools[].base|quote` like `examples/wallet` already does. Worth fixing during the §3.4 reshape.

- **`examples/_template/vitest.config.ts:6-7` carries commented-out `withDevstack` example code.** Either land a real consumer or drop the snippet — uncalled API drifts. Trivial cleanup, drop with §3.1.

- **`effect-app/src/main.ts:26` uses `as ReturnType<typeof Account<'alice'>>`** as a documented workaround for TS2742 from a non-exported `engine/shared` symbol. Every Effect-native consumer of `Account` outside the package will hit this. Either re-export the symbol or change `Account`'s inferred type. Worth a follow-up to track separately.

- **Six unreachable re-exports in `services/index.ts`** (`SealKeyServerEntry`, `WalrusNodeInfo`, `LocalPackage`, `LocalPackageTag`, `toSdkCoin`, `DeepbookMarketMakerTag`) suggest the internal barrel is the kind of file that drifts because nothing reads it. Recommend a yearly sweep, or — better — a typecheck-time invariant that re-exports in `services/index.ts` must be consumed by either `src/index.ts` or `src/advanced/index.ts`.

- **`localnetWalrusOptions` is the only "function returning Options" in the API.** Worth rolling its `LocalnetWalrusInputs` into `Walrus({ network: 'localnet', ...inputs })` and deleting the helper entirely. Slightly more invasive than Phase 1 — defer until users complain or until §3.4 reshape gives a natural opening.

- **The `<Name>Tag` Context.Service classes** (`SuiTag`, `FaucetTag`, `PackageTag`, etc.) are exported from `/advanced` but the `DeepbookMarketMakerTag` (`src/services/deepbook.ts:181`) is declared, re-exported from `services/index.ts`, and **never reaches a published barrel**. Either publish on `/advanced` (consistent) or drop the rename comment (the alternative). Folds into the §3.4 Deepbook reshape.

- **`provide` mutates the canonical Context.Service class via `Object.assign`** to give it `__layer` / `key` / etc. (`src/advanced/tag.ts:498`). The technique is documented and tested but worth a comment in the plugin-author surface JSDoc explaining the surprise: a `provide(SuiTag, ...)` call modifies `SuiTag` in place. Plugin authors who import `SuiTag` from `/advanced` to **yield** it (not implement it) might be confused. Worth a JSDoc clarification but no code change.

- **`DEFAULT_CODEGEN_OUTPUT` is exported from root** but the factory `Codegen({ output?: string })` already defaults to it. The const is exposed for users who want to write paths relative to the canonical output, but the audit found zero consumers. Drop in §3.2.

---

End of plan. The work is barrel-shaped, file-disjoint, mechanical. ~95 LoC of public surface
shrinks; two missing helpers ship; the underlying "internal services bypass the public surface"
finding is left to `integration-contract-redesign.md` to resolve by construction.
