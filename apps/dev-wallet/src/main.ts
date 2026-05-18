// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Web-hosted Sui Dev Wallet — standalone wallet app without CLI integration.
 *
 * Uses WebCrypto (persistent via IndexedDB) and InMemory adapters only.
 * Handles both standalone UI and popup signing requests.
 */

import { fromBase64, toBase64 } from '@mysten/sui/utils';

import type { SignerAdapter } from '@mysten-incubation/dev-wallet';
import { DevWallet } from '@mysten-incubation/dev-wallet';
import { parseWalletRequest } from '@mysten-incubation/dev-wallet/client';

// Import UI components to register custom elements (side-effect imports)
import '@mysten-incubation/dev-wallet/ui';

function getJwtSecretKey(): Uint8Array {
	const stored = localStorage.getItem('dev-wallet:jwt-secret');
	if (stored) return fromBase64(stored);
	const key = crypto.getRandomValues(new Uint8Array(32));
	localStorage.setItem('dev-wallet:jwt-secret', toBase64(key));
	return key;
}

async function createWallet(): Promise<DevWallet> {
	const initTasks: Array<Promise<SignerAdapter | null>> = [];

	// WebCrypto adapter (persistent via IndexedDB — preferred default)
	if (typeof indexedDB !== 'undefined') {
		initTasks.push(
			import('@mysten-incubation/dev-wallet/adapters')
				.then(async ({ WebCryptoSignerAdapter }) => {
					const adapter = new WebCryptoSignerAdapter();
					await adapter.initialize();
					return adapter;
				})
				.catch(() => null),
		);
	}

	// In-memory adapter (lightweight fallback, always available)
	initTasks.push(
		import('@mysten-incubation/dev-wallet/adapters').then(async ({ InMemorySignerAdapter }) => {
			const adapter = new InMemorySignerAdapter();
			await adapter.initialize();
			return adapter;
		}),
	);

	const results = await Promise.allSettled(initTasks);

	for (const result of results) {
		if (result.status === 'rejected') {
			console.warn('[dev-wallet] Adapter initialization failed:', result.reason);
		}
	}

	const adapters = results
		.filter(
			(r): r is PromiseFulfilledResult<SignerAdapter> =>
				r.status === 'fulfilled' && r.value !== null,
		)
		.map((r) => r.value);

	if (adapters.length === 0) {
		throw new Error('No adapters could be initialized');
	}

	const hasAccounts = adapters.some((a) => a.getAccounts().length > 0);
	if (!hasAccounts) {
		const creatableAdapter = adapters.find((a) => a.createAccount);
		if (creatableAdapter?.createAccount) {
			await creatableAdapter.createAccount({ label: 'Dev Account' });
		}
	}

	return new DevWallet({
		adapters,
		activeNetwork: 'devnet',
		persistNetworks: true,
	});
}

function showErrorMessage(container: HTMLElement, title: string, error: unknown) {
	container.innerHTML = '';
	const wrapper = document.createElement('div');
	wrapper.style.cssText = 'color: #ef4444; text-align: center;';

	const heading = document.createElement('h3');
	heading.textContent = title;
	wrapper.appendChild(heading);

	const message = document.createElement('p');
	message.textContent = error instanceof Error ? error.message : String(error);
	message.style.cssText = 'font-size: 13px; margin-top: 8px;';
	wrapper.appendChild(message);

	container.appendChild(wrapper);
}

async function handlePopupRequest(hash: string) {
	const app = document.getElementById('app');
	if (!app) throw new Error('Missing #app element in document');

	try {
		const wallet = await createWallet();
		const jwtSecretKey = getJwtSecretKey();

		const request = parseWalletRequest({
			adapters: [...wallet.adapters],
			jwtSecretKey,
			getClient: (network) => {
				try {
					return wallet.getClient(network);
				} catch {
					return undefined;
				}
			},
			hash,
		});

		app.innerHTML = '';

		const network = request.chain ? request.chain.split(':')[1] : undefined;
		const client = network
			? (wallet.getClient(network) ?? wallet.activeClient)
			: wallet.activeClient;

		const popup = document.createElement('dev-wallet-popup') as any;
		popup.walletName = 'Sui Dev Wallet';
		popup.requestType = request.type;
		popup.appName = request.appName;
		popup.appUrl = request.appUrl;
		popup.address = request.address ?? '';
		if (request.address) {
			const account = wallet.getAdapterForAccount(request.address)?.getAccount(request.address);
			if (account) {
				popup.accountLabel = account.label;
			}
		}
		popup.chain = request.chain ?? 'sui:unknown';
		popup.data = request.data ?? null;
		popup.client = client ?? null;

		if (request.type === 'connect') {
			popup.connectAccounts = wallet.adapters.flatMap((a) =>
				a.getAccounts().map((acc) => ({
					address: acc.address,
					label: acc.label,
					adapterName: a.name,
				})),
			);
		}

		let handling = false;

		popup.addEventListener('approve', async (e: CustomEvent) => {
			if (handling) return;
			handling = true;
			try {
				const detail = e.detail;
				await request.approve(
					detail?.selectedAddresses ? { selectedAddresses: detail.selectedAddresses } : undefined,
				);
				window.close();
			} catch {
				handling = false;
			}
		});

		popup.addEventListener('reject', () => {
			if (handling) return;
			handling = true;
			request.reject('User rejected');
			window.close();
		});

		app.appendChild(popup);
	} catch (error) {
		showErrorMessage(app, 'Error', error);
	}
}

async function showStandaloneUI() {
	const app = document.getElementById('app');
	if (!app) throw new Error('Missing #app element in document');

	try {
		const wallet = await createWallet();

		app.innerHTML = '';

		const el = document.createElement('dev-wallet-standalone') as any;
		el.wallet = wallet;
		el.bookmarkletOrigin = window.location.origin;
		app.appendChild(el);
	} catch (error) {
		showErrorMessage(app, 'Failed to initialize wallet', error);
	}
}

const hash = window.location.hash.slice(1);
if (hash) {
	handlePopupRequest(hash);
} else {
	showStandaloneUI();
}
