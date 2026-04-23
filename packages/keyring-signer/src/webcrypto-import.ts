// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@mysten/sui/cryptography';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { WebCryptoSigner } from '@mysten/signers/webcrypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';

import { Ed25519WebCryptoSigner } from './ed25519-signer.js';

// PKCS#8 envelope prefix for a 32-byte Ed25519 seed (RFC 8410).
const ED25519_PKCS8_PREFIX = new Uint8Array([
	0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/**
 * Parse a Sui Bech32 secret key (`suiprivkey...`) and return a signer whose
 * private key is held as a non-extractable Web Crypto `CryptoKey`. The scalar
 * bytes are zero-filled as soon as the import completes.
 *
 * Supports Sui's `ED25519` and `Secp256r1` schemes. Other schemes throw — they
 * can't be represented as non-extractable Web Crypto keys in Node.
 */
export async function signerFromBech32(bech32: string): Promise<Signer> {
	const { scheme, secretKey } = decodeSuiPrivateKey(bech32);
	try {
		switch (scheme) {
			case 'ED25519':
				return await importEd25519(secretKey);
			case 'Secp256r1':
				return await importSecp256r1(secretKey);
			default:
				throw new Error(
					`keyring-signer: scheme "${scheme}" is not supported. ` +
						`Supported schemes are ED25519 and Secp256r1.`,
				);
		}
	} finally {
		secretKey.fill(0);
	}
}

async function importEd25519(seed: Uint8Array): Promise<Ed25519WebCryptoSigner> {
	const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
	pkcs8.set(ED25519_PKCS8_PREFIX, 0);
	pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);

	let privateKey: CryptoKey;
	try {
		privateKey = await globalThis.crypto.subtle.importKey(
			'pkcs8',
			pkcs8,
			{ name: 'Ed25519' },
			false,
			['sign'],
		);
	} finally {
		pkcs8.fill(0);
	}

	return new Ed25519WebCryptoSigner(privateKey, ed25519.getPublicKey(seed));
}

async function importSecp256r1(scalar: Uint8Array): Promise<WebCryptoSigner> {
	const uncompressed = p256.getPublicKey(scalar, false); // 65 bytes: 0x04 || X(32) || Y(32)
	const x = uncompressed.slice(1, 33);
	const y = uncompressed.slice(33, 65);

	const jwk: JsonWebKey = {
		kty: 'EC',
		crv: 'P-256',
		d: base64url(scalar),
		x: base64url(x),
		y: base64url(y),
		ext: false,
	};

	let privateKey: CryptoKey;
	try {
		privateKey = await globalThis.crypto.subtle.importKey(
			'jwk',
			jwk,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['sign'],
		);
	} finally {
		jwk.d = '';
	}

	return WebCryptoSigner.import({
		privateKey,
		publicKey: compressSecp256r1Pub(x, y),
	});
}

function compressSecp256r1Pub(x: Uint8Array, y: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(new ArrayBuffer(33));
	out[0] = (y[31]! & 1) === 0 ? 0x02 : 0x03;
	out.set(x, 1);
	return out;
}

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64url');
}
