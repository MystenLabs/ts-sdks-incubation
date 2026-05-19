// Shape contracts for the `Sui(opts?)` factory. The localnet container
// branch is covered by the integration runs in `examples/wallet` —
// booting a real sui-localnet container under unit tests would just
// turn vitest red on machines without Docker. The other three branches
// (localnet-with-external-rpcUrl, testnet, mainnet, custom) only fetch
// `chainIdentifier` against their `rpcUrl` — we stub the gRPC client's
// chainIdentifier resolver so each test targets configuration logic,
// not protobuf-over-http wire behavior.

import { Cause, Effect, Exit, Layer, Option } from 'effect';
import { layer as NodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem';
import { afterEach, beforeEach, describe, expect, it, vi } from '@effect/vitest';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { EngineLive } from '../engine/engine.js';
import { EndpointRegistryLive, SuiStateRegistryLive } from '../engine/registries.js';
import { Sui, faucetReadyProbe } from './sui.js';

// EndpointRegistry is required by every Sui factory body (publish calls
// for `sui-rpc` / `sui-faucet` / `sui-graphql`). SuiStateRegistry holds
// the chainId published alongside. EngineLive backs the lifecycle wrap
// applied by `provide`.
const TestBaseLayer = Layer.mergeAll(
	EngineLive,
	NodeFileSystemLayer,
	EndpointRegistryLive,
	SuiStateRegistryLive,
);

// Phase -1 (gRPC migration): the Sui factory's chain-id resolution flows
// through `client.core.getChainIdentifier()`, which on `SuiGrpcClient`
// calls `ledgerService.getServiceInfo({})` over protobuf-encoded
// gRPC-web. Stubbing the wire format is fiddly and orthogonal to what
// these tests assert (config plumbing). Instead, intercept the
// constructor and swap `client.core.getChainIdentifier` for a stub.
// `core` is an instance field set in the `SuiGrpcClient` constructor
// (not a prototype getter), so we patch each freshly-constructed
// instance via a `Proxy` on the class. The closure restores the
// original constructor on cleanup.
const STUB_CHAIN_ID = 'test-chain-id';

const stubChainIdFetch = (): (() => void) => {
	const originalCtor = SuiGrpcClient.prototype.constructor;
	const originalGetChainId = (SuiGrpcClient.prototype as unknown as {
		core?: { getChainIdentifier?: unknown };
	}).core?.getChainIdentifier;
	void originalCtor;
	void originalGetChainId;
	// Patch every SuiGrpcClient instance's `core.getChainIdentifier`
	// post-construction by hooking the `core` setter. `core` is
	// assigned via `this.core = new GrpcCoreClient(...)` in the
	// constructor — a Proxy on `Reflect.construct` lets us replace
	// the just-built instance's `core.getChainIdentifier` before the
	// caller sees it.
	const SuiGrpcClientCtor = SuiGrpcClient as unknown as new (...args: unknown[]) => SuiGrpcClient;
	const patched = new Proxy(SuiGrpcClientCtor, {
		construct(target, argArray, newTarget) {
			const instance = Reflect.construct(target, argArray, newTarget) as SuiGrpcClient;
			const coreSlot = instance.core as unknown as {
				getChainIdentifier: () => Promise<{ chainIdentifier: string }>;
			};
			coreSlot.getChainIdentifier = async () => ({ chainIdentifier: STUB_CHAIN_ID });
			return instance;
		},
	});
	// Replace the export at the module level. Because `services/sui.ts`
	// imports `SuiGrpcClient` at load time, we can't swap the binding
	// in place — instead, spy on the prototype's `core` accessor by
	// observing every fresh client constructed through it. Since
	// `core` is assigned in the constructor body, the cleanest path
	// is to spy on `GrpcCoreClient.prototype.getChainIdentifier`.
	void patched;
	// Pull the GrpcCoreClient class off a probe instance.
	const probe = new SuiGrpcClient({
		baseUrl: 'http://__stub__',
		network: 'localnet',
	});
	const grpcCoreProto = Object.getPrototypeOf(probe.core) as {
		getChainIdentifier: () => Promise<{ chainIdentifier: string }>;
	};
	const spy = vi
		.spyOn(grpcCoreProto, 'getChainIdentifier')
		.mockResolvedValue({ chainIdentifier: STUB_CHAIN_ID });
	return () => {
		spy.mockRestore();
	};
};

describe('Sui(opts?) factory shapes', () => {
	it.effect("Sui({ network: 'testnet' }) defaults to the well-known testnet endpoints", () =>
		Effect.gen(function* () {
			const restore = stubChainIdFetch();
			try {
				const member = Sui({ network: 'testnet' });
				const sui = yield* Effect.gen(function* () {
					return yield* member;
				}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));
				expect(sui.network).toBe('testnet');
				expect(sui.rpc.host).toBe('https://fullnode.testnet.sui.io:443');
				expect(sui.faucet?.host).toBe('https://faucet.testnet.sui.io');
				// Live-net handles have no docker presence.
				expect(sui.rpc.container).toBeUndefined();
			} finally {
				restore();
			}
		}),
	);

	it.effect("Sui({ network: 'testnet', testnet: { rpcUrl } }) override wins over the default", () =>
		Effect.gen(function* () {
			const restore = stubChainIdFetch();
			try {
				const member = Sui({
					network: 'testnet',
					testnet: { rpcUrl: 'https://corp.example/sui' },
				});
				const sui = yield* Effect.gen(function* () {
					return yield* member;
				}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));
				expect(sui.rpc.host).toBe('https://corp.example/sui');
			} finally {
				restore();
			}
		}),
	);

	it.effect("Sui({ network: 'mainnet' }) defaults to mainnet rpc with NO faucet", () =>
		Effect.gen(function* () {
			const restore = stubChainIdFetch();
			try {
				const member = Sui({ network: 'mainnet' });
				const sui = yield* Effect.gen(function* () {
					return yield* member;
				}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));
				expect(sui.network).toBe('mainnet');
				expect(sui.rpc.host).toBe('https://fullnode.mainnet.sui.io:443');
				// Mainnet has no faucet — confirming a misconfigured signer can't
				// silently ask mainnet for free tokens.
				expect(sui.faucet).toBeUndefined();
			} finally {
				restore();
			}
		}),
	);

	it.effect('Sui({ network: { rpc } }) carries an explicit RPC through to Sui', () =>
		Effect.gen(function* () {
			const restore = stubChainIdFetch();
			try {
				const member = Sui({ network: { rpc: 'https://forked.example/sui' } });
				const sui = yield* Effect.gen(function* () {
					return yield* member;
				}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));
				// Default custom-network label when the caller doesn't supply one.
				expect(sui.network).toBe('custom');
				expect(sui.rpc.host).toBe('https://forked.example/sui');
			} finally {
				restore();
			}
		}),
	);

	// `waitForTransactionsReady` upgrades the socket-level "Sui ready"
	// gate into a "chain can transfer funds" guarantee for primitives
	// that immediately submit a funds-transferable tx after yielding
	// `SuiTag`. On networks without a faucet the chain is presumed
	// always-transferable (mainnet, custom-without-faucet) so the method
	// short-circuits to `Effect.void` — pinning this avoids regressing
	// into "30s wait on every mainnet read" by accident.
	it.effect("Sui({ network: 'mainnet' }).waitForTransactionsReady() resolves immediately", () =>
		Effect.gen(function* () {
			const restore = stubChainIdFetch();
			try {
				const member = Sui({ network: 'mainnet' });
				const sui = yield* Effect.gen(function* () {
					return yield* member;
				}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));
				// Should resolve without touching the network. If this hangs
				// the test would timeout; success means the no-faucet branch
				// returns `Effect.void` directly.
				yield* sui.waitForTransactionsReady();
			} finally {
				restore();
			}
		}),
	);

	// The localnet-with-external-rpcUrl branch — the user pre-booted
	// their own sui-localnet and just wants devstack to wrap it.
	// `graphqlUrl` is plumbed through when supplied.
	it.effect('Sui({ localnet: { rpcUrl, graphqlUrl } }) surfaces graphqlUrl on SuiTag', () =>
		Effect.gen(function* () {
			const restore = stubChainIdFetch();
			try {
				const member = Sui({
					localnet: {
						rpcUrl: 'http://localhost:9000',
						graphqlUrl: 'http://localhost:9125/graphql',
					},
				});
				const sui = yield* Effect.gen(function* () {
					return yield* member;
				}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));
				expect(sui.faucet).toBeUndefined();
				yield* sui.waitForTransactionsReady();
				expect(sui.network).toBe('localnet');
				expect(sui.rpc.host).toBe('http://localhost:9000');
				expect(sui.graphql?.host).toBe('http://localhost:9125/graphql');
				// Externally-managed RPC: no per-stack docker network, no
				// container-side URL on any endpoint.
				expect(sui.rpc.container).toBeUndefined();
				expect(sui.graphql?.container).toBeUndefined();
			} finally {
				restore();
			}
		}),
	);

	it.effect('Sui({ localnet: { rpcUrl } }) without graphqlUrl leaves it undefined', () =>
		Effect.gen(function* () {
			const restore = stubChainIdFetch();
			try {
				const member = Sui({ localnet: { rpcUrl: 'http://localhost:9000' } });
				const sui = yield* Effect.gen(function* () {
					return yield* member;
				}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));
				expect(sui.graphql).toBeUndefined();
			} finally {
				restore();
			}
		}),
	);

	it.effect('Sui({ network: { rpc } }) without a faucet skips the ready probe', () =>
		Effect.gen(function* () {
			const restore = stubChainIdFetch();
			try {
				const member = Sui({ network: { rpc: 'https://forked.example/sui' } });
				const sui = yield* Effect.gen(function* () {
					return yield* member;
				}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));
				expect(sui.faucet).toBeUndefined();
				yield* sui.waitForTransactionsReady();
			} finally {
				restore();
			}
		}),
	);
});

// `faucetReadyProbe` is the localnet ready gate that prevents the
// supervisor from declaring `SuiTag` "ready" while the underlying
// sui-faucet binary is still in its warm-up window (HTTP socket bound
// but tx pipeline not). During that window the faucet returns 200 OK
// with body `{"status": {"Failure": {"Internal": "..."}}}`, and a probe
// that only checked `response.ok` would let downstream `accounts.fund`
// race ahead and trip the 90s requestFunds timeout every time. These
// tests pin the rejection behavior.

describe('faucetReadyProbe', () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const FAUCET_URL = 'http://localhost:9123';

	it.effect('rejects a 200 OK body with status: { Failure }', () =>
		Effect.gen(function* () {
			globalThis.fetch = (async () =>
				new Response(
					JSON.stringify({
						status: { Failure: { Internal: 'gas object stale' } },
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				)) as typeof fetch;
			const exit = yield* faucetReadyProbe(FAUCET_URL).pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
			// The throw is wrapped twice — once by the inner `throw` and
			// again by `tryPromise`'s `catch` which prepends `faucet: `.
			// Either way the `Failure` substring must reach the user, or
			// the warm-up retry above will never know to keep waiting.
			if (Exit.isFailure(exit)) {
				const opt = Cause.findErrorOption(exit.cause as Cause.Cause<Error>);
				expect(Option.isSome(opt)).toBe(true);
				if (Option.isSome(opt)) {
					expect(opt.value).toBeInstanceOf(Error);
					expect((opt.value as Error).message).toContain('Failure');
				}
			}
		}),
	);

	it.effect('resolves cleanly on a `status: "Success"` body', () =>
		Effect.gen(function* () {
			globalThis.fetch = (async () =>
				new Response(
					JSON.stringify({
						status: 'Success',
						coins_sent: [{ id: '0xdeadbeef', amount: 1_000_000_000 }],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				)) as typeof fetch;
			yield* faucetReadyProbe(FAUCET_URL);
		}),
	);

	it.effect('rejects a non-OK HTTP status (e.g. 503 during boot)', () =>
		Effect.gen(function* () {
			globalThis.fetch = (async () => new Response('not yet', { status: 503 })) as typeof fetch;
			const exit = yield* faucetReadyProbe(FAUCET_URL).pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
		}),
	);
});

describe('EndpointName.SUI_CHECKPOINT_VOLUME (P2.T6)', () => {
	// The constant exists in `endpoint-names.ts` so future indexer wiring
	// can read it. The corresponding sui-side publish is the sui-fork
	// agent's responsibility; this test asserts the name shape only.
	it('uses the conventional name format', async () => {
		const { EndpointName } = await import('../runtime/endpoint-names.js');
		expect(EndpointName.SUI_CHECKPOINT_VOLUME).toBe('sui-checkpoint-volume');
	});
});
