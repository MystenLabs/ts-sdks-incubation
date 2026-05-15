// Integration test for the `Devstack` Effect Service. Stands up the
// registries + Identity, publishes a representative set of records,
// runs `gatherManifest()` (the core logic `DevstackLive` wraps as a
// Layer.effect), and asserts the v4 shape comes back as expected.
//
// We exercise `gatherManifest` directly rather than `yield* Devstack`
// because `Layer.effect(Devstack, gatherManifest())` builds eagerly: by
// the time a test body could seed the registries, the layer has already
// captured an empty snapshot. In real use, seeding happens during the
// acquire of the seeding Refs (which run before Devstack's layer
// builds), so this path matches the runtime semantics one level down.

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
import { gatherManifest } from './service.js';

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
	yield* eps.register({ name: 'sui-rpc', url: 'http://sui.svc-test.localhost:9000', kind: 'rpc' });
	yield* eps.register({
		name: 'sui-faucet',
		url: 'http://faucet.svc-test.localhost:9123',
		kind: 'faucet',
	});
	yield* eps.register({ name: 'wallet-app', url: 'http://wallet.svc-test.localhost:5180' });
	yield* eps.register({
		name: 'walrus-aggregator',
		url: 'http://aggregator.svc-test.localhost:9185',
	});
	yield* eps.register({
		name: 'walrus-publisher',
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
});
