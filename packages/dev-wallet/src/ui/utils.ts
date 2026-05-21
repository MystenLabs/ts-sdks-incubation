// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { normalizeStructTag, parseStructTag } from '@mysten/sui/utils';

const NORMALIZED_SUI_COIN_TYPE =
	'0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

const NORMALIZED_COIN_PREFIX =
	'0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<';

export function isSuiCoinType(coinType: string): boolean {
	try {
		return normalizeStructTag(coinType) === NORMALIZED_SUI_COIN_TYPE;
	} catch {
		return false;
	}
}

export function formatAddress(address: string): string {
	if (address.length <= 16) return address;
	return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

export function getCoinSymbol(coinType: string): string {
	try {
		const tag = parseStructTag(coinType);
		return tag.name;
	} catch {
		return coinType;
	}
}

/**
 * Subset of the generated `coins.ts` entry shape that the UI needs for
 * formatting and labelling. Matches the manifest `CoinEntry` shape emitted
 * by `StackHandleEmitter` (`coins.ts`) so consumers can pass the generated
 * `coins` record directly. Kept structurally-typed (no devstack import —
 * dev-wallet must not depend on the devstack package).
 */
export interface CoinManifestEntry {
	readonly type: string;
	readonly decimals: number;
	readonly symbol?: string;
	readonly displayName?: string;
	readonly iconUrl?: string;
}

/** A record keyed by coin name (e.g. `'mUSDC'`) mapping to entry metadata.
 *  Pass the generated `coins` constant — `<DevWalletPanel coins={coins} />`
 *  — to pre-seed UI metadata and skip per-coin RPC fetches on UI load. */
export type CoinRecord = Readonly<Record<string, CoinManifestEntry>>;

/** Build a fast `coinType → entry` lookup from the name-keyed generated
 *  record. Normalizes coin-type strings so callers can hit it with either
 *  the short (`0x2::sui::SUI`) or fully-padded form. */
export function indexCoinsByType(
	coins: CoinRecord | null | undefined,
): ReadonlyMap<string, CoinManifestEntry> {
	const map = new Map<string, CoinManifestEntry>();
	if (!coins) return map;
	for (const entry of Object.values(coins)) {
		try {
			map.set(normalizeStructTag(entry.type), entry);
		} catch {
			map.set(entry.type, entry);
		}
	}
	return map;
}

/** Look up a coin's metadata by its on-chain type string. Both the input
 *  `coinType` and the index entries are matched on their normalized form
 *  so callers don't have to canonicalize. Returns `undefined` for unknown
 *  coins — the caller decides whether to fall back to an RPC fetch. */
export function lookupCoinByType(
	index: ReadonlyMap<string, CoinManifestEntry>,
	coinType: string,
): CoinManifestEntry | undefined {
	try {
		return index.get(normalizeStructTag(coinType));
	} catch {
		return index.get(coinType);
	}
}

/** Check if a type string is a Coin wrapper (0x2::coin::Coin<...>) */
export function isCoinType(type: string): boolean {
	try {
		return normalizeStructTag(type).startsWith(NORMALIZED_COIN_PREFIX);
	} catch {
		return false;
	}
}

/** Extract the short struct name from a full Move type string */
export function getTypeName(type: string): string {
	try {
		return parseStructTag(type).name;
	} catch {
		return type;
	}
}

export async function copyToClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

export const NETWORK_COLORS: Record<string, string> = {
	mainnet: '#f97316',
	testnet: '#22c55e',
	devnet: '#3b82f6',
	localnet: '#6b7280',
	// Fork variants render an amber stripe so the operator can't mistake
	// a forked stack for the real upstream at a glance. Same hue family
	// as the mainnet orange but pushed warmer/yellower for contrast.
	'mainnet-fork': '#eab308',
	'testnet-fork': '#eab308',
	'devnet-fork': '#eab308',
};

/** Returns true when the network literal names a fork-mode runtime.
 *  Used by the badge + accounts panel + signing modal to surface the
 *  "no real chain" caveat — Phase 4 P4.17-P4.20. */
export function isForkNetwork(network: string): boolean {
	return network.endsWith('-fork');
}

export interface PairableAdapter {
	readonly isPaired: boolean;
}

export function isPairableAdapter(adapter: unknown): adapter is PairableAdapter {
	return adapter != null && typeof adapter === 'object' && 'isPaired' in adapter;
}

/** Dispatch a composed, bubbling custom event from a host element. */
export function emitEvent(host: HTMLElement, name: string, detail?: unknown): void {
	host.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
}

/** Clone a Set and toggle an item in/out of it. */
export function toggleSetItem<T>(set: Set<T>, item: T): Set<T> {
	const next = new Set(set);
	if (next.has(item)) {
		next.delete(item);
	} else {
		next.add(item);
	}
	return next;
}

/** Extract a user-facing error message, with a fallback for non-Error throws. */
export function getErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export { getNetworkFromChain } from '../wallet/constants.js';

/** Find the adapter that owns a given address. */
export function findAdapterForAddress<T extends { getAccount(address: string): unknown }>(
	adapters: readonly T[],
	address: string,
): T | undefined {
	return adapters.find((a) => a.getAccount(address) !== undefined);
}

export function formatCoinBalance(balance: string | bigint, decimals: number): string {
	if (decimals === 0) return balance.toString();

	const value = typeof balance === 'string' ? BigInt(balance) : balance;
	const divisor = BigInt(10 ** decimals);
	const whole = value / divisor;
	const fraction = value % divisor;

	if (fraction === 0n) return whole.toString();
	const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
	return `${whole}.${fractionStr}`;
}
