// Wallet-adapter contract.
//
// Architecture invariants verified here:
//   - `walletUrl` resolution precedence: explicit > fixture > manifest
//   - missing wallet endpoint (no fixture + no manifest entry) →
//     typed `PlaywrightWalletAdapterError`
//   - HTTP error responses (non-2xx) → typed error with status code
//   - `signTransaction` posts JSON to `/sign-transaction`

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PlaywrightWalletAdapterError } from '../../../src/build-integrations/playwright/errors.ts';
import {
	buildGlobalSetup,
	readStashedFixture,
	STACK_CONTEXT_SLOT,
	type PlaywrightStackFixture,
} from '../../../src/build-integrations/playwright/global-setup.ts';
import {
	DAPP_KIT_SLOT,
	connectAs,
	createWalletAdapter,
} from '../../../src/build-integrations/playwright/wallet-context.ts';
import { CURRENT_MANIFEST_VERSION } from '../../../src/substrate/runtime/manifest/manifest.ts';

const setFixture = (fixture: PlaywrightStackFixture | null) => {
	const slot = globalThis as unknown as Record<string, unknown>;
	if (fixture === null) delete slot[STACK_CONTEXT_SLOT];
	else slot[STACK_CONTEXT_SLOT] = fixture;
};

const setDappKitSlot = (slotValue: unknown) => {
	const slot = globalThis as unknown as Record<string, unknown>;
	if (slotValue === null) delete slot[DAPP_KIT_SLOT];
	else slot[DAPP_KIT_SLOT] = slotValue;
};

const writeWalletManifest = (walletUrl: string): string => {
	const root = mkdtempSync(join(tmpdir(), 'pw-wallet-ctx-'));
	const stateDir = join(root, '.devstack', 'stacks', 'main');
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, 'manifest.json'), manifestJson(walletUrl, 'main'));
	return root;
};

const manifestJson = (walletUrl: string, stack: string): string =>
	JSON.stringify({
		identity: { app: 'sample-app', stack, chain: 'localnet' },
		manifestVersion: CURRENT_MANIFEST_VERSION,
		services: {},
		endpoints: {
			'wallet#4:wallet-app': {
				name: 'wallet-app',
				url: walletUrl,
				displayUrl: walletUrl,
				wireProtocol: 'http',
				pluginKey: 'wallet#4',
				endpointKey: 'wallet#4:wallet-app',
			},
		},
		extras: {},
	});

const appendEngineEvent = (stateDir: string, seq: number, event: Record<string, unknown>) => {
	appendFileSync(
		join(stateDir, 'events.ndjson'),
		JSON.stringify({
			protocol: 1,
			seq,
			at: Date.now(),
			kind: 'engine',
			event: { ...event, at: Date.now() },
		}) + '\n',
	);
};

const writeCodegenEvent = (stateDir: string, seq = 1) => {
	appendEngineEvent(stateDir, seq, { tag: 'codegen.emitted', files: [] });
};

const writeDevEndpointEvent = (stateDir: string, seq: number) => {
	appendEngineEvent(stateDir, seq, {
		tag: 'endpoint.registered',
		endpoint: {
			name: 'dev',
			url: 'http://dev.sample-app.localhost:5175',
			displayUrl: 'http://dev.sample-app.localhost:5175',
			wireProtocol: 'http',
		},
	});
};

describe('createWalletAdapter', () => {
	beforeEach(() => setFixture(null));
	afterEach(() => {
		setFixture(null);
		setDappKitSlot(null);
	});

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
			endpoints: { 'wallet-app': 'http://from-fixture.localhost:42' },
			walletEndpoint: 'http://from-fixture.localhost:42',
			manifestPath: '/dev/null',
			stack: 'main',
			app: 'sample',
		});
		const adapter = createWalletAdapter();
		expect(adapter.walletUrl).toBe('http://from-fixture.localhost:42');
	});

	it('resolves wallet by endpoint name from a raw manifest key', () => {
		const root = writeWalletManifest('http://wallet.sample-app.localhost:6173');
		try {
			const adapter = createWalletAdapter({ cwd: root, env: {} });
			expect(adapter.walletUrl).toBe('http://wallet.sample-app.localhost:6173');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('global setup stashes wallet by endpoint name from a raw manifest key', async () => {
		const root = writeWalletManifest('http://wallet.sample-app.localhost:6173');
		try {
			await buildGlobalSetup({
				cwd: root,
				env: {},
				requireEndpoints: ['wallet'],
				waitForCodegen: false,
			})();
			const fixture = readStashedFixture();
			expect(fixture?.walletEndpoint).toBe('http://wallet.sample-app.localhost:6173');
			expect(fixture?.endpoints).toMatchObject({
				'wallet-app': 'http://wallet.sample-app.localhost:6173',
			});
		} finally {
			setFixture(null);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('global setup waits for the post-acquire codegen event', async () => {
		const root = writeWalletManifest('http://wallet.sample-app.localhost:6173');
		const stateDir = join(root, '.devstack', 'stacks', 'main');
		try {
			const setup = buildGlobalSetup({
				cwd: root,
				env: {},
				requireEndpoints: ['wallet'],
				readyTimeoutMs: 1_000,
				readyPollIntervalMs: 10,
			})();
			setTimeout(() => writeCodegenEvent(stateDir), 25);

			await setup;

			const fixture = readStashedFixture();
			expect(fixture?.walletEndpoint).toBe('http://wallet.sample-app.localhost:6173');
		} finally {
			setFixture(null);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('global setup ignores stale codegen emitted before the current dev endpoint', async () => {
		const root = writeWalletManifest('http://wallet.sample-app.localhost:6173');
		const stateDir = join(root, '.devstack', 'stacks', 'main');
		try {
			writeCodegenEvent(stateDir, 58);
			writeDevEndpointEvent(stateDir, 54);

			const setup = buildGlobalSetup({
				cwd: root,
				env: {},
				requireEndpoints: ['wallet'],
				readyTimeoutMs: 1_000,
				readyPollIntervalMs: 10,
			})();
			setTimeout(() => writeCodegenEvent(stateDir, 58), 25);

			await setup;

			const fixture = readStashedFixture();
			expect(fixture?.walletEndpoint).toBe('http://wallet.sample-app.localhost:6173');
		} finally {
			setFixture(null);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('global setup can infer the only stack directory when stack is not main', async () => {
		const root = mkdtempSync(join(tmpdir(), 'pw-wallet-ctx-'));
		const stateDir = join(root, '.devstack', 'stacks', 'token-studio');
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, 'manifest.json'),
			manifestJson('http://wallet.sample-app.localhost:6173', 'token-studio'),
		);
		writeCodegenEvent(stateDir);
		try {
			await buildGlobalSetup({ cwd: root, env: {}, requireEndpoints: ['wallet'] })();

			const fixture = readStashedFixture();
			expect(fixture?.stack).toBe('token-studio');
			expect(fixture?.walletEndpoint).toBe('http://wallet.sample-app.localhost:6173');
		} finally {
			setFixture(null);
			rmSync(root, { recursive: true, force: true });
		}
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

describe('connectAs', () => {
	beforeEach(() => setDappKitSlot(null));
	afterEach(() => setDappKitSlot(null));

	it('switches accounts through the dapp-kit slot', async () => {
		const calls: string[] = [];
		setDappKitSlot({
			selectAccount: (name: string) => calls.push(`select:${name}`),
		});
		const page = {
			evaluate: async <T>(fn: (arg: unknown) => T, arg?: unknown): Promise<T> => fn(arg),
		};

		await connectAs(page, 'alice');

		expect(calls).toEqual(['select:alice']);
	});

	it('awaits async account switching from the dapp-kit slot', async () => {
		const calls: string[] = [];
		setDappKitSlot({
			selectAccount: async (name: string) => {
				await Promise.resolve();
				calls.push(`select:${name}`);
			},
		});
		const page = {
			evaluate: async <T>(fn: (arg: unknown) => T, arg?: unknown): Promise<T> => fn(arg),
		};

		await connectAs(page, 'bob');

		expect(calls).toEqual(['select:bob']);
	});
});
