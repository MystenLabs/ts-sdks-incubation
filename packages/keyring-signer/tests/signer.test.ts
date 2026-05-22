// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { MemoryKeyringBackend } from '../src/backend.js';
import {
	createKeyringSignerWithBackend as createKeyringSigner,
	deleteKeyringSignerWithBackend as deleteKeyringSigner,
	exportKeyringSignerSecretWithBackend as exportKeyringSignerSecret,
	importKeyringSignerWithBackend as importKeyringSigner,
	listKeyringSignersWithBackend as listKeyringSigners,
	loadKeyringSignerWithBackend as loadKeyringSigner,
	type SupportedScheme,
} from '../src/signer.js';

const SCHEMES: SupportedScheme[] = ['ED25519', 'Secp256r1'];

describe('createKeyringSigner', () => {
	for (const scheme of SCHEMES) {
		it(`generates, persists, and reloads a ${scheme} key`, async () => {
			const backend = new MemoryKeyringBackend();
			const first = await createKeyringSigner({ scheme, tag: 'publisher', backend });
			expect(first.getKeyScheme()).toBe(scheme);

			const second = await createKeyringSigner({ scheme, tag: 'publisher', backend });
			expect(second.getPublicKey().toSuiAddress()).toBe(first.getPublicKey().toSuiAddress());
		});

		it(`signs transactions that verify against the ${scheme} public key`, async () => {
			const backend = new MemoryKeyringBackend();
			const signer = await createKeyringSigner({ scheme, tag: 'publisher', backend });
			const txBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

			const { bytes, signature } = await signer.signTransaction(txBytes);
			expect(Uint8Array.from(Buffer.from(bytes, 'base64'))).toEqual(txBytes);
			expect(await signer.getPublicKey().verifyTransaction(txBytes, signature)).toBe(true);
		});

		it(`signs personal messages that verify against the ${scheme} public key`, async () => {
			const backend = new MemoryKeyringBackend();
			const signer = await createKeyringSigner({ scheme, tag: 'publisher', backend });
			const message = new TextEncoder().encode('hello sui');

			const { signature } = await signer.signPersonalMessage(message);
			expect(await signer.getPublicKey().verifyPersonalMessage(message, signature)).toBe(true);
		});
	}

	it('namespaces by service', async () => {
		const backend = new MemoryKeyringBackend();
		const a = await createKeyringSigner({
			scheme: 'ED25519',
			tag: 'publisher',
			service: 'app-a',
			backend,
		});
		const b = await createKeyringSigner({
			scheme: 'ED25519',
			tag: 'publisher',
			service: 'app-b',
			backend,
		});
		expect(a.getPublicKey().toSuiAddress()).not.toBe(b.getPublicKey().toSuiAddress());
	});

	it('refuses to return an extractable private CryptoKey', async () => {
		const backend = new MemoryKeyringBackend();
		const signer = (await createKeyringSigner({
			scheme: 'ED25519',
			tag: 'publisher',
			backend,
		})) as unknown as { privateKey: CryptoKey };
		expect(signer.privateKey.extractable).toBe(false);
	});
});

describe('loadKeyringSigner', () => {
	it('returns null when nothing is stored', async () => {
		const backend = new MemoryKeyringBackend();
		expect(await loadKeyringSigner({ tag: 'missing', backend })).toBeNull();
	});

	it('returns the stored signer when present', async () => {
		const backend = new MemoryKeyringBackend();
		const created = await createKeyringSigner({
			scheme: 'Secp256r1',
			tag: 'publisher',
			backend,
		});
		const loaded = await loadKeyringSigner({ tag: 'publisher', backend });
		expect(loaded).not.toBeNull();
		expect(loaded!.getKeyScheme()).toBe('Secp256r1');
		expect(loaded!.getPublicKey().toSuiAddress()).toBe(created.getPublicKey().toSuiAddress());
	});
});

describe('listKeyringSigners', () => {
	it('returns tags for the given service, not secrets', async () => {
		const backend = new MemoryKeyringBackend();
		await createKeyringSigner({ scheme: 'ED25519', tag: 'alice', backend });
		await createKeyringSigner({ scheme: 'Secp256r1', tag: 'bob', backend });

		const tags = await listKeyringSigners({ backend });
		expect(tags.sort()).toEqual(['alice', 'bob']);
	});

	it('scopes results by service', async () => {
		const backend = new MemoryKeyringBackend();
		await createKeyringSigner({ scheme: 'ED25519', tag: 'alice', service: 'app-a', backend });
		await createKeyringSigner({ scheme: 'ED25519', tag: 'bob', service: 'app-b', backend });

		expect(await listKeyringSigners({ service: 'app-a', backend })).toEqual(['alice']);
		expect(await listKeyringSigners({ service: 'app-b', backend })).toEqual(['bob']);
	});
});

describe('importKeyringSigner', () => {
	it('persists an existing Bech32 secret key', async () => {
		const backend = new MemoryKeyringBackend();
		const source = await createKeyringSigner({ scheme: 'ED25519', tag: 'src', backend });
		const bech32 = (await exportKeyringSignerSecret({ tag: 'src', backend }))!;

		const imported = await importKeyringSigner({
			secretKey: bech32,
			tag: 'dst',
			backend,
		});
		expect(imported.getPublicKey().toSuiAddress()).toBe(source.getPublicKey().toSuiAddress());
	});

	it('refuses to overwrite by default', async () => {
		const backend = new MemoryKeyringBackend();
		await createKeyringSigner({ scheme: 'ED25519', tag: 'publisher', backend });
		const other = await createKeyringSigner({ scheme: 'ED25519', tag: 'other', backend });
		const otherBech32 = (await exportKeyringSignerSecret({ tag: 'other', backend }))!;
		await expect(
			importKeyringSigner({
				secretKey: otherBech32,
				tag: 'publisher',
				backend,
			}),
		).rejects.toThrow(/already exists/);
	});

	it('overwrites when overwrite: true', async () => {
		const backend = new MemoryKeyringBackend();
		await createKeyringSigner({ scheme: 'ED25519', tag: 'publisher', backend });
		const replacement = await createKeyringSigner({ scheme: 'ED25519', tag: 'tmp', backend });
		const replacementBech32 = (await exportKeyringSignerSecret({ tag: 'tmp', backend }))!;

		const imported = await importKeyringSigner({
			secretKey: replacementBech32,
			tag: 'publisher',
			backend,
			overwrite: true,
		});
		expect(imported.getPublicKey().toSuiAddress()).toBe(replacement.getPublicKey().toSuiAddress());
	});

	it('rejects Secp256k1 Bech32 secrets with a clear error', async () => {
		const backend = new MemoryKeyringBackend();
		// Bech32 encoding a valid Secp256k1 key is tedious; we verify via the decode path.
		// Using a minted k1 key from Sui's SDK:
		const { Secp256k1Keypair } = await import('@mysten/sui/keypairs/secp256k1');
		const k1 = new Secp256k1Keypair();
		await expect(
			importKeyringSigner({ secretKey: k1.getSecretKey(), tag: 'k1', backend }),
		).rejects.toThrow(/Secp256k1.*not supported/i);
	});
});

describe('deleteKeyringSigner + exportKeyringSignerSecret', () => {
	it('deletes entries and export returns null after', async () => {
		const backend = new MemoryKeyringBackend();
		await createKeyringSigner({ scheme: 'ED25519', tag: 'publisher', backend });

		const before = await exportKeyringSignerSecret({ tag: 'publisher', backend });
		expect(before).toMatch(/^suiprivkey/);

		expect(await deleteKeyringSigner({ tag: 'publisher', backend })).toBe(true);
		expect(await deleteKeyringSigner({ tag: 'publisher', backend })).toBe(false);
		expect(await exportKeyringSignerSecret({ tag: 'publisher', backend })).toBeNull();
	});
});
