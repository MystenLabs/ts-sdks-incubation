import { Effect, Exit, Option } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { TransactionDataBuilder } from '@mysten/sui/transactions';

import { suiForkFaucetStrategy } from '../../../src/plugins/sui/index.ts';
import { suiPluginError } from '../../../src/plugins/sui/errors.ts';
import type { ForkAdminSurface } from '../../../src/plugins/sui/mode/shared.ts';
import type { SuiSdkShim } from '../../../src/plugins/sui/chain-probe.ts';
import {
	LeaseBrokerService,
	layerLeaseBroker,
} from '../../../src/substrate/runtime/lease-broker/index.ts';

const WHALE = `0x${'a'.repeat(64)}`;
const RECIPIENT = `0x${'b'.repeat(64)}`;
const SMALL_COIN = `0x${'c'.repeat(64)}`;
const BIG_COIN = `0x${'d'.repeat(64)}`;
// A valid 32-byte base58 object digest (44 'B's decodes to 32 bytes),
// matching fork-mode.test.ts — the SDK rejects shorter digests at build.
const DIGEST = 'B'.repeat(44);

const CAP = 1_000_000_000_000n; // 1000 SUI

interface FakeCoin {
	readonly objectId: string;
	readonly version: string;
	readonly digest: string;
	readonly balance: string;
}

// Minimal SuiSdkShim: the fork faucet only touches `.core.listCoins`,
// `.core.getObject` (never hit — split/transfer has no object inputs),
// and `.core.waitForTransaction`.
const makeSdk = (
	coins: ReadonlyArray<FakeCoin>,
	onWait?: () => void,
): SuiSdkShim =>
	({
		core: {
			getObject: () => Promise.reject(new Error('getObject should not be called')),
			listCoins: () => Promise.resolve({ objects: coins }),
			waitForTransaction: () => {
				onWait?.();
				return Promise.resolve(undefined);
			},
		},
	}) as unknown as SuiSdkShim;

const makeFork = (
	impersonate: ForkAdminSurface['impersonate'],
): ForkAdminSurface => ({
	status: Effect.succeed({ checkpoint: '0', clock: 0 }),
	advanceClock: () => Effect.void,
	advanceCheckpoint: Effect.void,
	impersonate,
});

const okImpersonate =
	(capture?: (bytes: Uint8Array) => void): ForkAdminSurface['impersonate'] =>
	(_sender, tx) =>
		Effect.sync(() => {
			capture?.(tx as Uint8Array);
			return { digest: '0xdigest', success: true, raw: {} };
		});

describe('suiForkFaucetStrategy', () => {
	it.effect('builds a split+transfer tx from the whale, paying gas with its largest coin', () =>
		Effect.gen(function* () {
			let bytes: Uint8Array | undefined;
			const strategy = suiForkFaucetStrategy({
				whale: WHALE,
				fork: makeFork(okImpersonate((b) => (bytes = b))),
				// BIG_COIN listed AFTER the small one — selection must rank by
				// balance, not take the first.
				sdk: makeSdk([
					{ objectId: SMALL_COIN, version: '1', digest: DIGEST, balance: '5000000000' },
					{ objectId: BIG_COIN, version: '7', digest: DIGEST, balance: '5000000000000' },
				]),
				perRequestCapMist: CAP,
			});

			yield* strategy.request({ address: RECIPIENT, amount: 2_000_000_000n });

			expect(bytes).toBeDefined();
			const data = TransactionDataBuilder.fromBytes(bytes!).snapshot();
			expect(data.sender).toBe(WHALE);
			expect(data.gasData.owner).toBe(WHALE);
			expect(data.gasData.payment).toEqual([
				{ objectId: BIG_COIN, version: '7', digest: DIGEST },
			]);
			expect(data.gasData.budget).toBe('100000000');
			// splitCoins(gas, [amount]) + transferObjects([coin], recipient)
			expect(data.commands).toHaveLength(2);
		}),
	);

	it.effect('waits for finality on success', () =>
		Effect.gen(function* () {
			let waited = false;
			const strategy = suiForkFaucetStrategy({
				whale: WHALE,
				fork: makeFork(okImpersonate()),
				sdk: makeSdk(
					[{ objectId: BIG_COIN, version: '7', digest: DIGEST, balance: '5000000000000' }],
					() => {
						waited = true;
					},
				),
				perRequestCapMist: CAP,
			});
			yield* strategy.request({ address: RECIPIENT, amount: 1_000_000_000n });
			expect(waited).toBe(true);
		}),
	);

	it.effect('rejects a request above the per-request cap with FaucetBodyError', () =>
		Effect.gen(function* () {
			let submitted = false;
			const strategy = suiForkFaucetStrategy({
				whale: WHALE,
				fork: makeFork(() =>
					Effect.sync(() => {
						submitted = true;
						return { digest: '0x', success: true, raw: {} };
					}),
				),
				sdk: makeSdk([{ objectId: BIG_COIN, version: '7', digest: DIGEST, balance: '5000000000000' }]),
				perRequestCapMist: 1_000_000_000n,
			});

			const exit = yield* Effect.exit(strategy.request({ address: RECIPIENT, amount: 2_000_000_000n }));
			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.findErrorOption(exit);
			expect(Option.isSome(err)).toBe(true);
			if (Option.isSome(err)) {
				expect(err.value._tag).toBe('FaucetBodyError');
				expect(err.value.message).toContain('per-request cap');
			}
			expect(submitted).toBe(false);
		}),
	);

	it.effect('maps an impersonation SuiPluginError into FaucetBodyError', () =>
		Effect.gen(function* () {
			const strategy = suiForkFaucetStrategy({
				whale: WHALE,
				fork: makeFork(() =>
					Effect.fail(suiPluginError('fork-impersonate', 'boom from the fork binary')),
				),
				sdk: makeSdk([{ objectId: BIG_COIN, version: '7', digest: DIGEST, balance: '5000000000000' }]),
				perRequestCapMist: CAP,
			});

			const exit = yield* Effect.exit(strategy.request({ address: RECIPIENT, amount: 1_000_000_000n }));
			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.findErrorOption(exit);
			expect(Option.isSome(err)).toBe(true);
			if (Option.isSome(err)) {
				// MUST be a faucet-tagged error so account funding's catchTags
				// handle it — a raw SuiPluginError would escape uncaught.
				expect(err.value._tag).toBe('FaucetBodyError');
				expect(err.value.message).toContain('boom from the fork binary');
			}
		}),
	);

	it.effect('fails with FaucetBodyError when the whale has no SUI coins', () =>
		Effect.gen(function* () {
			const strategy = suiForkFaucetStrategy({
				whale: WHALE,
				fork: makeFork(okImpersonate()),
				sdk: makeSdk([]),
				perRequestCapMist: CAP,
			});
			const exit = yield* Effect.exit(strategy.request({ address: RECIPIENT, amount: 1_000_000_000n }));
			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.findErrorOption(exit);
			if (Option.isSome(err)) {
				expect(err.value._tag).toBe('FaucetBodyError');
				expect(err.value.message).toContain('no SUI coins');
			}
		}),
	);

	it.effect('flags an on-chain failed impersonation tx', () =>
		Effect.gen(function* () {
			const strategy = suiForkFaucetStrategy({
				whale: WHALE,
				fork: makeFork((_sender, _tx) =>
					Effect.succeed({ digest: '0xfaileddigest', success: false, raw: {} }),
				),
				sdk: makeSdk([{ objectId: BIG_COIN, version: '7', digest: DIGEST, balance: '5000000000000' }]),
				perRequestCapMist: CAP,
			});
			const exit = yield* Effect.exit(strategy.request({ address: RECIPIENT, amount: 1_000_000_000n }));
			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.findErrorOption(exit);
			if (Option.isSome(err)) {
				expect(err.value._tag).toBe('FaucetBodyError');
				expect(err.value.message).toContain('failed on-chain');
			}
		}),
	);

	it.effect('serializes concurrent requests on the whale lease', () =>
		Effect.gen(function* () {
			const broker = yield* LeaseBrokerService;
			let active = 0;
			let maxActive = 0;

			// Real-timer delay (NOT Effect.sleep): it.effect runs on the
			// TestClock, where virtual sleeps never advance and would hang.
			const slowImpersonate: ForkAdminSurface['impersonate'] = (_sender, _tx) =>
				Effect.gen(function* () {
					active += 1;
					maxActive = Math.max(maxActive, active);
					yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
					active -= 1;
					return { digest: '0x', success: true, raw: {} };
				});

			const strategy = suiForkFaucetStrategy({
				whale: WHALE,
				fork: makeFork(slowImpersonate),
				sdk: makeSdk([{ objectId: BIG_COIN, version: '7', digest: DIGEST, balance: '5000000000000' }]),
				perRequestCapMist: CAP,
				serialization: {
					broker,
					key: `sui-fork-faucet:sui:testnet`,
					owner: `sui-fork-faucet:sui:testnet`,
				},
			});

			yield* Effect.all(
				[
					strategy.request({ address: RECIPIENT, amount: 1_000_000_000n }),
					strategy.request({ address: SMALL_COIN, amount: 1_000_000_000n }),
				],
				{ concurrency: 'unbounded' },
			);

			expect(maxActive).toBe(1);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);
});
