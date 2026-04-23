// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { generateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';

import { getDefaultHelper } from './default-helper.js';
import type { AppleHelper } from './helper.js';
import { KeychainSigner } from './signer.js';

export type KeychainSeed =
	| { source: 'random' }
	| { source: 'bech32'; bech32: string }
	| { source: 'mnemonic'; mnemonic: string; path?: string }
	| { source: 'generate-mnemonic'; wordCount?: 12 | 24 };

export interface CreateKeychainSignerOptions {
	/** Stable identifier for the keychain key. */
	tag: string;
	/**
	 * If true (default), the key's ACL requires biometric (Touch ID) on first
	 * use per helper lifetime. If false, signing is silent. Only read when
	 * generating/importing a fresh key — existing keys keep their ACL.
	 */
	requireBiometric?: boolean;
	/**
	 * How to seed the key at creation time. Default is `{ source: 'random' }`
	 * which has the strongest isolation — the helper generates the key and
	 * the private bytes never appear in this process.
	 *
	 * Other seed modes bring the bytes briefly into this process during
	 * decode/derivation, then zero them and import via the helper. After
	 * creation, all modes produce the same keychain entry.
	 */
	seed?: KeychainSeed;
	helper?: AppleHelper;
}

export interface LoadKeychainSignerOptions {
	tag: string;
	helper?: AppleHelper;
}

export interface DeleteKeychainSignerOptions {
	tag: string;
	helper?: AppleHelper;
}

export interface ListKeychainSignersOptions {
	helper?: AppleHelper;
}

/**
 * Result of `createKeychainSigner`. The `mnemonic` field is populated **only**
 * when you pass `seed: { source: 'generate-mnemonic' }` — it's the caller's
 * single chance to display or persist the phrase. For all other seed modes
 * (including `'mnemonic'`, where the mnemonic was user-provided), this field
 * is `undefined`.
 */
export interface CreateKeychainSignerResult {
	signer: KeychainSigner;
	mnemonic?: string;
}

const DEFAULT_SECP256R1_DERIVATION_PATH = "m/74'/784'/0'/0/0";

/**
 * Load-or-generate a keychain-backed Sui signer at `tag`. If a key already
 * exists, `seed` and `requireBiometric` are ignored.
 */
export async function createKeychainSigner(
	options: CreateKeychainSignerOptions,
): Promise<CreateKeychainSignerResult> {
	const helper = options.helper ?? (await getDefaultHelper());

	const existing = await tryKeychainPubkey(helper, options.tag);
	if (existing) {
		return { signer: new KeychainSigner(helper, options.tag, existing) };
	}

	const seed: KeychainSeed = options.seed ?? { source: 'random' };
	const { scalar, mnemonic } = await resolveSeedScalar(seed);

	const reqArgs: Record<string, unknown> = {
		tag: options.tag,
		requireBiometric: options.requireBiometric ?? true,
	};
	if (scalar) {
		reqArgs.scalar = Buffer.from(scalar).toString('base64');
	}

	try {
		const { publicKey } = await helper.request<{ publicKey: string }>(
			'keychain.generate',
			reqArgs,
		);
		const signer = new KeychainSigner(
			helper,
			options.tag,
			Uint8Array.from(Buffer.from(publicKey, 'base64')),
		);
		return mnemonic !== undefined ? { signer, mnemonic } : { signer };
	} finally {
		if (scalar) scalar.fill(0);
	}
}

export async function loadKeychainSigner(
	options: LoadKeychainSignerOptions,
): Promise<KeychainSigner | null> {
	const helper = options.helper ?? (await getDefaultHelper());
	const publicKey = await tryKeychainPubkey(helper, options.tag);
	if (!publicKey) return null;
	return new KeychainSigner(helper, options.tag, publicKey);
}

export async function deleteKeychainSigner(
	options: DeleteKeychainSignerOptions,
): Promise<boolean> {
	const helper = options.helper ?? (await getDefaultHelper());
	const { deleted } = await helper.request<{ deleted: boolean }>('keychain.delete', {
		tag: options.tag,
	});
	return deleted;
}

export async function listKeychainSigners(
	options: ListKeychainSignersOptions = {},
): Promise<string[]> {
	const helper = options.helper ?? (await getDefaultHelper());
	const { tags } = await helper.request<{ tags: string[] }>('keychain.list', {});
	return tags;
}

async function tryKeychainPubkey(
	helper: AppleHelper,
	tag: string,
): Promise<Uint8Array | null> {
	try {
		const { publicKey } = await helper.request<{ publicKey: string }>('keychain.pubkey', {
			tag,
		});
		return Uint8Array.from(Buffer.from(publicKey, 'base64'));
	} catch (err) {
		if (/not found/i.test((err as Error).message)) return null;
		throw err;
	}
}

/**
 * Convert a {@link KeychainSeed} into the 32-byte scalar to hand to the
 * helper (if any — `random` returns undefined) and an optional mnemonic to
 * display (only for `generate-mnemonic`).
 */
async function resolveSeedScalar(
	seed: KeychainSeed,
): Promise<{ scalar: Uint8Array | null; mnemonic: string | undefined }> {
	switch (seed.source) {
		case 'random':
			return { scalar: null, mnemonic: undefined };
		case 'bech32': {
			const { scheme, secretKey } = decodeSuiPrivateKey(seed.bech32);
			if (scheme !== 'Secp256r1') {
				throw new Error(
					`createKeychainSigner: expected Secp256r1 Bech32 secret, got ${scheme}. ` +
						`Keychain mode supports P-256 only.`,
				);
			}
			return { scalar: secretKey, mnemonic: undefined };
		}
		case 'mnemonic': {
			const keypair = Secp256r1Keypair.deriveKeypair(
				seed.mnemonic,
				seed.path ?? DEFAULT_SECP256R1_DERIVATION_PATH,
			);
			const { secretKey } = decodeSuiPrivateKey(keypair.getSecretKey());
			return { scalar: secretKey, mnemonic: undefined };
		}
		case 'generate-mnemonic': {
			const strength = (seed.wordCount ?? 24) === 12 ? 128 : 256;
			const mnemonic = generateMnemonic(englishWordlist, strength);
			const keypair = Secp256r1Keypair.deriveKeypair(mnemonic, DEFAULT_SECP256R1_DERIVATION_PATH);
			const { secretKey } = decodeSuiPrivateKey(keypair.getSecretKey());
			return { scalar: secretKey, mnemonic };
		}
	}
}
