// Unit tests for the synchronous factory-time validation in
// `resolveLocalClusterOptions`. The distilled-doc invariants 11+16
// require BOTH `nodeCount >= 1` AND `shards >= nodeCount` — and the
// failure mode must be a thrown `WalrusConfigError` at the
// `defineDevstack(...)` call site, NOT a deferred Effect failure.

import { describe, expect, it } from 'vitest';

import {
	DEFAULT_SUI_VERSION,
	DEFAULT_WALRUS_REF,
} from '../../../src/plugins/walrus/bootstrap-assets/cargo-image.ts';
import {
	DEFAULT_WALRUS_CLIENT_SERVICE_PORT,
	DEFAULT_WALRUS_UPLOAD_RELAY_SERVICE_PORT,
} from '../../../src/plugins/walrus/client-services.ts';
import { resolveLocalClusterOptions } from '../../../src/plugins/walrus/mode/local-cluster.ts';

describe('resolveLocalClusterOptions', () => {
	it('applies defaults when called with the empty options bag', () => {
		const r = resolveLocalClusterOptions({});
		expect(r.name).toBe('walrus');
		expect(r.nodeCount).toBe(1);
		expect(r.shards).toBe(100);
		expect(r.version).toBe(DEFAULT_WALRUS_REF);
		expect(r.suiVersion).toBe(DEFAULT_SUI_VERSION);
		expect(r.epochDuration).toBe('24h');
		expect(r.aggregator).toEqual({ port: DEFAULT_WALRUS_CLIENT_SERVICE_PORT });
		expect(r.publisher).toEqual({ port: DEFAULT_WALRUS_CLIENT_SERVICE_PORT });
		expect(r.uploadRelay).toEqual({ port: DEFAULT_WALRUS_UPLOAD_RELAY_SERVICE_PORT });
	});

	it('preserves user-supplied release versions for image resolution', () => {
		const r = resolveLocalClusterOptions({
			version: 'devnet-v1.50.0',
			suiVersion: 'devnet-v1.72.0',
		});
		expect(r.version).toBe('devnet-v1.50.0');
		expect(r.suiVersion).toBe('devnet-v1.72.0');
	});

	it('throws synchronously on `nodeCount < 1` (distilled-doc invariant 11)', () => {
		expect(() => resolveLocalClusterOptions({ nodeCount: 0 })).toThrow(/nodeCount must be >= 1/);
	});

	it('throws synchronously on `shards < nodeCount`', () => {
		expect(() => resolveLocalClusterOptions({ nodeCount: 5, shards: 3 })).toThrow(
			/shards \(3\) must be >= nodeCount \(5\)/,
		);
	});

	it('keeps account funding out of the resolved local options', () => {
		const r = resolveLocalClusterOptions({});
		expect(Object.keys(r).sort()).toEqual([
			'aggregator',
			'containerApiPort',
			'epochDuration',
			'name',
			'nodeCount',
			'publisher',
			'readyTimeoutMs',
			'shards',
			'suiVersion',
			'uploadRelay',
			'version',
		]);
	});

	it('supports disabling the local publisher/aggregator/upload-relay endpoints', () => {
		const r = resolveLocalClusterOptions({
			aggregator: false,
			publisher: false,
			uploadRelay: false,
		});
		expect(r.aggregator).toBeNull();
		expect(r.publisher).toBeNull();
		expect(r.uploadRelay).toBeNull();
	});

	it('preserves service ports', () => {
		const r = resolveLocalClusterOptions({
			aggregator: { port: 40100 },
			publisher: {
				port: 40101,
			},
			uploadRelay: { port: 40102 },
		});
		expect(r.aggregator).toEqual({ port: 40100 });
		expect(r.publisher).toEqual({ port: 40101 });
		expect(r.uploadRelay).toEqual({ port: 40102 });
	});
});
