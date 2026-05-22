# Plugin API migration plan

Last updated: 2026-05-22.

> Historical note. The public API migration described here was followed by the engine/substrate
> migration tracked in `engine-api-migration-plan.md`. Treat that engine note, current source, and
> verification log as authoritative for the final resource-native model. Sections below that mention
> the temporary tag/member adapter, `resourceTag`, current-engine `StackMember`, or auto-mounted Sui
> are preserved as historical migration context, not active design.

Snapshot commit at note creation: `67c7d5bc`.

## Context

The devstack package is still unreleased. There is no consumer compatibility surface to preserve, so
this migration should keep breaking the public API directly instead of adding shims, deprecated
exports, or parallel `v2` surfaces.

The original source prototype was `packages/devstack/prototypes/simple-plugin-system`. Its authoring
model has been brought into `packages/devstack` while reusing the existing supervisor, lifecycle
graph, snapshot, routing, and codegen engine. The prototype tree is now deleted so future work starts
from the real package implementation and tests.

## Target public model

Plugin authors write one object:

```ts
const redis = definePlugin({
	id: 'redis/cache',
	dependsOn: { sui, sidecar },
	kind: 'leaf-long-running',
	start: (_ctx, { sidecar }) => Effect.succeed({ url: sidecar.url }),
	capabilities: ({ value }) => [
		routable(...),
		codegenable(...),
	],
});
```

Stack authors write one object:

```ts
export default defineDevstack({
	members: [app],
	stackName: 'arena',
	network,
	codegen: { outputDir: 'src/generated' },
});
```

Important rules:

- `id` is the public resource identity. Authors do not define tags.
- `dependsOn` accepts a single ref, tuple, or object. Object keys shape the callback deps.
- Plugin-valued dependencies are recursive entrypoints. Eventually examples should list only the
  top-level app/service member when its plugin-valued deps can pull the rest in.
- `start(ctx, deps)` receives resolved dependency values. Public author callbacks should not use
  `ctx.use`, `readConsumedTag`, or `consumeMembers`.
- Capabilities are plain arrays or dynamic array factories. The public `capabilities(...)` wrapper
  should disappear after old built-ins no longer need it internally.
- The public `Stack` handle is opaque. Runtime member details (`members`, `provides`, `consumes`,
  `acquire`) belong behind internal readers, not on the user-facing type.

## Landed in the current snapshot

- Added the public authoring substrate in `src/api/define-plugin.ts`: `definePlugin`, `resource`,
  `defineId`, resource refs, typed dependency resolution, and an adapter to the current engine
  member shape.
- Converted `defineDevstack` to object form in `src/api/define-devstack.ts`.
- Added recursive plugin-valued dependency expansion, duplicate-provider detection, cycle detection,
  and current-engine `consumes` dedupe by id.
- Made the public stack handle opaque. `readStackEngine(...)` is the internal bridge for CLI,
  runtime, and tests that still need the old engine tuple.
- Updated `defineDevstackWith` to delegate to the object-form composer without pre-expanding.
- Removed the old authoring helpers from the root public barrel: `defineNodePlugin`, `defineTag`,
  `consumeMembers`, `consumeMember`, `readConsumedTag`, engine member types, public built-in tags,
  and public tag-id helpers.
- Narrowed the public `/substrate` and `/contracts` barrels so they no longer export the old engine
  member/tag authoring model.
- Added registry-style typing for capability kinds, routable upstream kinds, network modes, and
  plugin kinds.
- Migrated the public `action(...)` API from `consumes`/`ctx.use(...)` to `dependsOn`/resolved
  dependency values.
- Migrated docs, examples, example type contracts, and CLI fixture configs to
  `defineDevstack({ members, ...options })` and the new plugin-authoring helpers where relevant.

## Landed after snapshot `67c7d5bc`

- Converted the Sui built-in family from `defineNodePlugin({ provides, consumes, acquire })` to
  `definePlugin({ id: 'sui', start, capabilities })`.
- Converted the dependency-free Postgres and Faucet built-in families to
  `definePlugin({ id, start, capabilities })`.
- Added `resourceTag(...)` as the current-engine tag view for resource refs. Converted built-ins now
  have resource identities, and their existing tag exports are derived from those identities only
  for older built-ins that still consume tag-shaped dependencies.
- Updated API tests, example type contracts, and service docs to show converted built-ins as plugin
  resource refs.
- Converted Host Service, Account, Wallet, Package, Coin, Action, Walrus, Seal, and DeepBook from
  `defineNodePlugin`/`defineTag`/`consumeMember(s)`/`readConsumedTag` lowering to
  `definePlugin({ id, dependsOn, start, capabilities })`.
- Tightened `definePlugin` dependency inference by splitting overloads for tuple, object, single-ref,
  and dependency-free plugins. Public author `start(_ctx, deps)` callbacks now receive inferred
  dependency values without per-plugin `deps as ...` casts.
- Added `resourceForMember(...)` / `resourcesForMembers(...)` as the localized bridge for current
  engine inputs during the migration. Built-in option types now use plugin/resource refs instead of
  public `StackMember` aliases.
- Cached `resourceTag(resourceRef)` so bare resource refs keep stable tag identity across adapter
  reads.
- Converted `src/samples/*` and non-substrate fixtures from `defineNodePlugin`/`defineTag` to
  `definePlugin({ id, dependsOn, start, capabilities })`.
- Deleted the old public-ish bridge helpers that no longer had non-substrate callsites:
  `src/api/consume-members.ts`, `src/api/tag.ts`, `test/api/consume-members.test.ts`, and
  `readConsumedTag` from `src/api/plugin-authoring.ts`.
- Removed the old action callback bridge. `ActionBuildContext` now exposes only action helpers;
  action body and dynamic discriminator callbacks receive resolved dependency values separately.
- Changed manifest extras callbacks from `ctx.get(tag)` / `ctx.use(member)` to
  `ctx.value(resource)`.
- Tightened package-mode service overloads so local/known package plugin bodies no longer cast
  the resolved package branch after constructing a specific mode.
- Removed `defineNodePlugin` from `src/api/define-plugin.ts`; substrate tests that still exercise
  raw current-engine members now use a test-local `defineEngineMember(...)` helper.
- Removed the `capabilities(...decls)` helper. Plugin authors and built-ins now use plain
  capability arrays or dynamic factories returning arrays.
- Removed codegen emitted-shape phantom plumbing: `CodegenEntries`, `EmittedFor`, `_emitted`, and
  `CodegenableDecl<Shape, Emitter>`. `CodegenableDecl` is now keyed by emitter name only; generated
  modules own their app-facing exported value types directly.
- Updated the packed-consumer smoke fixture to use root `definePlugin`/object-form
  `defineDevstack`, and tightened declaration repair so packed `.d.mts` files do not import
  `effect/*.js` subpaths.
- Removed `./contracts` and `./substrate` from package exports and tsdown entrypoints. Their public
  vocabulary is now available from the root barrel or internal source paths only; packed-consumer
  smoke asserts those subpaths are not exported.
- Added a root-entrypoint capability authoring test for module-augmented custom capability payloads,
  exact registered payload checks, open unregistered capability kinds, and `capabilitySink(...)`
  callback inference.
- Replaced the raw codegen emit-return contract with `CodegenEmitContext`. `CodegenableDecl.emit`
  now writes generated exports through `ctx.exportConst(...)` / `ctx.importStatement(...)` instead
  of returning an internal `{ [exportName]: value }` renderer record. Emitters return `ctx.done()`,
  so the old raw-return shape is a type error instead of a silent empty-file emission.
- Renamed the last `src/api/plugin-authoring.ts` residue to `src/api/plugin-errors.ts` now that it
  only contains the internal `pluginErrorContributions(...)` bridge.
- Fixed `resourceForMember(...)` / `resourcesForMembers(...)` so plugin-valued inputs remain
  plugin-valued in the TypeScript type, not only at runtime. Recursive dependency closure now sees
  explicit wallet accounts, account funding coins, action upstreams, host-service needs, Walrus
  seed accounts, and similar built-in dependency tuples as entrypoints when they are backed by
  plugins. Legacy current-engine members still project to bare resource refs.
- Replaced public built-in option aliases that exposed substrate `StackMember` shapes with
  `ResourceRef<id, value>`-based aliases, and renamed the action upstream public alias to
  `ActionUpstreamRef`.
- Removed the last tuple-dependency casts in Account and Wallet after the helper typing fix.
- Added runtime/type coverage for `defineDevstack({ members: [wallet({ accounts: [alice, bob] })] })`
  recursively expanding `alice`, `bob`, and auto-mounted Sui.
- Converted runnable examples to app/service entrypoint composition and verified their expanded
  member order from the current source.
- Deleted the stale `src/contracts/node-plugin.ts` file and updated architecture/style docs so
  `NodePlugin` is no longer documented as a public capability contract. The current-engine
  `StackMember` shape remains internal substrate adapter vocabulary.
- Deleted `packages/devstack/prototypes/simple-plugin-system` after package tests and packed-consumer
  smoke covered the migrated authoring behavior directly.
- Removed the stale `ResourceRefsOfMembers` helper type after `DependencyRefsOfMembers` became the
  correct internal bridge.

## Verification history

Original snapshot checks before the prototype was deleted:

```bash
npx tsc --noEmit -p packages/devstack/prototypes/simple-plugin-system/tsconfig.json
pnpm exec tsx packages/devstack/prototypes/simple-plugin-system/src/examples/runtime-smoke.ts
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run test/api/define-devstack.test.ts test/plugins/wallet/accounts-all.test.ts test/cli/main.test.ts test/cli/move-bindings-codegen.test.ts
pnpm --filter @mysten-incubation/devstack test
```

Original snapshot full package result: 146 files, 1001 tests passed.

Current post-snapshot slice verification:

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run test/api/define-devstack.test.ts test/plugins/network-defaults.test.ts test/plugins/barrel-imports.test.ts
```

Focused Vitest result: 3 files, 28 tests passed.

After the Postgres/Faucet batch, focused Vitest result: 3 files, 29 tests passed.

After the built-in conversion batch, focused verification passed:

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run test/plugins/deepbook/factory.test.ts test/plugins/deepbook/type-refusal.test-d.ts test/plugins/seal/public-refs.test.ts test/plugins/seal/keygen.test.ts test/plugins/walrus/seed-accounts.test.ts test/plugins/action/execute.test.ts test/plugins/wallet/accounts-all.test.ts test/plugins/account/variants.test.ts test/api/define-devstack.test.ts test/plugins/barrel-imports.test.ts
```

Focused Vitest result: 9 files, 89 tests passed.

Full package Vitest was rerun after two unrelated first-run 5s timeouts were isolated by a targeted
rerun:

```bash
pnpm --filter @mysten-incubation/devstack exec vitest run test/runtime/docker/ownership-lifecycle.test.ts test/surfaces/tui/dashboard.test.tsx
pnpm --filter @mysten-incubation/devstack test
```

Targeted timeout rerun result: 2 files, 25 tests passed.
Final full package result: 146 files, 1003 tests passed.

After the sample/fixture/helper cleanup and action/manifest callback cleanup:

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run test/api/run-stack.test.ts test/orchestrators/router/runtime-composition.test.ts test/e2e/capability-sinks-boot.test.ts test/e2e/snapshot-orchestrator-boot.test.ts test/plugins/barrel-imports.test.ts test/substrate/manifest-extras.test.ts test/plugins/action/execute.test.ts test/e2e/action-cache.test.ts test/plugins/package/public-ergonomics.test-d.ts test/plugins/deepbook/factory.test.ts
```

Focused Vitest result: 6 files, 46 tests passed.

Full package Vitest after this slice had one 5s timeout in
`test/runtime/docker/ownership-lifecycle.test.ts`:

```bash
pnpm --filter @mysten-incubation/devstack test
pnpm --filter @mysten-incubation/devstack exec vitest run test/runtime/docker/ownership-lifecycle.test.ts
```

Full-suite result: 144 files passed, 1 file timed out, 996 tests passed before failure.
Immediate targeted rerun result: 1 file, 23 tests passed.

After removing `defineNodePlugin`, the `capabilities(...)` helper, and codegen phantom plumbing:

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run test/substrate/build-context-use.test.ts test/substrate/runtime/run.test.ts test/substrate/runtime/supervisor.test.ts
pnpm --filter @mysten-incubation/devstack exec vitest run test/api/run-stack.test.ts test/e2e/capability-sinks-boot.test.ts test/plugins/barrel-imports.test.ts test/plugins/account/variants.test.ts test/plugins/deepbook/factory.test.ts test/substrate/build-context-use.test.ts test/substrate/runtime/run.test.ts test/substrate/runtime/supervisor.test.ts
pnpm --filter @mysten-incubation/devstack exec vitest run test/orchestrators/codegen/service.test.ts test/e2e/capability-sinks-boot.test.ts test/api/run-stack.test.ts test/plugins/barrel-imports.test.ts test/substrate/runtime/supervisor.test.ts
pnpm --filter @mysten-incubation/devstack build
pnpm --filter @mysten-incubation/devstack smoke:pack-consumer
pnpm --filter @mysten-incubation/devstack test
pnpm --filter @mysten-incubation/devstack build
pnpm --filter @mysten-incubation/devstack smoke:pack-consumer
pnpm --filter @mysten-incubation/devstack typecheck
```

Focused Vitest results: 3 files / 19 tests passed, then 7 files / 60 tests passed, then 4 files /
42 tests passed. Package build passed. Packed-consumer smoke passed CLI import, runtime import,
minimal boot, stack-context, and skipLibCheck-enabled typecheck.
Full package Vitest result: 145 files, 997 tests passed.
After removing `./contracts` and `./substrate`, package build passed again. Packed-consumer smoke
passed CLI import, runtime import, removed-subpath negative checks, minimal boot, stack-context, and
skipLibCheck-enabled typecheck. Package typecheck passed again after the export change.

After adding the custom capability authoring coverage:

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run test/api/capability-authoring.test.ts
```

Package typecheck passed. Focused Vitest result: 1 file / 1 test passed.

After replacing the raw codegen emit-return contract with `CodegenEmitContext`:

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run test/api/capability-authoring.test.ts test/orchestrators/codegen/service.test.ts test/e2e/capability-sinks-boot.test.ts test/api/run-stack.test.ts test/plugins/deepbook/factory.test.ts test/substrate/runtime/supervisor.test.ts test/cli/main.test.ts test/cli/move-bindings-codegen.test.ts
```

Package typecheck passed. Focused Vitest result: 7 files / 57 tests passed.

After renaming the leftover plugin-authoring bridge:

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run test/plugins/barrel-imports.test.ts test/plugins/account/variants.test.ts test/plugins/deepbook/factory.test.ts test/e2e/capability-sinks-boot.test.ts test/substrate/runtime/supervisor.test.ts
```

Package typecheck passed. Focused Vitest result: 4 files / 47 tests passed.

After fixing plugin-valued dependency typing, cleaning stale contract docs, and deleting the
prototype:

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run test/api/define-devstack.test.ts test/api/capability-authoring.test.ts test/plugins/wallet/accounts-all.test.ts test/plugins/account/variants.test.ts test/plugins/deepbook/factory.test.ts test/plugins/walrus/seed-accounts.test.ts
pnpm --filter @mysten-incubation/devstack test
pnpm --filter @mysten-incubation/devstack build
pnpm --filter @mysten-incubation/devstack smoke:pack-consumer
pnpm exec tsx -e "import { readStackEngine } from './packages/devstack/src/api/define-devstack.ts'; (async () => { for (const path of ['./examples/_template/devstack.config.ts','./examples/wallet/devstack.config.ts','./examples/private-content/devstack.config.ts','./examples/token-studio/devstack.config.ts','./examples/arena/devstack.config.ts','./examples/deepbook-full/devstack.config.ts','./examples/fork-greeting/devstack.config.ts']) { const mod = await import(path); console.log(path, readStackEngine(mod.default).members.map((m:any)=>m.provides.id).join(', ')); } })();"
```

Package typecheck passed. Focused Vitest result: 6 files / 58 tests passed. Package build passed.
Full package Vitest result: 146 files / 1001 tests passed.
Packed-consumer smoke passed CLI import, runtime import, removed-subpath negative checks, minimal
boot, and skipLibCheck-enabled typecheck.

Example expansion proof:

- `_template`: `sui, account/alice, package:hello, account/bob, wallet, host-service/app`
- `wallet`: `sui, account/publisher, package:mock_usdc, package:mock_weth, coin:mock_usdc, coin:mock_weth, account/alice, account/bob, account/carol, action:wallet.seedTokens, wallet, host-service/app`
- `private-content`: `sui, account/publisher, package:vault, account/alice, account/bob, walrus, seal:seal, wallet, host-service/app`
- `token-studio`: `sui, account/alice, package:managed_coin, coin:managed_coin, account/bob, account/carol, wallet, host-service/app`
- `arena`: `sui, account/alice, account/publisher, package:connect_four, action:arena.openLobby, account/bob, wallet, host-service/app`
- `deepbook-full`: `sui, account/alice, deepbook/deepbook, host-service/app`
- `fork-greeting`: `sui, account/publisher, package:greeting, account/alice, account/bob, wallet`

Useful public-surface scan:

```bash
rg -n "defineNodePlugin|defineTag|readConsumedTag|consumeMembers|consumeMember|ctx\\.use|CodegenEntries|EmittedFor|SuiTag|FaucetTag|WalletTag|PostgresTag|WalrusTag|StackMember|AnyMember|defineDevstack\\([^\\{]|capabilities\\(" \
  packages/docs/content/devstack examples packages/devstack/examples-test \
  packages/devstack/src/index.ts packages/devstack/src/substrate/index.ts packages/devstack/src/contracts/index.ts \
  -g '!packages/devstack/prototypes/**'
```

Expected remaining matches are prose references to `defineDevstack(...)`, not old public API usage.

The broader source/test scan that includes `ctx.get` now has expected remaining matches only in the
`definePlugin` adapter, substrate primitives, substrate-focused tests, and runtime calls to member
capability factories in tests:

```bash
rg -n "defineTag|readConsumedTag|consumeMembers|consumeMember|ctx\\.use|ctx\\.get|CodegenEntries|EmittedFor|capabilities\\(" packages/devstack/src packages/devstack/test -g '!packages/devstack/prototypes/**'
```

## Migration status and release-gate follow-ups

### 1. Converted built-ins to `definePlugin`

The root public API is migrated, and built-in plugin families now lower through `definePlugin`:

1. Account
2. Package
3. Coin
4. Wallet
5. Action internals
6. Host service
7. Walrus, Seal, DeepBook

Current status:

- Built-in plugin families are converted: Sui, Postgres, Faucet, Host Service, Account, Package,
  Coin, Wallet, Action, Walrus, Seal, and DeepBook.
- Production plugin barrels, samples, and non-substrate fixtures no longer import
  `defineNodePlugin`, `defineTag`, `consumeMember(s)`, or `readConsumedTag`.
- The public/root API and `/contracts`/`/substrate` barrels no longer expose the old helper names,
  the `capabilities(...)` helper, or codegen emitted-shape extraction types.
- Remaining scan matches are the bridge implementation itself, substrate primitives, and
  substrate-focused tests that intentionally exercise the current engine tag/member model.
- The old repeated `deps as ...` plugin-local cast pattern is gone. Remaining value-shape casts are
  boundary checks in test helpers or local domain projections, not `definePlugin` dependency
  inference failures.
- Built-in option aliases now expose plugin/resource refs rather than substrate `StackMember`
  shapes. Internal composite child lists still use `AnyMember` because they are current-engine
  implementation details, not public option surfaces.

Completed conversion rules:

- expose normal plugin values that are also resource refs;
- replace author-facing upstream member options with `dependsOn` refs where practical;
- move acquire bodies to `start(ctx, deps)`;
- keep existing resolved value shapes unless simplification is clearly local;
- update tests so examples can list top-level entrypoints instead of every dependency.

Residual internal cleanup:

- keep `defineTag`/`ctx.get`/`ctx.use` scoped to the adapter/substrate layer until the current
  engine tests are ported, rewritten against `definePlugin`, or deleted with the old engine;
- keep future public options on plugin/resource refs rather than substrate member/tag types.

### 2. Capability simplification

The registry surface exists, emitted-shape phantom plumbing is removed, and root-entrypoint module
augmentation plus `capabilitySink(...)` inference are covered by tests. Codegen emitters now use an
opaque writer/context surface instead of returning raw renderer records.

Current status:

- keep generated files owning app-facing exports and types directly;
- remaining codegen work is release-gate evidence and app-facing output polish, not old
  phantom/return-shape public API cleanup.

### 3. Tighten package subpaths and packed-consumer evidence

The package exports are intentionally narrower now. The packed-consumer smoke covers intended root
imports, removed-subpath failures for `./contracts` and `./substrate`, and a minimal object-form
`defineDevstack` boot from the packed artifact.

Before release:

- keep docs and examples on root imports unless a build-integration subpath is explicitly required;
- keep packed-consumer smoke in the release gate.

### 4. Update examples to entrypoint composition

Built-ins are now recursive plugin-valued refs. Runnable examples now use top-level app/service
entrypoint composition:

```ts
export default defineDevstack({ members: [app], stackName: 'wallet' });
```

Keep tests that prove recursive expansion, duplicate-provider rejection, missing bare refs, explicit
wallet account expansion, and wallet `accounts: 'all'` expansion after dependency closure.

### 5. Prototype deleted

`packages/devstack/prototypes/simple-plugin-system` has been deleted. The package implementation,
example type contracts, focused API tests, codegen tests, and packed-consumer smoke are now the
source of truth for the migrated authoring model.

## Next-session prompt

```text
We are in /Users/michaelhayes/code/ts-sdks-incubation. Read
packages/devstack/notes/plugin-api-migration-plan.md and
packages/devstack/notes/UNRESOLVED-BLOCKERS.md first.

The public plugin API migration was committed at snapshot 67c7d5bc. Current verified state:
- the old prototype tree has been deleted; package tests are now the source of truth
- pnpm --filter @mysten-incubation/devstack typecheck passed
- built-in plugin families, samples, and non-substrate fixtures are converted to definePlugin
- defineNodePlugin, consumeMember(s), readConsumedTag, api/tag.ts, and capabilities(...) are gone
  from the public/plugin-authoring API
- CodegenEntries/EmittedFor/_emitted phantom extraction is removed
- package exports only expose the root and build-integration subpaths; packed-consumer smoke asserts
  ./contracts and ./substrate are not exported
- focused API/substrate/codegen vitest passed
- full devstack Vitest passed: 146 files / 1001 tests
- package build passed
- packed-consumer smoke passed with skipLibCheck-enabled consumer typechecking
- module-augmented custom capability payloads and capabilitySink inference are covered by a focused
  root-entrypoint test
- codegen emitters write through `CodegenEmitContext` / `ctx.done()` instead of returning raw
  renderer records, and the old raw-return shape is type-refused
- plugin-valued dependency helper types now preserve plugin refs, so explicit wallet accounts and
  other built-in plugin dependency tuples participate in recursive entrypoint expansion
- public built-in option aliases use `ResourceRef<id, value>`-based shapes instead of substrate
  `StackMember` aliases
- examples have been moved to top-level app/service entrypoint composition and expansion was
  verified from the current source
- `contracts/node-plugin.ts` and the stale prototype tree are deleted

The public plugin API migration is complete by this note's gates. If resuming devstack release-gate
work, start from `UNRESOLVED-BLOCKERS.md` and keep docs/examples on root imports. Preserve the
existing supervisor/runtime path unless a later note explicitly says to delete a helper after all
callsites are gone.

Before editing, run:
rg -n "defineTag|readConsumedTag|consumeMembers|consumeMember|ctx\\.use|ctx\\.get|CodegenEntries|EmittedFor|capabilities\\(" packages/devstack/src packages/devstack/test -g '!packages/devstack/prototypes/**'

After each slice, run package-local typecheck and targeted Vitest. Use the repo Vitest guidance:
vitest run, no grep/head/tail. End by updating packages/devstack/notes/plugin-api-migration-plan.md
with what was converted and what remains.
```
