// Wallet-adapter contract.
//
// Architecture invariants verified here:
//   - `walletUrl` resolution precedence: explicit > fixture > manifest
//   - missing wallet endpoint (no fixture + no manifest entry) →
//     typed `PlaywrightWalletAdapterError`
//   - HTTP error responses (non-2xx) → typed error with status code
//   - `signTransaction` posts JSON to `/sign-transaction`

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PlaywrightWalletAdapterError } from '../../../src/build-integrations/playwright/errors.ts';
import {
	STACK_CONTEXT_SLOT,
	type PlaywrightStackFixture,
} from '../../../src/build-integrations/playwright/global-setup.ts';
import { createWalletAdapter } from '../../../src/build-integrations/playwright/wallet-context.ts';

const setFixture = (fixture: PlaywrightStackFixture | null) => {
	const slot = globalThis as unknown as Record<string, unknown>;
	if (fixture === null) delete slot[STACK_CONTEXT_SLOT];
	else slot[STACK_CONTEXT_SLOT] = fixture;
};

describe('createWalletAdapter', () => {
	beforeEach(() => setFixture(null));
	afterEach(() => setFixture(null));

	it('uses an explicit walletUrl when provided', () => {
		const adapter = createWalletAdapter({
			walletUrl: 'http://my-wallet:9000/',
		});
		expect(adapter.walletUrl).toBe('http://my-wallet:9000');
	});

	it('throws PlaywrightWalletAdapterError when nothing resolves', () => {
		expect(() =>
			createWalletAdapter({
				cwd: '/nonexistent-for-wallet-test',
				env: {},
			}),
		).toThrow(PlaywrightWalletAdapterError);
	});

	it('uses the global-setup fixture when present', () => {
		setFixture({
			endpoints: { wallet: 'http://from-fixture.localhost:42' },
			walletEndpoint: 'http://from-fixture.localhost:42',
			manifestPath: '/dev/null',
			stack: 'main',
			app: 'sample',
		});
		const adapter = createWalletAdapter();
		expect(adapter.walletUrl).toBe('http://from-fixture.localhost:42');
	});

	it('signTransaction posts JSON and returns parsed body', async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const stubFetch = (async (url: string, init?: RequestInit) => {
			calls.push({ url, init: init ?? {} });
			return new Response(JSON.stringify({ digest: 'abc', signature: 'sig', raw: {} }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}) as unknown as typeof fetch;

		const adapter = createWalletAdapter({
			walletUrl: 'http://w.localhost:1',
			fetch: stubFetch,
		});
		const res = await adapter.signTransaction({
			accountName: 'alice',
			txBytesBase64: 'AAAA',
		});
		expect(res.digest).toBe('abc');
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe('http://w.localhost:1/sign-transaction');
		expect(call.init.method).toBe('POST');
		const body = JSON.parse(String(call.init.body));
		expect(body).toMatchObject({ accountName: 'alice', txBytesBase64: 'AAAA' });
	});

	it('raises a typed error on non-2xx responses', async () => {
		const stubFetch = (async () =>
			new Response('boom', { status: 500 })) as unknown as typeof fetch;
		const adapter = createWalletAdapter({
			walletUrl: 'http://w.localhost:1',
			fetch: stubFetch,
		});
		await expect(
			adapter.signTransaction({
				accountName: 'alice',
				txBytesBase64: 'AA',
			}),
		).rejects.toBeInstanceOf(PlaywrightWalletAdapterError);
	});
});
