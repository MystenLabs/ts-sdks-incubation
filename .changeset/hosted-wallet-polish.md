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
- New `DevWallet.activeAccount` / `setActiveAccount()`.
- New connected-apps tracking: `ConnectedAppsStore` (in `/client`), which you pass to
  `parseWalletRequest({ connectedApps })` and `<dev-wallet-standalone>.connectedApps`. Approved
  connects are recorded, and signing requests from a disconnected origin are rejected.
- The standalone page centers the wallet, with a tabbed connect guide on the left (bookmarklet
  steps, console script, dApp Kit snippet) and connected apps on the right. On narrow screens both
  move to the top of the Settings tab. New elements: `<dev-wallet-connect-guide>` and
  `<dev-wallet-connected-apps>`. The page drops the embed snippet, the stale `v0.1.0` badge, and the
  "Running" indicator.
- The `serve` wallet configures the devnet and localnet faucets, so the Faucet button works there.
  After a faucet request, the balance refreshes once the transfer lands, not before.
- Custom networks in Settings take an optional faucet URL. `addNetwork(name, url, null)` now clears
  a network's faucet (omitting the argument leaves it unchanged), and faucet URLs are persisted.
- Fix: switching networks didn't re-render the wallet UI, so the badge, balances, and Faucet button
  stayed on the previous network.
- Remove the non-functional "Manage" button from the balances list.
- `DevWalletClient` identifies the requesting dApp in approval popups by its `document.title`
  (falling back to its host) instead of the wallet's own name.
