// signAndDispatch — focused unit tests for the substrate-side
// boilerplate compactor at
// `src/substrate/runtime/sui-execute/sign-and-dispatch.ts`.
//
// What this pins:
//
//   1. onSuccess branch — a `$kind:'Transaction'` envelope flows back
//      via `Effect.succeed` and the dispatch closure receives the
//      generic `TxOk` directly.
//   2. onFailed branch — a `$kind:'FailedTransaction'` envelope drives
//      `onFailed`; the dispatch's typed failure surfaces on the helper
//      error channel.
//   3. mapSignError branch — when the signer's `signAndExecute` fails
//      (an Effect.fail from the locked-signer surface), `mapSignError`
//      runs BEFORE any outer `Effect.catch` in the calling context,
//      so the helper's failure channel surfaces the MAPPED domain
//      error (the raw underlying sign error never reaches the
//      caller).
//   4. Generic variance over `TxOk` — the helper threads two different
//      `TxOk` shapes (a narrow `{digest}` and a widened
//      `{digest, balanceChanges}`) so the generic compiles + the
//      onSuccess callback receives the precise shape it declared.

import { Cause, Effect, Exit, Option } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	signAndDispatch,
	type SignAndDispatchResult,
	type SignAndDispatchSigner,
	type TransactionSignerSource,
} from '../../../../src/substrate/runtime/sui-execute/sign-and-dispatch.ts';

// ---------------------------------------------------------------------------
// Test-only error tags — match the real plugin pattern (callers wrap
// the raw sign error into their domain taxonomy before the dispatch
// callbacks fire).
// ---------------------------------------------------------------------------

class RawSignError {
	readonly _tag = 'RawSignError';
	constructor(readonly reason: string) {}
}
class DomainSignError {
	readonly _tag = 'DomainSignError';
	constructor(readonly cause: RawSignError) {}
}
class OnFailedError {
	readonly _tag = 'OnFailedError';
	constructor(readonly digest: string) {}
}

// ---------------------------------------------------------------------------
// Fake signer source — minimal slice of `TransactionSignerSource`.
// `signAndExecuteImpl` is the per-test response; `events` (when
// supplied) traces ordering for the mapError-before-catch assertion.
// ---------------------------------------------------------------------------

interface FakeSignerOpts<TxOk extends { readonly digest: string }> {
	readonly signAndExecuteImpl: (
		tx: Uint8Array,
	) => Effect.Effect<SignAndDispatchResult<TxOk>, RawSignError>;
	readonly events?: string[];
}

const fakeSignerSource = <TxOk extends { readonly digest: string }>(
	opts: FakeSignerOpts<TxOk>,
): TransactionSignerSource<RawSignError, TxOk> => ({
	withTransactionSigner: (body) => {
		const locked: SignAndDispatchSigner<RawSignError, TxOk> = {
			signAndExecute: (tx) =>
				Effect.gen(function* () {
					opts.events?.push('sign+execute');
					return yield* opts.signAndExecuteImpl(tx);
				}),
		};
		if (opts.events === undefined) return body(locked);
		return Effect.gen(function* () {
			opts.events!.push('scope:enter');
			return yield* body(locked);
		}).pipe(Effect.ensuring(Effect.sync(() => opts.events!.push('scope:exit'))));
	},
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('signAndDispatch', () => {
	it.effect('onSuccess branch — Transaction envelope flows back via Effect.succeed', () =>
		Effect.gen(function* () {
			interface NarrowReceipt {
				readonly digest: string;
			}
			const signerSource = fakeSignerSource<NarrowReceipt>({
				signAndExecuteImpl: () =>
					Effect.succeed({
						$kind: 'Transaction',
						Transaction: { digest: '0xfeed' },
					}),
			});
			const result = yield* signAndDispatch({
				signerSource,
				buildTxBytes: () => Effect.succeed(new Uint8Array([1, 2, 3])),
				mapSignError: (cause: RawSignError) => new DomainSignError(cause),
				onFailed: (failure) => Effect.fail(new OnFailedError(failure.digest)),
				onSuccess: (ok: NarrowReceipt) => Effect.succeed({ ok: true as const, digest: ok.digest }),
			});
			expect(result).toEqual({ ok: true, digest: '0xfeed' });
		}),
	);

	it.effect('onFailed branch — FailedTransaction envelope drives onFailed and propagates', () =>
		Effect.gen(function* () {
			const signerSource = fakeSignerSource({
				signAndExecuteImpl: () =>
					Effect.succeed({
						$kind: 'FailedTransaction',
						FailedTransaction: { digest: '0xbad', executionError: 'MoveAbort(0)' },
					}),
			});
			const exit = yield* Effect.exit(
				signAndDispatch({
					signerSource,
					buildTxBytes: () => Effect.succeed(new Uint8Array()),
					mapSignError: (cause: RawSignError) => new DomainSignError(cause),
					onFailed: (failure) => Effect.fail(new OnFailedError(failure.digest)),
					onSuccess: () => Effect.die('onSuccess should not run on FailedTransaction'),
				}),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const text = JSON.stringify(exit);
				expect(text).toContain('OnFailedError');
				expect(text).toContain('0xbad');
			}
		}),
	);

	it.effect('mapSignError branch — raw sign-error is projected to the typed domain error', () =>
		Effect.gen(function* () {
			const events: string[] = [];
			const signerSource = fakeSignerSource({
				events,
				signAndExecuteImpl: () => Effect.fail(new RawSignError('sign-refused')),
			});
			const exit = yield* Effect.exit(
				signAndDispatch({
					signerSource,
					buildTxBytes: () => Effect.succeed(new Uint8Array()),
					mapSignError: (cause) => {
						events.push('mapSignError');
						return new DomainSignError(cause);
					},
					onFailed: () => Effect.die('onFailed should not run when sign fails'),
					onSuccess: () => Effect.die('onSuccess should not run when sign fails'),
				}),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const text = JSON.stringify(exit);
				expect(text).toContain('DomainSignError');
				// The RAW underlying class name survives via the `cause`
				// field — the helper does not strip it; it just wraps.
				expect(text).toContain('RawSignError');
				expect(text).toContain('sign-refused');
			}
			// Ordering: scope opened, sign+execute ran, mapSignError fired
			// before scope exit. mapSignError MUST run BEFORE the scope's
			// finalizer so the caller sees the typed error from inside
			// any outer Effect.catch.
			expect(events).toEqual(['scope:enter', 'sign+execute', 'mapSignError', 'scope:exit']);
		}),
	);

	it.effect(
		'mapError ordering — outer Effect.catch sees the MAPPED domain error, not the raw cause',
		() =>
			Effect.gen(function* () {
				const signerSource = fakeSignerSource({
					signAndExecuteImpl: () => Effect.fail(new RawSignError('sign-refused')),
				});
				// Wrap signAndDispatch in an outer catch — the caught
				// value's `_tag` must be the projected `DomainSignError`,
				// proving `args.mapSignError` runs BEFORE the outer
				// catch.
				const exit = yield* Effect.exit(
					signAndDispatch({
						signerSource,
						buildTxBytes: () => Effect.succeed(new Uint8Array()),
						mapSignError: (cause) => new DomainSignError(cause),
						onFailed: () => Effect.die('unreachable'),
						onSuccess: () => Effect.die('unreachable'),
					}),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					const failure = Cause.findErrorOption(exit.cause);
					expect(Option.isSome(failure)).toBe(true);
					if (Option.isSome(failure)) {
						const caught = failure.value;
						expect(caught).toBeInstanceOf(DomainSignError);
						if (caught instanceof DomainSignError) {
							expect(caught._tag).toBe('DomainSignError');
							expect(caught.cause).toBeInstanceOf(RawSignError);
							expect(caught.cause.reason).toBe('sign-refused');
						}
					}
				}
			}),
	);

	it.effect('generic variance — narrow TxOk shape ({digest}) threads through onSuccess', () =>
		Effect.gen(function* () {
			interface NarrowReceipt {
				readonly digest: string;
			}
			const signerSource = fakeSignerSource<NarrowReceipt>({
				signAndExecuteImpl: () =>
					Effect.succeed({
						$kind: 'Transaction',
						Transaction: { digest: '0xnarrow' },
					}),
			});
			const out = yield* signAndDispatch({
				signerSource,
				buildTxBytes: () => Effect.succeed(new Uint8Array()),
				mapSignError: (cause: RawSignError) => new DomainSignError(cause),
				onFailed: (failure) => Effect.fail(new OnFailedError(failure.digest)),
				onSuccess: (ok: NarrowReceipt) => Effect.succeed(ok.digest),
			});
			expect(out).toBe('0xnarrow');
		}),
	);

	it.effect(
		'generic variance — widened TxOk ({digest, balanceChanges}) threads through onSuccess',
		() =>
			Effect.gen(function* () {
				interface WideReceipt {
					readonly digest: string;
					readonly balanceChanges: ReadonlyArray<{
						readonly owner: string;
						readonly amount: bigint;
					}>;
				}
				const signerSource = fakeSignerSource<WideReceipt>({
					signAndExecuteImpl: () =>
						Effect.succeed({
							$kind: 'Transaction',
							Transaction: {
								digest: '0xwide',
								balanceChanges: [{ owner: '0xa', amount: 100n }],
							},
						}),
				});
				const out = yield* signAndDispatch({
					signerSource,
					buildTxBytes: () => Effect.succeed(new Uint8Array()),
					mapSignError: (cause: RawSignError) => new DomainSignError(cause),
					onFailed: (failure) => Effect.fail(new OnFailedError(failure.digest)),
					onSuccess: (ok: WideReceipt) =>
						Effect.succeed({
							digest: ok.digest,
							firstOwner: ok.balanceChanges[0]?.owner,
							firstAmount: ok.balanceChanges[0]?.amount,
						}),
				});
				expect(out).toEqual({
					digest: '0xwide',
					firstOwner: '0xa',
					firstAmount: 100n,
				});
			}),
	);

	it.effect('buildTxBytes failure surfaces verbatim on the BuildError channel', () =>
		Effect.gen(function* () {
			class BuildExploded {
				readonly _tag = 'BuildExploded';
				constructor(readonly message: string) {}
			}
			const signerSource = fakeSignerSource({
				signAndExecuteImpl: () => Effect.die('signAndExecute should not run'),
			});
			const exit = yield* Effect.exit(
				signAndDispatch({
					signerSource,
					buildTxBytes: () => Effect.fail(new BuildExploded('boom')),
					mapSignError: (cause: RawSignError) => new DomainSignError(cause),
					onFailed: (failure) => Effect.fail(new OnFailedError(failure.digest)),
					onSuccess: () => Effect.die('unreachable'),
				}),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const text = JSON.stringify(exit);
				expect(text).toContain('BuildExploded');
				expect(text).toContain('boom');
			}
		}),
	);
});
