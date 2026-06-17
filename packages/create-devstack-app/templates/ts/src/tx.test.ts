// Unit test — pure logic, no devstack, no Docker. Runs under `pnpm test`.

import type { SuiClientTypes } from '@mysten/sui/client';
import { describe, expect, it } from 'vitest';

import { executedTx } from './tx.ts';

type Result = SuiClientTypes.TransactionResult<{ effects: true }>;

describe('executedTx', () => {
	it('returns the digest and the created object id on success', () => {
		const result = {
			$kind: 'Transaction',
			Transaction: {
				digest: '0xdigest',
				effects: {
					changedObjects: [
						{ idOperation: 'Mutated', objectId: '0xgas' },
						{ idOperation: 'Created', objectId: '0xcounter' },
					],
				},
			},
		} as unknown as Result;

		expect(executedTx(result)).toEqual({ digest: '0xdigest', createdId: '0xcounter' });
	});

	it('reports an undefined createdId when the tx created nothing', () => {
		const result = {
			$kind: 'Transaction',
			Transaction: { digest: '0xd', effects: { changedObjects: [] } },
		} as unknown as Result;

		expect(executedTx(result)).toEqual({ digest: '0xd', createdId: undefined });
	});

	it('throws the on-chain failure message', () => {
		const result = {
			$kind: 'FailedTransaction',
			FailedTransaction: { status: { error: { message: 'MoveAbort(counter, 1)' } } },
		} as unknown as Result;

		expect(() => executedTx(result)).toThrow('MoveAbort(counter, 1)');
	});
});
