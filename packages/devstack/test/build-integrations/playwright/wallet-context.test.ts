// Wallet-adapter contract.
//
// Architecture invariants verified here:
//   - `walletUrl` resolution precedence: explicit > fixture > manifest
//   - missing wallet endpoint (no fixture + no manifest entry) →
//     typed `PlaywrightWalletAdapterError`
//   - HTTP error responses (non-2xx) → typed error with status code
//   - `signTransaction` posts JSON to `/sign-transaction`

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
	switchNetwork,
} from '../../../src/build-integrations/playwright/wallet-context.ts';
import { WalletHttpPath } from '../../../src/plugins/wallet/protocol.ts';
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
		identity: { app: 'sample-app', stack, network: 'localnet' },
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
			generation: 1,
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
				reuse: true,
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

	it('global setup stamps a generation token and warns on rotation when re-mounted', async () => {
		// Playwright retries with `reuseExistingServer:false` can re-run
		// global-setup inside the same Node process; without a generation
		// token, the second call silently overwrites the slot and any
		// helper that cached the prior fixture observes stale state.
		// The fixture now carries a monotonic `generation` and the stash
		// emits a one-line stderr advisory when it overwrites a populated
		// slot.
		const root = writeWalletManifest('http://wallet.sample-app.localhost:6173');
		const originalWrite = process.stderr.write.bind(process.stderr);
		const captured: Array<string> = [];
		const stub = ((line: string | Uint8Array) => {
			captured.push(typeof line === 'string' ? line : String(line));
			return true;
		}) as typeof process.stderr.write;
		process.stderr.write = stub;
		try {
			await buildGlobalSetup({ cwd: root, env: {}, requireEndpoints: ['wallet'], reuse: true })();
			const first = readStashedFixture();
			expect(first?.generation).toBeGreaterThan(0);
			await buildGlobalSetup({ cwd: root, env: {}, requireEndpoints: ['wallet'], reuse: true })();
			const second = readStashedFixture();
			expect(second?.generation).toBeGreaterThan(first?.generation ?? 0);
			expect(captured.some((line) => line.includes('global-setup re-ran'))).toBe(true);
		} finally {
			process.stderr.write = originalWrite;
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
		try {
			await buildGlobalSetup({ cwd: root, env: {}, requireEndpoints: ['wallet'], reuse: true })();

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
		// Pin against the canonical wire-protocol constant so the test
		// fails the instant the adapter URL drifts away from what the
		// wallet HTTP server actually matches. Pre-fix this asserted
		// the literal `/sign-transaction`, which the server 404'd in
		// every real Playwright run.
		expect(call.url).toBe(`http://w.localhost:1${WalletHttpPath.SIGN_TRANSACTION}`);
		expect(call.init.method).toBe('POST');
		const body = JSON.parse(String(call.init.body));
		expect(body).toMatchObject({ accountName: 'alice', txBytesBase64: 'AAAA' });
	});

	it('listAccounts + signTransaction hit the canonical /api/v1/devstack/* paths', async () => {
		// Regression for the silent-404 bug: pin the EXACT byte strings
		// the wallet server's `dispatch` matches (see
		// `src/plugins/wallet/server.ts:449-460`). If anyone re-hardcodes
		// `/accounts` or `/sign-transaction` in the adapter, this fails.
		const calls: Array<{ url: string }> = [];
		const stubFetch = (async (url: string) => {
			calls.push({ url });
			return new Response(JSON.stringify({ digest: 'd', signature: 's', raw: {} }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}) as unknown as typeof fetch;

		const adapter = createWalletAdapter({
			walletUrl: 'http://w.localhost:1',
			fetch: stubFetch,
		});
		await adapter.listAccounts();
		await adapter.signTransaction({ accountName: 'alice', txBytesBase64: 'AA' });

		expect(calls).toHaveLength(2);
		expect(calls[0]!.url.endsWith('/api/v1/devstack/accounts')).toBe(true);
		expect(calls[1]!.url.endsWith('/api/v1/devstack/sign-transaction')).toBe(true);
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

	it('waits for the injected dapp-kit slot to appear after page load', async () => {
		const calls: string[] = [];
		let evaluateCalls = 0;
		const page = {
			evaluate: async <T>(fn: (arg: unknown) => T, arg?: unknown): Promise<T> => {
				evaluateCalls += 1;
				if (evaluateCalls === 1) {
					return { ok: false, reason: 'slot-not-populated' } as T;
				}
				setDappKitSlot({
					selectAccount: (name: string) => calls.push(`select:${name}`),
				});
				return fn(arg);
			},
		};

		await connectAs(page, 'alice');

		expect(evaluateCalls).toBe(2);
		expect(calls).toEqual(['select:alice']);
	});
});

describe('switchNetwork', () => {
	beforeEach(() => setDappKitSlot(null));
	afterEach(() => setDappKitSlot(null));

	const evalPage = () => ({
		evaluate: async <T>(fn: (arg: unknown) => T, arg?: unknown): Promise<T> => fn(arg),
	});

	it('switches network through the dapp-kit slot (same bridge as accounts)', async () => {
		const calls: string[] = [];
		let current = 'localnet';
		setDappKitSlot({
			switchNetwork: (network: string) => {
				calls.push(`switch:${network}`);
				current = network;
			},
			currentNetwork: () => current,
		});

		await switchNetwork(evalPage(), 'devnet');

		expect(calls).toEqual(['switch:devnet']);
	});

	it('waits until the slot reports the network actually changed', async () => {
		// Network propagation can lag the call — the helper polls currentNetwork
		// until it matches, so a switch that settles asynchronously still resolves.
		const calls: string[] = [];
		let current = 'localnet';
		setDappKitSlot({
			switchNetwork: (network: string) => {
				calls.push(`switch:${network}`);
				// settle one tick later
				void Promise.resolve().then(() => {
					current = network;
				});
			},
			currentNetwork: () => current,
		});

		await switchNetwork(evalPage(), 'devnet');
		expect(calls.at(-1)).toBe('switch:devnet');
	});

	it('throws a typed error when the slot has no switchNetwork', async () => {
		setDappKitSlot({ selectAccount: () => {} });
		await expect(switchNetwork(evalPage(), 'devnet')).rejects.toBeInstanceOf(
			PlaywrightWalletAdapterError,
		);
	});
});
