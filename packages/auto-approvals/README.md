# @mysten-incubation/auto-approvals

> [!WARNING] This package is experimental and not ready for production use. Its API may change in
> any release.

Policy-based transaction auto-approvals for Sui wallets. A dApp publishes a policy that describes
its operations and the coins and objects each one may touch. The user approves operations and sets
budgets, and the wallet can then sign matching transactions without prompting.

Built on the transaction analyzer in
[`@mysten/wallet-sdk`](https://www.npmjs.com/package/@mysten/wallet-sdk).

## Installation

```sh
npm i @mysten-incubation/auto-approvals @mysten/wallet-sdk @mysten/sui
```

## dApp: tag transactions with an operation

```ts
import { operationType } from '@mysten-incubation/auto-approvals';

const tx = new Transaction();
tx.add(operationType('increment-counter'));
```

## Wallet: check, commit, and reconcile

The wallet must list `OPERATION_INTENT` in its `supportedIntents` so the operation reaches it.
`readOperationType` reads the operation and removes the intent before analysis. If the transaction
also carries other custom intents, pass their resolvers in `intentResolvers` and build the result
before analysing it, since `analyze` can't copy unresolved custom intents:

```ts
const { transaction, operationType } = await readOperationType(json, { intentResolvers });
const bytes = await Transaction.from(transaction, { intentResolvers }).build({ client });
```

Budgets are charged for the net balance change of the transaction sender. If the wallet signs with
other addresses, such as a gas sponsor, pass all of its own addresses in
`autoApproval.senderAddresses` instead. Analysis fails for a sponsored transaction without them.

```ts
import { analyze } from '@mysten/wallet-sdk';
import {
	AutoApprovalManager,
	autoApprovalAnalyzer,
	readOperationType,
} from '@mysten-incubation/auto-approvals';

const manager = new AutoApprovalManager({ policy, state: savedState });

const { transaction, operationType } = await readOperationType(transactionJson);
const { autoApproval } = await analyze(
	{ autoApproval: autoApprovalAnalyzer },
	{ transaction, client, operationType: operationType ?? undefined, getCoinPrices },
);

const check = manager.checkTransaction(autoApproval);

if (check.canAutoApprove) {
	manager.commitTransaction(autoApproval);
	// Persist the reservation before executing so a crash can't restore the spent budget.
	saveState(manager.export());
	// Sign exactly the bytes that were analysed, so the executed digest matches the reservation.
	// Execute with `include: { balanceChanges: true }`. Aborted transactions still spend gas, so
	// reconcile both result variants.
	const result = await signAndExecute(autoApproval.result.bytes);
	manager.applyTransactionEffects(autoApproval, result.Transaction ?? result.FailedTransaction);
} else if (check.matchesPolicy) {
	// Ask the user to approve the operation, then call manager.updateSettings(...)
}

saveState(manager.export());
```

If the transaction is never executed (signing or submission fails), call
`manager.revertTransaction(autoApproval)` to release the reserved budget.

`updateSettings` throws while a transaction is pending, so settle or revert it first. Pending
transactions are stored by digest only, so after a restart a pending transaction can't be settled or
reverted with its original budget accounting. `reset()` clears it, along with the settings and
approvals.

## Budgets

Each coin type can have its own budget in `coinBudgets`, as a raw amount in the coin's smallest
unit. Spending in coin types without one is charged to `sharedBudget`, which is a value in the same
units `getCoinPrices` returns. A coin that `getCoinPrices` can't price can only be spent from its
own coin budget.

A transaction is charged for the net balance change of the wallet's addresses. When the wallet pays
gas, it's charged at least the gas budget in SUI even if it expects an inflow, because an aborted
transaction rolls back the inflow but still spends gas. `applyTransactionEffects` then replaces the
reservation with the real balance changes, but never leaves a budget higher than it was before the
transaction.

`commitTransaction` re-checks the transaction and throws `AutoApprovalRejectedError`, with the
digest and the check result, if it no longer passes.
