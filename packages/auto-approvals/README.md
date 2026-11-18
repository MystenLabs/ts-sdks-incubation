# @mysten-incubation/auto-approvals

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

```ts
import { analyze } from '@mysten/wallet-sdk';
import { AutoApprovalManager, autoApprovalAnalyzer } from '@mysten-incubation/auto-approvals';

const manager = new AutoApprovalManager({ policy, state: savedState });

const { autoApproval } = await analyze(
	{ autoApproval: autoApprovalAnalyzer },
	{ transaction, client, getCoinPrices },
);

const check = manager.checkTransaction(autoApproval);

if (check.canAutoApprove) {
	manager.commitTransaction(autoApproval);
	const result = await signAndExecute(transaction);
	manager.applyTransactionEffects(autoApproval, result);
} else if (check.matchesPolicy) {
	// Ask the user to approve the operation, then call manager.updateSettings(...)
}

saveState(manager.export());
```

If execution fails, call `manager.revertTransaction(autoApproval)` to release the reserved budget.
