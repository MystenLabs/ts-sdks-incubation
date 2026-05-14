// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Devstack signer adapter — exposes accounts resolved by `devstack up`'s
// `walletApp()` plugin to dApp Kit, signing transactions over HTTP so
// private keys never enter the frontend bundle. Mirrors RemoteCliAdapter's
// out-of-process model; the difference is the source of accounts (devstack
// resolved signers vs `sui keytool list`) and the endpoint paths.

import { Signer } from '@mysten/sui/cryptography';
import type { PublicKey, SignatureScheme } from '@mysten/sui/cryptography';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1PublicKey } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1PublicKey } from '@mysten/sui/keypairs/secp256r1';
import { fromBase64, toBase64 } from '@mysten/sui/utils';

import type { ManagedAccount } from '../types.js';
import { BaseSignerAdapter } from './base-adapter.js';
import { buildManagedAccount } from './build-managed-account.js';

const DEVSTACK_WALLET_FEATURES = [
	'sui:signTransaction',
	'sui:signAndExecuteTransaction',
	'sui:signPersonalMessage',
] as const;

interface ServerAccountInfo {
	name: string;
	address: string;
	scheme: SignatureScheme;
	publicKey: string;
}

class AuthError extends Error {
	constructor() {
		super('Unauthorized');
		this.name = 'AuthError';
	}
}

function publicKeyForScheme(base64: string, scheme: SignatureScheme): PublicKey {
	const bytes = fromBase64(base64);
	switch (scheme) {
		case 'ED25519':
			return new Ed25519PublicKey(bytes);
		case 'Secp256k1':
			return new Secp256k1PublicKey(bytes);
		case 'Secp256r1':
			return new Secp256r1PublicKey(bytes);
		default:
			throw new Error(`Unsupported key scheme: ${scheme}`);
	}
}

/**
 * Signer that delegates transaction signing to the devstack wallet-app
 * over HTTP. Mirrors {@link CliProxySigner} but talks to the
 * `walletApp()` plugin's endpoints under `/api/v1/devstack/*`.
 */
export class DevstackProxySigner extends Signer {
	#address: string;
	#publicKey: PublicKey;
	#scheme: SignatureScheme;
	#serverOrigin: string;
	#authToken: string | null;

	constructor(options: {
		address: string;
		publicKey: PublicKey;
		scheme: SignatureScheme;
		serverOrigin: string;
		authToken?: string | null;
	}) {
		super();
		this.#address = options.address;
		this.#publicKey = options.publicKey;
		this.#scheme = options.scheme;
		this.#serverOrigin = options.serverOrigin;
		this.#authToken = options.authToken ?? null;
	}

	async sign(_bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
		throw new Error(
			'DevstackProxySigner does not support raw digest signing. ' +
				'Use signTransaction (the wallet-app signs BCS-serialized TransactionData).',
		);
	}

	getKeyScheme(): SignatureScheme {
		return this.#scheme;
	}

	getPublicKey(): PublicKey {
		return this.#publicKey;
	}

	override toSuiAddress(): string {
		return this.#address;
	}

	override async signTransaction(bytes: Uint8Array) {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.#authToken !== null) {
			headers['Authorization'] = `Bearer ${this.#authToken}`;
		}
		const res = await fetch(`${this.#serverOrigin}/api/v1/devstack/sign-transaction`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				address: this.#address,
				txBytes: toBase64(bytes),
			}),
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			const message = (body as { error?: unknown }).error;
			throw new Error(
				`Devstack signing failed: ${typeof message === 'string' ? message : res.statusText}`,
			);
		}
		const { suiSignature } = (await res.json()) as { suiSignature?: string };
		if (typeof suiSignature !== 'string' || suiSignature.length === 0) {
			throw new Error('Devstack signing failed: server returned invalid signature');
		}
		return {
			bytes: toBase64(bytes),
			signature: suiSignature,
		};
	}

	override async signPersonalMessage(bytes: Uint8Array) {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.#authToken !== null) {
			headers['Authorization'] = `Bearer ${this.#authToken}`;
		}
		const res = await fetch(`${this.#serverOrigin}/api/v1/devstack/sign-personal-message`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				address: this.#address,
				messageBytes: toBase64(bytes),
			}),
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			const message = (body as { error?: unknown }).error;
			throw new Error(
				`Devstack personal-message signing failed: ${
					typeof message === 'string' ? message : res.statusText
				}`,
			);
		}
		const { signature } = (await res.json()) as { signature?: string };
		if (typeof signature !== 'string' || signature.length === 0) {
			throw new Error('Devstack personal-message signing failed: server returned no signature');
		}
		return { bytes: toBase64(bytes), signature };
	}
}

export interface DevstackSignerAdapterOptions {
	/** Wallet-app origin (e.g. `http://localhost:9420`). Read from the
	 * matching endpoint entry on the active manifest. */
	serverOrigin: string;
	/** Bearer token. Parse `?token=<hex>` from the manifest entry's
	 * `pairUrl`. Omit if the wallet-app runs without auth. */
	token?: string | null;
	/** Override the adapter's display name. Defaults to `'Devstack'`. */
	name?: string;
}

/**
 * {@link SignerAdapter} that surfaces every account resolved by `devstack up`
 * (including `cliSigner`/`envSigner`/`generatedKeypair` slots) without
 * shipping their private keys into the frontend bundle. All signing happens
 * server-side via the `walletApp()` plugin.
 *
 * The simplest construction reads the manifest's `wallet-app` endpoint:
 *
 * ```ts
 * import { manifest } from './generated/manifest.js';
 * import { createDevstackAdapterFromManifest } from '@mysten-incubation/dev-wallet/adapters';
 *
 * const adapter = createDevstackAdapterFromManifest(manifest);
 * ```
 *
 * Or thread the URL + token in manually (e.g. from a non-manifest source):
 *
 * ```ts
 * const adapter = new DevstackSignerAdapter({
 *     serverOrigin: 'http://localhost:9420',
 *     token: '<bearer hex>',
 * });
 * ```
 */
export class DevstackSignerAdapter extends BaseSignerAdapter {
	readonly id = 'devstack';
	readonly name: string;
	readonly allowAutoSign = true;

	#serverOrigin: string;
	#authToken: string | null;

	constructor(options: DevstackSignerAdapterOptions) {
		super();
		try {
			new URL(options.serverOrigin);
		} catch {
			throw new Error(`DevstackSignerAdapter: invalid serverOrigin "${options.serverOrigin}"`);
		}
		this.#serverOrigin = options.serverOrigin;
		this.#authToken = options.token ?? null;
		this.name = options.name ?? 'Devstack';
	}

	async initialize(): Promise<void> {
		try {
			const accounts = await this.#fetchAccounts();
			this.setInitialAccounts(accounts);
		} catch (error) {
			if (error instanceof AuthError) {
				console.warn('[dev-wallet] devstack adapter: unauthorized — skipping account import');
				return;
			}
			console.warn('[dev-wallet] devstack adapter: initialization failed:', error);
		}
	}

	override destroy(): void {
		this.#authToken = null;
		super.destroy();
	}

	async #fetchAccounts(): Promise<ManagedAccount[]> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.#authToken !== null) {
			headers['Authorization'] = `Bearer ${this.#authToken}`;
		}
		const res = await fetch(`${this.#serverOrigin}/api/v1/devstack/accounts`, { headers });
		if (res.status === 401 || res.status === 403) throw new AuthError();
		if (!res.ok) {
			throw new Error(`Failed to fetch devstack accounts: ${res.statusText}`);
		}
		const { accounts } = (await res.json()) as { accounts: ServerAccountInfo[] };
		return accounts.map((info) => {
			const publicKey = publicKeyForScheme(info.publicKey, info.scheme);
			const signer = new DevstackProxySigner({
				address: info.address,
				publicKey,
				scheme: info.scheme,
				serverOrigin: this.#serverOrigin,
				authToken: this.#authToken,
			});
			return buildManagedAccount(signer, info.address, info.name, DEVSTACK_WALLET_FEATURES);
		});
	}
}

/**
 * Pull the `?token=<hex>` parameter off a paired URL produced by the
 * `walletApp()` plugin. Returns `null` if the input is undefined or
 * doesn't carry a token.
 */
export function parseDevstackToken(pairedUrl: string | undefined): string | null {
	if (pairedUrl === undefined) return null;
	try {
		const url = new URL(pairedUrl);
		return url.searchParams.get('token');
	} catch {
		return null;
	}
}

/**
 * Convenience: read the `wallet-app` entry from a devstack manifest and
 * build a configured adapter, or return `null` when the entry isn't
 * present (no `walletApp.create(...)` in the stack, or it hasn't come
 * up yet).
 *
 * Reads `manifest.endpoints` for `{ name: 'wallet-app', url, pairUrl }`.
 */
export function createDevstackAdapterFromManifest(manifest: {
	endpoints?: ReadonlyArray<{ name: string; url: string; pairUrl?: string }>;
}): DevstackSignerAdapter | null {
	const endpoint = manifest.endpoints?.find((e) => e.name === 'wallet-app');
	if (endpoint !== undefined) {
		return new DevstackSignerAdapter({
			serverOrigin: endpoint.url,
			token: parseDevstackToken(endpoint.pairUrl),
		});
	}
	return null;
}
