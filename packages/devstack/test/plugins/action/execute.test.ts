// Unit tests for the Action plugin's `signAndExecute` helper.
//
// What this test pins (covers the helper's envelope-projection + error
// taxonomy without going near docker / a real chain):
//
//   1. happy path  — projects `{digest, objectChanges}` with one
//                    `kind: 'created'` entry (Lobby-style singleton);
//                    `mutated` entries surface separately; the
//                    fully-qualified `objectType` is carried through.
//   2. failed-tx   — `$kind: 'FailedTransaction'` surfaces as
//                    ActionError({phase:'sign'}) with the SDK error
//                    string preserved in the message.
//   3. no-digest   — `$kind: 'Transaction'` with `digest=undefined`
//                    surfaces as ActionError({phase:'parse'}).
//   4. build-throw — caller's `build` callback throws → ActionError
//                    ({phase:'sign'}).
//   5. execute-rejects — executeTransaction promise rejects →
//                        ActionError({phase:'sign'}) with the rejection
//                        message preserved.

import { Effect, Exit, Option } from 'effect';
import { describe, expect, it } from 'vitest';

import type { AccountValue } from '../../../src/plugins/account/service.ts';
import { chainId } from '../../../src/substrate/brand.ts';
import type { SuiClient } from '../../../src/plugins/sui/index.ts';
import { signAndExecute, type ActionObjectChange } from '../../../src/plugins/action/execute.ts';

// ---------------------------------------------------------------------------
// Fake account + sui shape — minimal contracts the helper actually
// touches.
// ---------------------------------------------------------------------------

const fakeAccount = (events?: string[]): AccountValue => {
	const signTransaction: AccountValue['signTransaction'] = () =>
		Effect.sync(() => {
			events?.push('sign');
			return {
				bytes: 'fake-bytes',
				signature: 'AAAA',
			};
		});
	const signAndExecute: AccountValue['signAndExecute'] = () =>
		Effect.die('signAndExecute unused by the action.signAndExecute helper');
	const withTransactionSigner: AccountValue['withTransactionSigner'] = (body) => {
		if (events === undefined) return body({ signTransaction, signAndExecute });
		return Effect.gen(function* () {
			events.push('scope:enter');
			return yield* body({ signTransaction, signAndExecute });
		}).pipe(Effect.ensuring(Effect.sync(() => events.push('scope:exit'))));
	};
	return {
		name: 'tester',
		address: '0x1111111111111111111111111111111111111111111111111111111111111111',
		scheme: 'ed25519',
		publicKey: new Uint8Array(32),
		source: 'real',
		funding: { requested: [], applied: [] },
		withTransactionSigner,
		// Sign always returns a deterministic signature.
		signTransaction,
		signPersonalMessage: () =>
			Effect.succeed({
				bytes: 'fake-msg',
				signature: 'AAAA',
			}),
		signAndExecute,
	};
};

interface FakeSdkClientOpts {
	readonly executeImpl?: (args: unknown) => Promise<unknown>;
	readonly waitImpl?: (args: unknown) => Promise<unknown>;
}

const makeFakeSui = (opts: FakeSdkClientOpts): SuiClient => {
	const client = {
		// `Transaction.build({client})` looks at the client to resolve
		// gas budgets + object versions. We pre-set everything on the
		// Transaction so the SDK's build path doesn't need to call back
		// — but the SDK still inspects some properties for client
		// version etc. We provide the minimal surface.
		// (The SDK accepts a wide range of "client-like" shapes; the
		// `@mysten/sui` `Transaction.build` issues a `.core.getReferenceGasPrice`
		// call when no `gasConfig` is set. We pre-set the gas config
		// inside the build callback the test passes.)
		core: {
			getReferenceGasPrice: () => Promise.resolve(1000n),
		},
		executeTransaction:
			opts.executeImpl ??
			((_args: unknown) =>
				Promise.resolve({
					$kind: 'Transaction',
					Transaction: { digest: 'AAAA' },
				})),
		waitForTransaction: opts.waitImpl ?? ((_args: unknown) => Promise.resolve({})),
	};
	return {
		sdk: {
			// `client` is the opaque ref the helper passes to
			// Transaction.build({client}) — we make it self-referencing
			// so the executeTransaction surface ALSO routes through this
			// stub (the helper casts the same opaque ref).
			client: client as unknown,
			// The sui plugin's `SuiSdkShim` also exposes a `core`
			// surface, but the helper only uses `client.executeTransaction`
			// / `waitForTransaction` (it does NOT route through
			// `sdk.core.executeTransaction`).
			core: {
				executeTransaction: client.executeTransaction,
				waitForTransaction: client.waitForTransaction,
				getObject: (_: unknown) => Promise.resolve({}),
			},
		} as unknown as SuiClient['sdk'],
		rpcUrl: 'http://127.0.0.1:9000',
		faucetUrl: null,
		graphqlUrl: null,
		hostGateway: {
			rpcUrl: 'http://host.docker.internal:9000',
			faucetUrl: null,
			graphqlUrl: null,
		},
		chain: chainId('sui:e2e-action-test'),
		// Trivial stubs for the remaining fields the helper doesn't
		// touch.
		waitForTransactionsReady: {
			wait: Effect.void as never,
			invalidate: Effect.void,
		},
		chainProbe: { get: () => Effect.succeed(null) } as never,
		fork: null,
		buildImage: null,
	};
};

// Pre-set the Transaction's gas config so `Transaction.build({client})`
// doesn't have to call back into the client for a reference gas price
// (keeps the test fully offline).
const seedTx = (tx: import('@mysten/sui/transactions').Transaction): void => {
	tx.setGasBudget(1_000_000n);
	tx.setGasPrice(1000n);
	tx.setGasOwner('0x1111111111111111111111111111111111111111111111111111111111111111');
	// Provide a gas payment so the build path doesn't try to resolve
	// owned coins (which would round-trip the stubbed client).
	tx.setGasPayment([
		{
			objectId: '0x2222222222222222222222222222222222222222222222222222222222222222',
			version: '1',
			digest: '11111111111111111111111111111111',
		},
	]);
};

describe('action signAndExecute helper', () => {
	it('happy path: projects digest + objectChanges (created + mutated buckets)', async () => {
		const account = fakeAccount();
		const sui = makeFakeSui({
			executeImpl: () =>
				Promise.resolve({
					$kind: 'Transaction',
					Transaction: {
						digest: '5KqYxFhEWQ6q7ZyKaRYrQX9wYxxYPDLPaGNRpRiKjJ7Y',
						effects: {
							changedObjects: [
								{
									objectId: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
									outputState: 'ObjectWrite',
									idOperation: 'Created',
								},
								{
									objectId: '0xbbbb000000000000000000000000000000000000000000000000000000000002',
									outputState: 'ObjectWrite',
									idOperation: 'None',
								},
							],
						},
						objectTypes: {
							'0xaaaa000000000000000000000000000000000000000000000000000000000001':
								'0xpkg::game::Lobby',
						},
					},
				}),
		});
		const exit = await Effect.runPromiseExit(
			Effect.scoped(
				signAndExecute({
					actionName: 'unit.happy',
					sui,
					account,
					build: (tx) => {
						seedTx(tx);
						tx.moveCall({
							target: '0x0000000000000000000000000000000000000000000000000000000000000999::m::f',
						});
					},
				}),
			),
		);
		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;
		const r = exit.value;
		const oc = (r.objectChanges ?? []) as ReadonlyArray<ActionObjectChange>;
		const created = oc.filter((c) => c.kind === 'created');
		const mutated = oc.filter((c) => c.kind === 'mutated');
		expect(r.digest).toBe('5KqYxFhEWQ6q7ZyKaRYrQX9wYxxYPDLPaGNRpRiKjJ7Y');
		expect(created.length).toBe(1);
		expect(mutated.length).toBe(1);
		expect(created[0]?.objectType).toBe('0xpkg::game::Lobby');
	});

	it('failed-tx: surfaces ActionError(phase=sign) with SDK error preserved', async () => {
		const account = fakeAccount();
		const sui = makeFakeSui({
			executeImpl: () =>
				Promise.resolve({
					$kind: 'FailedTransaction',
					FailedTransaction: {
						digest: 'GGGG',
						status: { error: 'InsufficientGas' },
					},
				}),
		});
		const exit = await Effect.runPromiseExit(
			Effect.scoped(
				signAndExecute({
					actionName: 'unit.failedTx',
					sui,
					account,
					build: (tx) => {
						seedTx(tx);
						tx.moveCall({
							target: '0x0000000000000000000000000000000000000000000000000000000000000999::m::f',
						});
					},
				}),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		const errOpt = Exit.findErrorOption(exit);
		expect(Option.isSome(errOpt)).toBe(true);
		const err = (errOpt as Option.Some<{ phase?: string; message?: string }>).value;
		expect(err.phase).toBe('sign');
		expect(err.message?.includes('InsufficientGas')).toBe(true);
	});

	it('failed-tx with digest waits before the account transaction scope releases', async () => {
		const events: string[] = [];
		const account = fakeAccount(events);
		const sui = makeFakeSui({
			executeImpl: () => {
				events.push('execute');
				return Promise.resolve({
					$kind: 'FailedTransaction',
					FailedTransaction: {
						digest: 'FAILED_DIGEST',
						status: { error: 'MoveAbort' },
					},
				});
			},
			waitImpl: () => {
				events.push('wait');
				expect(events).toEqual(['scope:enter', 'sign', 'execute', 'wait']);
				return Promise.resolve({});
			},
		});
		const exit = await Effect.runPromiseExit(
			Effect.scoped(
				signAndExecute({
					actionName: 'unit.failedTxWaits',
					sui,
					account,
					build: (tx) => {
						seedTx(tx);
						tx.moveCall({
							target: '0x0000000000000000000000000000000000000000000000000000000000000999::m::f',
						});
					},
				}),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		const errOpt = Exit.findErrorOption(exit);
		expect(Option.isSome(errOpt)).toBe(true);
		const err = (errOpt as Option.Some<{ message?: string }>).value;
		expect(err.message?.includes('MoveAbort')).toBe(true);
		expect(events).toEqual(['scope:enter', 'sign', 'execute', 'wait', 'scope:exit']);
	});

	it('no-digest: surfaces ActionError(phase=parse)', async () => {
		const account = fakeAccount();
		const sui = makeFakeSui({
			executeImpl: () =>
				Promise.resolve({
					$kind: 'Transaction',
					Transaction: { effects: { changedObjects: [] } },
				}),
		});
		const exit = await Effect.runPromiseExit(
			Effect.scoped(
				signAndExecute({
					actionName: 'unit.noDigest',
					sui,
					account,
					build: (tx) => {
						seedTx(tx);
						tx.moveCall({
							target: '0x0000000000000000000000000000000000000000000000000000000000000999::m::f',
						});
					},
				}),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		const errOpt = Exit.findErrorOption(exit);
		expect(Option.isSome(errOpt)).toBe(true);
		const err = (errOpt as Option.Some<{ phase?: string }>).value;
		expect(err.phase).toBe('parse');
	});

	it('build-throw: surfaces ActionError(phase=sign)', async () => {
		const account = fakeAccount();
		const sui = makeFakeSui({});
		const exit = await Effect.runPromiseExit(
			Effect.scoped(
				signAndExecute({
					actionName: 'unit.buildThrow',
					sui,
					account,
					build: () => {
						throw new Error('boom-in-build');
					},
				}),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		const errOpt = Exit.findErrorOption(exit);
		expect(Option.isSome(errOpt)).toBe(true);
		const err = (errOpt as Option.Some<{ phase?: string }>).value;
		expect(err.phase).toBe('sign');
	});

	it('execute-rejects: surfaces ActionError(phase=sign) with cause message', async () => {
		const account = fakeAccount();
		const sui = makeFakeSui({
			executeImpl: () => Promise.reject(new Error('rpc-down-503')),
		});
		const exit = await Effect.runPromiseExit(
			Effect.scoped(
				signAndExecute({
					actionName: 'unit.executeRejects',
					sui,
					account,
					build: (tx) => {
						seedTx(tx);
						tx.moveCall({
							target: '0x0000000000000000000000000000000000000000000000000000000000000999::m::f',
						});
					},
				}),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		const errOpt = Exit.findErrorOption(exit);
		expect(Option.isSome(errOpt)).toBe(true);
		const err = (errOpt as Option.Some<{ phase?: string; message?: string }>).value;
		expect(err.phase).toBe('sign');
		expect(err.message?.includes('rpc-down-503')).toBe(true);
	});
});
