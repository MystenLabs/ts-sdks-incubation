// Tests for `fromManifest()` — v3 → v4 in-memory migration and v4
// pass-through.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromManifest, migrateV3ToV4 } from './manifest-loader.js';
import type { Manifest } from './manifest-schema.js';

describe('fromManifest — v4 pass-through', () => {
	it('returns a v4 manifest unchanged', () => {
		const m: Manifest = {
			version: 4,
			stack: { name: 'main', network: 'localnet', app: 'hello' },
			services: {
				sui: {
					network: 'localnet',
					rpc: { url: 'http://sui.hello.localhost:9000' },
				},
			},
			packages: { hello: { id: '0xabc', captured: {} } },
			accounts: { alice: { address: '0x123' } },
			coins: {},
			app: { extras: {} },
		};
		expect(fromManifest(m)).toEqual(m);
	});

	it('throws on a non-object input', () => {
		expect(() => fromManifest(null)).toThrow(TypeError);
		expect(() => fromManifest('foo')).toThrow(TypeError);
		expect(() => fromManifest(42)).toThrow(TypeError);
	});
});

describe('fromManifest — forward-compat (version > EXPECTED_VERSION)', () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it('best-effort decodes a newer manifest version with a warning by default', () => {
		const v5: unknown = {
			version: 5,
			stack: { name: 'main', network: 'localnet', app: 'hello' },
			services: {
				sui: {
					network: 'localnet',
					rpc: { url: 'http://sui.hello.localhost:9000' },
				},
			},
			packages: { hello: { id: '0xabc', captured: {} } },
			accounts: {},
			coins: {},
			app: { extras: {} },
			// A field the v4 reader doesn't know about — should ride
			// along on the returned object but be ignored by typed reads.
			newSection: { somethingNew: true },
		};
		const m = fromManifest(v5);
		// Returned manifest is stamped to EXPECTED_VERSION (4) so the
		// type narrows correctly downstream.
		expect(m.version).toBe(4);
		expect(m.services.sui?.rpc.url).toBe('http://sui.hello.localhost:9000');
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/newer manifest version 5/);
	});

	it('hard-rejects newer manifest versions when strict: true', () => {
		const v5: unknown = {
			version: 5,
			stack: { name: 'main', network: 'localnet', app: 'hello' },
			services: {},
			packages: {},
			accounts: {},
			coins: {},
			app: { extras: {} },
		};
		expect(() => fromManifest(v5, { strict: true })).toThrow(/manifest version 5 is newer/);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('still hard-rejects an unknown non-numeric / older version regardless of strict', () => {
		const garbage = { version: 'banana', packages: [] };
		expect(() => fromManifest(garbage)).toThrow(/unknown manifest version/);
		expect(() => fromManifest(garbage, { strict: false })).toThrow(/unknown manifest version/);
		expect(() => fromManifest(garbage, { strict: true })).toThrow(/unknown manifest version/);
	});
});

describe('migrateV3ToV4 — endpoints', () => {
	it('groups sui-rpc / sui-faucet / sui-graphql under services.sui', () => {
		const v3 = {
			endpoints: [
				{ name: 'sui-rpc', url: 'http://sui.hello.localhost:9000', kind: 'rpc' },
				{ name: 'sui-faucet', url: 'http://faucet.hello.localhost:9123', kind: 'faucet' },
				{ name: 'sui-graphql', url: 'http://graphql.hello.localhost:9125', kind: 'graphql' },
			],
		};
		const v4 = migrateV3ToV4(v3);
		expect(v4.services.sui).toEqual({
			network: 'localnet',
			rpc: { url: 'http://sui.hello.localhost:9000' },
			faucet: { url: 'http://faucet.hello.localhost:9123' },
			graphql: { url: 'http://graphql.hello.localhost:9125' },
		});
	});

	it('drops services.sui entirely when sui-rpc is absent', () => {
		const v3 = { endpoints: [{ name: 'sui-faucet', url: 'http://x' }] };
		expect(migrateV3ToV4(v3).services.sui).toBeUndefined();
	});

	it('groups seal-key-server under services.seal', () => {
		const v3 = {
			endpoints: [
				{ name: 'seal-key-server', url: 'http://seal.hello.localhost:7443' },
			],
		};
		expect(migrateV3ToV4(v3).services.seal).toEqual({
			keyServer: { url: 'http://seal.hello.localhost:7443' },
		});
	});

	it('only emits services.walrus when both aggregator and publisher are present', () => {
		const partial = {
			endpoints: [{ name: 'walrus-aggregator', url: 'http://agg' }],
		};
		expect(migrateV3ToV4(partial).services.walrus).toBeUndefined();

		const full = {
			endpoints: [
				{ name: 'walrus-aggregator', url: 'http://aggregator.hello.localhost:9185' },
				{ name: 'walrus-publisher', url: 'http://publisher.hello.localhost:9186' },
			],
		};
		expect(migrateV3ToV4(full).services.walrus).toEqual({
			aggregator: { url: 'http://aggregator.hello.localhost:9185' },
			publisher: { url: 'http://publisher.hello.localhost:9186' },
		});
	});

	it('moves wallet-app + dev-server into app.{wallet,dev}', () => {
		const v3 = {
			endpoints: [
				{ name: 'wallet-app', url: 'http://wallet.hello.localhost:5180' },
				{ name: 'frontend.dev-server', url: 'http://dev.hello.localhost:5179' },
			],
		};
		const app = migrateV3ToV4(v3).app;
		expect(app.dev).toEqual({ url: 'http://dev.hello.localhost:5179' });
		expect(app.wallet).toEqual({ url: 'http://wallet.hello.localhost:5180' });
	});

	it('accepts bare `dev-server` as well as `frontend.dev-server`', () => {
		const v3 = {
			endpoints: [{ name: 'dev-server', url: 'http://x:5179' }],
		};
		expect(migrateV3ToV4(v3).app.dev).toEqual({ url: 'http://x:5179' });
	});

	it('preserves pairUrl as alternates[0]', () => {
		const v3 = {
			endpoints: [
				{ name: 'sui-rpc', url: 'http://sui.hello.localhost:9000', pairUrl: 'http://127.0.0.1:9000' },
			],
		};
		expect(migrateV3ToV4(v3).services.sui?.rpc).toEqual({
			url: 'http://sui.hello.localhost:9000',
			alternates: ['http://127.0.0.1:9000'],
		});
	});
});

describe('migrateV3ToV4 — packages/accounts/coins', () => {
	it('converts packages array to record keyed by name', () => {
		const v3 = {
			packages: [
				{
					name: 'hello',
					packageId: '0xabc',
					upgradeCapId: '0xdef',
					mvrPlaceholder: '@local/hello',
					captured: { treasuryCap: '0x111' },
				},
				{ name: 'world', packageId: '0x222' },
			],
		};
		const v4 = migrateV3ToV4(v3);
		expect(v4.packages.hello).toEqual({
			id: '0xabc',
			upgradeCapId: '0xdef',
			mvr: '@local/hello',
			captured: { treasuryCap: '0x111' },
		});
		expect(v4.packages.world).toEqual({ id: '0x222', captured: {} });
	});

	it('converts accounts array to record', () => {
		const v3 = { accounts: [{ name: 'alice', address: '0x1' }, { name: 'bob', address: '0x2' }] };
		expect(migrateV3ToV4(v3).accounts).toEqual({
			alice: { address: '0x1' },
			bob: { address: '0x2' },
		});
	});

	it('converts coins array to record, preserving sdkCoin', () => {
		const v3 = {
			coins: [
				{
					name: 'musdc',
					type: '0x111::usdc::USDC',
					decimals: 6,
					sdkCoin: { address: '0x111', type: 'usdc::USDC', scalar: 1_000_000 },
				},
			],
		};
		expect(migrateV3ToV4(v3).coins.musdc).toEqual({
			type: '0x111::usdc::USDC',
			decimals: 6,
			sdkCoin: { address: '0x111', type: 'usdc::USDC', scalar: 1_000_000 },
		});
	});

	it('reads stack identity from the v3.stack hint when present, with sensible defaults', () => {
		expect(migrateV3ToV4({}).stack).toEqual({ name: 'main', network: 'localnet', app: 'unknown' });
		expect(
			migrateV3ToV4({ stack: { name: 'test', network: 'testnet', app: 'arena' } }).stack,
		).toEqual({ name: 'test', network: 'testnet', app: 'arena' });
	});

	it('round-trips extras to app.extras', () => {
		const v3 = { extras: { openLobbyId: '0xab', custom: 42 } };
		expect(migrateV3ToV4(v3).app.extras).toEqual({ openLobbyId: '0xab', custom: 42 });
	});

	it('defaults app.extras to empty record when absent', () => {
		expect(migrateV3ToV4({}).app.extras).toEqual({});
	});
});

describe('migrateV3ToV4 — version field', () => {
	it('stamps version: 4 on the migrated output', () => {
		expect(migrateV3ToV4({}).version).toBe(4);
	});
});
