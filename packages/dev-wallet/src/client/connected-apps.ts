// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/** localStorage key for the connected-apps list. Bump the suffix on shape changes. */
export const CONNECTED_APPS_STORAGE_KEY = 'dev-wallet:connected-apps:v1';

/** A dApp the user approved a connection for in the standalone wallet. */
export interface ConnectedApp {
	/** The dApp's origin — the identity sessions are scoped to. */
	origin: string;
	/** Display name the dApp sent (its page title). */
	name: string;
	/** Addresses shared with the dApp. */
	accounts: string[];
	/** Milliseconds since epoch of the latest approval. */
	connectedAt: number;
}

function isConnectedApp(value: unknown): value is ConnectedApp {
	if (typeof value !== 'object' || value === null) return false;
	const app = value as Record<string, unknown>;
	return (
		typeof app.origin === 'string' &&
		typeof app.name === 'string' &&
		Array.isArray(app.accounts) &&
		app.accounts.every((a) => typeof a === 'string') &&
		typeof app.connectedAt === 'number'
	);
}

/**
 * Connected dApps for a standalone wallet, stored in the wallet origin's
 * localStorage so the popup (which records connections) and the wallet page
 * (which lists them) share it. Removing an app makes the popup reject that
 * origin's signing requests until it reconnects.
 */
export class ConnectedAppsStore {
	readonly #storage: Storage;

	constructor(storage: Storage = localStorage) {
		this.#storage = storage;
	}

	/** Connected apps, most recently connected first. */
	list(): ConnectedApp[] {
		const raw = this.#storage.getItem(CONNECTED_APPS_STORAGE_KEY);
		if (raw === null) return [];
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed) && parsed.every(isConnectedApp)) {
				return [...parsed].sort((a, b) => b.connectedAt - a.connectedAt);
			}
		} catch {
			// Invalid JSON — handled below.
		}
		console.warn(`[dev-wallet] Ignoring invalid data in "${CONNECTED_APPS_STORAGE_KEY}".`);
		return [];
	}

	has(origin: string): boolean {
		return this.list().some((app) => app.origin === origin);
	}

	/** Add an app, or replace the entry for its origin. */
	record(app: ConnectedApp): void {
		this.#write([app, ...this.list().filter((a) => a.origin !== app.origin)]);
	}

	remove(origin: string): void {
		this.#write(this.list().filter((a) => a.origin !== origin));
	}

	/** Call `callback` when another window (e.g. the signing popup) changes the list. */
	subscribe(callback: () => void): () => void {
		const onStorage = (e: StorageEvent) => {
			if (e.key === CONNECTED_APPS_STORAGE_KEY || e.key === null) callback();
		};
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	}

	#write(apps: ConnectedApp[]): void {
		this.#storage.setItem(CONNECTED_APPS_STORAGE_KEY, JSON.stringify(apps));
	}
}
