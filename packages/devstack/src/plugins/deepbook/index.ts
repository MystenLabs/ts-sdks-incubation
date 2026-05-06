// `deepbook()` plugin. First-class wrapper for `MystenLabs/deepbookv3`
// localnet integration. Replaces the generic `imports({ packages: [{
// name: 'deepbook', ... }] })` indirection with a typed surface for the
// most common DeepBook deployment patterns.
//
// Actions:
//
//   deepbook.source              — Build. Fetches + builds the upstream
//                                    DeepBook source as a content-
//                                    addressed image via BuildKit git
//                                    context. Idempotent on imageExists.
//   deepbook.publish             — Publish. Runs `sui client test-publish
//                                    --with-unpublished-dependencies`
//                                    inside the sui localnet container.
//                                    Captures registryId + adminCapId.
//   deepbook.pools               — Seed. Calls `init_balance_manager_map`
//                                    + `create_pool_admin` for each
//                                    declared pool. Idempotent via on-
//                                    chain pool-existence probe. Pools
//                                    land under
//                                    `registry.ns('deepbook').pools`.
//   deepbook.market-maker.<name> — HostProcess. Continuous grid-order
//                                    rebalancer per maker spec. Skipped
//                                    by `applyTestSetupFilter` (which
//                                    drops HostProcess); the long-running
//                                    supervisor owns the loop.
//
// Localnet-only (mirrors `walrus()`, `seal()`). Ships with a default
// `rev: 'v7.0.0'` so most apps don't think about versions.

import type { Action } from '../../core/types.js';
import { definePlugin } from '../../plugin.js';
import {
	type DeepbookMarketMakerSpec,
	deepbookMarketMakerAction,
} from './market-maker.js';
import { type DeepbookPoolSpec, deepbookPoolsAction } from './pools.js';
import { deepbookPublishAction } from './publish.js';
import { deepbookSourceAction } from './source.js';

export type { DeepbookMarketMakerSpec } from './market-maker.js';
export type { DeepbookPoolSpec } from './pools.js';

const DEFAULT_REV = 'v7.0.0';

interface DeepbookPluginOptions {
	/** Pinned deepbookv3 git ref. Default `'v7.0.0'`. Bumping this re-fetches
	 * + rebuilds the source image and re-publishes the package. */
	rev?: string;
	/** Account that signs the publish + pool-admin txs. Default `'publisher'`. */
	admin?: string;
	/** Pools to create on first up. Empty array (default) skips pool creation
	 * entirely — useful when you want deepbook published but no pools yet
	 * (the publish step still captures `registryId` + `adminCapId` so user
	 * code can create pools later). */
	pools?: ReadonlyArray<DeepbookPoolSpec>;
	/** Additional `needs:` entries to add to the `deepbook.pools` action.
	 * Use this when pool specs reference `@reg/<name>` tokens published by
	 * earlier setup actions — e.g. `needs: ['wallet-setup.usdc',
	 * 'wallet-setup.weth']` so pool creation waits until those tokens are
	 * in the registry. The base `['publish']` need is always present. */
	poolNeeds?: string[];
	/** Per-maker grid rebalancers. Each entry becomes a
	 *  `deepbook.market-maker.<name>` HostProcess action. Skipped by
	 *  test-setup paths (`applyTestSetupFilter` drops HostProcess
	 *  actions); the long-running supervisor (`devstack up`,
	 *  `devstack watch`, `pnpm dev`) owns the loop. See
	 *  `market-maker.ts` for the per-tick semantics. */
	marketMakers?: ReadonlyArray<DeepbookMarketMakerSpec>;
}

export const deepbook = (opts: DeepbookPluginOptions = {}) => {
	const rev = opts.rev ?? DEFAULT_REV;
	const admin = opts.admin ?? 'publisher';
	const pools = opts.pools ?? [];
	const marketMakers = opts.marketMakers ?? [];

	return definePlugin({
		name: 'deepbook',
		// Folded into the snapshot id. `rev` covers the source image; pool
		// + market-maker shapes change which on-chain objects the seed
		// actions create, so they must invalidate the snapshot when the
		// app author rewires the book. `midPrices` for makers is also part
		// of the hash since changing it re-deposits + re-grids on next tick.
		inputs: {
			rev,
			admin,
			pools: pools.map((p) => ({
				name: p.name,
				base: p.base,
				quote: p.quote,
				tickSize: p.tickSize.toString(),
				lotSize: p.lotSize.toString(),
				minSize: p.minSize.toString(),
				whitelisted: p.whitelisted ?? true,
				stable: p.stable ?? false,
			})),
			marketMakers: marketMakers.map((m) => ({
				name: m.name,
				signer: m.signer,
				pools: m.pools,
				levels: m.levels ?? 3,
				tickSpacing: m.tickSpacing ?? 1,
				refreshIntervalMs: m.refreshIntervalMs ?? 10_000,
			})),
		},
		actions: () => {
			const actions: Action[] = [
				deepbookSourceAction(rev),
				deepbookPublishAction({ rev, admin }),
			];
			if (pools.length > 0) {
				actions.push(deepbookPoolsAction({ pools, admin, extraNeeds: opts.poolNeeds ?? [] }));
			}
			for (const maker of marketMakers) {
				actions.push(deepbookMarketMakerAction({ maker, pools }));
			}
			return actions;
		},
	});
};

