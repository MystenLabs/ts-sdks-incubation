---
'@mysten-incubation/devstack': major
---

Replace the in-bundle key flow with an out-of-process signing server.

**Added.**

- `walletServer()` plugin — a built-in Service action that spins up an
  in-process HTTP server exposing every account devstack resolved
  (`cliSigner`, `envSigner`, `generatedKeypair`, …). Pairs with the new
  `DevstackSignerAdapter` in `@mysten-incubation/dev-wallet`. Service URL +
  paired token are written to `manifest.registry.services` as the
  `wallet-server` entry. Localnet-only.
- `createDevstackDappKit({ walletInitializers })` — pass the new
  `devWalletInitializer({ adapters: [DevstackSignerAdapter], ... })` through
  directly. Same hook the old `walletInitializerFactory` used internally,
  but now expressed as the wallet-standard initializer the rest of the
  ecosystem speaks.

**Removed (breaking).**

- `virtual:devstack-keys` Vite virtual module and the `devKeysPlugin`
  function. Inlining seeded keys into the frontend bundle is no longer the
  recommended path; use the wallet-server above. Apps still relying on the
  virtual module will fail to build — switch to
  `createDevstackAdapterFromManifest` from `@mysten-incubation/dev-wallet/adapters`.
- `DevKey` and `DevWalletInitializerFactory` types from
  `@mysten-incubation/devstack/dapp-kit`. The `devKeys` and
  `walletInitializerFactory` options on `createDevstackDappKit` are gone;
  use `walletInitializers` instead.

**Other.**

- Playwright `connectAs` helper retargets dApp Kit's current account via
  `dappKit.switchAccount({ account })` instead of looking for a per-account
  `Dev: <label>` wallet entry.
