// sui-execute — substrate-helper roundtrip tests.

import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	executeSuiTx,
	SuiExecuteError,
	type SuiExecuteClient,
} from '../../../../src/substrate/runtime/sui-execute/index.ts';

const stubSigner = {
	name: 'alice',
	address: '0xa11ce',
	signTransaction: (_tx: Uint8Array) => Effect.succeed({ bytes: 'aa', signature: 'sig-1' }),
};

const successfulClient = (params: {
	readonly digest?: string;
	readonly changes?: ReadonlyArray<{
		readonly objectId: string;
		readonly outputState?: string;
		readonly idOperation?: string;
	}>;
	readonly objectTypes?: Record<string, string>;
	readonly waitFailed?: boolean;
}): SuiExecuteClient => ({
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
	it.effect('returns a flat ExecutedReceipt with digest + projected changes', () =>
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
			const receipt = yield* Effect.scoped(
				executeSuiTx({
					client,
					signer: stubSigner,
					build: async () => new Uint8Array([1, 2, 3]),
				}),
			);
			expect(receipt.digest).toBe('0xfeed');
			expect(receipt.objectChanges.length).toBe(2);
			expect(receipt.objectChanges[0]?.objectType).toBe('0x2::package::Package');
			expect(receipt.objectChanges[1]?.idOperation).toBe('Created');
		}),
	);

	it.effect('FailedTransaction surfaces as phase: "failed-transaction"', () =>
		Effect.gen(function* () {
			const client: SuiExecuteClient = {
				executeTransaction: async () => ({
					$kind: 'FailedTransaction',
					FailedTransaction: {
						digest: '0xbad',
						status: { error: 'MoveAbort(...)' },
					},
				}),
				waitForTransaction: async () => undefined,
			};
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
			if (Exit.isFailure(exit)) {
				const err = (exit.cause as unknown as { failures?: ReadonlyArray<SuiExecuteError> })
					.failures?.[0];
				const text = JSON.stringify(exit.cause);
				expect(text).toContain('failed-transaction');
				expect(text).toContain('MoveAbort');
				void err;
			}
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
			const client: SuiExecuteClient = {
				executeTransaction: async () => ({
					$kind: 'Transaction',
					Transaction: {
						/* no digest */
						effects: { changedObjects: [] },
					},
				}),
				waitForTransaction: async () => undefined,
			};
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
			const client: SuiExecuteClient = {
				executeTransaction: async () => ({
					$kind: 'Transaction',
					Transaction: { digest: '0xabc', effects: { changedObjects: [] } },
				}),
				waitForTransaction: async () => {
					waitCalled = true;
				},
			};
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
