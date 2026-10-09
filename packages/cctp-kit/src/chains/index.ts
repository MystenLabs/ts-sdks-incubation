// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { EVM_MAINNET_CHAINS, EVM_TESTNET_CHAINS } from './evm.js';
import { DEFAULT_CHAIN_ICONS } from './icons.js';
import { SOLANA_DEVNET, SOLANA_MAINNET } from './solana.js';
import { SUI_MAINNET, SUI_TESTNET } from './sui.js';
import type { ChainDefinition, ChainKey, Network } from './types.js';

export * from './types.js';
export { EVM_MAINNET_CHAINS, EVM_TESTNET_CHAINS } from './evm.js';
export { SUI_MAINNET, SUI_TESTNET } from './sui.js';
export { SOLANA_DEVNET, SOLANA_MAINNET } from './solana.js';
export { DEFAULT_CHAIN_ICONS } from './icons.js';
export { FINALITY_BY_CHAIN } from './finality.js';
export type { FinalityEstimate } from './finality.js';

export interface AllowDeny<T> {
	allow?: T[];
	deny?: T[];
}

export interface ChainFilter extends AllowDeny<ChainKey> {
	/** Restrictions that only apply to the source side. */
	from?: AllowDeny<ChainKey>;
	/** Restrictions that only apply to the destination side. */
	to?: AllowDeny<ChainKey>;
}

export type Direction = 'both' | 'inflow' | 'outflow';

export interface RpcOverrides {
	/** Per chain: a single URL or an ordered fallback list. */
	urls?: Partial<Record<ChainKey, string | string[]>>;
	/** `prepend` (default) puts overrides ahead of the built-in list; `replace` drops the built-ins. */
	mode?: 'prepend' | 'replace';
}

export function getChainRegistry(network: Network): ChainDefinition[] {
	const chains =
		network === 'mainnet'
			? [SUI_MAINNET, SOLANA_MAINNET, ...EVM_MAINNET_CHAINS]
			: [SUI_TESTNET, SOLANA_DEVNET, ...EVM_TESTNET_CHAINS];
	return applyChainIcons(chains);
}

export type ChainIconOverrides = Partial<Record<ChainKey, string | null>>;

/** Attach icons: built-in defaults first, then host overrides (`null` forces a monogram). */
export function applyChainIcons(
	chains: ChainDefinition[],
	overrides: ChainIconOverrides = {},
): ChainDefinition[] {
	return chains.map((chain) => {
		const override = overrides[chain.key];
		const icon = override === undefined ? DEFAULT_CHAIN_ICONS[chain.key] : override;
		return { ...chain, icon: icon ?? undefined };
	});
}

export function applyRpcOverrides(
	chains: ChainDefinition[],
	overrides?: RpcOverrides,
): ChainDefinition[] {
	if (!overrides?.urls) return chains;
	const mode = overrides.mode ?? 'prepend';
	return chains.map((chain) => {
		const override = overrides.urls?.[chain.key];
		if (!override) return chain;
		const urls = Array.isArray(override) ? override : [override];
		const rpcUrls = mode === 'replace' ? urls : [...urls, ...chain.rpcUrls];
		if (chain.ecosystem === 'evm') {
			return {
				...chain,
				rpcUrls,
				viemChain: {
					...chain.viemChain,
					rpcUrls: { ...chain.viemChain.rpcUrls, default: { http: rpcUrls } },
				},
			};
		}
		return { ...chain, rpcUrls };
	});
}

function passes(key: ChainKey, filter?: AllowDeny<ChainKey>): boolean {
	if (!filter) return true;
	if (filter.allow && !filter.allow.includes(key)) return false;
	if (filter.deny && filter.deny.includes(key)) return false;
	return true;
}

export interface ResolvedRoutes {
	/** Chains selectable as the source. */
	from: ChainDefinition[];
	/** Chains selectable as the destination. */
	to: ChainDefinition[];
}

/**
 * Resolve the chains that may appear on each side of the form. Sui is always on exactly
 * one side of a route: `inflow` means every route ends on Sui, `outflow` means every route
 * starts on Sui, and `both` allows either orientation (but never Sui → Sui).
 */
export function resolveRoutes(
	chains: ChainDefinition[],
	direction: Direction = 'both',
	filter?: ChainFilter,
): ResolvedRoutes {
	const sui = chains.filter((c) => c.ecosystem === 'sui');
	const others = chains.filter((c) => c.ecosystem !== 'sui');

	const allowed = (side: 'from' | 'to') => (c: ChainDefinition) =>
		passes(c.key, filter) && passes(c.key, filter?.[side]);

	const nonSuiFrom = others.filter(allowed('from'));
	const nonSuiTo = others.filter(allowed('to'));

	switch (direction) {
		case 'inflow':
			return { from: nonSuiFrom, to: sui };
		case 'outflow':
			return { from: sui, to: nonSuiTo };
		default:
			return { from: [...sui, ...nonSuiFrom], to: [...sui, ...nonSuiTo] };
	}
}

/** Which side of the form Sui occupies for the current selection. */
export function suiSideFor(from: ChainKey): 'from' | 'to' {
	return from === 'sui' ? 'from' : 'to';
}

/**
 * The non-Sui chains the user may pick for the current orientation: destinations when Sui
 * is the source, sources otherwise.
 */
export function counterpartOptionsFor(routes: ResolvedRoutes, from: ChainKey): ChainDefinition[] {
	if (from === 'sui') return routes.to.filter((c) => c.key !== 'sui');
	return routes.from.filter((c) => c.key !== 'sui');
}

/** Destinations that are valid for a given source under the resolved routes. */
export function destinationsFor(routes: ResolvedRoutes, from: ChainKey): ChainDefinition[] {
	if (from === 'sui') return routes.to.filter((c) => c.key !== 'sui');
	return routes.to.filter((c) => c.key === 'sui');
}

export function findChain(chains: ChainDefinition[], key: ChainKey): ChainDefinition {
	const chain = chains.find((c) => c.key === key);
	if (!chain) throw new Error(`Unknown chain "${key}"`);
	return chain;
}

export function findChainByDomain(
	chains: ChainDefinition[],
	domain: number,
): ChainDefinition | undefined {
	return chains.find((c) => c.domain === domain);
}
