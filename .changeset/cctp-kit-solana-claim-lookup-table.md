---
'@mysten-incubation/cctp-kit': minor
---

Claims on Solana are now v0 transactions compiled against Circle's address lookup table, so they stay under Solana's 1232-byte limit after a wallet adds its compute budget instructions. Breaking: `SolanaChainDefinition` has a new required `cctpLookupTable`, `buildSolanaReceiveTransaction` returns a `VersionedTransaction`, and a custom `wallets.solana` adapter must accept `Transaction | VersionedTransaction`.
