// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Integration tests for the devstack page-register entry's MULTI-NETWORK
// contract: the dev wallet is handed the FULL network set the app supports
// (local + any live networks), advertises each as a wallet-standard chain,
// resolves the right RPC per chain, and — crucially — stays registered across
// a simulated dApp-Kit `switchNetwork` (only the active chain changes; the
// wallet is registered ONCE via wallet-standard).

import { getWallets } from '@mysten/wallet-standard';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerDevstackDevWallet } from '../src/inject/index.js';

// The inject dynamically loads the OPTIONAL WebCrypto adapter (create-your-own
// account), whose `initialize()` touches IndexedDB — unavailable under
// happy-dom. Stub it with a no-account, no-op adapter so the multi-network
// network/chain wiring (the subject of these tests) is exercised without the
// IndexedDB dependency. Production keeps the real adapter; the inject already
// degrades gracefully when `@mysten/signers` is absent.
vi.mock('../src/adapters/webcrypto-adapter.js', () => ({
	WebCryptoSignerAdapter: class {
		readonly id = 'webcrypto';
		readonly name = 'WebCrypto';
		initialize = vi.fn().mockResolvedValue(undefined);
		getAccounts = vi.fn(() => []);
		getAccount = vi.fn(() => undefined);
		onAccountsChanged = vi.fn(() => () => {});
		destroy = vi.fn();
	},
}));

const SERVER_ORIGIN = 'http://localhost:9420';

/** Reset the cross-call injection globals + wallet-standard registry between
 *  tests so each `registerDevstackDevWallet` starts clean. */
function resetInjectionGlobals(): void {
	const g = globalThis as Record<string, unknown>;
	delete g['__devstackDevWallet__'];
	delete g['__devstackDevWalletPromise__'];
	delete g['__DEV_WALLET_INJECTED__'];
}

describe('registerDevstackDevWallet — multi-network', () => {
	beforeEach(() => {
		resetInjectionGlobals();
		// The DevstackSignerAdapter fetches accounts over HTTP on initialize();
		// in unit tests there is no server, so return an empty account set fast
		// (the adapter swallows non-2xx / network errors and warns). A resolved
		// empty list keeps the wallet construction deterministic.
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ accounts: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
	});

	afterEach(() => {
		const g = globalThis as { __devstackDevWallet__?: { dispose: () => void } };
		g.__devstackDevWallet__?.dispose();
		resetInjectionGlobals();
		vi.restoreAllMocks();
	});

	it('advertises every supplied network as a wallet-standard chain — including non-standard names', async () => {
		const { wallet, dispose } = await registerDevstackDevWallet({
			serverOrigin: SERVER_ORIGIN,
			token: null,
			accounts: {},
			networks: {
				localnet: { rpc: 'http://localnet.routed/rpc', faucet: 'http://localnet.routed/faucet' },
				devnet: { rpc: 'http://devnet.routed/rpc', faucet: 'http://devnet.routed/faucet' },
				// A non-standard network name (a fork stack + an arbitrary custom
				// name) — neither is in the fixed SUI_CHAINS set. The wallet must
				// advertise BOTH so dApp Kit's chain-gated paths work for them.
				'testnet-fork': { rpc: 'http://testnet-fork.routed/rpc' },
				custom: { rpc: 'http://custom.routed/rpc' },
			},
			defaultNetwork: 'localnet',
			mountUI: false,
		});

		// The wallet advertises the standard wallet-standard Sui chains — dApp Kit
		// forwards `sui:<network>` for signing and the wallet routes by the
		// chain's network segment, so localnet AND devnet are both signable.
		expect(wallet.chains).toContain('sui:localnet');
		expect(wallet.chains).toContain('sui:devnet');
		// Crucially, chains reflects the CONFIGURED networks: the fork + custom
		// names are advertised too (they are NOT in the static standard set).
		expect(wallet.chains).toContain('sui:testnet-fork');
		expect(wallet.chains).toContain('sui:custom');

		// EVERY supplied network is configured with its routed rpc — the wallet
		// resolves the right endpoint per selected network.
		expect(wallet.availableNetworks).toEqual(
			expect.arrayContaining(['localnet', 'devnet', 'testnet-fork', 'custom']),
		);
		expect(wallet.networkUrls['localnet']).toBe('http://localnet.routed/rpc');
		expect(wallet.networkUrls['devnet']).toBe('http://devnet.routed/rpc');
		expect(wallet.networkUrls['testnet-fork']).toBe('http://testnet-fork.routed/rpc');

		// The wallet opens on the requested default network.
		expect(wallet.activeNetwork).toBe('localnet');

		dispose();
	});

	it("routes each selected network's faucet to the SELECTED network's endpoint", async () => {
		const { wallet, dispose } = await registerDevstackDevWallet({
			serverOrigin: SERVER_ORIGIN,
			token: null,
			accounts: {},
			networks: {
				localnet: { rpc: 'http://localnet.routed/rpc', faucet: 'http://localnet.routed/faucet' },
				devnet: { rpc: 'http://devnet.routed/rpc', faucet: 'http://devnet.routed/faucet' },
				// A live network with no faucet (e.g. mainnet) — null faucet drops out.
				mainnet: { rpc: 'http://mainnet.routed/rpc', faucet: null },
			},
			defaultNetwork: 'localnet',
			mountUI: false,
		});

		expect(wallet.activeFaucet).toBe('http://localnet.routed/faucet');
		wallet.setActiveNetwork('devnet');
		expect(wallet.activeFaucet).toBe('http://devnet.routed/faucet');
		// A network without a faucet resolves to null (no fund flow on mainnet).
		wallet.setActiveNetwork('mainnet');
		expect(wallet.activeFaucet).toBeNull();

		dispose();
	});

	it('STAYS registered across a simulated dApp-Kit network switch (registered once, only the active chain changes)', async () => {
		const { wallet, dispose } = await registerDevstackDevWallet({
			serverOrigin: SERVER_ORIGIN,
			token: null,
			accounts: {},
			networks: {
				localnet: { rpc: 'http://localnet.routed/rpc' },
				devnet: { rpc: 'http://devnet.routed/rpc' },
			},
			defaultNetwork: 'localnet',
			mountUI: false,
		});

		const registry = getWallets();
		const isRegistered = () => registry.get().some((w) => w === wallet);

		// Registered once on inject.
		expect(isRegistered()).toBe(true);

		// Simulate the UI flipping the dApp-Kit network: the wallet's active
		// network changes, but it is NOT re-registered / unmounted.
		wallet.setActiveNetwork('devnet');
		expect(wallet.activeNetwork).toBe('devnet');
		expect(isRegistered()).toBe(true);

		wallet.setActiveNetwork('localnet');
		expect(wallet.activeNetwork).toBe('localnet');
		expect(isRegistered()).toBe(true);

		// A second inject is idempotent — it returns the SAME wallet instance
		// rather than registering a second one (no per-network gate re-mounts).
		const again = await registerDevstackDevWallet({
			serverOrigin: SERVER_ORIGIN,
			token: null,
			accounts: {},
			networks: { localnet: { rpc: 'http://localnet.routed/rpc' } },
			mountUI: false,
		});
		expect(again.wallet).toBe(wallet);
		expect(registry.get().filter((w) => w === wallet)).toHaveLength(1);

		dispose();
	});

	it('falls back to a single localnet network when none are supplied (legacy default)', async () => {
		const { wallet, dispose } = await registerDevstackDevWallet({
			serverOrigin: SERVER_ORIGIN,
			token: null,
			accounts: {},
			mountUI: false,
		});

		expect(wallet.availableNetworks).toEqual(['localnet']);
		expect(wallet.networkUrls['localnet']).toBe('http://127.0.0.1:9000');
		expect(wallet.activeNetwork).toBe('localnet');

		dispose();
	});

	it('rejects early with a browser-visible diagnostic when the page origin is forbidden', async () => {
		const origin = globalThis.location.origin;
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(
			registerDevstackDevWallet({
				serverOrigin: SERVER_ORIGIN,
				token: null,
				accounts: {},
				allowedOrigins: ['http://dev.demo.localhost:5175', 'http://*.demo.localhost:5175'],
				mountUI: false,
			}),
		).rejects.toThrow(`page origin ${origin} is not allowlisted`);

		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining(`[devstack] dev wallet is not available from page origin ${origin}`),
		);
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('Allowed origins: http://dev.demo.localhost:5175'),
		);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});
