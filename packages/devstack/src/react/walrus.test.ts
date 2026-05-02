import { describe, expect, it, vi } from 'vitest';
import { localnetWalrusOptions } from './walrus.js';

const manifestWith = (overrides: Record<string, unknown> = {}) => ({
	registry: {
		packages: [
			{
				name: 'walrus',
				packageId: '0xwalrus',
				captured: {
					systemObject: '0xsystem',
					stakingObject: '0xstaking',
				},
			},
		],
		walrus: {
			nodes: [
				{ ip: '10.0.0.10', apiUrl: 'https://10.0.0.10:9185', hostApiUrl: 'http://localhost:19185' },
				{ ip: '10.0.0.11', apiUrl: 'https://10.0.0.11:9185', hostApiUrl: 'http://localhost:19186' },
			],
		},
		...overrides,
	},
});

describe('localnetWalrusOptions', () => {
	it('returns systemObjectId + stakingPoolId from the manifest', () => {
		const opts = localnetWalrusOptions(manifestWith());
		expect(opts.packageConfig).toEqual({
			systemObjectId: '0xsystem',
			stakingPoolId: '0xstaking',
		});
	});

	it('throws when the walrus package is missing from the manifest', () => {
		expect(() => localnetWalrusOptions({ registry: { packages: [], walrus: { nodes: [] } } }))
			.toThrow(/no `walrus` package in manifest/);
	});

	it('throws when the walrus.nodes list is empty', () => {
		expect(() =>
			localnetWalrusOptions({
				registry: {
					packages: [
						{ name: 'walrus', packageId: '0xw', captured: { systemObject: 'x', stakingObject: 'y' } },
					],
					walrus: { nodes: [] },
				},
			}),
		).toThrow(/no walrus nodes in manifest/);
	});

	it('throws when systemObject / stakingObject are not captured', () => {
		expect(() =>
			localnetWalrusOptions({
				registry: {
					packages: [{ name: 'walrus', packageId: '0xw', captured: {} }],
					walrus: { nodes: [{ ip: '10.0.0.10', apiUrl: 'a', hostApiUrl: 'b' }] },
				},
			}),
		).toThrow(/missing systemObject\/stakingObject/);
	});

	it('fetch override rewrites docker-IP URLs to host ports', async () => {
		const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			return new Response(JSON.stringify({ url }));
		}) as unknown as typeof globalThis.fetch;
		const opts = localnetWalrusOptions(manifestWith(), { fetch: baseFetch });
		const fetchOverride = opts.storageNodeClientOptions.fetch;

		await fetchOverride('https://10.0.0.10:9185/path/to/blob');
		expect(baseFetch).toHaveBeenLastCalledWith('http://localhost:19185/path/to/blob', undefined);

		await fetchOverride('https://10.0.0.11:9185/blob/2');
		expect(baseFetch).toHaveBeenLastCalledWith('http://localhost:19186/blob/2', undefined);
	});

	it('fetch override passes non-matching URLs through unchanged', async () => {
		const baseFetch = vi.fn(
			async (_input: RequestInfo | URL) => new Response('ok'),
		) as unknown as typeof globalThis.fetch;
		const opts = localnetWalrusOptions(manifestWith(), { fetch: baseFetch });
		await opts.storageNodeClientOptions.fetch('https://api.example.com/x');
		expect(baseFetch).toHaveBeenLastCalledWith('https://api.example.com/x', undefined);
	});

	it('fetch override handles a Request input by rebuilding with the new URL', async () => {
		const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			return new Response(url);
		});
		const opts = localnetWalrusOptions(manifestWith(), {
			fetch: baseFetch as unknown as typeof globalThis.fetch,
		});
		const req = new Request('https://10.0.0.10:9185/blob', { method: 'GET' });
		await opts.storageNodeClientOptions.fetch(req);
		// Fetch is called with a fresh Request (URL rewritten); first arg is a Request.
		const arg0 = baseFetch.mock.calls[0]?.[0] as Request;
		expect(arg0).toBeInstanceOf(Request);
		expect(arg0.url).toBe('http://localhost:19185/blob');
	});
});
