// Deepbook plugin — Codegenable contribution.
//
// One emit shape: `deepbook-network`. Mirrors the resolved value's
// stable identifiers (package id, registry id, per-pool ids).

import type { CodegenableDecl } from '../../contracts/codegenable.ts';

import { defineSimpleConstExport } from '../internal/codegen-helpers.ts';

export interface DeepbookPoolBinding {
	readonly name: string;
	readonly poolId: string;
	readonly base: string;
	readonly quote: string;
	readonly baseCoinType: string;
	readonly quoteCoinType: string;
}

export interface DeepbookBindings {
	readonly name: string;
	readonly chain: string;
	readonly packageId: string;
	readonly registryId: string;
	readonly adminCapId: string | null;
	readonly deepTreasuryId: string | null;
	readonly pools: ReadonlyArray<DeepbookPoolBinding>;
	readonly pyth: {
		readonly packageId: string | null;
		readonly stateId: string | null;
		readonly wormholeStateId: string | null;
		readonly feeds: ReadonlyArray<{
			readonly symbol: string;
			readonly feedId: string;
			readonly priceInfoObjectId: string;
			readonly price: string;
			readonly expo: number;
		}>;
	} | null;
	readonly margin: {
		readonly packageId: string;
		readonly registryId: string;
	} | null;
	readonly serverUrl: string | null;
	readonly indexerUrl: string | null;
}

/** Build the Codegenable contribution for a deepbook instance.
 *
 *  Name-keyed sibling aggregate (mirrors `coin/codegen.ts`): every
 *  deepbook instance folds into a single `generated/deepbook.ts`
 *  exporting `export const deepbook = { <name>: DeepbookBindings, ... }`.
 *  Consumers read `deepbook.<name>`. `aggregateOnly` — no standalone
 *  per-instance file. */
export const makeDeepbookCodegenable = (
	bindings: DeepbookBindings,
): CodegenableDecl<`deepbook/${string}`> =>
	defineSimpleConstExport({
		emitterName: `deepbook/${bindings.name}` as `deepbook/${string}`,
		outputPath: `deepbook/${bindings.name}.ts`,
		exportName: bindings.name,
		value: bindings,
		aggregateOnly: true,
		aggregate: {
			kind: 'deepbook',
			bucket: 'deepbook.ts',
			// This decl's exported map keys by instance name — the
			// aggregate's merge key.
			project: (exported) => exported,
		},
	});
