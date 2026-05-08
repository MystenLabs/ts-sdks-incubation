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
		expect(() => localnetWalrusOptions({ registry: { packages: [] } })).toThrow(
			/no `walrus` package in manifest/,
		);
	});

	it('throws when systemObject / stakingObject are not captured', () => {
		expect(() =>
			localnetWalrusOptions({
				registry: {
					packages: [{ name: 'walrus', packageId: '0xw', captured: {} }],
				},
			}),
		).toThrow(/missing systemObject\/stakingObject/);
	});

	it('fetch override rewrites https:// to http:// (the only fix the SDK needs once on-chain URLs are public hostnames)', async () => {
		const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			return new Response(JSON.stringify({ url }));
		}) as unknown as typeof globalThis.fetch;
		const opts = localnetWalrusOptions(manifestWith(), { fetch: baseFetch });
		const fetchOverride = opts.storageNodeClientOptions.fetch;

		await fetchOverride('https://walrus-node-0.localhost:19185/path/to/blob');
		expect(baseFetch).toHaveBeenLastCalledWith(
			'http://walrus-node-0.localhost:19185/path/to/blob',
			undefined,
		);

		await fetchOverride('https://walrus-node-1.localhost:19185/blob/2');
		expect(baseFetch).toHaveBeenLastCalledWith(
			'http://walrus-node-1.localhost:19185/blob/2',
			undefined,
		);
	});

	it('fetch override passes non-https URLs through unchanged', async () => {
		const baseFetch = vi.fn(
			async (_input: RequestInfo | URL) => new Response('ok'),
		) as unknown as typeof globalThis.fetch;
		const opts = localnetWalrusOptions(manifestWith(), { fetch: baseFetch });
		await opts.storageNodeClientOptions.fetch('http://walrus-node-0.localhost:19185/x');
		expect(baseFetch).toHaveBeenLastCalledWith('http://walrus-node-0.localhost:19185/x', undefined);
	});

	it('fetch override handles a Request input by rebuilding with the new URL', async () => {
		const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			return new Response(url);
		});
		const opts = localnetWalrusOptions(manifestWith(), {
			fetch: baseFetch as unknown as typeof globalThis.fetch,
		});
		const req = new Request('https://walrus-node-0.localhost:19185/blob', { method: 'GET' });
		await opts.storageNodeClientOptions.fetch(req);
		const arg0 = baseFetch.mock.calls[0]?.[0] as Request;
		expect(arg0).toBeInstanceOf(Request);
		expect(arg0.url).toBe('http://walrus-node-0.localhost:19185/blob');
	});
});
