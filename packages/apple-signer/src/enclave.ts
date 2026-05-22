// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getDefaultHelper } from './default-helper.js';
import type { AppleHelper } from './helper.js';
import { HelperError } from './helper.js';
import { SecureEnclaveSigner } from './signer.js';

export interface CreateEnclaveSignerOptions {
	/** Stable identifier for the Secure Enclave key. */
	tag: string;
	/**
	 * If true (default), the key's ACL requires biometric (Touch ID) on first
	 * use per helper lifetime. If false, signing is silent with no prompt.
	 * Only read when generating a fresh key — existing keys keep their ACL.
	 */
	requireBiometric?: boolean;
	/**
	 * Override the helper instance. Pass a mock to test without touching the
	 * real Secure Enclave. Defaults to a shared module-level subprocess helper
	 * that's reused across all factory calls in this Node process.
	 */
	helper?: AppleHelper;
}

export interface LoadEnclaveSignerOptions {
	tag: string;
	helper?: AppleHelper;
}

export interface DeleteEnclaveSignerOptions {
	tag: string;
	helper?: AppleHelper;
}

export interface ListEnclaveSignersOptions {
	helper?: AppleHelper;
}

/**
 * Load-or-generate a Secure-Enclave-backed signer at `tag`. If a key already
 * exists, its existing ACL is used and `requireBiometric` is ignored.
 */
export async function createEnclaveSigner(
	options: CreateEnclaveSignerOptions,
): Promise<SecureEnclaveSigner> {
	const helper = options.helper ?? (await getDefaultHelper());
	const existing = await tryEnclavePubkey(helper, options.tag);
	if (existing) {
		return new SecureEnclaveSigner(helper, options.tag, existing);
	}
	try {
		const { publicKey } = await helper.request<{ publicKey: string }>('enclave.generate', {
			tag: options.tag,
			requireBiometric: options.requireBiometric ?? true,
		});
		return new SecureEnclaveSigner(helper, options.tag, Buffer.from(publicKey, 'base64'));
	} catch (err) {
		// Concurrent caller won the race and created the key between our
		// pubkey-check and our generate. Reload instead of failing.
		if (err instanceof HelperError && err.code === 'already_exists') {
			const pubkey = await tryEnclavePubkey(helper, options.tag);
			if (pubkey) return new SecureEnclaveSigner(helper, options.tag, pubkey);
		}
		throw err;
	}
}

export async function loadEnclaveSigner(
	options: LoadEnclaveSignerOptions,
): Promise<SecureEnclaveSigner | null> {
	const helper = options.helper ?? (await getDefaultHelper());
	const publicKey = await tryEnclavePubkey(helper, options.tag);
	if (!publicKey) return null;
	return new SecureEnclaveSigner(helper, options.tag, publicKey);
}

export async function deleteEnclaveSigner(options: DeleteEnclaveSignerOptions): Promise<boolean> {
	const helper = options.helper ?? (await getDefaultHelper());
	const { deleted } = await helper.request<{ deleted: boolean }>('enclave.delete', {
		tag: options.tag,
	});
	return deleted;
}

export async function listEnclaveSigners(
	options: ListEnclaveSignersOptions = {},
): Promise<string[]> {
	const helper = options.helper ?? (await getDefaultHelper());
	const { tags } = await helper.request<{ tags: string[] }>('enclave.list', {});
	return tags;
}

async function tryEnclavePubkey(helper: AppleHelper, tag: string): Promise<Uint8Array | null> {
	try {
		const { publicKey } = await helper.request<{ publicKey: string }>('enclave.pubkey', { tag });
		return Uint8Array.from(Buffer.from(publicKey, 'base64'));
	} catch (err) {
		if (err instanceof HelperError && err.code === 'not_found') return null;
		throw err;
	}
}
