# @mysten-incubation/dev-wallet

## 0.2.0

### Minor Changes

- 3806dc8: Add the devstack signer adapter and a custom panel API.

  **Adapter.**
  - New `DevstackSignerAdapter` (and `DevstackProxySigner`) under
    `@mysten-incubation/dev-wallet/adapters`. Mirrors `RemoteCliAdapter`'s out-of-process model —
    keys never enter the frontend bundle; signing goes over HTTP to a devstack-side wallet-app
    server.
  - `parseDevstackToken(pairedUrl)` and `createDevstackAdapterFromManifest(manifest)` helpers wire
    the adapter up from the devstack manifest's wallet-server service entry.

  **Panel API.**
  - New `WalletPanelDescriptor` type (`{ id, label, icon?, tagName }`) plus
    `DevWalletConfig.panels?` and `DevWalletInitializerConfig.panels?` options. The wallet appends
    each registered tab after the built-in Assets / Objects / Settings; the registered custom
    element gets `.wallet`, `.activeAddress`, and `.client` properties wired in automatically.

### Patch Changes

- 9be42e5: Redesign the dev wallet UI with a clearer standalone layout, polished wallet panel
  chrome, useful side content, refreshed settings and signing flows, and updated docs screenshots.

## 0.0.1

### Patch Changes

- Test publish via CI
