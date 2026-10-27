import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Option } from 'effect';

import { bootLiveMode } from '../../../src/plugins/sui/mode/live.ts';
import { bootLocalRpcMode } from '../../../src/plugins/sui/mode/external.ts';
import { assembleSuiClient } from '../../../src/plugins/sui/mode/shared-boot.ts';

// Regression: `assembleSuiClient`'s empty-chain guard must surface on the
// TYPED (`SuiConfigError`) channel — NOT as a defect. The guard used to be
// a synchronous `expectNonEmptyString(...)` throw inside the mode-boot
// `Effect.gen` bodies, which Effect turns into a DEFECT (a `Die`, not a
// `Fail`). A caller-pinned empty chain (`.live.custom({ chain: '' })` /
// `local-rpc` with `chain: ''`) short-circuits the `opts.chain ?? probe`
// and reaches assembly verbatim, so the crash was user-reachable.
//
// The assertions distinguish Fail from Die explicitly (Effect v4 beta
// `Cause` API): `Cause.findErrorOption` yields the value ONLY for the
// typed channel, and `Cause.hasDies` is asserted false. Under the old
// sync-throw code the failure surfaced as a Die, so `findErrorOption`
// would be `None` and `hasDies` would be `true` — failing this test. The
// end-to-end cases additionally prove `catchTag` recovers it (a `catchTag`
// never fires on a defect).

// A stand-in gRPC client. `assembleSuiClient`'s empty-chain guard fires
// before the client is ever touched, so a bare object is sufficient.
const fakeSdkClient = {} as never;

const fakeWaitForTransactionsReady = {
	wait: Effect.void,
	invalidate: Effect.void,
};

describe('assembleSuiClient empty-chain guard', () => {
	it.effect('fails on the SuiConfigError channel (not a defect) for an empty chain', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				assembleSuiClient({
					sdkClient: fakeSdkClient,
					chainId: '',
					rpcUrl: 'http://127.0.0.1:9000',
					waitForTransactionsReady: fakeWaitForTransactionsReady,
				}),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				// Typed failure present...
				const failure = Cause.findErrorOption(exit.cause);
				expect(Option.isSome(failure)).toBe(true);
				if (Option.isSome(failure)) {
					expect(failure.value._tag).toBe('SuiConfigError');
					expect(failure.value.field).toBe('chainId');
				}
				// ...and emphatically NOT a defect (the pre-fix behaviour).
				expect(Cause.hasDies(exit.cause)).toBe(false);
			}
		}),
	);

	it.effect('produces a real SuiClient for a non-empty chain', () =>
		Effect.gen(function* () {
			const { client, chainProbe } = yield* assembleSuiClient({
				sdkClient: fakeSdkClient,
				chainId: 'sui:devnet-aabbcc',
				rpcUrl: 'http://127.0.0.1:9000',
				waitForTransactionsReady: fakeWaitForTransactionsReady,
			});
			expect(client.chainId).toBe('sui:devnet-aabbcc');
			expect(client.rpcUrl).toBe('http://127.0.0.1:9000');
			expect(client.fork).toBeNull();
			// The probe is constructed and keyed off the branded chain.
			expect(typeof chainProbe.get).toBe('function');
		}),
	);
});

describe('mode boot empty-chain pin reaches the typed channel end-to-end', () => {
	// Drives the REAL `bootLiveMode` path. `network: 'custom'` + `chain: ''`
	// + no `faucetUrl` performs no network I/O: the chain-id probe is
	// short-circuited by `opts.chain ?? ...` and the funds-ready gate is the
	// no-op. So the boot reaches `assembleSuiClient('')` and must fail typed,
	// proving the un-yielded sync-throw can no longer escape as a defect.
	it.effect('bootLiveMode custom({ chain: "" }) fails with a catchable SuiConfigError', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				Effect.scoped(
					bootLiveMode({
						mode: 'live',
						network: 'custom',
						rpcUrl: 'http://127.0.0.1:9000',
						chainId: '',
					}),
				),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				expect(Cause.hasDies(exit.cause)).toBe(false);
				const failure = Cause.findErrorOption(exit.cause);
				expect(Option.isSome(failure)).toBe(true);
				if (Option.isSome(failure)) {
					expect(failure.value._tag).toBe('SuiConfigError');
				}
			}

			// And it is recoverable via `catchTag` — the contract the boot
			// channel promises (it would never fire on a defect).
			const recovered = yield* Effect.scoped(
				bootLiveMode({
					mode: 'live',
					network: 'custom',
					rpcUrl: 'http://127.0.0.1:9000',
					chainId: '',
				}),
			).pipe(Effect.catchTag('SuiConfigError', (e) => Effect.succeed(e.field)));
			expect(recovered).toBe('chainId');
		}),
	);

	it.effect('bootLocalRpcMode({ chain: "" }) fails with a catchable SuiConfigError', () =>
		Effect.gen(function* () {
			const recovered = yield* Effect.scoped(
				bootLocalRpcMode({
					mode: 'local-rpc',
					rpcUrl: 'http://127.0.0.1:9000',
					chainId: '',
				}),
			).pipe(
				Effect.map(() => 'boot-unexpectedly-succeeded'),
				Effect.catchTag('SuiConfigError', (e) => Effect.succeed(`config:${e.field}`)),
			);
			expect(recovered).toBe('config:chainId');
		}),
	);
});

describe('assembleSuiClient graphqlHeaders', () => {
	const base = {
		sdkClient: fakeSdkClient,
		chainId: 'sui:custom-aabbcc',
		rpcUrl: 'http://127.0.0.1:9000',
		waitForTransactionsReady: fakeWaitForTransactionsReady,
	};

	it.effect('carries configured headers on the resolved client', () =>
		Effect.gen(function* () {
			const { client } = yield* assembleSuiClient({
				...base,
				graphqlUrl: 'https://graphql.example/graphql',
				graphqlHeaders: { authorization: 'Bearer t0ken' },
			});
			expect(client.graphqlUrl).toBe('https://graphql.example/graphql');
			expect(client.graphqlHeaders).toEqual({ authorization: 'Bearer t0ken' });
		}),
	);

	it.effect('defaults to no headers', () =>
		Effect.gen(function* () {
			const { client } = yield* assembleSuiClient(base);
			expect(client.graphqlHeaders).toEqual({});
		}),
	);

	it.effect('rejects headers without a GraphQL endpoint on the typed channel', () =>
		Effect.gen(function* () {
			const field = yield* assembleSuiClient({
				...base,
				graphqlHeaders: { authorization: 'Bearer t0ken' },
			}).pipe(
				Effect.map(() => 'unexpected-success'),
				Effect.catchTag('SuiConfigError', (e) => Effect.succeed(e.field)),
			);
			expect(field).toBe('graphqlHeaders');
		}),
	);

	it.effect('never echoes a rejected header value (a credential) in the error', () =>
		Effect.gen(function* () {
			const error = yield* assembleSuiClient({
				...base,
				graphqlUrl: 'https://graphql.example/graphql',
				graphqlHeaders: { authorization: 'Bearer t0ken\ninjected' },
			}).pipe(Effect.flip);
			expect(error._tag).toBe('SuiConfigError');
			expect(JSON.stringify(error)).not.toContain('t0ken');
		}),
	);

	it.effect('rejects an invalid header name on the typed channel', () =>
		Effect.gen(function* () {
			const field = yield* assembleSuiClient({
				...base,
				graphqlUrl: 'https://graphql.example/graphql',
				graphqlHeaders: { 'bad header': 'x' },
			}).pipe(
				Effect.map(() => 'unexpected-success'),
				Effect.catchTag('SuiConfigError', (e) => Effect.succeed(e.field)),
			);
			expect(field).toBe('graphqlHeaders');
		}),
	);

	it.effect('bootLocalRpcMode threads graphqlHeaders onto the client', () =>
		Effect.gen(function* () {
			// `chainId` pinned + no faucet → no network I/O.
			const { client, resolved } = yield* Effect.scoped(
				bootLocalRpcMode({
					mode: 'local-rpc',
					rpcUrl: 'http://127.0.0.1:9000',
					graphqlUrl: 'https://graphql.example/graphql',
					graphqlHeaders: { 'x-api-key': 'k' },
					chainId: 'sui:custom-aabbcc',
				}),
			);
			expect(client.graphqlHeaders).toEqual({ 'x-api-key': 'k' });
			// Never reaches the codegen-facing projection.
			expect(JSON.stringify(resolved)).not.toContain('x-api-key');
		}),
	);

	it.effect('bootLiveMode threads graphqlHeaders onto the client', () =>
		Effect.gen(function* () {
			const { client } = yield* Effect.scoped(
				bootLiveMode({
					mode: 'live',
					network: 'custom',
					rpcUrl: 'http://127.0.0.1:9000',
					graphqlUrl: 'https://graphql.example/graphql',
					graphqlHeaders: { authorization: 'Bearer t0ken' },
					chainId: 'sui:custom-aabbcc',
				}),
			);
			expect(client.graphqlHeaders).toEqual({ authorization: 'Bearer t0ken' });
		}),
	);
});
