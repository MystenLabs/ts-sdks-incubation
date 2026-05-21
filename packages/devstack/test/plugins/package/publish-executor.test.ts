import { Effect, Exit, Fiber } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';

import { chainId } from '../../../src/substrate/brand.ts';
import { layerLeaseBroker } from '../../../src/substrate/runtime/lease-broker/index.ts';
import { layerStrategyRegistry } from '../../../src/substrate/runtime/strategy-registry/index.ts';
import {
	acquireAccount,
	type AccountAcquireContext,
	type AccountOptions,
} from '../../../src/plugins/account/service.ts';
import type { SuiSdkShim } from '../../../src/plugins/sui/chain-probe.ts';
import { makePublishExecutor } from '../../../src/plugins/package/publish-executor.ts';

const txHarness = vi.hoisted(() => ({
	events: [] as string[],
}));

vi.mock('@mysten/sui/transactions', () => ({
	Transaction: class {
		#label = 0;

		setSender(_address: string): void {}

		publish(inputs: { readonly modules: ReadonlyArray<ReadonlyArray<number>> }): unknown {
			this.#label = inputs.modules[0]?.[0] ?? 0;
			return { upgradeCap: this.#label };
		}

		transferObjects(_objects: ReadonlyArray<unknown>, _address: string): void {}

		async build(): Promise<Uint8Array> {
			txHarness.events.push(`${this.#label}:build`);
			return new Uint8Array([this.#label]);
		}
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

const stubSuiSdk = (): SuiSdkShim => ({
	core: {
		getObject: () => Promise.reject(new Error('stub getObject')),
		getTransaction: () => Promise.reject(new Error('stub getTransaction')),
		executeTransaction: () => Promise.reject(new Error('stub executeTransaction')),
		waitForTransaction: () => Promise.reject(new Error('stub waitForTransaction')),
	},
	client: null,
});

const accountCtx: AccountAcquireContext = {
	sui: { mode: 'local', chain: chainId('sui:localnet'), sdk: stubSuiSdk() },
	runtimeRoot: '/tmp/devstack-publish-executor-test',
	app: 'test-app',
	stack: 'test-stack',
	emitAutoPromotionEvent: () => Effect.void,
};

const accountOpts: AccountOptions = {
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
	opts: { readonly failedLabels?: ReadonlySet<number> } = {},
): SuiSdkShim => {
	const client = {
		executeTransaction: async (args: { readonly transaction: Uint8Array }) => {
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
							{
								objectId: `0xpkg${label}`,
								outputState: 'PackageWrite',
								idOperation: 'Created',
							},
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
				},
			};
		},
		waitForTransaction: async (args: { readonly digest: string }) => {
			txHarness.events.push(`${args.digest.replace('digest-', '')}:wait`);
			await waitGates.get(args.digest)?.wait;
		},
	};
	return {
		core: {
			getObject: () => Promise.reject(new Error('stub getObject')),
			getTransaction: () => Promise.reject(new Error('stub getTransaction')),
			executeTransaction: () => Promise.reject(new Error('stub executeTransaction')),
			waitForTransaction: () => Promise.reject(new Error('stub waitForTransaction')),
		},
		client,
	};
};

describe('package publish executor', () => {
	it.effect('keeps Transaction.build through waitForTransaction inside the publisher lease', () =>
		Effect.gen(function* () {
			txHarness.events.length = 0;
			const account = yield* acquireAccount(accountOpts, accountCtx).pipe(
				Effect.provide(layerStrategyRegistry),
				Effect.orDie,
			);
			const waitOne = makeGate();
			const waitTwo = makeGate();
			const executor = makePublishExecutor({
				sdk: makePublishSdk(
					new Map([
						['digest-1', waitOne],
						['digest-2', waitTwo],
					]),
				),
				account,
			});

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
			const account = yield* acquireAccount(accountOpts, accountCtx).pipe(
				Effect.provide(layerStrategyRegistry),
				Effect.orDie,
			);
			const waitOne = makeGate();
			const waitTwo = makeGate();
			const executor = makePublishExecutor({
				sdk: makePublishSdk(
					new Map([
						['digest-1', waitOne],
						['digest-2', waitTwo],
					]),
					{ failedLabels: new Set([1]) },
				),
				account,
			});

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
});
