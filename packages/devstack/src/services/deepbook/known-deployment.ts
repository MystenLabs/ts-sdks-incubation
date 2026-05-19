// `deepbookKnownPackage(opts)` — point `DeepbookCoreTag` at an already-
// deployed deepbook-v3 instance (canonical testnet/mainnet, or any
// caller-supplied id pair). Does NOT provide `DeepbookAdminTag` (we don't
// own the cap) or `DeepbookMarketMaker` (no balance manager to set up
// here). Stack `deepbookMarketMaker(...)` separately for makers running
// against a known package.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Effect } from 'effect';
import { provide } from '../../advanced/tag.js';
import { publishDeepbookState } from '../../engine/registries.js';
import { DeepbookCoreTag, type DeepbookCore } from '../deepbook.js';
import { knownDeployments, type KnownNetwork } from '../../engine/known-deployments.js';
import { makeFindPool, type DeepbookPool } from './internal.js';

export interface DeepbookKnownPackageOptions {
	readonly network?: KnownNetwork;
	readonly packageId?: string;
	readonly registryId?: string;
	readonly pools?: ReadonlyArray<{
		readonly name: string;
		readonly poolId: string;
		readonly baseType: string;
		readonly quoteType: string;
	}>;
}

/**
 * Point `DeepbookCoreTag` at an already-deployed deepbook-v3 instance
 * (canonical testnet/mainnet, or any caller-supplied id pair). Does NOT
 * provide `DeepbookAdminTag` (we don't own the cap) or `DeepbookMarketMaker`
 * (no balance manager to set up here). Stack `deepbookMarketMaker(...)`
 * separately for makers running against a known package.
 */
export const deepbookKnownPackage = (opts: DeepbookKnownPackageOptions) => {
	const deployment =
		opts.network !== undefined ? knownDeployments.deepbook[opts.network] : undefined;
	const packageId = opts.packageId ?? deployment?.packageId;
	const registryId = opts.registryId ?? deployment?.registryId;

	if (packageId === undefined || registryId === undefined) {
		throw new Error(
			'deepbookKnownPackage: no packageId/registryId could be resolved. Pass ' +
				'`network` (e.g. `"testnet"`) for a canonical deployment, or supply ' +
				'`packageId` + `registryId` explicitly.',
		);
	}

	// SDK-aligned `packageIds` view. Sourced from the registry's
	// camelCase entry when the caller passed `network`; falls back to
	// explicit ids (with empty strings + undefineds for the optional
	// fields) when only `packageId`/`registryId` were supplied.
	const packageIds: DeepbookCore['packageIds'] = {
		DEEPBOOK_PACKAGE_ID: packageId,
		REGISTRY_ID: registryId,
		DEEP_TREASURY_ID: deployment?.deepTreasuryId ?? '',
		MARGIN_PACKAGE_ID: deployment?.marginPackageId,
		MARGIN_REGISTRY_ID: deployment?.marginRegistryId,
		LIQUIDATION_PACKAGE_ID: deployment?.liquidationPackageId,
	};

	const staticPools = opts.pools ?? [];
	const fakeDeepbookPools: Record<string, DeepbookPool> = {};
	for (const p of staticPools) {
		fakeDeepbookPools[p.name] = {
			name: p.name,
			poolId: p.poolId,
			base: p.baseType,
			quote: p.quoteType,
			// Tick/lot/min not known from the registry — known-package
			// consumers carry these themselves (e.g. inside
			// `deepbookMarketMaker.pools[]`).
			tickSize: 0n,
			lotSize: 0n,
			minSize: 0n,
		};
	}
	const poolIds = new Map<string, string>(staticPools.map((p) => [p.name, p.poolId]));
	const findPool = makeFindPool('deepbookKnownPackage', fakeDeepbookPools);

	return provide(
		DeepbookCoreTag,
		Effect.gen(function* () {
			yield* Effect.annotateCurrentSpan({
				'deepbook.packageId': packageId,
				'deepbook.registryId': registryId,
				'deepbook.poolCount': staticPools.length,
			});
			yield* publishDeepbookState({
				name: opts.network ?? 'deepbookKnownPackage',
				packageId,
				registryId,
				pools: Object.fromEntries(
					staticPools.map((p) => [
						p.name,
						{ poolId: p.poolId, baseType: p.baseType, quoteType: p.quoteType },
					]),
				),
			});
			return {
				packageId,
				registryId,
				packageIds,
				poolIds,
				findPool,
			} satisfies DeepbookCore;
		}).pipe(Effect.withSpan('DeepbookKnownPackage')),
		{
			kind: 'service',
			plugin: 'deepbook',
			displayTitle: 'deepbook.known',
			display: (s) => ({ title: 'deepbook.known', primary: s.packageId }),
		},
	);
};
