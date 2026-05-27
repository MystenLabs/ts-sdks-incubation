import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';

import type { AccountValue } from '../../../src/plugins/account/index.ts';
import type { SuiSdkShim } from '../../../src/plugins/sui/index.ts';

const harness = vi.hoisted(() => ({
	quote: {
		baseOut: 1,
		quoteIn: 1,
		deepRequired: 0,
	},
	txBuilds: 0,
	swapArgs: [] as unknown[],
}));

vi.mock('@mysten/deepbook-v3', () => ({
	DeepBookClient: class {
		readonly deepBook = {
			swapExactQuantity: (args: unknown) => {
				harness.swapArgs.push(args);
				return ['base-coin', 'quote-coin', 'deep-coin'];
			},
		};

		getQuoteQuantityIn(): Promise<typeof harness.quote> {
			return Promise.resolve(harness.quote);
		}
	},
}));

vi.mock('@mysten/sui/transactions', () => ({
	Transaction: class {
		setSender(_address: string): void {}
		add<T>(value: T): T {
			return value;
		}
		transferObjects(_objects: ReadonlyArray<unknown>, _address: string): void {}
		build(): Promise<Uint8Array> {
			harness.txBuilds += 1;
			return Promise.resolve(new Uint8Array([1, 2, 3]));
		}
	},
}));

import { makeDeepbookDeepFundingStrategy } from '../../../src/plugins/deepbook/faucet-strategy.ts';

const sdk = { client: {}, core: {} } as unknown as SuiSdkShim;

describe('DeepBook DEEP funding strategy', () => {
	it.effect('fails when account execution returns FailedTransaction', () =>
		Effect.gen(function* () {
			harness.txBuilds = 0;
			harness.swapArgs = [];

			const account: AccountValue = {
				name: 'alice',
				address: '0xalice',
				scheme: 'ed25519',
				publicKey: new Uint8Array(32),
				source: 'real',
				withTransactionSigner: (body) =>
					body({
						signTransaction: () => Effect.die('unused signTransaction'),
						signAndExecute: () =>
							Effect.succeed({
								$kind: 'FailedTransaction',
								FailedTransaction: {
									digest: 'deep-failed-digest',
									executionError: 'MoveAbort',
								},
							}),
					}),
				signAndExecute: () => Effect.die('unused signAndExecute'),
				signTransaction: () => Effect.die('unused signTransaction'),
				signPersonalMessage: () => Effect.die('unused signPersonalMessage'),
				funding: { requested: [], applied: [] },
			};

			const strategy = makeDeepbookDeepFundingStrategy({ suiSdk: sdk });
			const err = yield* strategy
				.request({ address: '0xrecipient', amount: 1n, account })
				.pipe(Effect.flip);

			expect(err._tag).toBe('DeepbookPluginError');
			expect(err.phase).toBe('fund-deep');
			expect(err.message).toContain('deep-failed-digest');
			expect(err.message).toContain('MoveAbort');
			expect(harness.txBuilds).toBe(1);
			expect(harness.swapArgs).toHaveLength(1);
		}),
	);
});
