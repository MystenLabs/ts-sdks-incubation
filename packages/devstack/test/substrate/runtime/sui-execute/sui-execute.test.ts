// sui-execute — substrate-helper roundtrip tests.

import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	executeSuiTx,
	SuiExecuteError,
	type TransactionSignerScope,
	type SuiExecuteClient,
} from '../../../../src/substrate/runtime/sui-execute/index.ts';

const stubSignTransaction = (_tx: Uint8Array) =>
	Effect.succeed({ bytes: 'aa', signature: 'sig-1' });

const stubSigner = {
	name: 'alice',
	address: '0xa11ce',
	signTransaction: stubSignTransaction,
	withTransactionSigner: <A, E, R>(
		body: (signer: TransactionSignerScope) => Effect.Effect<A, E, R>,
	) => body({ signTransaction: stubSignTransaction }),
};

// Mock SuiExecuteClient — only `core.executeTransaction` /
// `core.waitForTransaction` are reached by `executeSuiTx`; other
// ClientWithCoreApi fields aren't touched, so we project via `as never`.
const stubClient = (core: {
	readonly executeTransaction: (args: unknown) => Promise<unknown>;
	readonly waitForTransaction: (args: unknown) => Promise<unknown>;
}): SuiExecuteClient => ({ core }) as never;

const successfulClient = (params: {
	readonly digest?: string;
	readonly changes?: ReadonlyArray<{
		readonly objectId: string;
		readonly outputState?: string;
		readonly idOperation?: string;
	}>;
	readonly objectTypes?: Record<string, string>;
	readonly waitFailed?: boolean;
}): SuiExecuteClient =>
	stubClient({
		executeTransaction: async () => ({
			$kind: 'Transaction',
			Transaction: {
				digest: params.digest ?? '0xdeadbeef',
				effects: { changedObjects: params.changes ?? [] },
				objectTypes: params.objectTypes ?? {},
			},
		}),
		waitForTransaction: async () => {
			if (params.waitFailed) throw new Error('wait failed');
			return undefined;
		},
	});

describe('executeSuiTx', () => {
	it.effect('returns $kind:"Transaction" with a flat ExecutedReceipt', () =>
		Effect.gen(function* () {
			const client = successfulClient({
				digest: '0xfeed',
				changes: [
					{ objectId: '0xpkg', outputState: 'PackageWrite' },
					{ objectId: '0xup', idOperation: 'Created' },
				],
				objectTypes: {
					'0xpkg': '0x2::package::Package',
					'0xup': '0x2::package::UpgradeCap',
				},
			});
			const result = yield* Effect.scoped(
				executeSuiTx({
					client,
					signer: stubSigner,
					build: async () => new Uint8Array([1, 2, 3]),
				}),
			);
			expect(result.$kind).toBe('Transaction');
			if (result.$kind !== 'Transaction') return;
			const receipt = result.Transaction;
			expect(receipt.digest).toBe('0xfeed');
			expect(receipt.objectChanges.length).toBe(2);
			expect(receipt.objectChanges[0]?.objectType).toBe('0x2::package::Package');
			expect(receipt.objectChanges[1]?.idOperation).toBe('Created');
		}),
	);

	it.effect(
		'FailedTransaction surfaces as $kind:"FailedTransaction" return value (NOT error)',
		() =>
			Effect.gen(function* () {
				const client = stubClient({
					executeTransaction: async () => ({
						$kind: 'FailedTransaction',
						FailedTransaction: {
							digest: '0xbad',
							status: { error: 'MoveAbort(...)' },
						},
					}),
					waitForTransaction: async () => undefined,
				});
				const result = yield* Effect.scoped(
					executeSuiTx({
						client,
						signer: stubSigner,
						build: async () => new Uint8Array(),
					}),
				);
				expect(result.$kind).toBe('FailedTransaction');
				if (result.$kind !== 'FailedTransaction') return;
				expect(result.FailedTransaction.digest).toBe('0xbad');
				expect(result.FailedTransaction.executionError).toBe('MoveAbort(...)');
			}),
	);

	it.effect('FailedTransaction return is exposed via the success channel — no error surfaces', () =>
		Effect.gen(function* () {
			const client = stubClient({
				executeTransaction: async () => ({
					$kind: 'FailedTransaction',
					FailedTransaction: { digest: '0xbad', status: { error: 'MoveAbort(0)' } },
				}),
				waitForTransaction: async () => undefined,
			});
			const exit = yield* Effect.scoped(
				Effect.exit(
					executeSuiTx({
						client,
						signer: stubSigner,
						build: async () => new Uint8Array(),
					}),
				),
			);
			expect(Exit.isSuccess(exit)).toBe(true);
			if (Exit.isSuccess(exit)) {
				expect(exit.value.$kind).toBe('FailedTransaction');
			}
		}),
	);

	it.effect('FailedTransaction with no digest fails with phase:"no-digest"', () =>
		Effect.gen(function* () {
			const client = stubClient({
				executeTransaction: async () => ({
					$kind: 'FailedTransaction',
					FailedTransaction: { /* no digest */ status: { error: 'MoveAbort(0)' } },
				}),
				waitForTransaction: async () => undefined,
			});
			const exit = yield* Effect.scoped(
				Effect.exit(
					executeSuiTx({
						client,
						signer: stubSigner,
						build: async () => new Uint8Array(),
					}),
				),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			expect(JSON.stringify(exit)).toContain('no-digest');
		}),
	);

	it.effect('FailedTransaction with digest waits before the transaction scope releases', () =>
		Effect.gen(function* () {
			const events: string[] = [];
			const signer = {
				name: 'alice',
				address: '0xa11ce',
				signTransaction: () => Effect.die('outer signer should not be used'),
				withTransactionSigner: <A, E, R>(
					body: (signer: TransactionSignerScope) => Effect.Effect<A, E, R>,
				) =>
					Effect.gen(function* () {
						events.push('scope:enter');
						return yield* body({
							signTransaction: () =>
								Effect.sync(() => {
									events.push('sign');
									return { bytes: 'aa', signature: 'sig-1' };
								}),
						});
					}).pipe(Effect.ensuring(Effect.sync(() => events.push('scope:exit')))),
			};
			const client = stubClient({
				executeTransaction: async () => {
					events.push('execute');
					return {
						$kind: 'FailedTransaction',
						FailedTransaction: {
							digest: '0xbad',
							status: { error: 'MoveAbort(...)' },
						},
					};
				},
				waitForTransaction: async () => {
					events.push('wait');
					expect(events).toEqual(['scope:enter', 'sign', 'execute', 'wait']);
				},
			});
			const result = yield* Effect.scoped(
				executeSuiTx({
					client,
					signer,
					build: async () => new Uint8Array(),
				}),
			);
			expect(result.$kind).toBe('FailedTransaction');
			expect(events).toEqual(['scope:enter', 'sign', 'execute', 'wait', 'scope:exit']);
		}),
	);

	it.effect('serialize failure surfaces as phase: "serialize"', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.scoped(
				Effect.exit(
					executeSuiTx({
						client: successfulClient({}),
						signer: stubSigner,
						build: async () => {
							throw new Error('build-failed');
						},
					}),
				),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			const text = JSON.stringify(exit);
			expect(text).toContain('serialize');
			expect(text).toContain('build-failed');
		}),
	);

	it.effect('no-digest surfaces as phase: "no-digest"', () =>
		Effect.gen(function* () {
			const client = stubClient({
				executeTransaction: async () => ({
					$kind: 'Transaction',
					Transaction: {
						/* no digest */
						effects: { changedObjects: [] },
					},
				}),
				waitForTransaction: async () => undefined,
			});
			const exit = yield* Effect.scoped(
				Effect.exit(
					executeSuiTx({
						client,
						signer: stubSigner,
						build: async () => new Uint8Array(),
					}),
				),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			expect(JSON.stringify(exit)).toContain('no-digest');
		}),
	);

	it.effect('awaitFinality=false skips waitForTransaction', () =>
		Effect.gen(function* () {
			let waitCalled = false;
			const client = stubClient({
				executeTransaction: async () => ({
					$kind: 'Transaction',
					Transaction: { digest: '0xabc', effects: { changedObjects: [] } },
				}),
				waitForTransaction: async () => {
					waitCalled = true;
				},
			});
			yield* Effect.scoped(
				executeSuiTx({
					client,
					signer: stubSigner,
					build: async () => new Uint8Array(),
					awaitFinality: false,
				}),
			);
			expect(waitCalled).toBe(false);
		}),
	);

	it('SuiExecuteError is a tagged failure', () => {
		const err = new SuiExecuteError({
			phase: 'execute',
			signerName: 'x',
			signerAddress: '0x',
			message: 'boom',
		});
		expect(err._tag).toBe('SuiExecuteError');
	});
});
