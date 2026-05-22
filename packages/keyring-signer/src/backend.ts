// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage abstraction for keyring-signer. An implementation only needs to
 * persist, read, list, and delete opaque string values keyed by (service, account).
 *
 * The production backend is {@link NapiKeyringBackend}, which uses the OS
 * keyring via `@napi-rs/keyring`. {@link MemoryKeyringBackend} is intended
 * for tests and ephemeral use.
 */
export interface KeyringBackend {
	get(service: string, account: string): Promise<string | null>;
	set(service: string, account: string, value: string): Promise<void>;
	list(service: string): Promise<string[]>;
	delete(service: string, account: string): Promise<boolean>;
}

export class MemoryKeyringBackend implements KeyringBackend {
	readonly #store = new Map<string, string>();

	async get(service: string, account: string): Promise<string | null> {
		return this.#store.get(key(service, account)) ?? null;
	}

	async set(service: string, account: string, value: string): Promise<void> {
		this.#store.set(key(service, account), value);
	}

	async list(service: string): Promise<string[]> {
		const accounts: string[] = [];
		for (const k of this.#store.keys()) {
			const [s, a] = JSON.parse(k) as [string, string];
			if (s === service) accounts.push(a);
		}
		return accounts;
	}

	async delete(service: string, account: string): Promise<boolean> {
		return this.#store.delete(key(service, account));
	}
}

function key(service: string, account: string): string {
	return JSON.stringify([service, account]);
}

type NapiEntry = {
	getPassword(): string | null;
	setPassword(password: string): void;
	deletePassword(): boolean;
};

type NapiEntryCtor = new (service: string, account: string) => NapiEntry;
type NapiCredential = { account: string; password: string };
type NapiFindCredentials = (service: string, target?: string | null) => NapiCredential[];

export class NapiKeyringBackend implements KeyringBackend {
	readonly #Entry: NapiEntryCtor;
	readonly #findCredentials: NapiFindCredentials;

	constructor(Entry: NapiEntryCtor, findCredentials: NapiFindCredentials) {
		this.#Entry = Entry;
		this.#findCredentials = findCredentials;
	}

	/**
	 * Dynamically import `@napi-rs/keyring` and return a backend bound to its
	 * `Entry` class. Keeps the native dep out of the module graph for consumers
	 * who only want the in-memory backend (e.g. tests).
	 */
	static async load(): Promise<NapiKeyringBackend> {
		const mod = (await import('@napi-rs/keyring')) as {
			Entry: NapiEntryCtor;
			findCredentials: NapiFindCredentials;
		};
		return new NapiKeyringBackend(mod.Entry, mod.findCredentials);
	}

	async get(service: string, account: string): Promise<string | null> {
		return new this.#Entry(service, account).getPassword();
	}

	async set(service: string, account: string, value: string): Promise<void> {
		new this.#Entry(service, account).setPassword(value);
	}

	async list(service: string): Promise<string[]> {
		return this.#findCredentials(service).map((c) => c.account);
	}

	async delete(service: string, account: string): Promise<boolean> {
		return new this.#Entry(service, account).deletePassword();
	}
}
