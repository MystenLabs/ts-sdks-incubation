// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@mysten/sui/cryptography';
import type { ReadonlyWalletAccount } from '@mysten/wallet-standard';

/**
 * Descriptor for a custom wallet panel mounted as a tab in the
 * built-in floating panel and standalone wallet UIs.
 *
 * The wallet renders the panel by creating an element of `tagName` and
 * setting `.wallet` (the {@link DevWallet} instance), `.activeAddress`,
 * and `.client` (the {@link ClientWithCoreApi} for the active network)
 * properties. Panel authors register a custom element ahead of time
 * (typically via `@customElement('my-panel')`) and reference its tag
 * here.
 */
export interface WalletPanelDescriptor {
	/** Unique panel id; becomes the tab id and persists with `activeTab`. */
	id: string;
	/** Visible label in the tab bar. Keep short (≤ 8 chars) for narrow drawers. */
	label: string;
	/** Optional inline SVG markup for the tab icon. Plain string — rendered
	 * with Lit's `unsafeHTML` directive. Omit to fall back to a generic icon. */
	icon?: string;
	/** Custom element tag name, e.g. `'devstack-faucet-panel'`. The element
	 * must be registered (decorated with `@customElement`) before the wallet
	 * mounts; use side-effect imports in your registration entrypoint. */
	tagName: string;
}

export interface ManagedAccount {
	address: string;
	label: string;
	signer: Signer;
	walletAccount: ReadonlyWalletAccount;
}

export interface CreateAccountOptions {
	label?: string;
	[key: string]: unknown;
}

export interface ImportAccountOptions {
	/** Keypair to import — used by adapters that accept raw keypairs. */
	signer?: Signer;
	/** Address to import — used by adapters that look up keys from an external source (e.g. CLI keystore). */
	address?: string;
	label?: string;
}

/**
 * Pluggable interface for managing accounts and providing signers to a {@link DevWallet}.
 * Implementations handle key generation, storage, and lifecycle.
 */
export interface SignerAdapter {
	readonly id: string;
	readonly name: string;
	/**
	 * Whether accounts from this adapter are eligible for auto-signing.
	 * Defaults to `true`. CLI-based adapters set this to `false` to ensure
	 * transactions always require explicit user approval.
	 */
	readonly allowAutoSign?: boolean;

	/** Load keys from storage. Must be called before use. */
	initialize(): Promise<void>;
	getAccounts(): ManagedAccount[];
	getAccount(address: string): ManagedAccount | undefined;

	createAccount?(options?: CreateAccountOptions): Promise<ManagedAccount>;
	importAccount?(options: ImportAccountOptions): Promise<ManagedAccount>;
	/** List accounts available for import (e.g. from a CLI keystore). */
	listAvailableAccounts?(): Promise<
		Array<{ address: string; scheme: string; alias?: string | null }>
	>;
	removeAccount?(address: string): Promise<boolean>;
	renameAccount?(address: string, label: string): Promise<boolean>;

	/** Subscribe to account list changes. Returns an unsubscribe function. */
	onAccountsChanged(callback: (accounts: ManagedAccount[]) => void): () => void;
	destroy(): void;
}
