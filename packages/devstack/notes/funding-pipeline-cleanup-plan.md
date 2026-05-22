# Funding pipeline cleanup plan

Last updated: 2026-05-22.

## 1. Context and goals

This plan covers the account, coin, package, and faucet public surfaces:

- `packages/devstack/src/plugins/account`
- `packages/devstack/src/plugins/coin`
- `packages/devstack/src/plugins/package`
- `packages/devstack/src/plugins/faucet`
- related tests under `packages/devstack/test/plugins/{account,coin,package,faucet}`
- docs under `packages/docs/content/devstack/features/coins-and-funding.mdx`,
  `features/accounts-and-wallet.mdx`, `reference/faucet.mdx`, and `reference/services.mdx`
- examples that publish packages, resolve coins, or fund accounts.

The goal is to make the funding path direct and smaller. Account identity, package publish, coin
addressing, and faucet strategy registration currently work, but their public APIs expose too many
internal mechanics and preserve several footguns. This repo is unreleased, so cleanup should be
breaking and atomic.

`boundary-cleanup-plan.md` owns the deeper Coin/Package event-boundary and plugin-layer decoupling.
This plan owns the public API and plugin-local cleanup around that boundary work.

## 2. Audit findings

### Account options duplicate identity

Current shape:

- `account(name, opts?)` accepts `AccountOptions` variants that also contain `name`.
- `packages/devstack/src/plugins/account/index.ts` silently overwrites `opts.name` with the outer
  factory name.
- Comments and examples still describe `{ kind: 'ephemeral', name: 'alice' }`.

Target shape:

- The outer `account('alice', ...)` argument is the only account identity.
- Remove `name` from every public `AccountOptions` variant in
  `packages/devstack/src/plugins/account/service.ts` and variant modules.
- Internal acquire inputs can carry a normalized `name`, but callers cannot pass a conflicting name.

### Funding has two public names for one idea

Current shape:

- Default SUI funding uses `fund?: bigint` on ephemeral accounts.
- Cross-coin funding uses `funding: [{ coin, amount }]`.
- Docs teach `coin.builtin('sui')` plus `funding` for SUI top-ups, while bare ephemeral accounts use
  `fund`.

Target shape:

- Rename the default SUI amount to an explicit `suiMist?: bigint` or `initialMist?: bigint`.
- Keep custom funding as `funding`, but make the SUI shorthand the preferred path for SUI.
- Do not require `coin.builtin('sui')` just to request the normal SUI faucet path.

### Faucet dispatcher is over-public for built-in use

Current shape:

- Root exports include `faucet`, `defineFaucetStrategy`, `faucetCapabilityKey`, `suiLocalStrategy`,
  `suiLiveStrategy`, `requestFundsOnce`, `requestFundsWithRetry`, and retry constants.
- `faucet()` resolves to a dispatcher service, but built-in account funding calls the strategy
  registry directly through `faucetCapabilityFor(...)`.
- Docs teach `faucet({ strategies })`, but examples do not need a faucet member.

Target shape:

- Make faucet strategy registration a plugin-author capability helper only if a real custom-plugin
  story remains.
- Delete the `faucet()` dispatcher plugin unless a first-party example or test needs the resolved
  dispatcher resource.
- Internalize HTTP retry helpers under the Sui/faucet implementation unless they are intentionally
  public.

### `coin.local(symbol)` has no dependency edge

Current shape:

- `coin.local('SYMBOL')` resolves from the registry without depending on the publisher.
- The docs warn users to compose the publisher before the consumer.
- `SYMBOL_FORM_NO_DEP_EDGE_WARNING` exists only to document the footgun.

Target shape:

- Prefer `coin.fromPackage(packageMember, witness)` for all package-produced local coins.
- Delete `coin.local(symbol)` from the public namespace unless a real built-in consumer requires a
  symbol-only lookup.
- If retained internally, keep it under an internal helper and remove the public warning constant.

### Coin resource ids can collide

Current shape:

- `coin.fromPackage(pkg, witness)` uses `coin:<lowercase witness>` as the resource id.
- Two packages with the same witness name collide even though they are distinct coin types.

Target shape:

- Key package-scoped coin resources by package identity plus witness, for example
  `coin:${packageName}/${witness}`.
- Codegen can still export by display symbol, but compose-time identity must be package-scoped.

### Package surface exposes internals and escape hatches

Current shape:

- The package barrel exports `pkg(...)` as a convenience switch over `localPackage` vs
  `knownPackage`.
- `LocalPackageOptions.resolveSourcePath` makes `sourcePath` a type-inference placeholder.
- `capture` accepts either a suffix map or an arbitrary callback over `PublishReceipt`.
- The barrel exports publish executor, receipt helper, and capture callback types that are not
  normal app-author APIs.

Target shape:

- Delete `pkg(...)`; require explicit `localPackage(...)` or `knownPackage(...)`.
- Remove `resolveSourcePath` from public package options. Source fetching belongs in the service
  plugin that needs it, not in the basic package factory.
- Keep only record-form `capture: { key: '::module::Type' }` publicly.
- Move publish executor, receipt helper, and callback types behind internal source imports or a
  neutral contract module used by the boundary cleanup.

### Cache-hit coin discovery is fragile

Current shape:

- Package registers discovered coin records only when `publishReceipt !== null`.
- Cache hits assume the previous boot already registered the same coin records.

Target shape:

- After the boundary work, package receipt replay or coin discovery should run for both fresh
  publish and verified cache-hit paths.
- A cold process with a valid package cache must still populate `coin.fromPackage(...)`.

## 3. Specific public API changes

- Change `AccountOptions` so variants no longer accept `name`.
- Rename `fund` to `initialMist` or `suiMist`; update `DEFAULT_EPHEMERAL_FUND_MIST` if the chosen
  public name should match.
- Delete root exports for `faucet`, `FaucetService`, `FaucetDispatcher`, `FaucetRequest`,
  `requestFundsOnce`, `requestFundsWithRetry`, and retry constants unless a first-party consumer
  remains after migration.
- Keep or delete `defineFaucetStrategy` explicitly. If kept, document it as plugin-author API, not a
  stack member API.
- Delete `coin.local` and `SYMBOL_FORM_NO_DEP_EDGE_WARNING` from the public `coin` namespace.
- Change `coin.fromPackage` resource ids from witness-only to package-scoped.
- Delete `pkg(...)` from `packages/devstack/src/plugins/package/index.ts` and root exports.
- Remove `LocalPackageOptions.resolveSourcePath`.
- Remove public `PackageCaptureCallback`; keep only record-form capture.
- Internalize `PublishExecutor`, `pickCreatedByType`, `PublishReceipt`, and `PublishObjectChange`
  unless the boundary cleanup moves them to a neutral contract module.

## 4. Internal implementation changes

- Update `packages/devstack/src/plugins/account/service.ts` and variant modules to receive the
  account name from normalized acquire inputs rather than public options.
- Update `packages/devstack/src/plugins/account/funding.ts` so SUI default funding and custom coin
  funding have clearly separated code paths and event fields.
- Move faucet HTTP helpers behind internal modules if the dispatcher plugin is deleted.
- Update `packages/devstack/src/plugins/coin/index.ts`, `registry.ts`, and `codegen.ts` for the
  package-scoped coin id.
- Update `packages/devstack/src/plugins/package/index.ts`, `mode-local.ts`, and `publish-receipt.ts`
  to separate public capture maps from internal receipt projection.
- Coordinate cache-hit discovery with `packages/devstack/notes/boundary-cleanup-plan.md`.

## 5. Built-in plugin/component migration steps

1. Migrate account variant constructors and tests to no-inner-name options.
2. Migrate all examples and docs from `fund` to the chosen SUI funding option.
3. Replace any `coin.local(...)` first-party usage with `coin.fromPackage(...)` or
   `coin.known(...)`.
4. Update wallet, token-studio, private-content, connect-four, and fork-greeting configs if
   package/coin refs change.
5. Delete `faucet()` docs and tests if the dispatcher member is removed.
6. Apply the boundary Coin/Package receipt event work before deleting internal receipt imports.

## 6. Docs, examples, and test updates

Docs to update:

- `packages/docs/content/devstack/features/accounts-and-wallet.mdx`
- `packages/docs/content/devstack/features/coins-and-funding.mdx`
- `packages/docs/content/devstack/reference/faucet.mdx`
- `packages/docs/content/devstack/reference/services.mdx`
- `packages/devstack/README.md`

Examples to update:

- `examples/wallet/devstack.config.ts`
- `examples/token-studio/devstack.config.ts`
- `examples/private-content/devstack.config.ts`
- `examples/connect-four/devstack.config.ts`
- `examples/fork-greeting/devstack.config.ts`

Tests to update or add:

- `test/plugins/account/variants.test.ts`
- `test/plugins/account/lease-broker-integration.test.ts`
- `test/plugins/coin/registry.test.ts`
- `test/plugins/coin/discovery.test.ts`
- `test/plugins/faucet/factory.test.ts`
- `test/plugins/package/public-ergonomics.test-d.ts`
- `test/plugins/package/capture.test.ts`
- `test/build-integrations/release-surface.test.ts`

Add a type test proving a package-scoped coin id does not collide when two packages use the same
witness name.

## 7. Verification commands

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run \
	test/plugins/account/variants.test.ts \
	test/plugins/account/lease-broker-integration.test.ts \
	test/plugins/coin/registry.test.ts \
	test/plugins/coin/discovery.test.ts \
	test/plugins/faucet/factory.test.ts \
	test/plugins/package/public-ergonomics.test-d.ts \
	test/plugins/package/capture.test.ts \
	test/build-integrations/release-surface.test.ts
pnpm --filter @mysten-incubation/devstack build
pnpm --filter @mysten-incubation/devstack smoke:pack-consumer
```

Residue scans:

```bash
rg -n "kind: '.*', name:|fund:" packages/devstack/src/plugins/account packages/docs/content/devstack examples
rg -n "coin\\.local|SYMBOL_FORM_NO_DEP_EDGE_WARNING|pkg\\(" packages/devstack/src packages/docs/content/devstack examples
rg -n "faucet\\(|FaucetDispatcher|requestFundsOnce|requestFundsWithRetry" packages/devstack/src packages/docs/content/devstack examples
```

## 8. Acceptance criteria

- Account public options cannot specify an inner `name`.
- SUI funding has one documented public option name.
- Package-produced coins use dependency-carrying `coin.fromPackage(...)` in first-party examples.
- No public `coin.local` warning constant remains.
- `coin.fromPackage` ids are package-scoped and collision-tested.
- `pkg(...)`, `resolveSourcePath`, and callback capture are gone from the public package surface.
- Faucet exports match real built-in use; dispatcher-only APIs are deleted unless covered by a
  first-party custom-strategy test.
- Typecheck, focused tests, build, and packed-consumer smoke pass.

## 9. Explicit out-of-scope items

- The neutral publish-receipt event and plugin-layer boundary work; tracked in
  `boundary-cleanup-plan.md`.
- Adding new funding strategy types beyond preserving current SUI and WAL behavior.
- Changing Sui custody/security semantics for live accounts.
- Expanding package codegen or generated Move bindings beyond what the cleanup requires.
