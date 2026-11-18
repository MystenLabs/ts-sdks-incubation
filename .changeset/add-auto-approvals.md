---
'@mysten-incubation/auto-approvals': minor
---

Add `@mysten-incubation/auto-approvals`, the policy-based transaction auto-approval manager previously exported from `@mysten/wallet-sdk`. Compared to the last `@mysten/wallet-sdk` release, the shared budget now covers the combined value of every coin type a transaction spends, owned-object permissions compare access levels correctly, spends that need a shared budget are rejected when none is configured, empty coin budgets count as zero, policy object types are normalized before matching, and `applyTransactionEffects` rejects results whose digest doesn't match the analysis.
