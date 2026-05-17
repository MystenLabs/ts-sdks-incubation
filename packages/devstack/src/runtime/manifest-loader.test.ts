// Tests for `fromManifest()` — v4 pass-through + forward-compat
// best-effort decoding.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromManifest } from './manifest-loader.js';
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

	it('hard-rejects an unknown non-numeric / older version regardless of strict', () => {
		const garbage = { version: 'banana', packages: [] };
		expect(() => fromManifest(garbage)).toThrow(/unknown manifest version/);
		expect(() => fromManifest(garbage, { strict: false })).toThrow(/unknown manifest version/);
		expect(() => fromManifest(garbage, { strict: true })).toThrow(/unknown manifest version/);
	});

	it('hard-rejects a v3 manifest (migration support removed pre-1.0)', () => {
		const v3 = {
			packages: [{ name: 'hello', packageId: '0xabc' }],
			endpoints: [{ name: 'sui-rpc', url: 'http://sui.localhost:9000' }],
			accounts: [{ name: 'alice', address: '0x123' }],
		};
		expect(() => fromManifest(v3)).toThrow(/unknown manifest version/);
	});
});
