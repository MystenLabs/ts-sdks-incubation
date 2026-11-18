---
'@mysten-incubation/auto-approvals': minor
---

Add `@mysten-incubation/auto-approvals`, the policy-based transaction auto-approval manager previously exported from `@mysten/wallet-sdk`. Compared to the last `@mysten/wallet-sdk` release, the shared budget now covers the combined value of every coin type a transaction spends, owned-object permissions compare access levels correctly, spends that need a shared budget are rejected when none is configured, empty coin budgets count as zero, policy object types are normalized before matching, and `applyTransactionEffects` rejects results whose digest doesn't match the analysis. `readOperationType` replaces `extractOperationType` for reading a dApp's operation intent, which `analyze` can't copy on its own. `updateSettings` throws while a transaction is pending, coin budgets must be raw integer amounts, a digest can't be committed twice, and saved state that can't be decoded is ignored with a warning.
