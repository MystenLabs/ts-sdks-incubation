// Deepbook plugin — Codegenable contribution.
//
// One emit shape: `deepbook-network`. Mirrors the resolved value's
// stable identifiers (package id, registry id, per-pool ids).

import { Effect } from 'effect';

import type { CodegenableDecl } from '../../contracts/codegenable.ts';

export interface DeepbookPoolBinding {
	readonly name: string;
	readonly poolId: string;
	readonly baseCoinType: string;
	readonly quoteCoinType: string;
}

export interface DeepbookBindings {
	readonly name: string;
	readonly chain: string;
	readonly packageId: string;
	readonly registryId: string;
	readonly adminCapId: string | null;
	readonly pools: ReadonlyArray<DeepbookPoolBinding>;
	readonly pyth: {
		readonly stateId: string;
		readonly wormholeStateId: string;
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
): CodegenableDecl<DeepbookBindings, 'deepbook-network'> => ({
	kind: 'codegenable',
	emitterName: 'deepbook-network',
	outputPath: `deepbook/${bindings.name}.ts`,
	emit: () =>
		Effect.sync(() => ({
			deepbookBindings: bindings satisfies DeepbookBindings,
		})),
});
