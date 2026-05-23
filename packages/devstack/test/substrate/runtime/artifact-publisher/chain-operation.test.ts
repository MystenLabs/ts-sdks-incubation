// ChainOperation typed seam — compile + dispatch tests.

import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	compileChainOperation,
	type ChainOperation,
	type ResolvedSigner,
} from '../../../../src/substrate/runtime/artifact-publisher/chain-operation.ts';

interface Produced {
	readonly digest: string;
	readonly via: 'sui-tx' | 'shell-oneshot' | 'register-only';
}

describe('compileChainOperation', () => {
	it.effect('sui-tx variant runs executor + parse and returns Produced', () =>
		Effect.gen(function* () {
			let signerCalled = false;
			let buildCalled = false;
			let parseCalled = false;
			const signer: ResolvedSigner = {
				name: 'alice',
				address: '0xa11ce',
				signTransaction: () =>
					Effect.sync(() => {
						signerCalled = true;
						return { bytes: 'b', signature: 's' };
					}),
				withTransactionSigner: (body) =>
					body({
						signTransaction: () =>
							Effect.sync(() => {
								signerCalled = true;
								return { bytes: 'b', signature: 's' };
							}),
					}),
			};
			const op: ChainOperation<Produced> = {
				_tag: 'sui-tx',
				build: () => {
					buildCalled = true;
				},
				signer,
				executor: () => Effect.succeed({ digest: '0xdead', stub: true }),
				parse: (effects) =>
					Effect.sync(() => {
						parseCalled = true;
						const e = effects as { readonly digest: string };
						return { digest: e.digest, via: 'sui-tx' as const };
					}),
			};
			const result = yield* Effect.scoped(compileChainOperation(op));
			expect(result.digest).toBe('0xdead');
			expect(result.via).toBe('sui-tx');
			// build callback is invoked at the call-site of the executor;
			// in this test the executor is a stub so build is never called.
			expect(buildCalled).toBe(false);
			expect(signerCalled).toBe(false);
			expect(parseCalled).toBe(true);
		}),
	);

	it.effect('shell-oneshot variant runs runner + parse and returns Produced', () =>
		Effect.gen(function* () {
			const op: ChainOperation<Produced> = {
				_tag: 'shell-oneshot',
				spec: { image: 'walrus:latest', argv: ['register-known'] },
				runner: () => Effect.succeed('digest=0xbeef\n'),
				parse: (stdout) =>
					Effect.sync(() => ({
						digest: stdout.match(/digest=([0-9a-fx]+)/)?.[1] ?? '',
						via: 'shell-oneshot' as const,
					})),
			};
			const result = yield* Effect.scoped(compileChainOperation(op));
			expect(result.digest).toBe('0xbeef');
			expect(result.via).toBe('shell-oneshot');
		}),
	);

	it.effect('register-only variant yields the pre-resolved Produced', () =>
		Effect.gen(function* () {
			const op: ChainOperation<Produced> = {
				_tag: 'register-only',
				produced: Effect.succeed({ digest: '0xcafe', via: 'register-only' as const }),
			};
			const result = yield* Effect.scoped(compileChainOperation(op));
			expect(result).toEqual({ digest: '0xcafe', via: 'register-only' });
		}),
	);

	it.effect('sui-tx executor failures propagate verbatim', () =>
		Effect.gen(function* () {
			const op: ChainOperation<Produced> = {
				_tag: 'sui-tx',
				build: () => {},
				signer: {
					name: 'alice',
					address: '0xa11ce',
					signTransaction: () => Effect.succeed({ bytes: '', signature: '' }),
					withTransactionSigner: (body) =>
						body({
							signTransaction: () => Effect.succeed({ bytes: '', signature: '' }),
						}),
				},
				executor: () =>
					Effect.fail({
						_tag: 'ArtifactPublishError' as const,
						reason: 'produce-failed' as const,
						detail: 'simulated executor failure',
					}),
				parse: () =>
					Effect.fail({
						_tag: 'ArtifactPublishError' as const,
						reason: 'produce-failed' as const,
						detail: 'parse not reached',
					}),
			};
			const exit = yield* Effect.scoped(Effect.exit(compileChainOperation(op)));
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const value = exit.cause;
				// The executor's typed error reaches the consumer
				// verbatim — no substrate-side wrap.
				const failures = JSON.stringify(value);
				expect(failures).toContain('simulated executor failure');
			}
		}),
	);
});
