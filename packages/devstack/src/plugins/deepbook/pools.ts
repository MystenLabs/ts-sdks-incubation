// `deepbook.pools` — Seed action that creates pools per the declarative
// spec on the deepbook plugin. One tx per cycle:
//   1. `init_balance_manager_map(registry, adminCap)` — once-per-deepbook
//      bootstrap; the call is idempotent on chain.
//   2. `create_pool_admin<Base, Quote>(registry, tickSize, lotSize,
//      minSize, whitelisted, stable, adminCap)` per declared pool.
//
// Captures each created Pool object's id + objectType into the
// plugin-namespaced registry as `registry.ns('deepbook').pools` so the
// market-maker action and frontend swap helper can look them up by name.
//
// getStatus probes each pool's objectId on chain; if every declared
// pool exists with the matching `Pool<Base, Quote>` type, skip — the
// reconciler short-circuits and the registry hook re-publishes the
// cached pool entries on warm-path skips.

import { Transaction } from '@mysten/sui/transactions';

import {
	type ActionRunContext,
	type Registry,
	type RegistryQuery,
	requireLocalnetCtx,
} from '../../core/types.js';
import { openSuiRpcClient } from '../../helpers/sui-client.js';
import { seed } from '../../actions/seed.js';
import { resolveCoinType } from './coin-spec.js';

export interface DeepbookPoolSpec {
	name: string;
	base: string;
	quote: string;
	tickSize: bigint;
	lotSize: bigint;
	minSize: bigint;
	/** Whitelisted pool — disables DEEP fees. Default true (test friendly). */
	whitelisted?: boolean;
	/** Stable pool — different fee math. Default false. */
	stable?: boolean;
}

interface DeepbookPool {
	name: string;
	poolId: string;
	objectType: string;
	baseCoinType: string;
	quoteCoinType: string;
}

interface DeepbookNamespace {
	pools: RegistryQuery<DeepbookPool>;
	balanceManagers: RegistryQuery<{ name: string; objectId: string; owner: string }>;
}

export const deepbookNs = (registry: Registry): DeepbookNamespace =>
	registry.ns<DeepbookNamespace>('deepbook');

interface DeepbookPoolsActionOptions {
	pools: ReadonlyArray<DeepbookPoolSpec>;
	admin: string;
	/** Cross-plugin needs added to the `['publish']` base set. Use to wait
	 * on app-side actions that register `@reg/<token>` tokens this action's
	 * pool specs reference. */
	extraNeeds?: string[];
}

export function deepbookPoolsAction(opts: DeepbookPoolsActionOptions) {
	const inputs = {
		admin: opts.admin,
		pools: opts.pools.map((p) => ({
			name: p.name,
			base: p.base,
			quote: p.quote,
			tickSize: p.tickSize.toString(),
			lotSize: p.lotSize.toString(),
			minSize: p.minSize.toString(),
			whitelisted: p.whitelisted ?? true,
			stable: p.stable ?? false,
		})),
	};

	return seed({
		name: 'pools',
		needs: ['publish', ...(opts.extraNeeds ?? [])],
		runsAs: opts.admin,
		inputs,
		// Pool entries land in the plugin namespace via this action. Re-publish
		// them on warm-path skips so anyone reading the registry sees the
		// same shape regardless of whether `run` fired this cycle.
		provides: {
			registry: (ctx) => republishCachedPools(ctx, opts.pools),
		},
		getStatus: async (ctx) => {
			if (opts.pools.length === 0) return { ok: true, detail: 'no pools declared' };
			const deepbookPkg = ctx.registry.packages.find('deepbook');
			if (deepbookPkg === undefined) return { ok: false, detail: 'deepbook not published' };
			const ns = deepbookNs(ctx.registry);
			const client = openSuiRpcClient(ctx);
			for (const spec of opts.pools) {
				const cached = ns.pools.find(spec.name);
				if (cached === undefined) return { ok: false, detail: `pool ${spec.name} missing` };
				const expected = expectedPoolType(deepbookPkg.packageId, ctx.registry, spec);
				if (cached.objectType !== expected) {
					return { ok: false, detail: `pool ${spec.name} type stale` };
				}
				const live = await client.getObject({ id: cached.poolId });
				if (live.data === null || live.data === undefined) {
					return { ok: false, detail: `pool ${cached.poolId} not on chain` };
				}
			}
			return { ok: true, detail: `${opts.pools.length} pool(s) live` };
		},
		run: async (ctx) => {
			requireLocalnetCtx(ctx);
			const deepbookPkg = ctx.registry.packages.require('deepbook');
			const registryId = deepbookPkg.captured.registryId;
			const adminCapId = deepbookPkg.captured.adminCapId;
			if (registryId === undefined || adminCapId === undefined) {
				throw new Error(
					'deepbook.pools: registryId or adminCapId missing from deepbook package captures',
				);
			}
			const admin = ctx.accounts.get(opts.admin);
			const client = openSuiRpcClient(ctx);

			const tx = new Transaction();
			tx.setGasBudget(500_000_000);
			tx.moveCall({
				target: `${deepbookPkg.packageId}::registry::init_balance_manager_map`,
				arguments: [tx.object(registryId), tx.object(adminCapId)],
			});
			for (const spec of opts.pools) {
				const baseType = resolveCoinType(ctx.registry, spec.base);
				const quoteType = resolveCoinType(ctx.registry, spec.quote);
				tx.moveCall({
					target: `${deepbookPkg.packageId}::pool::create_pool_admin`,
					typeArguments: [baseType, quoteType],
					arguments: [
						tx.object(registryId),
						tx.pure.u64(spec.tickSize),
						tx.pure.u64(spec.lotSize),
						tx.pure.u64(spec.minSize),
						tx.pure.bool(spec.whitelisted ?? true),
						tx.pure.bool(spec.stable ?? false),
						tx.object(adminCapId),
					],
				});
			}
			const result = await client.signAndExecuteTransaction({
				signer: admin,
				transaction: tx,
				options: { showEffects: true, showObjectChanges: true },
			});
			if (result.effects?.status?.status !== 'success') {
				throw new Error(
					`deepbook.pools: tx failed: ${result.effects?.status?.error ?? 'unknown'}`,
				);
			}
			await client.waitForTransaction({ digest: result.digest });

			const ns = deepbookNs(ctx.registry);
			for (const spec of opts.pools) {
				const baseType = resolveCoinType(ctx.registry, spec.base);
				const quoteType = resolveCoinType(ctx.registry, spec.quote);
				const expected = `${deepbookPkg.packageId}::pool::Pool<${baseType}, ${quoteType}>`;
				const found = (result.objectChanges ?? []).find(
					(c) => c.type === 'created' && 'objectType' in c && c.objectType === expected,
				);
				if (found === undefined || found.type !== 'created') {
					throw new Error(`deepbook.pools: created Pool object missing for ${spec.name}`);
				}
				ns.pools.register({
					name: spec.name,
					poolId: found.objectId,
					objectType: expected,
					baseCoinType: baseType,
					quoteCoinType: quoteType,
				});
			}
		},
	});
}

function expectedPoolType(packageId: string, registry: Registry, spec: DeepbookPoolSpec): string {
	const base = resolveCoinType(registry, spec.base);
	const quote = resolveCoinType(registry, spec.quote);
	return `${packageId}::pool::Pool<${base}, ${quote}>`;
}

function republishCachedPools(ctx: ActionRunContext, pools: ReadonlyArray<DeepbookPoolSpec>): void {
	const ns = deepbookNs(ctx.registry);
	for (const spec of pools) {
		const cached = ns.pools.find(spec.name);
		if (cached !== undefined) {
			// Re-register so the dirty bit fires for codegen-style cascades
			// even on warm-path skips. Same shape, no-op on equal values.
			ns.pools.register(cached);
		}
	}
}
