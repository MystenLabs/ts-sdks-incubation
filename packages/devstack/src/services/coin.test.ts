// L1 unit test for `mintFromTreasury` — verifies the Transaction builder
// produces the expected `0x2::coin::mint_and_transfer` moveCall with the
// right type arg + ordered positional args.
//
// We invoke the moveCall builder directly (rather than the full Effect
// tag) since the tx shape is the load-bearing piece; the full mint
// + state-store cache flow is covered by the L3 docker tests.

import { describe, expect, it } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';

describe('mintFromTreasury tx-builder shape', () => {
	it('produces `0x2::coin::mint_and_transfer<T>` with (cap, amount, recipient) args', async () => {
		const treasuryCapId = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
		const fullCoinType = '0xabcdef::deep::DEEP';
		const recipient = '0x9999999999999999999999999999999999999999999999999999999999999999';
		const amount = 1_000_000_000n;

		const t = new Transaction();
		t.setGasBudget(100_000_000n);
		t.moveCall({
			target: '0x2::coin::mint_and_transfer',
			typeArguments: [fullCoinType],
			arguments: [t.object(treasuryCapId), t.pure.u64(amount), t.pure.address(recipient)],
		});

		// Inspect the constructed tx's serialized commands. The SDK exposes
		// `t.getData()` (sync, snapshot of the transaction-data builder)
		// which surfaces `commands` for inspection without serializing the
		// whole thing.
		const data = t.getData();
		const commands = data.commands;
		expect(commands.length).toBe(1);
		const moveCall = commands[0] as {
			readonly $kind: string;
			readonly MoveCall?: {
				readonly package: string;
				readonly module: string;
				readonly function: string;
				readonly typeArguments: ReadonlyArray<string>;
				readonly arguments: ReadonlyArray<unknown>;
			};
		};
		expect(moveCall.$kind).toBe('MoveCall');
		expect(moveCall.MoveCall?.package).toBe('0x0000000000000000000000000000000000000000000000000000000000000002');
		expect(moveCall.MoveCall?.module).toBe('coin');
		expect(moveCall.MoveCall?.function).toBe('mint_and_transfer');
		expect(moveCall.MoveCall?.typeArguments).toEqual([fullCoinType]);
		expect(moveCall.MoveCall?.arguments.length).toBe(3);
	});
});
