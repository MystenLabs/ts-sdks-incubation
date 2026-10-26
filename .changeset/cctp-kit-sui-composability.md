---
'@mysten-incubation/cctp-kit': minor
---

Add `sui.executeTransaction` to execute the kit's Sui burns and claims in place of dapp-kit's
wallet, `claim: 'manual'` with `kit.claim(id)`, and `suiDepositForBurn` / `suiReceiveMessage`
transaction thunks. `SuiDepositForBurnParams` now takes a `coin`; `buildSuiBurnTransaction` takes
`SuiBurnTransactionParams`.
