# Wallet and app entrypoints cleanup plan

Last updated: 2026-05-22.

## 1. Context and goals

This plan covers the dev wallet and app host-entrypoint surface:

- `packages/devstack/src/plugins/wallet`
- `packages/devstack/src/plugins/host-service`
- `packages/devstack/src/build-integrations/{vite,playwright,browser,runtime}`
- wallet/app docs under `packages/docs/content/devstack`
- examples `_template`, `token-studio`, `private-content`, `connect-four`, `deepbook-trader`, and
  `fork-greeting`.

The goal is to make the app-and-wallet path feel like one coherent dev-app entrypoint instead of a
set of loosely related primitives. Preserve the wallet security behavior, pairing protocol,
generated dapp-kit config, browser tests, and host-service supervision.

Boundary-layer router ownership and build-integration deduplication have already happened. This plan
owns the remaining public app/wallet API.

## Current status

Completed on 2026-05-22:

- `HostServiceOptions.needs` was renamed to `after` across the public type, factory implementation,
  first-party examples, create-devstack-app template, template sync fixups, and focused tests. No
  compatibility alias was kept.
- Example/template `devstack.config.ts` files that export a `stack` now annotate it with the public
  `Stack` handle so node-config declaration checks do not infer private package internals.

Current verification:

- `pnpm --filter @mysten-incubation/devstack exec vitest run test/plugins/host-service/service.test.ts test/api/define-devstack.test.ts test/build-integrations/release-surface.test.ts`
  passed (3 files / 40 tests).
- `pnpm --filter @mysten-incubation/create-devstack-app run check-template` passed.
- `pnpm --filter @mysten-incubation/create-devstack-app typecheck` passed.
- Direct node-config typechecks passed for the then-current examples; rerun after the remaining
  wallet-entrypoint cleanup lands against the current curated example set.

Still open:

- Wallet routing/origin duplication is still unresolved; this rename only fixes the host-service
  ordering vocabulary.
- Wallet internal root exports and the shared/generated Playwright dapp-kit bridge remain open.
- Wallet and token-studio browser e2e already have release proof in `UNRESOLVED-BLOCKERS.md`, but
  should be rerun after the remaining wallet-entrypoint cleanup lands.

## 2. Audit findings

### `wallet({ accounts: 'all' })` is implemented as composer magic

Current shape:

- `wallet()` defaults to `accounts: 'all'`.
- The wallet factory returns a placeholder with a symbol-keyed expander,
  `WALLET_EXPAND_ACCOUNTS_ALL`.
- The composer rewrites the member after it sees all account members.

Target shape:

- Keep the user-facing shorthand only if it remains easy to explain.
- Prefer explicit account refs in examples: `wallet({ accounts: [alice, bob] })`.
- If `accounts: 'all'` remains, hide the expander from root public exports and document it as an
  internal composer hook only.

### Router enablement is too manual

Current shape:

- Wallet routing is gated by `WalletOptions.enableRouter`.
- Docs/comments say it is implicitly true with a Vite plugin, but the current public shape still
  asks examples to pass `enableRouter: true`.
- `hostService(...)` always emits a routable declaration, while wallet routing is optional.

Target shape:

- Decide one behavior and make it true:
  - either wallet always emits a routable when the router is enabled for the stack, or
  - callers explicitly opt into every routed endpoint.
- Remove misleading comments about implicit Vite coupling until it is implemented.
- Examples should not need router-specific wallet flags for the standard app path.

### Allowed origins duplicate app-entrypoint facts

Current shape:

- Wallet callers pass `allowedOrigins`, `allowLocalhostVite`, and sometimes router origins.
- App examples already know their host-service port and router host.
- Playwright configs now pass app origins separately.

Target shape:

- Derive the standard app origin from the host-service/app plugin relationship.
- Keep `allowedOrigins` for true nonstandard origins only.
- Keep `allowLocalhostVite` as an explicit insecure opt-in for tests, but avoid requiring it for
  stack-scoped routed app flows.

### Public wallet barrel exports too many internals

Current shape:

- The wallet barrel exports protocol schemas, pairing helpers, origin policy helpers, server
  dispatch/start functions, routable builders, codegen builders, and snapshot builders.
- Most app authors only need `wallet`, `WalletOptions`, generated dapp-kit config, and maybe
  protocol types for tests.

Target shape:

- Keep root exports small.
- Move server internals, pairing helpers, CORS helpers, and codegen/snapshot builders behind
  internal source imports or test utilities.
- Keep protocol request/response types public only if the dev-wallet package consumes them from the
  package root.

### Playwright bridge teaches app-local globals

Current shape:

- Examples must install `connectAs(...)` and expose a dapp-kit selection slot from app code.
- The app-side slot is deliberately narrow now, but each example owns repeated setup.

Target shape:

- Provide one documented helper or generated app snippet for the dapp-kit test bridge.
- Examples should not each reimplement account name/address lookup and wallet store polling.
- Preserve the rule that browser apps do not import `@mysten-incubation/devstack`.

## 3. Specific public API changes

- Remove `WalletOptions.enableRouter` if routing can be derived from stack/router state. Otherwise
  update docs to present it as a required explicit flag.
- Move `WALLET_EXPAND_ACCOUNTS_ALL` and `WalletExpandAccountsAllExpander` out of root exports.
- Stop exporting wallet server internals from the root barrel: `dispatch`, `startHttpServer`,
  `WalletServerConfig`, `WalletServerHandle`, and `makeWalletRoutable`.
- Stop exporting wallet implementation helpers unless required by `@mysten-incubation/dev-wallet`:
  `mintToken`, `acquirePairingToken`, `tokenPath`, `composePairUrl`, `parsePairUrl`,
  `parseBearerHeader`, `safeBearerEquals`, `redactToken`, `resolveOriginPolicy`, `checkOrigin`, and
  `corsHeadersFor`.
- Add or expose a single build-integration runtime helper for the Playwright dapp-kit selection
  bridge, without importing devstack from app runtime bundles.

## 4. Internal implementation changes

- Update wallet composer expansion in `packages/devstack/src/api/define-devstack.ts` and
  `define-devstack-with.ts` if `accounts: 'all'` remains.
- Move wallet implementation-only exports to internal module imports in tests.
- Update `build-integrations/runtime/dapp-kit-slot.ts`, `vite/setup-globals.ts`,
  `playwright/wallet-context.ts`, and example app glue so selection bridge code is shared.
- Keep router entrypoint derivation aligned with the current plugin-owned entrypoint architecture.

## 5. Built-in plugin/component migration steps

1. Decide wallet routing derivation and update wallet capabilities accordingly.
2. Move wallet internal exports and update tests to import from source-internal paths when needed.
3. Replace duplicated example dapp-kit Playwright slots with the shared helper/snippet.
4. Update create-devstack-app template after examples are migrated.

## 6. Docs, examples, and test updates

Docs to update:

- `packages/docs/content/devstack/features/accounts-and-wallet.mdx`
- `packages/docs/content/devstack/features/testing-playwright.mdx`
- `packages/docs/content/devstack/features/local-dev.mdx`
- `packages/docs/content/devstack/reference/services.mdx`
- `packages/devstack/README.md`

Examples/template to update:

- `examples/_template/devstack.config.ts`
- `examples/token-studio/devstack.config.ts`
- `examples/token-studio/src/dapp-kit.ts`
- `examples/private-content/devstack.config.ts`
- `examples/connect-four/devstack.config.ts`
- `examples/fork-greeting/devstack.config.ts`
- `packages/create-devstack-app/template/devstack.config.ts`

Tests to update:

- `test/plugins/wallet/accounts-all.test.ts`
- `test/plugins/wallet/origin-policy.test.ts`
- `test/plugins/wallet/pairing-token.test.ts`
- `test/plugins/wallet/snapshot.test.ts`
- `test/plugins/host-service/service.test.ts`
- `test/build-integrations/playwright/wallet-context.test.ts`
- `test/build-integrations/vite/dapp-kit-slot.test.ts`
- `test/build-integrations/runtime/dapp-kit-slot.test.ts`
- `test/build-integrations/release-surface.test.ts`

## 7. Verification commands

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run \
	test/plugins/wallet/accounts-all.test.ts \
	test/plugins/wallet/origin-policy.test.ts \
	test/plugins/wallet/pairing-token.test.ts \
	test/build-integrations/playwright/wallet-context.test.ts \
	test/build-integrations/vite/dapp-kit-slot.test.ts \
	test/build-integrations/runtime/dapp-kit-slot.test.ts \
	test/build-integrations/release-surface.test.ts
pnpm --filter @mysten-incubation/create-devstack-app run check-template
pnpm --filter @mysten-incubation/deepbook-trader test:e2e
pnpm --filter @mysten-incubation/token-studio test:e2e
```

Residue scans:

```bash
rg -n "needs:" examples packages/create-devstack-app packages/docs/content/devstack packages/devstack/src
rg -n "WALLET_EXPAND_ACCOUNTS_ALL|WalletExpandAccountsAllExpander" packages/devstack/src/index.ts packages/devstack/src/plugins/wallet
rg -n "enableRouter: true" examples packages/docs/content/devstack packages/create-devstack-app
```

## 8. Acceptance criteria

- Standard app + wallet examples do not require redundant router/origin flags.
- Wallet internals are no longer root public exports unless they are consumed by the dev-wallet
  package.
- The Playwright dapp-kit bridge is shared or generated; examples do not carry divergent polling
  code.
- DeepBook-trader wallet e2e and token-studio e2e pass.
- Create-devstack-app template check passes.

## 9. Explicit out-of-scope items

- Changing the dev-wallet package UI or wallet-standard adapter behavior.
- Weakening origin + bearer enforcement.
- Generic router entrypoint ownership and build-integration runtime consolidation.
- Adding multi-wallet or production wallet support.
