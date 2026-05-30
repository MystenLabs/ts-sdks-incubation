import { Effect, Exit, Fiber } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
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
	NULL_BALANCE_READER,
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
	balanceReader: FundingBalanceReader = NULL_BALANCE_READER,
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
			balanceReader,
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

					expect(applied).toEqual([{ ...fundingEntry(), outcome: 'funded' }]);
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

					expect(applied).toEqual([{ ...sui, outcome: 'funded' }]);
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

					expect(applied).toEqual([{ ...fundingEntry(), outcome: 'funded' }]);
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

					expect(applied).toEqual([{ ...fundingEntry(), outcome: 'already-satisfied' }]);
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

						expect(applied).toEqual([{ ...sui, outcome: 'already-satisfied' }]);
					}),
				),
			),
	);

	it.effect(
		'self-funding (funded address == publisher signer) completes without deadlock and is not double-wrapped',
		() =>
			withFundingLayers(
				Effect.scoped(
					Effect.gen(function* () {
						// Regression (coin self-funding hang): a coin funded with a
						// coin IT published mints via the publisher account's own
						// `withTransactionSigner`, which self-acquires
						// `account:<publisherAddress>`. When the funded address IS
						// the publisher address, the dispatcher's
						// `account:<fundedAddress>` lease and the mint's
						// `account:<publisherAddress>` lease collapse to the same
						// non-reentrant key — the inner acquire would block forever.
						//
						// The coin strategy sets `usesAccountSigner: true`, so the
						// dispatcher must NOT pre-acquire the funded-address lease.
						// This models the coin flow: the strategy acquires the
						// SAME `account:<0xalice>` key the dispatcher would have
						// taken, and asserts (a) the dispatcher did not already
						// hold it (no double-acquire), and (b) the whole request
						// completes — a deadlock would surface as a test timeout.
						const registry = yield* StrategyRegistryService;
						const broker = yield* LeaseBrokerService;
						let strategyRan = false;
						let heldKeysWhenStrategyEntered: ReadonlyArray<string> = [];
						yield* registry.register('coinType:0xfeed::wal::WAL', {
							usesAccountSigner: true,
							request: (req) =>
								Effect.gen(function* () {
									// The dispatcher must not be holding the funded
									// address's lease — otherwise the self-acquire below
									// (which the real mint's publisher signer performs on
									// the SAME address) would deadlock.
									const holders = yield* broker.holders();
									heldKeysWhenStrategyEntered = [...holders.keys()];
									// Self-acquire the funded address's lease, exactly as
									// the coin mint does via the publisher (== funded)
									// account's `withTransactionSigner`.
									yield* withAddressLease(broker, 'alice', req.address, Effect.void);
									strategyRan = true;
								}),
						} satisfies AccountFundingStrategy);

						const applied = yield* applyCrossCuttingFunding({
							accountName: 'alice',
							address: '0xalice',
							variant: 'ephemeral',
							account: fakeAccount,
							funding: [fundingEntry()],
							chainId: chainId('sui:localnet'),
							broker,
							balanceReader: NULL_BALANCE_READER,
						});

						expect(strategyRan).toBe(true);
						expect(applied).toEqual([{ ...fundingEntry(), outcome: 'funded' }]);
						// No double-acquire: the dispatcher did not hold the funded
						// address's lease key when the account-signer strategy ran.
						expect(heldKeysWhenStrategyEntered).not.toContain('account:0xalice');
					}),
				),
			),
	);

	it.effect(
		'still wraps strategies that do not use the account signer in the per-address lease',
		() =>
			withFundingLayers(
				Effect.scoped(
					Effect.gen(function* () {
						// Non-self / faucet-shaped path is unchanged: a strategy that
						// does NOT set `usesAccountSigner` is wrapped by the
						// dispatcher in `account:<fundedAddress>`, so the lease IS
						// held while the strategy's wire call runs. This locks in the
						// cross-account behavior the self-funding fix must not regress.
						const registry = yield* StrategyRegistryService;
						const broker = yield* LeaseBrokerService;
						let heldWhenStrategyEntered: ReadonlyMap<string, string> = new Map();
						yield* registry.register('coinType:0xfeed::wal::WAL', {
							request: () =>
								Effect.gen(function* () {
									heldWhenStrategyEntered = yield* broker.holders();
								}),
						} satisfies AccountFundingStrategy);

						const applied = yield* applyFunding([fundingEntry()]);

						expect(applied).toEqual([{ ...fundingEntry(), outcome: 'funded' }]);
						// The dispatcher held the funded-address lease (attributed to
						// the account name) around the (non-account-signer) wire call.
						expect([...heldWhenStrategyEntered.keys()]).toContain('account:0xalice');
						expect(heldWhenStrategyEntered.get('account:0xalice')).toBe('alice');
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
											$kind: 'Transaction',
											Transaction: {
												digest: 'digest',
												effects: {},
												objectChanges: [],
												balanceChanges: [],
											},
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
						balanceReader: NULL_BALANCE_READER,
					});

					expect(applied).toEqual([{ ...fundingEntry(), outcome: 'funded' }]);
					expect(signerBodyRan).toBe(true);
				}),
			),
		),
	);

	it.effect(
		'NULL_BALANCE_READER opt-out is the only way to skip the finality wait — production readers always poll',
		() =>
			withFundingLayers(
				Effect.scoped(
					Effect.gen(function* () {
						// Regression: balanceReader USED to be optional, so a
						// caller that forgot to wire it silently returned
						// `Effect.void` from the finality wait. Now the field
						// is REQUIRED at the type level and the only opt-out
						// is the explicitly-named `NULL_BALANCE_READER`
						// sentinel — production readers without
						// `skipFinalityWait: true` always poll until
						// `balance >= amount` or the bounded schedule
						// exhausts (which would surface a typed timeout).
						const registry = yield* StrategyRegistryService;
						const events: string[] = [];
						yield* registry.register('coinType:0xfeed::wal::WAL', {
							request: () =>
								Effect.sync(() => {
									events.push('request');
								}),
						} satisfies AccountFundingStrategy);

						// NULL_BALANCE_READER — skips the wait deterministically.
						const applied = yield* applyFunding([fundingEntry()], NULL_BALANCE_READER);
						expect(applied).toEqual([{ ...fundingEntry(), outcome: 'funded' }]);
						// No `balance:...` events — the wait was short-circuited
						// by the sentinel, not by the bounded poll schedule.
						expect(events).toEqual(['request']);
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

	it.effect(
		'fails with a settlement-timeout error when the funded balance never becomes visible',
		() =>
			// Regression for the rewritten `waitForBalanceAtLeast`: a
			// production reader that always reports BELOW the requested
			// amount must drive the bounded spaced poll to its 30s wall-clock
			// bound (`Schedule.during`) and then fail on the typed channel
			// with the settlement-timeout `AccountAcquireError` — not loop
			// forever and not succeed. `it.effect` installs a TestClock, so
			// the spaced sleeps only advance via `TestClock.adjust`; we fork
			// the poll loop and drive the virtual clock past the bound. If a
			// future refactor broke the `until` predicate or the `during`
			// bound (e.g. an always-true exit), the fork would succeed and
			// this assertion would fail.
			withFundingLayers(
				Effect.scoped(
					Effect.gen(function* () {
						const registry = yield* StrategyRegistryService;
						let reads = 0;
						yield* registry.register('coinType:0xfeed::wal::WAL', {
							request: () => Effect.void,
						} satisfies AccountFundingStrategy);

						// Always below the requested 123n — the funded coin
						// never settles.
						const stuckReader: FundingBalanceReader = {
							readBalance: () =>
								Effect.sync(() => {
									reads += 1;
									return 0n;
								}),
						};

						const fiber = yield* Effect.forkChild(
							applyFunding([fundingEntry()], stuckReader).pipe(Effect.exit),
						);
						// Let the forked poll loop reach its first parked sleep
						// (pre-check read → fund → first in-wait read → park on
						// the 250ms spaced delay) before driving the clock.
						yield* Effect.yieldNow;
						yield* Effect.yieldNow;
						// Advance well past the 30s settlement budget so the
						// bounded schedule (`during 30000 millis`) halts; the
						// always-below reader re-parks each poll, so a single
						// large adjust cascades through every poll up to the bound.
						yield* TestClock.adjust('60 seconds');
						const exit = yield* Fiber.join(fiber);

						expect(Exit.isFailure(exit)).toBe(true);
						const error = Exit.findErrorOption(exit);
						expect(error._tag).toBe('Some');
						if (error._tag === 'Some') {
							expect(error.value.phase).toBe('fund-cross-cutting');
							expect(error.value.message).toContain('settlement timeout');
						}
						// The poll loop actually polled more than once before the
						// bound (pre-check read + at least one in-wait read).
						expect(reads).toBeGreaterThan(1);
					}),
				),
			),
	);

	it.effect(
		'spans the 250ms inter-poll delay across multiple reads before settlement',
		() =>
			// Pins the spaced-delay path of the rewritten wait: the funded
			// balance only becomes visible after the inter-poll delay
			// elapses, so the wait must re-read across a `TestClock.adjust`.
			// A regression dropping the spaced delay (single read) or
			// breaking the `until` predicate would not satisfy on the later
			// read and would fall through to the timeout branch instead.
			withFundingLayers(
				Effect.scoped(
					Effect.gen(function* () {
						const registry = yield* StrategyRegistryService;
						yield* registry.register('coinType:0xfeed::wal::WAL', {
							request: () => Effect.void,
						} satisfies AccountFundingStrategy);

						// Read #1 is the `applyCrossCuttingFunding` pre-check
						// (below → proceed to fund). Read #2 is the first in-wait
						// poll (still below → schedule parks on the 250ms sleep).
						// Read #3 (after the clock advances) satisfies `until`.
						let reads = 0;
						const settlingReader: FundingBalanceReader = {
							readBalance: () =>
								Effect.sync(() => {
									reads += 1;
									return reads >= 3 ? 123n : 0n;
								}),
						};

						const fiber = yield* Effect.forkChild(
							applyFunding([fundingEntry()], settlingReader).pipe(Effect.exit),
						);
						// Let the loop reach the first in-wait poll and park on the
						// 250ms spaced sleep before we release it.
						yield* Effect.yieldNow;
						yield* Effect.yieldNow;
						// Release the parked 250ms inter-poll sleep so the wait
						// re-reads and observes the settled balance.
						yield* TestClock.adjust('250 millis');
						const exit = yield* Fiber.join(fiber);

						expect(Exit.isSuccess(exit)).toBe(true);
						if (Exit.isSuccess(exit)) {
							expect(exit.value).toEqual([{ ...fundingEntry(), outcome: 'funded' }]);
						}
						// Settlement required re-reading across the spaced delay.
						expect(reads).toBeGreaterThanOrEqual(3);
					}),
				),
			),
	);
});
