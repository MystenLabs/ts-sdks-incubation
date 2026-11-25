---
'@mysten-incubation/cctp-kit': minor
---

Add deposit addresses: a "Send to an address" tab where the user gets an address on Base or Solana, with a QR code, sends USDC to it from any wallet or exchange, and receives it on Sui. The widget derives the address itself and watches it; the claimer service (`deposit.baseUrl`, or `sponsor.baseUrl`) processes the deposit, and the transfer then runs like any other. `deposit.recovery` sets whether users may (`optional`) or must (`required`) give a recovery address on the source chain; the default, `none`, makes Sui-only addresses. Testnet only for now: no deposit contracts are on mainnet yet.

`deposit.only` makes it a deposit-only widget, with no wallet form.

New: `CctpKitConfig.deposit`, `kit.depositChains()`, `kit.depositAddress()`, `kit.watchDeposit()`, `kit.savedRecovery()`, `kit.saveRecovery()`, `stores.$deposit`, and the exports `deriveDepositAddress`, `DEPOSIT_CONTRACTS`, `minimumDeposit`, `watchDepositAddress` and `requestDepositProcess`. Adds the `uqr` dependency for the QR code.
