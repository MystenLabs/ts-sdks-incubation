// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SignatureScheme } from '@mysten/sui/cryptography';
import { Signer } from '@mysten/sui/cryptography';
import { Secp256r1PublicKey } from '@mysten/sui/keypairs/secp256r1';
import { p256 } from '@noble/curves/nist.js';

import type { AppleHelper } from './helper.js';

/**
 * Sui Signer backed by an Apple Secure Enclave P-256 (Secp256r1) key.
 *
 * The private key never leaves the Secure Enclave. The Swift helper holds a
 * single `LAContext` for its lifetime; the first sign operation triggers a
 * biometric (Touch ID) prompt and subsequent signs are silent. When the Node
 * process exits, the helper exits, the context is destroyed, and the next
 * process must re-authenticate.
 *
 * Not extractable by any user or any app — device-bound, no recovery.
 */
export class SecureEnclaveSigner extends Signer {
	readonly #helper: AppleHelper;
	readonly #tag: string;
	readonly #publicKey: Secp256r1PublicKey;

	constructor(helper: AppleHelper, tag: string, publicKey: Uint8Array) {
		super();
		this.#helper = helper;
		this.#tag = tag;
		this.#publicKey = new Secp256r1PublicKey(publicKey);
	}

	getKeyScheme(): SignatureScheme {
		return 'Secp256r1';
	}

	getPublicKey(): Secp256r1PublicKey {
		return this.#publicKey;
	}

	/** The tag the Secure Enclave key is stored under. */
	get tag(): string {
		return this.#tag;
	}

	async sign(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
		const { signature: derB64 } = await this.#helper.request<{ signature: string }>(
			'enclave.sign',
			{
				tag: this.#tag,
				digest: Buffer.from(bytes).toString('base64'),
			},
		);
		return lowSCompactFromDer(derB64);
	}
}

/**
 * Sui Signer backed by a P-256 (Secp256r1) key stored in the macOS Keychain.
 *
 * Unlike {@link SecureEnclaveSigner}, the key is a software key in the user's
 * login keychain rather than inside the Secure Enclave chip. Trade-offs:
 *
 * - ✅ The **user can export** the key as a password-encrypted `.p12` via
 *   Keychain Access.app. Useful for backup, migration, or moving the key to
 *   the Sui CLI.
 * - ❌ Not hardware-attested — a software key, stored encrypted at rest by
 *   macOS, but reconstructable by any process that can satisfy the keychain
 *   ACL (the helper itself has silent sign access by being the creator).
 *
 * Biometric gating, helper lifecycle, and per-process prompt behavior are
 * identical to {@link SecureEnclaveSigner}.
 */
export class KeychainSigner extends Signer {
	readonly #helper: AppleHelper;
	readonly #tag: string;
	readonly #publicKey: Secp256r1PublicKey;

	constructor(helper: AppleHelper, tag: string, publicKey: Uint8Array) {
		super();
		this.#helper = helper;
		this.#tag = tag;
		this.#publicKey = new Secp256r1PublicKey(publicKey);
	}

	getKeyScheme(): SignatureScheme {
		return 'Secp256r1';
	}

	getPublicKey(): Secp256r1PublicKey {
		return this.#publicKey;
	}

	/** The tag the keychain key is stored under. */
	get tag(): string {
		return this.#tag;
	}

	async sign(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
		const { signature: derB64 } = await this.#helper.request<{ signature: string }>(
			'keychain.sign',
			{
				tag: this.#tag,
				digest: Buffer.from(bytes).toString('base64'),
			},
		);
		return lowSCompactFromDer(derB64);
	}
}

/**
 * Convert a DER-encoded ECDSA signature (from the helper) to compact `r||s`
 * with low-S normalization, as Sui's Secp256r1 verifier requires.
 */
function lowSCompactFromDer(derBase64: string): Uint8Array<ArrayBuffer> {
	const der = Buffer.from(derBase64, 'base64');
	const sig = p256.Signature.fromBytes(new Uint8Array(der), 'der');
	const normalized = sig.hasHighS() ? new p256.Signature(sig.r, p256.Point.Fn.neg(sig.s)) : sig;
	const out = new Uint8Array(new ArrayBuffer(64));
	out.set(normalized.toBytes('compact'));
	return out;
}
