// Unit tests for the Action plugin's `signAndExecute` helper.
//
// Post-dedup (backlog #29) the action body delegates the SDK roundtrip
// (sign + execute + finality wait + envelope projection) to the
// account's `withTransactionSigner` / `signAndExecute` surface. The
// helper now:
//   1. Allocates + populates the Transaction (caller's `build`).
//   2. Serialises bytes via `Transaction.build({ client })` (or the
//      fork-mode builder for impersonation).
//   3. Calls `lockedSigner.signAndExecute(txBytes)`.
//   4. Re-projects the returned `TxResult` into the action's
//      `ActionReceipt` (bucketed created/mutated rows).
//
// What this test pins:
//
//   1. happy path  — projects `{digest, objectChanges}` with `created`
//                    and `mutated` buckets carried from the account's
//                    flat `objectChanges`; fully-qualified `objectType`
//                    survives.
//   2. failed-tx   — `SignAndExecuteResult({$kind:'FailedTransaction'})`
//                    maps to `ActionError(phase:'execute-failed')` with
//                    the on-chain `executionError` preserved.
//   3. no-digest   — `AccountSignError(phase:'no-digest')` (SDK
//                    envelope protocol violation) flows through the
//                    transport branch and maps to `ActionError
//                    (phase:'sign')` with the originating phase
//                    preserved via `cause`.
//   4. build-throw — caller's `build` callback throws → ActionError
//                    ({phase:'sign'}).
//   5. lease + ordering — the build → signAndExecute → projection
//      sequence happens inside the account's withTransactionSigner
//      scope; finalizer runs after.
//   6. transport   — `AccountSignError(phase:'submit')` maps to
//                    `ActionError(phase:'sign')` with the cause
//                    message preserved.

import { Effect, Exit, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { TransactionDataBuilder } from '@mysten/sui/transactions';

import { accountSignError } from '../../../src/plugins/account/errors.ts';
import type { AccountValue, SignAndExecuteResult } from '../../../src/plugins/account/service.ts';
import { chainId } from '../../../src/substrate/brand.ts';
import type { SuiClient } from '../../../src/plugins/sui/index.ts';
import { signAndExecute, type ActionObjectChange } from '../../../src/plugins/action/execute.ts';

// ---------------------------------------------------------------------------
// Fake account + sui shape — minimal contracts the helper actually
// touches.
// ---------------------------------------------------------------------------

interface FakeAccountOpts {
	readonly events?: string[];
	readonly signAndExecuteImpl?: (
		tx: Uint8Array,
	) => Effect.Effect<SignAndExecuteResult, ReturnType<typeof accountSignError>>;
}

const fakeAccount = (opts: FakeAccountOpts = {}): AccountValue => {
	const { events, signAndExecuteImpl } = opts;
	const signTransaction: AccountValue['signTransaction'] = () =>
		Effect.sync(() => {
			events?.push('sign');
			return {
				bytes: 'fake-bytes',
				signature: 'AAAA',
			};
		});
	const defaultSignAndExecute: AccountValue['signAndExecute'] = () =>
		Effect.sync(() => {
			events?.push('sign+execute');
			return {
				$kind: 'Transaction',
				Transaction: {
					digest: 'DEFAULT_DIGEST',
					effects: {},
					objectChanges: [],
					balanceChanges: [],
				},
			};
		});
	const signAndExecute: AccountValue['signAndExecute'] =
		signAndExecuteImpl ?? defaultSignAndExecute;
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
		signTransaction,
		signPersonalMessage: () =>
			Effect.succeed({
				bytes: 'fake-msg',
				signature: 'AAAA',
			}),
		signAndExecute,
	};
};

const makeFakeSui = (): SuiClient => {
	// The helper only needs the SDK's `client` ref for `Transaction.build`;
	// `executeTransaction` and `waitForTransaction` move into the account's
	// surface post-dedup, so this shim deliberately omits both.
	const client = {
		core: {
			getReferenceGasPrice: () => Promise.resolve(1000n),
		},
	};
	return {
		sdk: {
			client: client as unknown,
			core: {
				executeTransaction: () =>
					Promise.reject(
						new Error('action.signAndExecute should not call executeTransaction directly'),
					),
				waitForTransaction: () =>
					Promise.reject(
						new Error('action.signAndExecute should not call waitForTransaction directly'),
					),
				getObject: (_: unknown) => Promise.resolve({}),
				listCoins: () =>
					Promise.resolve({
						objects: [
							{
								objectId: '0x3333333333333333333333333333333333333333333333333333333333333333',
								version: '1',
								digest: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
								balance: '1000000000',
							},
						],
						hasNextPage: false,
						cursor: null,
					}),
			},
		} as unknown as SuiClient['sdk'],
		rpcUrl: 'http://127.0.0.1:9000',
		faucetUrl: null,
		fundingFaucetUrl: null,
		graphqlUrl: null,
		hostGateway: {
			rpcUrl: 'http://host.docker.internal:9000',
			faucetUrl: null,
			graphqlUrl: null,
		},
		chain: chainId('sui:e2e-action-test'),
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
// doesn't need to round-trip the stubbed client for a reference gas
// price (keeps the test fully offline).
const seedTx = (tx: import('@mysten/sui/transactions').Transaction): void => {
	tx.setGasBudget(1_000_000n);
	tx.setGasPrice(1000n);
	tx.setGasOwner('0x1111111111111111111111111111111111111111111111111111111111111111');
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
		const account = fakeAccount({
			signAndExecuteImpl: () =>
				Effect.succeed({
					$kind: 'Transaction',
					Transaction: {
						digest: '5KqYxFhEWQ6q7ZyKaRYrQX9wYxxYPDLPaGNRpRiKjJ7Y',
						effects: {},
						objectChanges: [
							{
								type: 'created',
								objectId: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
								objectType: '0xpkg::game::Lobby',
								outputState: 'ObjectWrite',
								idOperation: 'Created',
							},
							{
								type: 'mutated',
								objectId: '0xbbbb000000000000000000000000000000000000000000000000000000000002',
								outputState: 'ObjectWrite',
								idOperation: 'None',
							},
						],
						balanceChanges: [],
					},
				} satisfies SignAndExecuteResult),
		});
		const sui = makeFakeSui();
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

	it('impersonation account: routes through account.signAndExecute without direct signing', async () => {
		const events: string[] = [];
		const base = fakeAccount({ events });
		const signTransaction: AccountValue['signTransaction'] = () =>
			Effect.die('impersonation should not sign directly');
		const accountSignAndExecute: AccountValue['signAndExecute'] = () =>
			Effect.sync(() => {
				events.push('impersonate');
				return {
					$kind: 'Transaction',
					Transaction: {
						digest: 'IMPERSONATED_DIGEST',
						effects: {},
						objectChanges: [
							{
								type: 'created',
								objectId: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
								objectType: '0xpkg::game::Lobby',
							},
						],
						balanceChanges: [{ owner: base.address }],
					},
				};
			});
		const account: AccountValue = {
			...base,
			source: 'impersonate',
			signTransaction,
			signAndExecute: accountSignAndExecute,
			withTransactionSigner: (body) =>
				Effect.gen(function* () {
					events.push('scope:enter');
					return yield* body({ signTransaction, signAndExecute: accountSignAndExecute });
				}).pipe(Effect.ensuring(Effect.sync(() => events.push('scope:exit')))),
		};
		const sui = makeFakeSui();

		const exit = await Effect.runPromiseExit(
			Effect.scoped(
				signAndExecute({
					actionName: 'unit.impersonate',
					sui,
					account,
					build: seedTx,
				}),
			),
		);

		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;
		expect(exit.value).toEqual({
			digest: 'IMPERSONATED_DIGEST',
			objectChanges: [
				{
					kind: 'created',
					objectId: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
					objectType: '0xpkg::game::Lobby',
				},
			],
			balanceChanges: [{ owner: base.address }],
		});
		expect(events).toEqual(['scope:enter', 'impersonate', 'scope:exit']);
	});

	it('impersonation account: builds offline with explicit fork gas defaults', async () => {
		const events: string[] = [];
		const base = fakeAccount({ events });
		const signTransaction: AccountValue['signTransaction'] = () =>
			Effect.die('impersonation should not sign directly');
		const accountSignAndExecute: AccountValue['signAndExecute'] = (txBytes) =>
			Effect.sync(() => {
				const data = TransactionDataBuilder.fromBytes(txBytes).snapshot();
				events.push(
					`impersonate:${data.sender}:${data.gasData.payment?.[0]?.objectId ?? '<none>'}`,
				);
				return {
					$kind: 'Transaction',
					Transaction: {
						digest: 'IMPERSONATED_DIGEST',
						effects: {},
						objectChanges: [],
						balanceChanges: [],
					},
				};
			});
		const account: AccountValue = {
			...base,
			source: 'impersonate',
			signTransaction,
			signAndExecute: accountSignAndExecute,
			withTransactionSigner: (body) =>
				body({ signTransaction, signAndExecute: accountSignAndExecute }),
		};
		const sui = makeFakeSui();

		const exit = await Effect.runPromiseExit(
			Effect.scoped(
				signAndExecute({
					actionName: 'unit.impersonateOfflineBuild',
					sui,
					account,
					build: (tx) => {
						tx.moveCall({
							target: '0x0000000000000000000000000000000000000000000000000000000000000999::m::f',
						});
					},
				}),
			),
		);

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(events).toEqual([
			`impersonate:${base.address}:0x3333333333333333333333333333333333333333333333333333333333333333`,
		]);
	});

	it('failed-tx: returns FailedTransaction → ActionError(phase=execute-failed) with executionError preserved', async () => {
		const account = fakeAccount({
			signAndExecuteImpl: () =>
				Effect.succeed({
					$kind: 'FailedTransaction',
					FailedTransaction: {
						digest: 'GGGG',
						executionError: 'InsufficientGas',
					},
				}),
		});
		const sui = makeFakeSui();
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
		expect(err.phase).toBe('execute-failed');
		expect(err.message?.includes('InsufficientGas')).toBe(true);
		// `formatExecutedFailure` (substrate/runtime/sui-execute) renders
		// the on-chain failure tail as `at <digest>: <executionError>` —
		// the digest is plainly present without a `digest=` prefix.
		expect(err.message?.includes('at GGGG')).toBe(true);
	});

	it('account scope unwinds AFTER the action body completes (sequencing pin)', async () => {
		const events: string[] = [];
		const account = fakeAccount({
			events,
			signAndExecuteImpl: () => {
				events.push('sign+execute');
				return Effect.succeed({
					$kind: 'FailedTransaction',
					FailedTransaction: {
						digest: 'FAILED_DIGEST',
						executionError: 'MoveAbort',
					},
				});
			},
		});
		const sui = makeFakeSui();
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
		expect(events).toEqual(['scope:enter', 'sign+execute', 'scope:exit']);
	});

	it('build-throw: surfaces ActionError(phase=sign)', async () => {
		const account = fakeAccount();
		const sui = makeFakeSui();
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

	it('account.signAndExecute transport failure: surfaces ActionError(phase=sign) with cause message', async () => {
		const account = fakeAccount({
			signAndExecuteImpl: () =>
				Effect.fail(
					accountSignError({
						phase: 'submit',
						accountName: 'tester',
						address: '0x1111111111111111111111111111111111111111111111111111111111111111',
						message: "Account 'tester': executeTransaction transport failed. rpc-down-503",
					}),
				),
		});
		const sui = makeFakeSui();
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

	it("no-digest: AccountSignError(phase='no-digest') flows through and preserves the cause phase", async () => {
		const account = fakeAccount({
			signAndExecuteImpl: () =>
				Effect.fail(
					accountSignError({
						phase: 'no-digest',
						accountName: 'tester',
						address: '0x1111111111111111111111111111111111111111111111111111111111111111',
						message:
							"Account 'tester': executeTransaction returned a malformed envelope — no digest.",
					}),
				),
		});
		const sui = makeFakeSui();
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
		const err = (errOpt as Option.Some<{ phase?: string; cause?: { phase?: string } }>).value;
		expect(err.phase).toBe('sign');
		// The originating no-digest phase must survive on `cause` so the
		// cause walker can render it distinctly from a generic transport
		// failure (per STYLE_GUIDE §2 phase discipline).
		expect(err.cause?.phase).toBe('no-digest');
	});
});
