import { describe, expect, it } from 'vitest';

import { createCounterTx, incrementTx } from './counter.js';

interface MoveCall {
	readonly package?: string;
	readonly module?: string;
	readonly function?: string;
}

/** Pull the (single) MoveCall out of a built transaction's command list,
 *  tolerating the `{ $kind, MoveCall }` enum wrapper the sui SDK emits. */
function moveCallOf(tx: { getData: () => unknown }): MoveCall {
	const data = tx.getData() as { commands?: ReadonlyArray<Record<string, unknown>> };
	const commands = data.commands ?? [];
	for (const command of commands) {
		const call = (command.MoveCall ?? command) as MoveCall;
		if (call.function !== undefined) return call;
	}
	throw new Error('transaction has no MoveCall command');
}

describe('counter tx builders', () => {
	it('createCounterTx targets counter::create_and_share', () => {
		const call = moveCallOf(createCounterTx());
		expect(call.module).toBe('counter');
		expect(call.function).toBe('create_and_share');
	});

	it('incrementTx targets counter::increment_entry', () => {
		const call = moveCallOf(incrementTx('0x1'));
		expect(call.module).toBe('counter');
		expect(call.function).toBe('increment_entry');
	});
});
