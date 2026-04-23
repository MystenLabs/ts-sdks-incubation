// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SignatureScheme } from '@mysten/sui/cryptography';
import { Signer } from '@mysten/sui/cryptography';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';

/**
 * Ed25519 signer backed by a non-extractable Web Crypto `CryptoKey`.
 *
 * The private key is held as an opaque `CryptoKey` handle — `crypto.subtle.sign`
 * is the only way to use it, and the raw bytes cannot be read back by any code
 * in the same process. This is a meaningful but not absolute boundary (V8
 * internals and debuggers can still inspect backing memory).
 */
export class Ed25519WebCryptoSigner extends Signer {
	readonly privateKey: CryptoKey;
	readonly #publicKey: Ed25519PublicKey;

	constructor(privateKey: CryptoKey, publicKey: Uint8Array) {
		super();
		if (privateKey.extractable) {
			throw new Error(
				'Ed25519WebCryptoSigner refuses extractable private keys — import with extractable:false',
			);
		}
		this.privateKey = privateKey;
		this.#publicKey = new Ed25519PublicKey(publicKey);
	}

	getKeyScheme(): SignatureScheme {
		return 'ED25519';
	}

	getPublicKey(): Ed25519PublicKey {
		return this.#publicKey;
	}

	async sign(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
		const raw = await globalThis.crypto.subtle.sign(
			'Ed25519',
			this.privateKey,
			bytes as BufferSource,
		);
		return new Uint8Array(raw) as Uint8Array<ArrayBuffer>;
	}
}
