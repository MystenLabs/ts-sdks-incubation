// Coin plugin — Codegenable contribution.
//
// Distilled-doc 13-coin.md §"Files written": the codegen orchestrator
// projects the per-stack CoinRegistry into a generated `coins.ts`
// table:
//
//   export const coins = {
//     mUSDC: { type, decimals, sdkCoin, symbol, ... },
//     mWETH: { type, decimals, sdkCoin, symbol, ... },
//   } as const;
//   export type CoinName = keyof typeof coins;
//
// This file declares the SEAM — the typed binding shape and the
// per-coin contribution. The heavy lift (writing the bytes, merging
// all coins into one file) happens in the codegen orchestrator
// (plugin/codegen layer, NOT this plugin); it walks every member's
// caps tuple, finds the Coin-emitted contributions, and emits ONE
// `coins.ts` referencing every entry.
//
// Per-coin shape mirrors the v3 `CoinEntry` (manifest schema) sans
// the `sdkCoin` runtime projection — that lives in the SDK adapter
// at codegen time, not in the binding shape.

import { Effect } from 'effect';

import type { CodegenableDecl } from '../../contracts/codegenable.ts';

/** The typed shape per emitted coin record. Downstream consumers
 *  see this exact shape via `EmittedFor<Caps, \`coin/${Symbol}\`>`
 *  at the `defineDevstack` call site. */
export interface CoinBindings {
	readonly symbol: string;
	readonly fullCoinType: string;
	readonly decimals: number;
	readonly displayName?: string;
	readonly iconUrl?: string;
	readonly treasuryCapId?: string;
	readonly metadataId?: string;
	readonly packageId?: string;
	readonly source: 'registry' | 'on-chain' | 'builtin';
}

/** Construct the Codegenable contribution for one coin instance.
 *
 *  Emitter name is literal `coin/${symbol}` so the orchestrator can
 *  group them and folds them into a single `coins.ts` at staging
 *  time. Mirrors `account/${name}` naming in the Account plugin. */
export const makeCoinCodegen = <Symbol extends string>(parts: {
	readonly symbol: Symbol;
	readonly resolved: CoinBindings;
}): CodegenableDecl<CoinBindings, `coin/${Symbol}`> => ({
	kind: 'codegenable',
	emitterName: `coin/${parts.symbol}` as `coin/${Symbol}`,
	outputPath: `coins/${parts.symbol}.ts`,
	sensitive: false,
	emit: () =>
		Effect.sync(() => ({
			[parts.symbol]: parts.resolved,
		})),
});
