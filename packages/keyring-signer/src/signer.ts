// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@mysten/sui/cryptography';
import { encodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';

import type { KeyringBackend } from './backend.js';
import { NapiKeyringBackend } from './backend.js';
import { signerFromBech32 } from './webcrypto-import.js';

export type SupportedScheme = 'ED25519' | 'Secp256r1';

export const DEFAULT_SERVICE = 'sui-keyring-signer';

/**
 * Memoize the OS-keyring backend so repeated public-API calls don't re-import
 * `@napi-rs/keyring` or instantiate new wrappers.
 */
let defaultBackendPromise: Promise<KeyringBackend> | null = null;
function defaultBackend(): Promise<KeyringBackend> {
	defaultBackendPromise ??= NapiKeyringBackend.load();
	return defaultBackendPromise;
}

export interface KeyringSignerOptions {
	/**
	 * Which Sui signature scheme to use when generating a fresh key. If a key
	 * already exists at (service, tag), its stored scheme is used and this
	 * option is ignored.
	 */
	scheme: SupportedScheme;
	/**
	 * Stable identifier for the key — e.g. `"publisher"`, a Sui address, or any
	 * logical name your tool wants. Tags are namespaced by `service`.
	 */
	tag: string;
	/**
	 * Keyring service — namespaces keys per-app. Defaults to
	 * {@link DEFAULT_SERVICE}. Override to keep your app's keys separate from
	 * other tools using this library.
	 */
	service?: string;
}

export interface LoadKeyringSignerOptions {
	tag: string;
	service?: string;
}

export interface ListKeyringSignersOptions {
	service?: string;
}

export interface ImportKeyringSignerOptions {
	/** Bech32 `suiprivkey...` string. The embedded flag determines the scheme. */
	secretKey: string;
	tag: string;
	service?: string;
	/** If true, overwrite any existing entry. Defaults to false. */
	overwrite?: boolean;
}

/**
 * Load-or-generate the key at (service, tag) in the OS keyring and return a
 * {@link Signer} backed by a non-extractable Web Crypto `CryptoKey`. The raw
 * private bytes live in memory only briefly during import and are zero-filled
 * afterward.
 */
export async function createKeyringSigner(options: KeyringSignerOptions): Promise<Signer> {
	return createKeyringSignerWithBackend({ ...options, backend: await defaultBackend() });
}

/**
 * Load an existing keypair or return `null`. The scheme is derived from the
 * stored key's flag byte.
 */
export async function loadKeyringSigner(options: LoadKeyringSignerOptions): Promise<Signer | null> {
	return loadKeyringSignerWithBackend({ ...options, backend: await defaultBackend() });
}

/**
 * List the tags stored under a keyring service. Returns identifiers only —
 * secrets are never returned.
 */
export async function listKeyringSigners(
	options: ListKeyringSignersOptions = {},
): Promise<string[]> {
	return listKeyringSignersWithBackend({ ...options, backend: await defaultBackend() });
}

/**
 * Persist an existing Bech32-encoded secret key (`suiprivkey...`). By default
 * refuses to overwrite an existing entry.
 */
export async function importKeyringSigner(options: ImportKeyringSignerOptions): Promise<Signer> {
	return importKeyringSignerWithBackend({ ...options, backend: await defaultBackend() });
}

/**
 * Remove the keyring entry at (service, tag). Returns whether an entry was
 * actually deleted.
 */
export async function deleteKeyringSigner(options: LoadKeyringSignerOptions): Promise<boolean> {
	return deleteKeyringSignerWithBackend({ ...options, backend: await defaultBackend() });
}

/**
 * Read the raw Bech32 `suiprivkey...` string from the OS keyring, bypassing the
 * Signer entirely. Intended for migration flows (moving a key to `sui.keystore`
 * or another vault). The Signer API never exposes private bytes — this is the
 * only path that does.
 */
export async function exportKeyringSignerSecret(
	options: LoadKeyringSignerOptions,
): Promise<string | null> {
	return exportKeyringSignerSecretWithBackend({
		...options,
		backend: await defaultBackend(),
	});
}

// ---------------------------------------------------------------------------
// Internal backend-parameterized variants. Exported so tests can use
// MemoryKeyringBackend without touching the real OS keyring. Not re-exported
// from index.ts — consumers use the public API above.
// ---------------------------------------------------------------------------

export async function createKeyringSignerWithBackend(
	options: KeyringSignerOptions & { backend: KeyringBackend },
): Promise<Signer> {
	const { scheme, tag, backend } = options;
	const service = options.service ?? DEFAULT_SERVICE;

	const existing = await backend.get(service, tag);
	if (existing) {
		return signerFromBech32(existing);
	}

	const bech32 = generateFreshBech32(scheme);
	await backend.set(service, tag, bech32);
	return signerFromBech32(bech32);
}

export async function loadKeyringSignerWithBackend(
	options: LoadKeyringSignerOptions & { backend: KeyringBackend },
): Promise<Signer | null> {
	const service = options.service ?? DEFAULT_SERVICE;
	const existing = await options.backend.get(service, options.tag);
	return existing ? signerFromBech32(existing) : null;
}

export async function listKeyringSignersWithBackend(
	options: ListKeyringSignersOptions & { backend: KeyringBackend },
): Promise<string[]> {
	const service = options.service ?? DEFAULT_SERVICE;
	return options.backend.list(service);
}

export async function importKeyringSignerWithBackend(
	options: ImportKeyringSignerOptions & { backend: KeyringBackend },
): Promise<Signer> {
	const service = options.service ?? DEFAULT_SERVICE;
	// Validate the Bech32 decodes to a supported scheme BEFORE writing. Otherwise
	// a malformed or Secp256k1 key would land in the keyring and only fail on
	// the next load — leaving an unusable entry behind.
	const signer = await signerFromBech32(options.secretKey);
	if (!options.overwrite && (await options.backend.get(service, options.tag)) !== null) {
		throw new Error(
			`keyring-signer: entry already exists at ${service}/${options.tag}. Pass overwrite: true to replace.`,
		);
	}
	await options.backend.set(service, options.tag, options.secretKey);
	return signer;
}

export async function deleteKeyringSignerWithBackend(
	options: LoadKeyringSignerOptions & { backend: KeyringBackend },
): Promise<boolean> {
	const service = options.service ?? DEFAULT_SERVICE;
	return options.backend.delete(service, options.tag);
}

export async function exportKeyringSignerSecretWithBackend(
	options: LoadKeyringSignerOptions & { backend: KeyringBackend },
): Promise<string | null> {
	const service = options.service ?? DEFAULT_SERVICE;
	return options.backend.get(service, options.tag);
}

function generateFreshBech32(scheme: SupportedScheme): string {
	switch (scheme) {
		case 'ED25519': {
			const seed = ed25519.utils.randomSecretKey();
			return encodeSuiPrivateKey(seed, 'ED25519');
		}
		case 'Secp256r1': {
			const scalar = p256.utils.randomSecretKey();
			return encodeSuiPrivateKey(scalar, 'Secp256r1');
		}
	}
}
