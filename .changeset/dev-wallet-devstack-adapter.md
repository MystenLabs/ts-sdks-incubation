---
'@mysten-incubation/dev-wallet': minor
---

Add the devstack signer adapter and a custom panel API.

**Adapter.**

- New `DevstackSignerAdapter` (and `DevstackProxySigner`) under
  `@mysten-incubation/dev-wallet/adapters`. Mirrors `RemoteCliAdapter`'s
  out-of-process model — keys never enter the frontend bundle; signing
  goes over HTTP to a devstack-side wallet-app server.
- `parseDevstackToken(pairedUrl)` and
  `createDevstackAdapterFromManifest(manifest)` helpers wire the adapter
  up from the devstack manifest's wallet-server service entry.

**Panel API.**

- New `WalletPanelDescriptor` type (`{ id, label, icon?, tagName }`) plus
  `DevWalletConfig.panels?` and `DevWalletInitializerConfig.panels?`
  options. The wallet appends each registered tab after the built-in
  Assets / Objects / Settings; the registered custom element gets
  `.wallet`, `.activeAddress`, and `.client` properties wired in
  automatically.
