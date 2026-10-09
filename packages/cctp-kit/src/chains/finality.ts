// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ChainKey } from './types.js';

/** Expected wait for Circle's attestation, as an inclusive range in seconds. */
export interface FinalityEstimate {
	/** Standard transfer: time to source-chain finality. */
	standard: readonly [minSeconds: number, maxSeconds: number];
	/** Fast transfer (only on chains that support it as a source). */
	fast?: readonly [minSeconds: number, maxSeconds: number];
}

const MIN = 60;
const HOUR = 3600;
/** OP-stack and other L2s that wait for ~65 Ethereum blocks. */
const L1_FINALITY = [15 * MIN, 19 * MIN] as const;
const FAST_L2 = [5, 15] as const;

/**
 * Source: https://developers.circle.com/cctp/concepts/finality-and-block-confirmations
 * (fetched 2026-10-01). Testnets mirror mainnets. Sui is not listed by Circle yet; its
 * checkpoint finality is a few seconds and the burns Circle attested on 2026-10-01 agree.
 */
export const FINALITY_BY_CHAIN: Record<ChainKey, FinalityEstimate> = {
	sui: { standard: [3, 20] },
	solana: { standard: [20, 40], fast: [5, 15] },
	ethereum: { standard: L1_FINALITY, fast: [15, 30] },
	avalanche: { standard: [5, 12] },
	optimism: { standard: L1_FINALITY, fast: FAST_L2 },
	arbitrum: { standard: L1_FINALITY, fast: FAST_L2 },
	base: { standard: L1_FINALITY, fast: FAST_L2 },
	polygon: { standard: [5, 15] },
	unichain: { standard: L1_FINALITY, fast: FAST_L2 },
	linea: { standard: [6 * HOUR, 32 * HOUR], fast: FAST_L2 },
	codex: { standard: L1_FINALITY, fast: FAST_L2 },
	sonic: { standard: [5, 12] },
	worldchain: { standard: L1_FINALITY, fast: FAST_L2 },
	monad: { standard: [3, 10] },
	sei: { standard: [3, 10] },
	xdc: { standard: [8, 15] },
	hyperevm: { standard: [3, 10] },
	ink: { standard: [25 * MIN, 35 * MIN], fast: FAST_L2 },
	plume: { standard: L1_FINALITY, fast: FAST_L2 },
	arc: { standard: [1, 5] },
	edge: { standard: [16 * MIN, 21 * MIN], fast: FAST_L2 },
	injective: { standard: [1, 5] },
	morph: { standard: [20 * MIN, 30 * MIN], fast: FAST_L2 },
	pharos: { standard: [5, 12] },
	cronos: { standard: [1, 5] },
	plasma: { standard: [1, 5] },
	xlayer: { standard: L1_FINALITY, fast: FAST_L2 },
};
