import { Effect, Exit, Fiber, Option } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';

import { layerLeaseBroker } from '../../../src/substrate/runtime/lease-broker/index.ts';
import { layerStrategyRegistry } from '../../../src/substrate/runtime/strategy-registry/index.ts';
import {
	acquireAccount,
	type AccountValue,
	type AccountAcquireContext,
	type ResolvedAccountOptions,
} from '../../../src/plugins/account/service.ts';
import type { SuiSdkShim } from '../../../src/plugins/sui/chain-probe.ts';
import { publishError } from '../../../src/plugins/package/errors.ts';
import { makePublishExecutor } from '../../../src/plugins/package/publish-executor.ts';

const txHarness = vi.hoisted(() => ({
	events: [] as string[],
}));

vi.mock('@mysten/sui/transactions', () => ({
	Transaction: class {
		#label = 0;
		#data = {
			version: 2 as const,
			sender: null as string | null,
			gasData: {
				budget: null as string | null,
				price: null as string | null,
				owner: null as string | null,
				payment: null as ReadonlyArray<unknown> | null,
			},
			expiration: null as unknown,
			inputs: [] as [],
			commands: [] as [],
		};

		setSender(address: string): void {
			this.#data.sender = address;
		}
		setGasBudget(value: bigint): void {
			this.#data.gasData.budget = String(value);
		}
		setGasPrice(value: bigint): void {
			this.#data.gasData.price = String(value);
		}
		setGasOwner(value: string): void {
			this.#data.gasData.owner = value;
		}
		setGasPayment(value: ReadonlyArray<unknown>): void {
			this.#data.gasData.payment = value;
		}
		setExpiration(value: unknown): void {
			this.#data.expiration = value;
		}
		getData(): {
			readonly version: 2;
			readonly sender: string | null;
			readonly mockLabel: number;
			readonly gasData: {
				readonly budget: string | null;
				readonly price: string | null;
				readonly owner: string | null;
				readonly payment: ReadonlyArray<unknown> | null;
			};
			readonly expiration: unknown;
			readonly inputs: [];
			readonly commands: [];
		} {
			return { ...this.#data, mockLabel: this.#label };
		}

		publish(inputs: { readonly modules: ReadonlyArray<ReadonlyArray<number>> }): unknown {
			this.#label = inputs.modules[0]?.[0] ?? 0;
			return { upgradeCap: this.#label };
		}

		transferObjects(_objects: ReadonlyArray<unknown>, _address: string): void {}

		async prepareForSerialization(): Promise<void> {}

		async build(): Promise<Uint8Array> {
			txHarness.events.push(`${this.#label}:build`);
			return new Uint8Array([this.#label]);
		}
	},
	TransactionDataBuilder: {
		restore(data: { readonly mockLabel?: number }) {
			return {
				build(): Uint8Array {
					const label = data.mockLabel ?? 0;
					txHarness.events.push(`${label}:build`);
					return new Uint8Array([label]);
				},
			};
		},
	},
}));

interface Gate {
	readonly wait: Promise<void>;
	readonly release: () => void;
}

const makeGate = (): Gate => {
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { wait, release };
};

const makeAccountCtx = (sdk: SuiSdkShim): AccountAcquireContext => ({
	sui: { mode: 'local', chainId: 'sui:localnet', sdk },
	runtimeRoot: '/tmp/devstack-publish-executor-test',
	app: 'test-app',
	stack: 'test-stack',
	emitAutoPromotionEvent: () => Effect.void,
});

const accountOpts: ResolvedAccountOptions = {
	kind: 'signer',
	name: 'publisher',
	signer: {
		toSuiAddress: () => '0xabc',
		getKeyScheme: () => 'ed25519',
		getPublicKey: () => ({ toRawBytes: () => new Uint8Array(32) }),
		signTransaction: async () => ({ bytes: 'tx-bytes', signature: 'sig' }),
		signPersonalMessage: async () => ({ bytes: 'msg-bytes', signature: 'sig' }),
	},
	addressOverride: '0xabc',
};

const makePublishSdk = (
	waitGates: ReadonlyMap<string, Gate>,
	opts: {
		readonly failedLabels?: ReadonlySet<number>;
		readonly missingPublishedLabels?: ReadonlySet<number>;
	} = {},
): SuiSdkShim => {
	const executeTransaction = async (args: { readonly transaction: Uint8Array }) => {
		const label = args.transaction[0] ?? 0;
		txHarness.events.push(`${label}:execute`);
		if (opts.failedLabels?.has(label) === true) {
			return {
				$kind: 'FailedTransaction',
				FailedTransaction: {
					digest: `digest-${label}`,
					status: { error: 'MoveAbort' },
				},
			};
		}
		return {
			$kind: 'Transaction',
			Transaction: {
				digest: `digest-${label}`,
				effects: {
					changedObjects: [
						...(opts.missingPublishedLabels?.has(label) === true
							? []
							: [
									{
										objectId: `0xpkg${label}`,
										outputState: 'PackageWrite',
										idOperation: 'Created',
									},
								]),
						{
							objectId: `0xcap${label}`,
							outputState: 'ObjectWrite',
							idOperation: 'Created',
						},
					],
				},
				objectTypes: {
					[`0xcap${label}`]: '0x2::package::UpgradeCap',
				},
				// NB: the publish path projects object changes from the account
				// plugin's `projectTxResult`, which derives them from
				// `effects.changedObjects` + `objectTypes` (above) — NOT from a
				// top-level `Transaction.objectChanges`. So no such array is
				// declared here; adding one would be dead (the SDK-driven path
				// never reads it). The impersonation test below DOES declare
				// `Transaction.objectChanges` because its stub bypasses
				// `projectTxResult` and is consumed by `signAndDispatch` directly.
			},
		};
	};
	const waitForTransaction = async (args: { readonly digest: string }) => {
		txHarness.events.push(`${args.digest.replace('digest-', '')}:wait`);
		await waitGates.get(args.digest)?.wait;
	};
	return {
		core: {
			getObject: () => Promise.reject(new Error('stub getObject')),
			getTransaction: () => Promise.reject(new Error('stub getTransaction')),
			getBalance: () => Promise.reject(new Error('stub getBalance')),
			listCoins: () =>
				Promise.resolve({
					objects: [
						{
							objectId: '0xgas',
							version: '1',
							digest: 'gas-digest',
							balance: '1000000000',
						},
					],
					hasNextPage: false,
					cursor: null,
				}),
			executeTransaction,
			waitForTransaction,
		},
		// Tests don't reach the publish-side client surface — the unified
		// signAndExecute path goes through account.sdk.core.* exclusively.
		client: null as never,
	};
};

describe('package publish executor', () => {
	it.effect('keeps Transaction.build through waitForTransaction inside the publisher lease', () =>
		Effect.gen(function* () {
			txHarness.events.length = 0;
			const waitOne = makeGate();
			const waitTwo = makeGate();
			const sharedSdk = makePublishSdk(
				new Map([
					['digest-1', waitOne],
					['digest-2', waitTwo],
				]),
			);
			const account = yield* acquireAccount(accountOpts, makeAccountCtx(sharedSdk)).pipe(
				Effect.provide(layerStrategyRegistry),
				Effect.orDie,
			);
			const executor = makePublishExecutor({ sdk: sharedSdk, account });

			const first = yield* Effect.forkChild(
				executor.publishTx({
					modules: [new Uint8Array([1])],
					dependencies: [],
					sourcePath: '/tmp/pkg-one',
					packageName: 'pkg_one',
				}),
			);
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;

			const second = yield* Effect.forkChild(
				executor.publishTx({
					modules: [new Uint8Array([2])],
					dependencies: [],
					sourcePath: '/tmp/pkg-two',
					packageName: 'pkg_two',
				}),
			);
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;

			expect(txHarness.events).toEqual(['1:build', '1:execute', '1:wait']);

			waitOne.release();
			const firstReceipt = yield* Fiber.join(first);
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;
			expect(firstReceipt.packageId).toBe('0xpkg1');
			expect(txHarness.events).toEqual([
				'1:build',
				'1:execute',
				'1:wait',
				'2:build',
				'2:execute',
				'2:wait',
			]);

			waitTwo.release();
			const secondReceipt = yield* Fiber.join(second);
			expect(secondReceipt.packageId).toBe('0xpkg2');
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect('waits for FailedTransaction digests before releasing the publisher lease', () =>
		Effect.gen(function* () {
			txHarness.events.length = 0;
			const waitOne = makeGate();
			const waitTwo = makeGate();
			const sharedSdk = makePublishSdk(
				new Map([
					['digest-1', waitOne],
					['digest-2', waitTwo],
				]),
				{ failedLabels: new Set([1]) },
			);
			const account = yield* acquireAccount(accountOpts, makeAccountCtx(sharedSdk)).pipe(
				Effect.provide(layerStrategyRegistry),
				Effect.orDie,
			);
			const executor = makePublishExecutor({ sdk: sharedSdk, account });

			const failedFirst = yield* Effect.forkChild(
				Effect.exit(
					executor.publishTx({
						modules: [new Uint8Array([1])],
						dependencies: [],
						sourcePath: '/tmp/pkg-one',
						packageName: 'pkg_one',
					}),
				),
			);
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;

			const second = yield* Effect.forkChild(
				executor.publishTx({
					modules: [new Uint8Array([2])],
					dependencies: [],
					sourcePath: '/tmp/pkg-two',
					packageName: 'pkg_two',
				}),
			);
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;

			expect(txHarness.events).toEqual(['1:build', '1:execute', '1:wait']);

			waitOne.release();
			const failedExit = yield* Fiber.join(failedFirst);
			expect(Exit.isFailure(failedExit)).toBe(true);
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;
			expect(txHarness.events).toEqual([
				'1:build',
				'1:execute',
				'1:wait',
				'2:build',
				'2:execute',
				'2:wait',
			]);

			waitTwo.release();
			const secondReceipt = yield* Fiber.join(second);
			expect(secondReceipt.packageId).toBe('0xpkg2');
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect(
		'postPublishReadyHint swallows a transient RPC failure (stale-object read is non-fatal)',
		() =>
			Effect.gen(function* () {
				// Contract: `getObject` rejecting after a successful publish
				// is a "tx written but object not yet queryable" race; the
				// next produce phase (`parse`) inspects the actual output, so
				// the hint is best-effort and ALWAYS succeeds — the read
				// failure is logged at debug (not silently dropped) and the
				// hint resolves regardless. The separate unit-test below pins
				// the `publishError('parse', ...)` shape used by other phases
				// (packageName optional, on-chain id only in the message).
				const sdk: SuiSdkShim = {
					core: {
						getObject: () => Promise.reject(new Error('hint-rpc-down')),
						getTransaction: () => Promise.reject(new Error('stub')),
						getBalance: () => Promise.reject(new Error('stub')),
						listCoins: () => Promise.resolve({ objects: [], hasNextPage: false, cursor: null }),
						executeTransaction: () => Promise.reject(new Error('stub')),
						waitForTransaction: () => Promise.reject(new Error('stub')),
					},
					client: null as never,
				};
				const account = {
					name: 'publisher',
					address: '0xabc',
				} as unknown as AccountValue;
				const executor = makePublishExecutor({ sdk, account });

				const exit = yield* Effect.exit(
					Effect.scoped(executor.postPublishReadyHint('0xpkg-onchain-id')),
				);
				expect(Exit.isSuccess(exit)).toBe(true);
			}),
	);

	it.effect('fails parse before returning output when the published change is missing', () =>
		Effect.gen(function* () {
			const sharedSdk = makePublishSdk(new Map(), {
				missingPublishedLabels: new Set([3]),
			});
			const account = yield* acquireAccount(accountOpts, makeAccountCtx(sharedSdk)).pipe(
				Effect.provide(layerStrategyRegistry),
				Effect.orDie,
			);
			const executor = makePublishExecutor({ sdk: sharedSdk, account });

			const exit = yield* Effect.exit(
				executor.publishTx({
					modules: [new Uint8Array([3])],
					dependencies: [],
					sourcePath: '/tmp/pkg-missing-published',
					packageName: 'pkg_missing_published',
				}),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			const errorOpt = Exit.findErrorOption(exit);
			expect(Option.isSome(errorOpt)).toBe(true);
			const error = Option.getOrThrow(errorOpt);
			expect(error._tag).toBe('PublishError');
			expect(error.phase).toBe('parse');
			expect(error.message).toContain('no "published" change');
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it('publishError("parse") shape — packageName is optional, never overloaded with on-chain id', () => {
		// Regression: previously the hint threw
		// `publishError('parse', { packageName: packageId, ... })`,
		// stamping the on-chain `0x…` id into the symbolic name
		// slot — the user's error display showed `packageName=0x...`.
		// The fix made `packageName` optional on the error class and
		// removed the overload at the throw site (the on-chain id is
		// now carried in `message` where it's unambiguous; `mode-local`
		// re-stamps `packageName` + `sourcePath` from the outer inputs
		// when the error bubbles through).
		const err = publishError('parse', {
			message: 'postPublishReadyHint(0xpkg-onchain-id) failed',
			cause: new Error('hint-rpc-down'),
		});
		expect(err._tag).toBe('PublishError');
		expect(err.phase).toBe('parse');
		expect(err.packageName).toBeUndefined();
		expect(err.message).toContain('0xpkg-onchain-id');
	});

	it.effect('publishes with an impersonation account through account.signAndExecute', () =>
		Effect.gen(function* () {
			txHarness.events.length = 0;
			const signTransaction: AccountValue['signTransaction'] = () =>
				Effect.die('impersonation should not sign directly');
			const accountSignAndExecute: AccountValue['signAndExecute'] = (tx) =>
				Effect.sync(() => {
					const label = tx[0] ?? 0;
					txHarness.events.push(`${label}:impersonate`);
					return {
						$kind: 'Transaction',
						Transaction: {
							digest: `digest-${label}`,
							effects: {},
							objectChanges: [
								{
									type: 'published',
									objectId: `0xpkg${label}`,
									objectType: `0xpkg${label}::published::Package`,
								},
								{
									type: 'created',
									objectId: `0xcap${label}`,
									objectType: '0x2::package::UpgradeCap',
								},
							],
							balanceChanges: [],
						},
					};
				});
			const account: AccountValue = {
				name: 'publisher',
				address: '0xabc',
				scheme: 'ed25519',
				publicKey: new Uint8Array(32),
				source: 'impersonate',
				funding: { requested: [], applied: [] },
				signTransaction,
				signAndExecute: accountSignAndExecute,
				signPersonalMessage: () => Effect.die('unused'),
				withTransactionSigner: (body) =>
					body({ signTransaction, signAndExecute: accountSignAndExecute }),
			};
			const executor = makePublishExecutor({
				sdk: makePublishSdk(new Map()),
				account,
			});

			const receipt = yield* executor.publishTx({
				modules: [new Uint8Array([7])],
				dependencies: [],
				sourcePath: '/tmp/pkg-impersonate',
				packageName: 'pkg_impersonate',
			});

			expect(receipt.packageId).toBe('0xpkg7');
			expect(receipt.upgradeCapId).toBe('0xcap7');
			expect(txHarness.events).toEqual(['7:build', '7:impersonate']);
		}),
	);
});
