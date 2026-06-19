// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@mysten/sui/cryptography';
import type { IdentifierString } from '@mysten/wallet-standard';
import { ReadonlyWalletAccount, SUI_CHAINS } from '@mysten/wallet-standard';

import type { ManagedAccount } from '../types.js';

const DEFAULT_FEATURES: IdentifierString[] = [
	'sui:signTransaction',
	'sui:signAndExecuteTransaction',
	'sui:signPersonalMessage',
];

/**
 * Resolve the wallet-standard chains to advertise for the given configured
 * network names. Each network is advertised as `sui:<name>` so dApp Kit's
 * chain-gated paths work for fork networks (`testnet-fork`, …) and custom
 * names, unioned with the standard {@link SUI_CHAINS} for safety. Standard
 * chains come first; configured-only chains are appended in the given order,
 * de-duplicated.
 */
export function chainsForNetworks(networks?: readonly string[]): `sui:${string}`[] {
	const chains: `sui:${string}`[] = [...SUI_CHAINS];
	const seen = new Set<string>(SUI_CHAINS);
	for (const network of networks ?? []) {
		const chain = `sui:${network}` as const;
		if (!seen.has(chain)) {
			seen.add(chain);
			chains.push(chain);
		}
	}
	return chains;
}

/**
 * Build a {@link ManagedAccount} from a signer, address, label, optional
 * feature list, and optional advertised chains. When `chains` is omitted the
 * account advertises the standard {@link SUI_CHAINS}; pass the configured
 * network names (via {@link chainsForNetworks}) so per-account advertised
 * chains include fork/custom networks too.
 */
export function buildManagedAccount(
	signer: Signer,
	address: string,
	label: string,
	features?: readonly IdentifierString[],
	chains?: readonly `sui:${string}`[],
): ManagedAccount {
	const walletAccount = new ReadonlyWalletAccount({
		address,
		label,
		publicKey: signer.getPublicKey().toSuiBytes(),
		chains: chains !== undefined ? [...chains] : [...SUI_CHAINS],
		features: [...(features ?? DEFAULT_FEATURES)],
	});
	return { address, label, signer, walletAccount };
}
