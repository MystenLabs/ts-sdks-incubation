// L1 unit tests for the market-maker primitive — `bps` grid math + the
// state-store key shape for `perPool`. No chain, no Docker.

import * as nodeFs from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { describe as effectDescribe, it as effectIt } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as NodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem';
import { ChainProbeLive } from '../../engine/chain-probe.js';
import { EngineLive } from '../../engine/engine.js';
import { LeasingLive } from '../../engine/leasing.js';
import {
	CoinRegistryLive,
	DeepbookStateRegistryLive,
	PackageRegistryLive,
} from '../../engine/registries.js';
import { StateStore, StateStoreConfig, StateStoreLive } from '../../engine/state-store.js';
import { tag } from '../../advanced/tag.js';
import { SuiTag, type Sui } from '../sui.js';
import { DeepbookCoreTag, type DeepbookCore } from '../deepbook.js';
import type { Account, SignAndExecuteError, TxResult } from '../../engine/shared.js';
import { calculateGridLevels } from './internal.js';
import { deepbookMarketMaker, STATE_KEY_BALANCE_MANAGER_PREFIX_INTERNAL } from './market-maker.js';

describe('calculateGridLevels (bps strategy)', () => {
	it('produces tick-aligned prices at the expected bps offsets', () => {
		// mid = 1_000_000 (e.g. SUI/USDC at $1 in 6dp quote)
		// tickSize = 100, lotSize = 1
		// spreadBps = 20 (0.20%), levelSpacingBps = 5 (0.05%), levels = 3
		const result = calculateGridLevels({
			mid: 1_000_000n,
			sizeBase: 1_000_000n,
			tickSize: 100n,
			lotSize: 1n,
			levels: 3,
			spreadBps: 20,
			levelSpacingBps: 5,
		});

		expect(result.bids.length + result.asks.length).toBe(6);

		// Level 1: spread = 20 bps → offset = 1_000_000 * 20 / 10_000 = 2000.
		// Tick-aligned: 2000 → 2000.
		// bid = 1_000_000 - 2000 = 998_000 → align to 100: 998_000.
		// ask = 1_000_000 + 2000 = 1_002_000.
		expect(result.bids[0]?.price).toBe(998_000n);
		expect(result.asks[0]?.price).toBe(1_002_000n);

		// Level 2: spread = 25 bps → offset = 2500 → tick-aligned to 2500.
		// bid = 997_500, ask = 1_002_500.
		expect(result.bids[1]?.price).toBe(997_500n);
		expect(result.asks[1]?.price).toBe(1_002_500n);

		// Level 3: spread = 30 bps → offset = 3000 → tick-aligned to 3000.
		// bid = 997_000, ask = 1_003_000.
		expect(result.bids[2]?.price).toBe(997_000n);
		expect(result.asks[2]?.price).toBe(1_003_000n);
	});

	it('aligns sizes to lotSize', () => {
		// sizeBase = 123n, lotSize = 10n → rounds down to 120.
		const result = calculateGridLevels({
			mid: 1_000_000n,
			sizeBase: 123n,
			tickSize: 100n,
			lotSize: 10n,
			levels: 1,
			spreadBps: 10,
			levelSpacingBps: 1,
		});
		expect(result.bids[0]?.size).toBe(120n);
		expect(result.asks[0]?.size).toBe(120n);
	});

	it('drops bids that would land at or below zero', () => {
		// mid = 100, spreadBps = 20_000 (200%) → offset > mid → bid <= 0.
		const result = calculateGridLevels({
			mid: 100n,
			sizeBase: 1n,
			tickSize: 1n,
			lotSize: 1n,
			levels: 1,
			spreadBps: 20_000,
			levelSpacingBps: 0,
		});
		expect(result.bids.length).toBe(0);
		expect(result.asks.length).toBe(1);
	});
});

describe('state-store key shape', () => {
	it('uses deepbook/market-maker/balance-manager prefix', () => {
		expect(STATE_KEY_BALANCE_MANAGER_PREFIX_INTERNAL).toBe('deepbook/market-maker/balance-manager');
	});

	it('perPool variant appends pool name as final segment', () => {
		// The maker constructs `${baseKey}/${poolName}` for perPool;
		// assert the join produces the expected canonical shape.
		const baseKey = `${STATE_KEY_BALANCE_MANAGER_PREFIX_INTERNAL}/CHAIN/PKG/SIGNER`;
		const poolKey = `${baseKey}/sui_usdc`;
		expect(poolKey).toBe('deepbook/market-maker/balance-manager/CHAIN/PKG/SIGNER/sui_usdc');
	});
});

// -----------------------------------------------------------------------------
// Bug A regression — split cancel + place transactions on resume
//
// Pre-fix: `tickOnce` jammed `cancel_all_orders` and `place_limit_order` into
// a SINGLE transaction. When `cancel_all_orders` -> `process_cancel` ->
// `vault.settle_balance_manager` aborts with `EBalanceManagerBalanceTooLow`
// (Move abort code 3 in `balance_manager::withdraw_with_proof`), the WHOLE
// tx unwinds — the initial-tick gate fails and the supervisor errors out.
//
// Post-fix: cancel runs as its own tx; on `SignAndExecuteError` we log
// a warning and proceed to a separate place tx. The cached BM is reused
// either way (no recreate, no inventory loss).
// -----------------------------------------------------------------------------

const mkTmpDir = (label: string) =>
	Effect.tryPromise({
		try: () => nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), `devstack-mm-${label}-`)),
		catch: (cause) => new Error(`failed to create tmpdir: ${String(cause)}`),
	}).pipe(Effect.orDie);

// `client.core.getObject` returns the full shape `ChainProbe`'s Schema
// validator expects: `{object: {objectId, type, version, owner}}`. The
// market-maker's verify probe (Phase C, B3 fix) requires BOTH existence
// AND `owner.address === signer.address`, so we set AddressOwner
// pointing at the test signer's address.
const makeMockSuiOk = (chainId: string, signerAddress = '0xCAFE'): Layer.Layer<SuiTag> =>
	Layer.succeed(SuiTag, {
		network: 'localnet',
		rpc: { host: 'http://localhost:9000' },
		chainId,
		faucet: undefined,
		client: {
			core: {
				getObject: async (args: { objectId: string }) => ({
					object: {
						objectId: args.objectId,
						type: '0xDEEPB00C::balance_manager::BalanceManager',
						version: '1',
						owner: { $kind: 'AddressOwner' as const, AddressOwner: signerAddress },
					} as unknown,
				}),
			},
		} as unknown as Sui['client'],
		waitForTransactionsReady: () => Effect.void,
		runtime: 'bundled',
	});

const mockStateConfig = (stateDir: string): Layer.Layer<StateStoreConfig> =>
	Layer.succeed(StateStoreConfig, {
		stack: 'test',
		network: 'localnet',
		stateDir,
	});

const makeMockDeepbookCore = (packageId: string): Layer.Layer<DeepbookCoreTag> => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const poolRef = (poolId: string, base: string, quote: string): any => ({
		poolId,
		baseType: base,
		quoteType: quote,
	});
	const core: DeepbookCore = {
		packageId,
		registryId: '0xREG',
		packageIds: {
			DEEPBOOK_PACKAGE_ID: packageId,
			REGISTRY_ID: '0xREG',
			DEEP_TREASURY_ID: '',
			MARGIN_PACKAGE_ID: undefined,
			MARGIN_REGISTRY_ID: undefined,
			LIQUIDATION_PACKAGE_ID: undefined,
		},
		poolIds: new Map([['sui_usdc', '0xP00L1']]),
		findPool: ({ base, quote }) => Effect.succeed(poolRef('0xP00L1', base, quote)),
	};
	return Layer.succeed(DeepbookCoreTag, core);
};

const TestBaseLayer = Layer.mergeAll(
	EngineLive,
	NodeFileSystemLayer,
	LeasingLive,
	PackageRegistryLive,
	CoinRegistryLive,
	DeepbookStateRegistryLive,
);

effectDescribe('deepbookMarketMaker — cancel-resilient resume (Bug A)', () => {
	effectIt.effect(
		'splits cancel + place: cancel failure on resume does NOT kill the place tx',
		() =>
			Effect.gen(function* () {
				const tmpdir = yield* mkTmpDir('cancel-resilient');
				const chainId = 'test-chain-mm-cancel';
				const packageId = '0xDEEPB00C';
				const cachedBmId = '0xBALANCEMGR_CACHED';

				// Build the BM-cache state-store entry the maker reads on resume.
				const baseKey = `${STATE_KEY_BALANCE_MANAGER_PREFIX_INTERNAL}/${chainId}/${packageId}/0xCAFE`;
				const cacheKey = `${baseKey}/sui_usdc`;

				// Mock signer captures every signAndExecute call. First call (cancel)
				// throws SignAndExecuteError mimicking the on-chain MoveAbort code 3
				// in `withdraw_with_proof`. Second call (place) returns a successful
				// TxResult. The split-tick fix means cancel can fail without killing
				// place — pre-fix, both lived in one tx and the abort propagated.
				const calls: Array<{ phase: 'cancel' | 'place' }> = [];
				const signer: Account = {
					name: 'alice',
					address: '0xCAFE',
					publicKey: new Uint8Array(new ArrayBuffer(0)),
					scheme: 'ed25519',
					signAndExecute: vi.fn((_t: unknown) => {
						const phase: 'cancel' | 'place' = calls.length === 0 ? 'cancel' : 'place';
						calls.push({ phase });
						if (phase === 'cancel') {
							return Effect.fail({
								_tag: 'SignAndExecuteError',
								message:
									"Transaction resolution failed: MoveAbort in 4th command, abort code: 3, in '0xDEEPB00C::balance_manager::withdraw_with_proof'",
							} satisfies SignAndExecuteError) as never;
						}
						return Effect.succeed({
							digest: '0xDIGEST',
							effects: { status: { status: 'success' } },
							objectChanges: [],
							balanceChanges: undefined,
						} satisfies TxResult);
					}),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					signTransaction: (() =>
						Effect.fail({
							_tag: 'SignAndExecuteError',
							message: 'unreachable',
						} satisfies SignAndExecuteError)) as any,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					signPersonalMessage: (() =>
						Effect.fail({
							_tag: 'SignAndExecuteError',
							message: 'unreachable',
						} satisfies SignAndExecuteError)) as any,
				};
				const signerTag = tag('alice', Effect.succeed(signer));

				const maker = deepbookMarketMaker({
					name: 'deepbook.maker',
					signer: signerTag,
					strategy: { kind: 'bps', spreadBps: 10, levelSpacingBps: 100, levels: 2 },
					pools: [
						{
							name: 'sui_usdc',
							base: '0x2::sui::SUI',
							quote: `${packageId}::usdc::USDC`,
							tickSize: 1_000n,
							midPrice: 3_500_000n,
							sizePerLevel: 1_000_000_000n,
						},
					],
				});

				const supportLayer = Layer.mergeAll(
					TestBaseLayer,
					makeMockSuiOk(chainId),
					Layer.provide(ChainProbeLive, makeMockSuiOk(chainId)),
					Layer.provideMerge(
						Layer.provide(StateStoreLive, mockStateConfig(tmpdir)),
						NodeFileSystemLayer,
					),
					signerTag.__layer,
					makeMockDeepbookCore(packageId),
				);

				yield* Effect.gen(function* () {
					const state = yield* StateStore;
					yield* state.put(cacheKey, { balanceManagerId: cachedBmId });
				}).pipe(Effect.provide(supportLayer));

				// Initial-tick gate: maker yields, body runs cancel then place.
				const memberLayer = (
					maker.__layers as ReadonlyArray<Layer.Layer<unknown, unknown, unknown>>
				).reduce<Layer.Layer<unknown, unknown, unknown>>(
					(acc, l) => Layer.provideMerge(l, acc),
					Layer.empty as unknown as Layer.Layer<unknown, unknown, unknown>,
				);
				const handle = yield* Effect.scoped(
					Effect.gen(function* () {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						return yield* maker as any;
					}).pipe(Effect.provide(Layer.provide(memberLayer, supportLayer))) as Effect.Effect<
						{ pid: number },
						unknown,
						never
					>,
				);
				expect(handle.pid).toBe(0);

				// Cancel was attempted first and failed; place was attempted second
				// and succeeded. Two distinct submissions == split. Pre-fix
				// there was a SINGLE tx and a MoveAbort would have killed it.
				expect(calls.length).toBe(2);
				expect(calls[0]?.phase).toBe('cancel');
				expect(calls[1]?.phase).toBe('place');
			}),
	);

	effectIt.effect('place-tx BalanceTooLow abort recreates BalanceManager and retries', () =>
		Effect.gen(function* () {
			const tmpdir = yield* mkTmpDir('place-recreate');
			const chainId = 'test-chain-mm-recreate';
			const packageId = '0xDEEPB00D';
			const cachedBmId = '0xBALANCEMGR_INCONSISTENT';

			const baseKey = `${STATE_KEY_BALANCE_MANAGER_PREFIX_INTERNAL}/${chainId}/${packageId}/0xCAFE`;
			const cacheKey = `${baseKey}/sui_usdc`;

			// Three-call sequence:
			//   call 0: cancel-stale tx succeeds (steady-state cancel on resumed
			//           BM — Move-side process_cancel had no `owed` drift).
			//   call 1: place tx aborts with EBalanceManagerBalanceTooLow at
			//           place_limit_order — the BM's free balance doesn't cover
			//           the lock even after cancel cleared its orders (the dev-
			//           resume edge case where the snapshot left the BM ledger
			//           inconsistent with the on-chain account state).
			//   call 2: retry place tx after recreate succeeds (newlyCreated
			//           branch mints a fresh BM with pre-deposit; we don't
			//           require capturing the BM id here since the in-memory
			//           map is what the catch handler clears, and the recovery
			//           path falls back to the freshly-issued BM via the
			//           initial-tick newlyCreated flow).
			const calls: Array<{ phase: 'cancel' | 'place'; outcome: 'ok' | 'abort' }> = [];
			const signer: Account = {
				name: 'alice',
				address: '0xCAFE',
				publicKey: new Uint8Array(new ArrayBuffer(0)),
				scheme: 'ed25519',
				signAndExecute: vi.fn((_t: unknown) => {
					const idx = calls.length;
					if (idx === 0) {
						calls.push({ phase: 'cancel', outcome: 'ok' });
						return Effect.succeed({
							digest: '0xCANCEL',
							effects: { status: { status: 'success' } },
							objectChanges: [],
							balanceChanges: undefined,
						} satisfies TxResult);
					}
					if (idx === 1) {
						calls.push({ phase: 'place', outcome: 'abort' });
						return Effect.fail({
							_tag: 'SignAndExecuteError',
							message:
								"Transaction resolution failed: MoveAbort in 3rd command, abort code: 3, in '0xDEEPB00D::balance_manager::withdraw_with_proof'",
						} satisfies SignAndExecuteError) as never;
					}
					calls.push({ phase: 'place', outcome: 'ok' });
					return Effect.succeed({
						digest: '0xPLACE',
						effects: { status: { status: 'success' } },
						// newlyCreated path captures from objectChanges. Synthesize
						// a BalanceManager `created` change so the post-place
						// state-store write succeeds (otherwise the maker fails
						// the `createdBmIds.length < newlyCreated.size` invariant).
						objectChanges: [
							{
								type: 'created',
								sender: '0xCAFE',
								owner: { AddressOwner: '0xCAFE' },
								objectType: `${packageId}::balance_manager::BalanceManager`,
								objectId: '0xFRESH_BM',
								version: '1',
								digest: 'aa',
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
							} as any,
						],
						balanceChanges: undefined,
					} satisfies TxResult);
				}),
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				signTransaction: (() =>
					Effect.fail({
						_tag: 'SignAndExecuteError',
						message: 'unreachable',
					} satisfies SignAndExecuteError)) as any,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				signPersonalMessage: (() =>
					Effect.fail({
						_tag: 'SignAndExecuteError',
						message: 'unreachable',
					} satisfies SignAndExecuteError)) as any,
			};
			const signerTag = tag('alice', Effect.succeed(signer));

			const maker = deepbookMarketMaker({
				name: 'deepbook.maker',
				signer: signerTag,
				strategy: { kind: 'bps', spreadBps: 10, levelSpacingBps: 100, levels: 1 },
				pools: [
					{
						name: 'sui_usdc',
						base: '0x2::sui::SUI',
						quote: `${packageId}::usdc::USDC`,
						tickSize: 1_000n,
						midPrice: 3_500_000n,
						sizePerLevel: 1_000_000_000n,
					},
				],
			});

			const supportLayer = Layer.mergeAll(
				TestBaseLayer,
				makeMockSuiOk(chainId),
				Layer.provide(ChainProbeLive, makeMockSuiOk(chainId)),
				Layer.provideMerge(
					Layer.provide(StateStoreLive, mockStateConfig(tmpdir)),
					NodeFileSystemLayer,
				),
				signerTag.__layer,
				makeMockDeepbookCore(packageId),
			);

			yield* Effect.gen(function* () {
				const state = yield* StateStore;
				yield* state.put(cacheKey, { balanceManagerId: cachedBmId });
			}).pipe(Effect.provide(supportLayer));

			const memberLayer = (
				maker.__layers as ReadonlyArray<Layer.Layer<unknown, unknown, unknown>>
			).reduce<Layer.Layer<unknown, unknown, unknown>>(
				(acc, l) => Layer.provideMerge(l, acc),
				Layer.empty as unknown as Layer.Layer<unknown, unknown, unknown>,
			);
			const handle = yield* Effect.scoped(
				Effect.gen(function* () {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					return yield* maker as any;
				}).pipe(Effect.provide(Layer.provide(memberLayer, supportLayer))) as Effect.Effect<
					{ pid: number },
					unknown,
					never
				>,
			);
			expect(handle.pid).toBe(0);

			// Three submissions: cancel ok, place abort, place ok after recreate.
			expect(calls.length).toBe(3);
			expect(calls[0]).toEqual({ phase: 'cancel', outcome: 'ok' });
			expect(calls[1]).toEqual({ phase: 'place', outcome: 'abort' });
			expect(calls[2]).toEqual({ phase: 'place', outcome: 'ok' });

			// Cache was invalidated + rewritten with the fresh id from the retry.
			const fresh = yield* Effect.gen(function* () {
				const state = yield* StateStore;
				return yield* state.get(cacheKey);
			}).pipe(Effect.provide(supportLayer));
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			expect((fresh as any)._tag).toBe('Some');
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			expect(((fresh as any).value as { balanceManagerId: string }).balanceManagerId).toBe(
				'0xFRESH_BM',
			);
		}),
	);
});
