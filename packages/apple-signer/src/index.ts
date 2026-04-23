// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

// Helper protocol (advanced users / tests)
export type { AppleHelper, SubprocessHelperOptions } from './helper.js';
export { SubprocessHelper } from './helper.js';
export { resolveBinaryPath } from './binary-resolver.js';

// Signer classes
export { SecureEnclaveSigner, KeychainSigner } from './signer.js';

// Enclave mode — SE-backed, device-bound, not recoverable
export type {
	CreateEnclaveSignerOptions,
	DeleteEnclaveSignerOptions,
	ListEnclaveSignersOptions,
	LoadEnclaveSignerOptions,
} from './enclave.js';
export {
	createEnclaveSigner,
	deleteEnclaveSigner,
	listEnclaveSigners,
	loadEnclaveSigner,
} from './enclave.js';

// Keychain mode — software key in macOS Keychain, user-recoverable via UI
export type {
	CreateKeychainSignerOptions,
	CreateKeychainSignerResult,
	DeleteKeychainSignerOptions,
	KeychainSeed,
	ListKeychainSignersOptions,
	LoadKeychainSignerOptions,
} from './keychain.js';
export {
	createKeychainSigner,
	deleteKeychainSigner,
	listKeychainSigners,
	loadKeychainSigner,
} from './keychain.js';
