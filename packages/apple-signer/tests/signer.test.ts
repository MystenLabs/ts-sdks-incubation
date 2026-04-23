// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from 'vitest';

import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { p256 } from '@noble/curves/nist.js';
import { generateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';

import type { AppleHelper } from '../src/helper.js';
import {
	createEnclaveSigner,
	deleteEnclaveSigner,
	listEnclaveSigners,
	loadEnclaveSigner,
} from '../src/enclave.js';
import {
	createKeychainSigner,
	deleteKeychainSigner,
	listKeychainSigners,
	loadKeychainSigner,
} from '../src/keychain.js';
import { KeychainSigner, SecureEnclaveSigner } from '../src/signer.js';

/**
 * Fake helper that mimics the Swift binary's JSON protocol entirely in JS,
 * using noble for crypto. Covers both `enclave.*` and `keychain.*` ops so we
 * can exercise the full signer path without the Secure Enclave or keychain.
 */
function fakeHelper(): AppleHelper & {
	enclaveKeys: Map<string, Uint8Array>;
	keychainKeys: Map<string, Uint8Array>;
} {
	const enclaveKeys = new Map<string, Uint8Array>();
	const keychainKeys = new Map<string, Uint8Array>();

	const compressedPub = (scalar: Uint8Array): string => {
		const uncompressed = p256.getPublicKey(scalar, false);
		const x = uncompressed.slice(1, 33);
		const y = uncompressed.slice(33, 65);
		const out = new Uint8Array(33);
		out[0] = (y[31]! & 1) === 0 ? 0x02 : 0x03;
		out.set(x, 1);
		return Buffer.from(out).toString('base64');
	};

	const derSignature = (scalar: Uint8Array, digestB64: string): string => {
		const digest = Uint8Array.from(Buffer.from(digestB64, 'base64'));
		// Match Swift helper: SHA-256(digest) then ECDSA. Noble does this by default.
		// Skip lowS so the Node-side normalization is exercised.
		const compact = p256.sign(digest, scalar, { lowS: false });
		const der = p256.Signature.fromBytes(compact, 'compact').toBytes('der');
		return Buffer.from(der).toString('base64');
	};

	return {
		enclaveKeys,
		keychainKeys,
		async close() {},
		async request(op, args = {}) {
			const a = args as { tag?: string; digest?: string; scalar?: string };
			switch (op) {
				case 'enclave.generate': {
					const tag = a.tag!;
					if (enclaveKeys.has(tag)) throw new Error(`key with tag '${tag}' already exists`);
					const scalar = p256.utils.randomSecretKey();
					enclaveKeys.set(tag, scalar);
					return { publicKey: compressedPub(scalar) };
				}
				case 'enclave.pubkey': {
					const scalar = enclaveKeys.get(a.tag!);
					if (!scalar) throw new Error(`key with tag '${a.tag}' not found`);
					return { publicKey: compressedPub(scalar) };
				}
				case 'enclave.sign': {
					const scalar = enclaveKeys.get(a.tag!);
					if (!scalar) throw new Error(`key with tag '${a.tag}' not found`);
					return { signature: derSignature(scalar, a.digest!) };
				}
				case 'enclave.list':
					return { tags: [...enclaveKeys.keys()] };
				case 'enclave.delete':
					return { deleted: enclaveKeys.delete(a.tag!) };

				case 'keychain.generate': {
					const tag = a.tag!;
					if (keychainKeys.has(tag)) throw new Error(`key with tag '${tag}' already exists`);
					const scalar = a.scalar
						? Uint8Array.from(Buffer.from(a.scalar, 'base64'))
						: p256.utils.randomSecretKey();
					keychainKeys.set(tag, scalar);
					return { publicKey: compressedPub(scalar) };
				}
				case 'keychain.pubkey': {
					const scalar = keychainKeys.get(a.tag!);
					if (!scalar) throw new Error(`key with tag '${a.tag}' not found`);
					return { publicKey: compressedPub(scalar) };
				}
				case 'keychain.sign': {
					const scalar = keychainKeys.get(a.tag!);
					if (!scalar) throw new Error(`key with tag '${a.tag}' not found`);
					return { signature: derSignature(scalar, a.digest!) };
				}
				case 'keychain.list':
					return { tags: [...keychainKeys.keys()] };
				case 'keychain.delete':
					return { deleted: keychainKeys.delete(a.tag!) };

				default:
					throw new Error(`unknown op: ${op}`);
			}
		},
	};
}

describe('SecureEnclaveSigner (fake helper)', () => {
	let helper: ReturnType<typeof fakeHelper>;
	beforeEach(() => {
		helper = fakeHelper();
	});

	it('creates a signer whose signTransaction verifies', async () => {
		const signer = await createEnclaveSigner({ tag: 'publisher', helper });
		expect(signer.getKeyScheme()).toBe('Secp256r1');

		const txBytes = new TextEncoder().encode(`tx-${Math.random()}`);
		const { bytes, signature } = await signer.signTransaction(txBytes);
		expect(Uint8Array.from(Buffer.from(bytes, 'base64'))).toEqual(txBytes);
		expect(await signer.getPublicKey().verifyTransaction(txBytes, signature)).toBe(true);
	});

	it('signs personal messages that verify', async () => {
		const signer = await createEnclaveSigner({ tag: 'publisher', helper });
		const msg = new TextEncoder().encode('hi');
		const { signature } = await signer.signPersonalMessage(msg);
		expect(await signer.getPublicKey().verifyPersonalMessage(msg, signature)).toBe(true);
	});

	it('reloads the same key via load-or-generate', async () => {
		const a = await createEnclaveSigner({ tag: 'publisher', helper });
		const b = await createEnclaveSigner({ tag: 'publisher', helper });
		expect(b.getPublicKey().toSuiAddress()).toBe(a.getPublicKey().toSuiAddress());
	});

	it('loadEnclaveSigner returns null for unknown tags', async () => {
		expect(await loadEnclaveSigner({ tag: 'nope', helper })).toBeNull();
		await createEnclaveSigner({ tag: 'publisher', helper });
		const loaded = await loadEnclaveSigner({ tag: 'publisher', helper });
		expect(loaded).toBeInstanceOf(SecureEnclaveSigner);
	});

	it('lists and deletes tags', async () => {
		await createEnclaveSigner({ tag: 'alice', helper });
		await createEnclaveSigner({ tag: 'bob', helper });
		expect((await listEnclaveSigners({ helper })).sort()).toEqual(['alice', 'bob']);

		expect(await deleteEnclaveSigner({ tag: 'alice', helper })).toBe(true);
		expect(await deleteEnclaveSigner({ tag: 'alice', helper })).toBe(false);
		expect(await listEnclaveSigners({ helper })).toEqual(['bob']);
	});

	it('normalizes signatures to low-S', async () => {
		const signer = await createEnclaveSigner({ tag: 'publisher', helper });
		for (let i = 0; i < 20; i++) {
			const msg = new TextEncoder().encode(`m-${i}`);
			const { signature } = await signer.signPersonalMessage(msg);
			expect(await signer.getPublicKey().verifyPersonalMessage(msg, signature)).toBe(true);
		}
	});
});

describe('KeychainSigner (fake helper)', () => {
	let helper: ReturnType<typeof fakeHelper>;
	beforeEach(() => {
		helper = fakeHelper();
	});

	it('generates a random key and signs/verifies', async () => {
		const { signer, mnemonic } = await createKeychainSigner({ tag: 'publisher', helper });
		expect(mnemonic).toBeUndefined();
		expect(signer).toBeInstanceOf(KeychainSigner);

		const msg = new TextEncoder().encode('hi keychain');
		const { signature } = await signer.signPersonalMessage(msg);
		expect(await signer.getPublicKey().verifyPersonalMessage(msg, signature)).toBe(true);
	});

	it('imports an existing Bech32 and reproduces the same address', async () => {
		const source = new Secp256r1Keypair();
		const bech32 = source.getSecretKey();

		const { signer, mnemonic } = await createKeychainSigner({
			tag: 'imported-bech32',
			helper,
			seed: { source: 'bech32', bech32 },
		});
		expect(mnemonic).toBeUndefined();
		expect(signer.getPublicKey().toSuiAddress()).toBe(source.getPublicKey().toSuiAddress());
	});

	it('rejects a non-Secp256r1 Bech32', async () => {
		const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
		const edKey = new Ed25519Keypair();
		await expect(
			createKeychainSigner({
				tag: 'bad',
				helper,
				seed: { source: 'bech32', bech32: edKey.getSecretKey() },
			}),
		).rejects.toThrow(/Secp256r1/);
	});

	it('imports from a BIP39 mnemonic and reproduces the derived address', async () => {
		const mnemonic = generateMnemonic(englishWordlist, 256);
		const derived = Secp256r1Keypair.deriveKeypair(mnemonic);

		const { signer, mnemonic: returnedMnemonic } = await createKeychainSigner({
			tag: 'imported-mnemonic',
			helper,
			seed: { source: 'mnemonic', mnemonic },
		});
		expect(returnedMnemonic).toBeUndefined();
		expect(signer.getPublicKey().toSuiAddress()).toBe(derived.getPublicKey().toSuiAddress());
	});

	it('generates a mnemonic on demand and returns it once', async () => {
		const { signer, mnemonic } = await createKeychainSigner({
			tag: 'generated-mnemonic',
			helper,
			seed: { source: 'generate-mnemonic', wordCount: 24 },
		});
		expect(mnemonic).toBeTypeOf('string');
		expect(mnemonic!.split(/\s+/).length).toBe(24);

		// The mnemonic reproduces the same address
		const derived = Secp256r1Keypair.deriveKeypair(mnemonic!);
		expect(signer.getPublicKey().toSuiAddress()).toBe(derived.getPublicKey().toSuiAddress());

		// Reload from the helper (e.g. next process) — same address, no mnemonic returned
		const reloaded = await loadKeychainSigner({ tag: 'generated-mnemonic', helper });
		expect(reloaded!.getPublicKey().toSuiAddress()).toBe(signer.getPublicKey().toSuiAddress());
	});

	it('loadKeychainSigner returns null for unknown tags', async () => {
		expect(await loadKeychainSigner({ tag: 'nope', helper })).toBeNull();
	});

	it('lists and deletes', async () => {
		await createKeychainSigner({ tag: 'a', helper });
		await createKeychainSigner({ tag: 'b', helper });
		expect((await listKeychainSigners({ helper })).sort()).toEqual(['a', 'b']);

		expect(await deleteKeychainSigner({ tag: 'a', helper })).toBe(true);
		expect(await deleteKeychainSigner({ tag: 'a', helper })).toBe(false);
	});

	it('keeps enclave and keychain namespaces separate', async () => {
		await createEnclaveSigner({ tag: 'shared', helper });
		const { signer: keychainSigner } = await createKeychainSigner({ tag: 'shared', helper });
		const enclaveLoaded = await loadEnclaveSigner({ tag: 'shared', helper });

		expect(keychainSigner.getPublicKey().toSuiAddress()).not.toBe(
			enclaveLoaded!.getPublicKey().toSuiAddress(),
		);
		expect(await listEnclaveSigners({ helper })).toEqual(['shared']);
		expect(await listKeychainSigners({ helper })).toEqual(['shared']);
	});
});

describe('Cross-package: keypairFromP12 + importKeychainSigner', () => {
	it('a Bech32 from keyring-signer/recover round-trips through keychain import', async () => {
		const helper = fakeHelper();

		// Pretend a user exported a Secp256r1 keypair externally; the recover util
		// returns a Secp256r1Keypair whose Bech32 we can import.
		const external = new Secp256r1Keypair();
		const exportedBech32 = external.getSecretKey();

		const { signer } = await createKeychainSigner({
			tag: 'roundtrip',
			helper,
			seed: { source: 'bech32', bech32: exportedBech32 },
		});

		expect(signer.getPublicKey().toSuiAddress()).toBe(external.getPublicKey().toSuiAddress());

		// The scalar decoded from the Bech32 matches what the helper stored.
		const { secretKey } = decodeSuiPrivateKey(exportedBech32);
		expect(Array.from(helper.keychainKeys.get('roundtrip')!)).toEqual(Array.from(secretKey));
	});
});
