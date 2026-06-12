// Counter flows over the generated Move bindings.
//
// Binding names come from devstack's Move codegen (snake_case Move fn →
// camelCase TS export):
//   - `counter::create_and_share` → `createAndShare`
//   - `counter::increment_entry`  → `incrementEntry`
//   - struct `Counter`            → `Counter` (with `.get({ client, objectId })`)
//
// No package id is threaded here: the generated builders default `package`
// to `@local/counter`; construct your client with
// `mvr: { overrides: { packages: config.mvrOverrides } }` (see
// `./generated/config.ts`) and the name resolves to the deployed id.

import type { ClientWithCoreApi } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

import {
	Counter,
	createAndShare as buildCreateAndShare,
	incrementEntry as buildIncrement,
} from './generated/bindings/counter/counter.ts';

/** Build a tx that creates + shares a fresh `Counter` (starts at 0). */
export function createCounterTx(): Transaction {
	const tx = new Transaction();
	buildCreateAndShare()(tx);
	return tx;
}

/** Build a tx that increments the shared `Counter` at `counterId` by one. */
export function incrementTx(counterId: string): Transaction {
	const tx = new Transaction();
	buildIncrement({ arguments: { counter: counterId } })(tx);
	return tx;
}

/** Read the current value of the shared `Counter` at `objectId`. */
export async function readCounter(client: ClientWithCoreApi, objectId: string): Promise<bigint> {
	const result = await Counter.get({ client, objectId });
	return BigInt(result.json.value);
}
