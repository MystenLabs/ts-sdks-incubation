---
'@mysten-incubation/devstack': minor
'@mysten-incubation/dev-wallet': minor
---

Disambiguate the conflated `chain` concept into three precise ones: `network` (the network name — `localnet`/`testnet`/…), `chainId` (the genesis-digest chain identifier, unique per spun-up network), and the wallet-standard `sui:<network>` chain name (derived only at the dev-wallet wallet-standard boundary — `sui:` never appears in devstack internals).

**Breaking.** The substrate `Identity`/manifest field `chain` is now `network` and holds the bare network name (previously a `sui:`-prefixed string). The network parser accepts only canonical names — the `local` shorthand and the `sui:`-prefixed alias table are removed (use `localnet`); `network ⇄ chain id` is now just a `sui:` prefix, not a lookup table. The sui plugin's resolved value, on-disk cache-dir keys, and `chain-probe:`/`faucet:request:` capability keys now key on the genesis-digest `chainId`. The generated `config.ts` active-network key is `localnet` (was `local`), and `config.networks.<net>` / `byNetwork.<net>` are keyed by network name. The dev-wallet `registerDevstackDevWallet` config and `DevWalletConfig` take `network` instead of `chain`. The dashboard GraphQL surfaces `chainId` (sui) and `network` (deepbook) instead of `chain`. Known walrus/deepbook deployments and the deepbook DEEP-funding gate now key on the network name — fixing a latent bug where the gate compared a genesis digest against the `'sui:testnet'` literal and was dead for every non-literal value.

On-disk state keyed by the old `sui:local` chain brand is invalidated; run `devstack wipe` on existing local stacks after upgrading.
