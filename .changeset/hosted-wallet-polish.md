---
'@mysten-incubation/dev-wallet': minor
---

Standalone wallet and hosted-wallet fixes.

- **Breaking:** `DevWalletConfig.persistNetworks` is renamed to `persistState`. It now also persists
  the active network and the UI's active account, under a versioned `dev-wallet:state:v1` key.
  Networks saved under the old `dev-wallet:networks` key aren't migrated. Invalid saved state is
  ignored with a warning.
- **Breaking:** `<dev-wallet-standalone>`'s `bookmarkletOrigin` is renamed to `walletOrigin`. It now
  defaults to the page origin.
- New `DevWallet.activeAccount` / `setActiveAccount()`, and a `<dev-wallet-connect-guide>` element
  (bookmarklet, console script, and dApp Kit snippet for a given origin).
- The standalone page centers the wallet and shows setup help beside it. On narrow screens the same
  help is at the top of the Settings tab. It drops the embed snippet, the stale `v0.1.0` badge, and
  the "Running" indicator.
- The `serve` wallet configures the devnet and localnet faucets, so the Faucet button works there.
- `DevWalletClient` identifies the requesting dApp in approval popups by its `document.title`
  (falling back to its host) instead of the wallet's own name.
