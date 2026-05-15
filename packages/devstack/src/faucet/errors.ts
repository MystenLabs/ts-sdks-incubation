import { Data } from 'effect';

/** Tagged error surfaced by every Faucet strategy. The `coinType` field
 *  carries the coin the request was for (e.g. `'SUI'`, `'WAL'`, or a
 *  fully-qualified Move type) so a multi-strategy run's error message
 *  points at the right strategy. */
export class FaucetRequestError extends Data.TaggedError('FaucetRequestError')<{
	readonly coinType: string;
	readonly address: string;
	readonly amount: bigint;
	readonly message: string;
	readonly cause?: unknown;
}> {}
