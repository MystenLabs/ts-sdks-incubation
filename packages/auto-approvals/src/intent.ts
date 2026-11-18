// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TransactionDataBuilder, TransactionResult } from '@mysten/sui/transactions';
import { Transaction, TransactionCommands } from '@mysten/sui/transactions';

export const OPERATION_INTENT = '@mysten/wallet-kit/AutoApprovalOperation';

export function operationType(operationType: string) {
	return (tx: Transaction): TransactionResult => {
		tx.addIntentResolver(OPERATION_INTENT, (transactionData, _options, next) => {
			replaceOperationTypeIntent(transactionData);
			return next();
		});

		const result = tx.add(
			TransactionCommands.Intent({
				name: OPERATION_INTENT,
				inputs: {},
				data: { operationType },
			}),
		);

		return result;
	};
}

/**
 * Reads the operation type a dApp tagged with {@link operationType} and returns a copy of the
 * transaction (as JSON) with that intent removed, ready to pass to `analyze` with `operationType`.
 * Other intents are left for the wallet to resolve.
 */
export async function readOperationType(
	transaction: Parameters<typeof Transaction.from>[0],
): Promise<{ transaction: string; operationType: string | null }> {
	let operationType: string | null = null;

	const tx = Transaction.from(transaction, {
		intentResolvers: {
			[OPERATION_INTENT]: (transactionData, _options, next) => {
				replaceOperationTypeIntent(transactionData, (type) => {
					operationType = type;
				});
				return next();
			},
		},
	});

	const otherIntents = tx
		.getData()
		.commands.flatMap((command) =>
			command.$kind === '$Intent' && command.$Intent.name !== OPERATION_INTENT
				? [command.$Intent.name]
				: [],
		);
	const json = await tx.toJSON({ supportedIntents: otherIntents });

	return { transaction: json, operationType };
}

function replaceOperationTypeIntent(
	transactionData: TransactionDataBuilder,
	cb?: (operationType: string) => void,
) {
	let intentFound = false;
	for (let index = 0; index < transactionData.commands.length; index++) {
		const command = transactionData.commands[index];
		if (command.$kind === '$Intent' && command.$Intent.name === OPERATION_INTENT) {
			if (intentFound) {
				throw new Error('Multiple operation type intents found in transaction');
			}
			intentFound = true;
			const operationType = command.$Intent.data.operationType as string;
			transactionData.replaceCommand(index, []);
			cb?.(operationType);
		}
	}
}
