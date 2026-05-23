import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { chainId } from '../../../src/substrate/brand.ts';
import {
	StrategyRegistryService,
	layerStrategyRegistry,
} from '../../../src/substrate/runtime/strategy-registry/index.ts';
import {
	LeaseBrokerService,
	layerLeaseBroker,
} from '../../../src/substrate/runtime/lease-broker/index.ts';
import {
	applyCrossCuttingFunding,
	fundEphemeralDefault,
	SUI_FULL_COIN_TYPE,
	type AccountFundingRequest,
	type AccountFundingStrategy,
	type FundingBalanceReader,
	type ProjectedFundingEntry,
} from '../../../src/plugins/account/funding.ts';
import { withAddressLease } from '../../../src/plugins/account/lease.ts';
import type { AccountValue } from '../../../src/plugins/account/service.ts';

const fakeAccount = {
	name: 'alice',
	address: '0xalice',
	scheme: 'ed25519',
	publicKey: new Uint8Array(),
	source: 'real',
	funding: { requested: [], applied: [] },
	signAndExecute: null,
	withTransactionSigner: null,
	signTransaction: null,
	signPersonalMessage: null,
} as unknown as AccountValue;

const fundingEntry = (overrides: Partial<ProjectedFundingEntry> = {}): ProjectedFundingEntry => ({
	coin: 'WAL',
	fullCoinType: '0xfeed::wal::WAL',
	amount: 123n,
	...overrides,
});

const applyFunding = (
	funding: ReadonlyArray<ProjectedFundingEntry>,
	balanceReader?: FundingBalanceReader,
) =>
	Effect.gen(function* () {
		const broker = yield* LeaseBrokerService;
		return yield* applyCrossCuttingFunding({
			accountName: 'alice',
			address: '0xalice',
			variant: 'ephemeral',
			account: fakeAccount,
			funding,
			chainId: chainId('sui:localnet'),
			broker,
			...(balanceReader !== undefined ? { balanceReader } : {}),
		});
	});

const withFundingLayers = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<Exclude<R, StrategyRegistryService>, LeaseBrokerService>> =>
	effect.pipe(Effect.provide(layerStrategyRegistry), Effect.provide(layerLeaseBroker));

describe('account cross-cutting funding dispatch', () => {
	it.effect('dispatches arbitrary coin funding by resolved full coin type', () =>
		withFundingLayers(
			Effect.scoped(
				Effect.gen(function* () {
					const registry = yield* StrategyRegistryService;
					const requests: AccountFundingRequest[] = [];
					const strategy: AccountFundingStrategy = {
						request: (req) => Effect.sync(() => requests.push(req)),
					};
					yield* registry.register('coinType:0xfeed::wal::WAL', strategy);

					const applied = yield* applyFunding([fundingEntry()]);

					expect(applied).toEqual([fundingEntry()]);
					expect(requests).toHaveLength(1);
					expect(requests[0]).toMatchObject({
						address: '0xalice',
						amount: 123n,
						account: fakeAccount,
					});
				}),
			),
		),
	);

	it.effect('skips arbitrary coin funding when only a symbol-keyed strategy exists', () =>
		withFundingLayers(
			Effect.scoped(
				Effect.gen(function* () {
					const registry = yield* StrategyRegistryService;
					let called = false;
					yield* registry.register('coinType:WAL', {
						request: () => Effect.sync(() => void (called = true)),
					} satisfies AccountFundingStrategy);

					const applied = yield* applyFunding([fundingEntry()]);

					expect(applied).toEqual([]);
					expect(called).toBe(false);
				}),
			),
		),
	);

	it.effect('routes explicit SUI funding through the chain faucet strategy', () =>
		withFundingLayers(
			Effect.scoped(
				Effect.gen(function* () {
					const registry = yield* StrategyRegistryService;
					const requests: AccountFundingRequest[] = [];
					yield* registry.register('faucet:request:sui:localnet', {
						request: (req) => Effect.sync(() => requests.push(req)),
					} satisfies AccountFundingStrategy);

					const sui = fundingEntry({
						coin: 'SUI',
						fullCoinType: SUI_FULL_COIN_TYPE,
						amount: 1_000_000n,
					});
					const applied = yield* applyFunding([sui]);

					expect(applied).toEqual([sui]);
					expect(requests.map((request) => request.amount)).toEqual([1_000_000n]);
				}),
			),
		),
	);

	it.effect('waits for default SUI funding to become balance-visible before returning', () =>
		withFundingLayers(
			Effect.scoped(
				Effect.gen(function* () {
					const registry = yield* StrategyRegistryService;
					const broker = yield* LeaseBrokerService;
					const events: string[] = [];
					yield* registry.register('faucet:request:sui:localnet', {
						request: () =>
							Effect.sync(() => {
								events.push('request');
							}),
					} satisfies AccountFundingStrategy);

					let reads = 0;
					const balanceReader: FundingBalanceReader = {
						readBalance: () =>
							Effect.sync(() => {
								reads += 1;
								const balance = reads === 1 ? 0n : 1_000_000n;
								events.push(`balance:${balance}`);
								return balance;
							}),
					};

					yield* fundEphemeralDefault({
						accountName: 'alice',
						address: '0xalice',
						amountMist: 1_000_000n,
						suiMode: 'local',
						chainId: chainId('sui:localnet'),
						emitAutoPromotionEvent: () => Effect.void,
						broker,
						balanceReader,
					});

					expect(events).toEqual(['balance:0', 'request', 'balance:1000000']);
				}),
			),
		),
	);

	it.effect('waits for cross-cutting funding to become balance-visible before applying it', () =>
		withFundingLayers(
			Effect.scoped(
				Effect.gen(function* () {
					const registry = yield* StrategyRegistryService;
					const events: string[] = [];
					yield* registry.register('coinType:0xfeed::wal::WAL', {
						request: () =>
							Effect.sync(() => {
								events.push('request');
							}),
					} satisfies AccountFundingStrategy);

					let reads = 0;
					const applied = yield* applyFunding([fundingEntry()], {
						readBalance: () =>
							Effect.sync(() => {
								reads += 1;
								const balance = reads === 1 ? 0n : 123n;
								events.push(`balance:${balance}`);
								return balance;
							}),
					});

					expect(applied).toEqual([fundingEntry()]);
					expect(events).toEqual(['balance:0', 'request', 'balance:123']);
				}),
			),
		),
	);

	it.effect('treats already-satisfied funding entries as applied without calling a strategy', () =>
		withFundingLayers(
			Effect.scoped(
				Effect.gen(function* () {
					const registry = yield* StrategyRegistryService;
					let called = false;
					yield* registry.register('coinType:0xfeed::wal::WAL', {
						request: () => Effect.sync(() => void (called = true)),
					} satisfies AccountFundingStrategy);

					const applied = yield* applyFunding([fundingEntry()], {
						readBalance: () => Effect.succeed(123n),
					});

					expect(applied).toEqual([fundingEntry()]);
					expect(called).toBe(false);
				}),
			),
		),
	);

	it.effect(
		'does not require a faucet strategy when explicit SUI funding is already satisfied',
		() =>
			withFundingLayers(
				Effect.scoped(
					Effect.gen(function* () {
						const sui = fundingEntry({
							coin: 'SUI',
							fullCoinType: SUI_FULL_COIN_TYPE,
							amount: 1_000_000n,
						});

						const applied = yield* applyFunding([sui], {
							readBalance: () => Effect.succeed(1_000_000n),
						});

						expect(applied).toEqual([sui]);
					}),
				),
			),
	);

	it.effect('lets account-signer strategies own the per-address lease', () =>
		withFundingLayers(
			Effect.scoped(
				Effect.gen(function* () {
					const registry = yield* StrategyRegistryService;
					const broker = yield* LeaseBrokerService;
					let signerBodyRan = false;
					const account = {
						...fakeAccount,
						withTransactionSigner: (body) =>
							withAddressLease(
								broker,
								'alice',
								'0xalice',
								body({
									signTransaction: () => Effect.succeed({ bytes: 'bytes', signature: 'sig' }),
									signAndExecute: () =>
										Effect.succeed({
											digest: 'digest',
											effects: {},
											objectChanges: [],
											balanceChanges: [],
										}),
								}),
							),
					} as AccountValue;
					yield* registry.register('coinType:0xfeed::wal::WAL', {
						usesAccountSigner: true,
						request: (req) =>
							Effect.gen(function* () {
								const holders = yield* broker.holders();
								expect(holders.size).toBe(0);
								yield* req.account.withTransactionSigner(() =>
									Effect.sync(() => {
										signerBodyRan = true;
									}),
								);
							}),
					} satisfies AccountFundingStrategy);

					const applied = yield* applyCrossCuttingFunding({
						accountName: 'alice',
						address: '0xalice',
						variant: 'ephemeral',
						account,
						funding: [fundingEntry()],
						chainId: chainId('sui:localnet'),
						broker,
					});

					expect(applied).toEqual([fundingEntry()]);
					expect(signerBodyRan).toBe(true);
				}),
			),
		),
	);

	it.effect('fails loudly when explicit SUI funding has no faucet strategy', () =>
		withFundingLayers(
			Effect.scoped(
				Effect.gen(function* () {
					const exit = yield* applyFunding([
						fundingEntry({
							coin: 'SUI',
							fullCoinType: SUI_FULL_COIN_TYPE,
							amount: 1_000_000n,
						}),
					]).pipe(Effect.exit);

					expect(Exit.isFailure(exit)).toBe(true);
					const error = Exit.findErrorOption(exit);
					expect(error._tag).toBe('Some');
					if (error._tag === 'Some') {
						expect(error.value.phase).toBe('fund-cross-cutting');
						expect(error.value.message).toContain('no SUI funding strategy registered');
					}
				}),
			),
		),
	);
});
