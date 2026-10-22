# @mysten-incubation/cctp-kit

## 0.1.0

### Minor Changes

- 4e59e5d: Add `@mysten-incubation/cctp-kit`, an embeddable USDC bridge for Sui dapps built on
  Circle CCTP v2. It moves native USDC between Sui and 25 EVM chains plus Solana by burn and mint,
  with Fast Transfer where the source chain offers it. It ships a `<mysten-cctp-bridge>` web
  component, a headless core and React bindings, and takes its Sui wallet and client from dapp-kit
  2.0.
- 9d58c50: Claims on Solana are now v0 transactions compiled against Circle's address lookup table,
  so they stay under Solana's 1232-byte limit after a wallet adds its compute budget instructions.
  Breaking: `SolanaChainDefinition` has a new required `cctpLookupTable`,
  `buildSolanaReceiveTransaction` returns a `VersionedTransaction`, and a custom `wallets.solana`
  adapter must accept `Transaction | VersionedTransaction`.
