# token-studio + arena + wallet examples

**Verdict**: B+ — Strong consistency, in places too high. Each example earns its place pedagogically. The byte-identical duplication of `dapp-kit.ts`, `Card.tsx`, and `lib/format.ts` is debt the next phase needs to pay before more apps land. Notable miss: no NFT example.

## Architecture consistency: very high, in places too high

The three apps are *strongly* aligned at every layer that matters. Common shape:

- **Identical scaffold:** every app has `devstack.config.ts` + `<app>Plugin.ts` + `vite.config.ts` + `vitest.config.ts` + `playwright.config.ts` + `tsconfig*.json` in the same shape. `vitest.config.ts` is the one-liner `defineDevstackVitestConfig()`. `playwright.config.ts` is `defineDevstackPlaywrightConfig({ port, manageStack: true })`.
- **Identical package.json scripts:** all four apps ship the exact same 12 scripts.
- **Identical providers:** `src/main.tsx` is the same `<StrictMode><QueryClientProvider><DAppKitProvider><DevstackProvider>` tree across all three.
- **Identical wallet plumbing:** `src/dapp-kit.ts` is **byte-for-byte identical** in arena, token-studio and wallet.
- **Same App layout:** all three render a header with `<ConnectButton/>`, a `NotDeployed` state, a `DisconnectedView`, then a `ConnectedView`. Tailwind palette per app is the only visible variation.

The downside: **a lot of duplication**. The codebase has explicit `// FRICTION:` markers calling it out — `Card.tsx` is byte-identical between wallet and token-studio (and arena's is near-identical), `shortAddress`/`labelFor` are noted as the "fourth copy", `Field` is duplicated across MintForm/TransferForm/SendForm/SwapForm, and `useCoinBalance`/`useInvalidateBalances` are near-duplicates between wallet and token-studio. The authors are aware (good — the friction notes are actionable) but no shared `@mysten-incubation/ui` or `@mysten-incubation/dev-react` package has been extracted yet. For an examples set whose job is to *teach the API*, the duplication is mostly fine; the danger is when readers think "that's how I'm supposed to do it" instead of seeing prebuilt primitives.

## Surface coverage across the four apps

Combined, the four examples exercise:

- **Plugins:** `sui`, `codegen`, `walletServer`, `vite`, `walrus`, `seal`, `imports` — all hit. Per-app plugin authoring (`definePlugin`/`definePublishAction`/`seed`) is covered.
- **Capture types:** `TreasuryCap`, `CoinMetadata`, `UpgradeCap`, `Registry`, `DeepbookAdminCap`, `Lobby` — broad coverage of `capture:` patterns.
- **Action variety:** publish, seed-shared-object (arena), seed-tokens via TreasuryCap mint (wallet), multi-tx seeds with cross-action `needs:` ordering, namespace registries.
- **Frontend hooks:** `useDevstackDeployed`, `useDevstackPackage`, `useDevstackSignAndExecute` (with and without `invalidateKeys`), `DevstackProvider`, `DevstackDebugPanel`.
- **Codegen consumption:** all four declaration-merge `DevstackPackageRegistry`.

**What's not exercised:**
- **`deploy` to live testnet/mainnet** — every app has the script but no example actually publishes against a non-localnet target.
- **Multi-stack workflows** — every app has `.devstack/active` + `.devstack/stacks/`, but no example demonstrates flipping between e.g. localnet/test stacks at runtime.
- **Custom signers / non-Ed25519 / multisig** — only the default localnet keystore + dev-wallet are exercised.
- **Custom service plugin** — every app uses only `sui`/`walrus`/`seal`/`walletServer`. No demo of writing a new long-running service plugin for a third-party daemon.
- **`emit` action** — registered in the plugin SPI but no example uses it.
- **Production build of a panel-driven app** is wired but no example commits a built-output story.

## Integration variety: each app pulls its own weight

- **token-studio** — minimal canonical "publish + capture caps" example. One action, alice-as-publisher gates the mint UI. Cleanest reference for "I want to deploy a coin and use it from React."
- **arena** — only example demonstrating `seed()` + `seedSharedObject()` + namespaced registries (`arena.sharedObjects`). It's also the only example that does interactive multi-account coordination (lobby→game state machine, polling on shared objects). The Move package has its own unit tests (4 `#[test]` functions) — no other example does this.
- **wallet** — only example using the `imports` plugin (deepbook v3 from upstream GitHub, pinned by rev), and the only one that demonstrates a multi-coin app, a multi-step seed chain (`seedTokens`→`seedPools`→`seedOrders`) with explicit gas-contention ordering, and namespace registries with two independent kinds (`pools`, `balanceManager`). Substantively the heaviest plugin file (~480 lines).
- **private-content** — adds `walrus` + `seal` plugins. Outside scope but worth noting it's the only one with full encrypted-storage flow.

The split is genuinely useful: each app would teach a different reader.

## Customizability and gaps

**Genuinely uncovered use cases that a Sui scaffold-eth-2 audience would expect:**

- **NFT / kiosk / display object** — no example. `display` and `kiosk` are big Sui patterns and have nothing.
- **Sponsored transactions** — `wallet-server` supports it, but no example sponsors anything.
- **Oracle / Pyth consumer** — no example imports Pyth/Switchboard via `imports` and reads price feeds.
- **AMM** — wallet uses DeepBook (orderbook), but no AMM example.
- **Social / chat / on-chain identity** — no example uses dynamic fields or owned-object inboxes for messaging.
- **Subscription / time-locked / clock-driven flows** — `0x6` clock is read in wallet's seedOrders but no UI-side example consumes Clock for a vesting/unlock pattern.
- **Custom external service** — none of these apps stand up a non-stock backend daemon as a `service` plugin.

For "scaffold-eth-2 for Sui," the **missing NFT example is the most conspicuous gap** — it's the demo most newcomers will look for first.

## Testing

E2E suites are real but uneven:

- **token-studio** — 1 spec, 2 tests (mint, transfer). Bare minimum. Doesn't test burn or supply readback.
- **arena** — 1 spec, 1 long test. Strong: exercises lobby→game transition through real UI clicks, then drives 7 moves via JSON-RPC for speed. The most ambitious test.
- **wallet** — 3 specs: `send-sui`, `swap` (DeepBook taker against seeded book), and `panels` (smoke for `dev-wallet-panel` custom element). Strongest e2e coverage.
- **No unit tests anywhere** — `vitest.config.ts` is wired and `pnpm test` works, but `find` finds zero `*.test.ts` or `*.test.tsx` files in any of the three.

**Quality issues spotted:**
- `arena/e2e/connect-four.spec.ts` re-implements manifest loading + key loading from scratch. The `defineDevstackPlaywrightConfig` should be exposing helpers for these.
- `wallet/e2e/swap.spec.ts` has no graceful fallback if seedOrders fails; the UI just shows "no pools," which is a vague failure mode.

## Top recommendations

1. **Lift duplicated UI primitives** (`dapp-kit.ts`, `Card.tsx`, `Field.tsx`, `lib/format.ts`) into a shared package before adding more examples.
2. **Add an NFT example** (kiosk + display) — the biggest missing demo for the Sui audience.
3. **Add a live-net deploy walkthrough** in one example (testnet promotion).
4. **Expose manifest-loading helpers** from `defineDevstackPlaywrightConfig` so e2e specs don't re-implement them.
5. **Add unit tests** in at least one example as a reference shape (lib/format, lib/coin formatting).
