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

The Coin/Package event-boundary and plugin-layer decoupling has already been completed. This plan
owns the remaining public API and plugin-local cleanup around account, funding, faucet, and package
ergonomics.

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

### Funding uses one public list

Current shape:

- Bare `account('alice')` still applies the default ephemeral SUI amount.
- Explicit funding uses `funding: [{ coin, amount }]` for every coin.
- SUI top-ups use `{ coin: 'sui', amount }` so callers do not need `coin.builtin('sui')` for the
  normal faucet path.

Remaining target:

- Keep custom funding as `funding` and preserve the SUI shorthand as the documented SUI path.
- Do not reintroduce a second public funding option for the default SUI amount.

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
  neutral contract module if another plugin needs them.

### Cache-hit coin discovery must stay current

Current shape:

- Package records discovered coin records from the current package-owned publish output path.
- Cache hits must not assume a previous boot registered the same coin records.

Target shape:

- Package receipt replay or coin discovery should run for both fresh publish and verified cache-hit
  paths.
- A cold process with a valid package cache must still populate `coin.fromPackage(...)`.

## 3. Specific public API changes

- Change `AccountOptions` so variants no longer accept `name`.
- Keep explicit SUI funding under `funding: [{ coin: 'sui', amount }]`; the bare ephemeral form
  keeps `DEFAULT_EPHEMERAL_FUND_MIST` as its internal default.
- Delete root exports for `faucet`, `FaucetService`, `FaucetDispatcher`, `FaucetRequest`,
  `requestFundsOnce`, `requestFundsWithRetry`, and retry constants unless a first-party consumer
  remains after migration.
- Keep or delete `defineFaucetStrategy` explicitly. If kept, document it as plugin-author API, not a
  stack member API.
- Delete `pkg(...)` from `packages/devstack/src/plugins/package/index.ts` and root exports.
- Remove `LocalPackageOptions.resolveSourcePath`.
- Remove public `PackageCaptureCallback`; keep only record-form capture.
- Internalize `PublishExecutor`, `pickCreatedByType`, `PublishReceipt`, and `PublishObjectChange`
  unless they move to a neutral contract module.

## 4. Internal implementation changes

- Update `packages/devstack/src/plugins/account/service.ts` and variant modules to receive the
  account name from normalized acquire inputs rather than public options.
- Update `packages/devstack/src/plugins/account/funding.ts` so SUI default funding and custom coin
  funding have clearly separated code paths and event fields.
- Move faucet HTTP helpers behind internal modules if the dispatcher plugin is deleted.
- Update `packages/devstack/src/plugins/package/index.ts`, `mode-local.ts`, and `publish-output.ts`
  to separate public capture maps from internal receipt projection.
- Keep cache-hit discovery aligned with the current package-owned contribution path.

## 5. Built-in plugin/component migration steps

1. Migrate account variant constructors and tests to no-inner-name options.
2. Keep examples and docs on the single `funding` list with the `{ coin: 'sui', amount }` shorthand.
3. Update wallet, token-studio, private-content, connect-four, and fork-greeting configs if
   package/coin refs change.
4. Delete `faucet()` docs and tests if the dispatcher member is removed.

## 6. Docs, examples, and test updates

Docs to update:

- `packages/docs/content/devstack/features/accounts-and-wallet.mdx`
- `packages/docs/content/devstack/features/coins-and-funding.mdx`
- `packages/docs/content/devstack/reference/faucet.mdx`
- `packages/docs/content/devstack/reference/services.mdx`
- `packages/devstack/README.md`

Examples to update:

- `examples/token-studio/devstack.config.ts`
- `examples/deepbook-trader/devstack.config.ts`
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
rg -n "kind: '.*', name:|\\bfund\\?:" packages/devstack/src/plugins/account packages/docs/content/devstack examples
rg -n "coin\\.local|SYMBOL_FORM_NO_DEP_EDGE_WARNING|pkg\\(" packages/devstack/src packages/docs/content/devstack examples
rg -n "faucet\\(|FaucetDispatcher|requestFundsOnce|requestFundsWithRetry" packages/devstack/src packages/docs/content/devstack examples
```

## 8. Acceptance criteria

- Account public options cannot specify an inner `name`.
- SUI funding has one documented public option name.
- `pkg(...)`, `resolveSourcePath`, and callback capture are gone from the public package surface.
- Faucet exports match real built-in use; dispatcher-only APIs are deleted unless covered by a
  first-party custom-strategy test.
- Typecheck, focused tests, build, and packed-consumer smoke pass.

## 9. Explicit out-of-scope items

- Adding new funding strategy types beyond preserving current SUI and WAL behavior.
- Changing Sui custody/security semantics for live accounts.
- Expanding package codegen or generated Move bindings beyond what the cleanup requires.
