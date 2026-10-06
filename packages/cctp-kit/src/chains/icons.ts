// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ChainKey } from './types.js';

/**
 * Default chain icons, served from DefiLlama's public icon CDN. Hosts with a strict CSP
 * need `img-src https://icons.llamao.fi`, or can override any entry (or set it to `null`
 * for a text monogram) through `createCctpKit({ icons })`.
 */
const LLAMA = 'https://icons.llamao.fi/icons/chains';

export const DEFAULT_CHAIN_ICONS: Record<ChainKey, string | null> = {
	sui: `${LLAMA}/rsz_sui.jpg`,
	solana: `${LLAMA}/rsz_solana.jpg`,
	ethereum: `${LLAMA}/rsz_ethereum.jpg`,
	avalanche: `${LLAMA}/rsz_avalanche.jpg`,
	optimism: `${LLAMA}/rsz_optimism.jpg`,
	arbitrum: `${LLAMA}/rsz_arbitrum.jpg`,
	base: `${LLAMA}/rsz_base.jpg`,
	polygon: `${LLAMA}/rsz_polygon.jpg`,
	unichain: `${LLAMA}/rsz_unichain.jpg`,
	linea: `${LLAMA}/rsz_linea.jpg`,
	codex: `${LLAMA}/rsz_codex.jpg`,
	sonic: `${LLAMA}/rsz_sonic.jpg`,
	worldchain: `${LLAMA}/rsz_world%20chain.jpg`,
	monad: `${LLAMA}/rsz_monad.jpg`,
	sei: `${LLAMA}/rsz_sei.jpg`,
	xdc: `${LLAMA}/rsz_xdc.jpg`,
	hyperevm: `${LLAMA}/rsz_hyperliquid.jpg`,
	ink: `${LLAMA}/rsz_ink.jpg`,
	plume: `${LLAMA}/rsz_plume.jpg`,
	arc: `${LLAMA}/rsz_arc.jpg`,
	// No public icon available at the time of writing; falls back to a monogram.
	edge: null,
	injective: `${LLAMA}/rsz_injective.jpg`,
	morph: `${LLAMA}/rsz_morph.jpg`,
	pharos: `${LLAMA}/rsz_pharos.jpg`,
	cronos: `${LLAMA}/rsz_cronos.jpg`,
	plasma: `${LLAMA}/rsz_plasma.jpg`,
	xlayer: `${LLAMA}/rsz_x%20layer.jpg`,
};
