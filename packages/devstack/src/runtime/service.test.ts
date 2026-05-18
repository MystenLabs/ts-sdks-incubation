// Integration test for the `Devstack` Effect Service. Stands up the
// registries + Identity, publishes a representative set of records,
// runs `gatherManifest()` (the core logic `DevstackLive` wraps as a
// Layer.succeed-of-thunk) and asserts the v4 shape comes back as
// expected.
//
// `Devstack` is now non-eager: `yield* Devstack` returns a `{current()}`
// thunk that re-gathers on demand. The `late registration` test below
// covers the supervisor's real-world acquire order — registries seeded
// AFTER the Devstack layer built still surface through `current()`.

import { Effect, Layer } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { Identity } from '../engine/identity.js';
import {
	AccountRegistry,
	AccountRegistryLive,
	CoinRegistry,
	CoinRegistryLive,
	EndpointRegistry,
	EndpointRegistryLive,
	PackageRegistry,
	PackageRegistryLive,
} from '../engine/registries.js';
import { EndpointName } from './endpoint-names.js';
import { Devstack, DevstackLive, gatherManifest } from './service.js';

const IdentityLive = Layer.succeed(Identity, {
	app: 'svc-test',
	stack: 'main',
	network: 'localnet',
});

// Manually-seeded registries — we don't need the engine for this test.
const seedAll = Effect.gen(function* () {
	const pkgs = yield* PackageRegistry;
	const eps = yield* EndpointRegistry;
	const accts = yield* AccountRegistry;
	const coins = yield* CoinRegistry;
	yield* pkgs.register({
		name: 'hello',
		packageId: '0xabc',
		mvrPlaceholder: '@local/hello',
		captured: { treasuryCap: '0x111' },
	});
	yield* eps.register({
		name: EndpointName.SUI_RPC,
		url: 'http://sui.svc-test.localhost:9000',
		kind: 'rpc',
	});
	yield* eps.register({
		name: EndpointName.SUI_FAUCET,
		url: 'http://faucet.svc-test.localhost:9123',
		kind: 'faucet',
	});
	yield* eps.register({
		name: EndpointName.WALLET_APP,
		url: 'http://wallet.svc-test.localhost:5180',
	});
	yield* eps.register({
		name: EndpointName.WALRUS_AGGREGATOR,
		url: 'http://aggregator.svc-test.localhost:9185',
	});
	yield* eps.register({
		name: EndpointName.WALRUS_PUBLISHER,
		url: 'http://publisher.svc-test.localhost:9186',
	});
	yield* accts.register({ name: 'alice', address: '0x1' });
	yield* coins.register({
		name: 'musdc',
		type: '0xabc::usdc::USDC',
		decimals: 6,
		sdkCoin: { address: '0xabc', type: 'usdc::USDC', scalar: 1_000_000 },
	});
});

const RegistriesLive = Layer.mergeAll(
	PackageRegistryLive,
	EndpointRegistryLive,
	AccountRegistryLive,
	CoinRegistryLive,
);

describe('Devstack service — gatherManifest', () => {
	it.effect('builds a v4 snapshot from seeded registries', () =>
		Effect.gen(function* () {
			yield* seedAll;
			const ds = yield* gatherManifest();

			expect(ds.version).toBe(4);
			expect(ds.stack).toEqual({ name: 'main', network: 'localnet', app: 'svc-test' });

			expect(ds.services.sui?.rpc.url).toBe('http://sui.svc-test.localhost:9000');
			expect(ds.services.sui?.faucet?.url).toBe('http://faucet.svc-test.localhost:9123');
			expect(ds.services.sui?.network).toBe('localnet');
			expect(ds.services.walrus).toEqual({
				aggregator: { url: 'http://aggregator.svc-test.localhost:9185' },
				publisher: { url: 'http://publisher.svc-test.localhost:9186' },
			});
			expect(ds.services.seal).toBeUndefined();

			expect(ds.packages.hello).toEqual({
				id: '0xabc',
				mvr: '@local/hello',
				captured: { treasuryCap: '0x111' },
			});

			expect(ds.accounts.alice).toEqual({ address: '0x1' });

			expect(ds.coins.musdc?.type).toBe('0xabc::usdc::USDC');
			expect(ds.coins.musdc?.decimals).toBe(6);

			expect(ds.app.wallet?.url).toBe('http://wallet.svc-test.localhost:5180');
			expect(ds.app.dev).toBeUndefined();
		}).pipe(Effect.provide(Layer.mergeAll(RegistriesLive, IdentityLive))),
	);

	it.effect('omits services.sui when no sui-rpc endpoint is registered', () =>
		Effect.gen(function* () {
			const ds = yield* gatherManifest();
			expect(ds.services.sui).toBeUndefined();
			expect(ds.services.walrus).toBeUndefined();
			expect(ds.app.extras).toEqual({});
		}).pipe(Effect.provide(Layer.mergeAll(RegistriesLive, IdentityLive))),
	);

	it.effect('passes the extras argument through to app.extras', () =>
		Effect.gen(function* () {
			const ds = yield* gatherManifest({ openLobbyId: '0xab' });
			expect(ds.app.extras).toEqual({ openLobbyId: '0xab' });
		}).pipe(Effect.provide(Layer.mergeAll(RegistriesLive, IdentityLive))),
	);

	// HIGH-C6 regression: `Devstack.current()` must reflect registries
	// seeded AFTER `DevstackLive` builds. The previous shape eagerly
	// captured a snapshot at layer-build time, so any service registered
	// later (the wallet primitive's endpoint, an Action's lazy captured
	// id) was invisible to downstream `yield* Devstack` consumers.
	it.effect('current() reflects late eps.register calls', () =>
		Effect.gen(function* () {
			const dev = yield* Devstack;
			// Build-time: registries are empty. The thunk must NOT have
			// captured this state.
			const empty = yield* dev.current();
			expect(empty.services.sui).toBeUndefined();
			expect(empty.app.wallet).toBeUndefined();

			// Late registration — after `yield* Devstack` already
			// resolved, before any `current()` consumer sees it.
			const eps = yield* EndpointRegistry;
			yield* eps.register({
				name: EndpointName.SUI_RPC,
				url: 'http://sui.svc-test.localhost:9000',
				kind: 'rpc',
			});
			yield* eps.register({
				name: EndpointName.WALLET_APP,
				url: 'http://wallet.svc-test.localhost:5180',
			});

			const refreshed = yield* dev.current();
			expect(refreshed.services.sui?.rpc.url).toBe('http://sui.svc-test.localhost:9000');
			expect(refreshed.app.wallet?.url).toBe('http://wallet.svc-test.localhost:5180');
		}).pipe(Effect.provide(Layer.mergeAll(DevstackLive, RegistriesLive, IdentityLive))),
	);
});

// Lock down the EndpointName string values so a typo in
// `runtime/endpoint-names.ts` would surface here. The manifest grouping
// (above) reads through the constants, but every external consumer
// (codegen emitters' downstream readers, playwright e2e tests, the
// on-disk manifest schema) keys off the literal string — a silent
// rename would split the producer half from the consumer half.
describe('EndpointName constants', () => {
	it('match the canonical registry string values', () => {
		expect(EndpointName.SUI_RPC).toBe('sui-rpc');
		expect(EndpointName.SUI_FAUCET).toBe('sui-faucet');
		expect(EndpointName.SUI_GRAPHQL).toBe('sui-graphql');
		expect(EndpointName.SUI_INDEXER_DB).toBe('sui-indexer-db');
		expect(EndpointName.WALLET_APP).toBe('wallet-app');
		expect(EndpointName.DEV_SERVER_PRIMARY).toBe('frontend.dev-server');
		expect(EndpointName.DEV_SERVER_FALLBACK).toBe('dev-server');
		expect(EndpointName.SEAL_KEY_SERVER).toBe('seal-key-server');
		expect(EndpointName.WALRUS_AGGREGATOR).toBe('walrus-aggregator');
		expect(EndpointName.WALRUS_PUBLISHER).toBe('walrus-publisher');
	});
});
