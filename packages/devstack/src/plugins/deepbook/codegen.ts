// Deepbook plugin — Codegenable contribution.
//
// One emit shape: `deepbook-network`. Mirrors the resolved value's
// stable identifiers (package id, registry id, per-pool ids).

import { Effect } from 'effect';

import type { CodegenableDecl } from '../../contracts/codegenable.ts';

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

export const makeDeepbookCodegenable = (
	bindings: DeepbookBindings,
): CodegenableDecl<'deepbook-network'> => ({
	kind: 'codegenable',
	emitterName: 'deepbook-network',
	outputPath: `deepbook/${bindings.name}.ts`,
	emit: (ctx) =>
		Effect.sync(() => {
			ctx.exportConst('deepbookBindings', bindings satisfies DeepbookBindings);
			return ctx.done();
		}),
});
