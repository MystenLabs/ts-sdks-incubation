// Integration test for `gatherManifest`. Stands up the registries +
// Identity, publishes a representative set of records, runs
// `gatherManifest()` and asserts the v5 shape comes back as expected.

import { Effect, Layer } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { Identity } from '../engine/identity.js';
import {
	AccountRegistry,
	AccountRegistryLive,
	CoinRegistry,
	CoinRegistryLive,
	DeepbookIndexerStateRegistryLive,
	DeepbookMarginStateRegistryLive,
	DeepbookServerStateRegistryLive,
	DeepbookStateRegistryLive,
	EndpointRegistry,
	EndpointRegistryLive,
	PackageRegistry,
	PackageRegistryLive,
	PostgresStateRegistryLive,
	publishPostgresState,
	PythStateRegistryLive,
	SealStateRegistryLive,
	SuiStateRegistryLive,
	WalrusStateRegistryLive,
} from '../engine/registries.js';
import { EndpointName } from './endpoint-names.js';
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
	SuiStateRegistryLive,
	SealStateRegistryLive,
	WalrusStateRegistryLive,
	DeepbookStateRegistryLive,
	PythStateRegistryLive,
	PostgresStateRegistryLive,
	DeepbookIndexerStateRegistryLive,
	DeepbookServerStateRegistryLive,
	DeepbookMarginStateRegistryLive,
);

describe('gatherManifest', () => {
	it.effect('builds a v5 snapshot from seeded registries', () =>
		Effect.gen(function* () {
			yield* seedAll;
			const ds = yield* gatherManifest();

			expect(ds.version).toBe(5);
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

	// HIGH-C6 regression: subsequent `gatherManifest()` calls must
	// reflect registries seeded AFTER prior calls. Each call walks the
	// live registries fresh; the manifest emitter's slow-tick re-snapshot
	// relies on this property to surface late-registered services (the
	// wallet primitive's endpoint, an Action's lazy captured id).
	it.effect('gatherManifest reflects late eps.register calls', () =>
		Effect.gen(function* () {
			// First call: registries are empty.
			const empty = yield* gatherManifest();
			expect(empty.services.sui).toBeUndefined();
			expect(empty.app.wallet).toBeUndefined();

			// Late registration — after the first snapshot already ran.
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

			const refreshed = yield* gatherManifest();
			expect(refreshed.services.sui?.rpc.url).toBe('http://sui.svc-test.localhost:9000');
			expect(refreshed.app.wallet?.url).toBe('http://wallet.svc-test.localhost:5180');
		}).pipe(Effect.provide(Layer.mergeAll(RegistriesLive, IdentityLive))),
	);

	// Wave-2 invariant: the manifest's postgres endpoint URL must be
	// plain (no `<user>:<password>@` segment). The split lives at the
	// registry-shape level — `PostgresStateRecord.endpoint` is
	// guaranteed plain by construction, so the grouper has nothing to
	// strip. A regression here would mean someone re-introduced the
	// credentialed URL in the state record.
	it.effect('manifest postgres endpoint URL never contains credentials', () =>
		Effect.gen(function* () {
			yield* publishPostgresState({
				name: 'postgres',
				user: 'devstack',
				password: 'pgcred-secret',
				endpoint: 'postgres://postgres-main:5432',
				containerNetwork: 'devstack-app-main-postgres',
				networkAlias: 'postgres-main',
				databases: ['deepbook'],
			});

			const ds = yield* gatherManifest();
			const url = ds.services.postgres?.endpoint.url;
			expect(url).toBeDefined();
			expect(url).not.toContain('@');
			expect(url).not.toContain('pgcred-secret');
		}).pipe(Effect.provide(Layer.mergeAll(RegistriesLive, IdentityLive))),
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
		expect(EndpointName.SEAL_KEY_SERVER).toBe('seal-key-server');
		expect(EndpointName.WALRUS_AGGREGATOR).toBe('walrus-aggregator');
		expect(EndpointName.WALRUS_PUBLISHER).toBe('walrus-publisher');
	});
});
