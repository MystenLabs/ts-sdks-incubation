// DeepBook v3 shared internals — constants, fee/order-type math, the
// `DeepbookPoolSpec` / `DeepbookPool` types, and the helpers
// (`resolveCoinRef`, `makeFindPool`, `depositPreDeposits`) used by
// more than one factory. Re-exported through `./index.ts` for any
// type that lands on the public surface; helpers stay file-local.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Effect } from 'effect';
import type { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions';
import { type LayeredTag } from '../../advanced/tag.js';
import { DeepbookError } from '../../engine/errors.js';
import { type DeepbookCore, type DeepbookPoolRef } from '../deepbook.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const SUI_CLOCK_OBJECT_ID = '0x6';

// Sui system shared `CoinRegistry` object id — well-known framework
// shared object holding the `0x2::coin_registry` state. Used by the
// margin path for the `finalize_registration` / `migrate_legacy_metadata`
// flows (R11). Hardcoded — the on-chain id is stable across networks.
export const COIN_REGISTRY_OBJECT_ID = '0xc';

export const DEEPBOOK_REGISTRY_TYPE_SUFFIX = '::registry::Registry';
export const DEEPBOOK_ADMIN_CAP_TYPE_SUFFIX = '::registry::DeepbookAdminCap';

// Margin — type-suffix constants used by the margin factory to extract
// captured object ids from publish receipts. Follow the same convention
// as the deepbook constants above: `<pkg>::<module>::<TypeName>`.
export const MARGIN_REGISTRY_TYPE_SUFFIX = '::margin_registry::MarginRegistry';
export const MARGIN_ADMIN_CAP_TYPE_SUFFIX = '::margin_registry::MarginAdminCap';
export const MARGIN_MAINTAINER_CAP_TYPE_SUFFIX = '::margin_registry::MaintainerCap';
export const MARGIN_POOL_TYPE_PREFIX = '::margin_pool::MarginPool';
export const MARGIN_SUPPLIER_CAP_TYPE_SUFFIX = '::margin_pool::SupplierCap';

// `pool::place_limit_order` order types. POST_ONLY rejects any order that
// would cross the book — required for makers; without it a maker would
// self-take its own bids when posting an ask inside the spread on a thin
// book.
export const ORDER_TYPE_POST_ONLY = 3;
export const SELF_MATCHING_ALLOWED = 0;

// Per-pool default predeposit multiplier — covers ~16 refresh ticks of
// the full grid before any fills would draw the maker down. Mirrors v3.
export const DEFAULT_PREDEPOSIT_MULTIPLIER = 100n;

// -----------------------------------------------------------------------------
// Shared types
// -----------------------------------------------------------------------------

// `base` / `quote` accept either a literal Move type string
// (`0x2::sui::SUI`) or a tag whose yielded value carries
// `fullCoinType` — the shape every `Coin(...)` factory ref produces.
// The tag form lets pools reference coins published earlier in the
// same devstack, where the on-chain id (and therefore the full Move
// type) isn't known until the publish step resolves at runtime.
//
// `Context.Service` is invariant in its value parameter, so a coin
// tag with a richer shape (the auto-discovered fields on `CoinValue`)
// isn't assignable to `LayeredTag<any, { fullCoinType: string }, any,
// any>`. The pool spec's coin slots accept any tag (`AnyCoinTag`);
// the `fullCoinType` field is read structurally inside the body.
export type DeepbookCoinRef = string | LayeredTag<any, { readonly fullCoinType: string }, any, any>;

export type AnyCoinTag = LayeredTag<any, any, any, any>;

export interface DeepbookPoolSpec<
	Base extends string | AnyCoinTag = string | AnyCoinTag,
	Quote extends string | AnyCoinTag = string | AnyCoinTag,
> {
	readonly name: string;
	readonly base: Base;
	readonly quote: Quote;
	readonly tickSize: bigint;
	readonly lotSize: bigint;
	readonly minSize: bigint;
	/** Whitelisted pool — disables DEEP fees. Default true (test-friendly). */
	readonly whitelisted?: boolean;
	/** Stable pool — different fee math. Default false. */
	readonly stable?: boolean;
}

export interface DeepbookPool {
	readonly name: string;
	readonly poolId: string;
	readonly base: string;
	readonly quote: string;
	/** Echoed back so consumers (market makers) can compute level offsets
	 *  without re-reading the spec. */
	readonly tickSize: bigint;
	readonly lotSize: bigint;
	readonly minSize: bigint;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Tag refs are duck-typed: a tag is yieldable inside `Effect.gen`, a
// literal Move-type string isn't. The structural `fullCoinType: string`
// constraint is enforced at the call-site type — once we're inside the
// body the value is opaque, so we trust the constraint and read the
// field directly.
export const resolveCoinRef = (ref: string | AnyCoinTag) =>
	Effect.gen(function* () {
		if (typeof ref === 'string') return ref;
		const coin = (yield* ref) as { readonly fullCoinType: string };
		return coin.fullCoinType;
	});

// Build a `findPool` closure against a known pool table. Used by both
// local-deploy (table populated post-publish) and known-package (table
// populated from the caller's static config).
export const makeFindPool = (
	factoryName: string,
	pools: Record<string, DeepbookPool>,
): DeepbookCore['findPool'] => {
	const byBaseQuote = new Map<string, DeepbookPoolRef>();
	for (const p of Object.values(pools)) {
		byBaseQuote.set(`${p.base}|${p.quote}`, {
			poolId: p.poolId,
			baseType: p.base,
			quoteType: p.quote,
		});
	}
	return (opts) =>
		Effect.gen(function* () {
			const hit = byBaseQuote.get(`${opts.base}|${opts.quote}`);
			if (hit !== undefined) return hit;
			return yield* Effect.fail(
				new DeepbookError({
					phase: 'market-maker-tick',
					message:
						`${factoryName}: pool not declared for base=${opts.base} ` +
						`quote=${opts.quote}. Add it to the factory's \`pools\` option.`,
				}),
			);
		});
};

// `depositPreDeposits` builds the `balance_manager::deposit<T>` fan-out for
// a market-maker's initial BalanceManager funding. Imported by the
// market-maker factory; the local-deploy factory uses a smaller inline
// version (it mints the BalanceManager lazily on first tick).
interface DepositArgs {
	readonly t: Transaction;
	readonly bm: TransactionObjectArgument;
	readonly packageId: string;
	readonly quotedPools: ReadonlyArray<{
		readonly spec: {
			readonly sizePerLevel: bigint;
			readonly midPrice: bigint;
			readonly preDeposit?: { readonly base: bigint; readonly quote: bigint };
		};
		readonly pool: DeepbookPoolRef;
	}>;
}

// -----------------------------------------------------------------------------
// bps grid math (P0.3 — port from deepbook-sandbox/grid-strategy.ts:46-153)
// -----------------------------------------------------------------------------

/** Round `value` down to the nearest multiple of `step`. Step must be > 0;
 *  callers ensure that at the spec-validation layer.  */
export const alignToTickSize = (value: bigint, tickSize: bigint): bigint => {
	if (tickSize <= 0n) return value;
	return value - (value % tickSize);
};

/** Round `size` down to the nearest multiple of `lotSize`. Mirrors the
 *  sandbox helper of the same name — DeepBook v3 rejects orders whose
 *  size doesn't divide evenly by the pool's lot_size. */
export const alignToLotSize = (size: bigint, lotSize: bigint): bigint => {
	if (lotSize <= 0n) return size;
	return size - (size % lotSize);
};

/** Compute the grid offsets for a basis-points strategy. Returns one
 *  entry per level per side; the maker iterates over both sides and
 *  places a POST_ONLY limit order for each. Mirrors the sandbox grid
 *  formula at `sandbox/scripts/market-maker/grid-strategy.ts:46-153`:
 *  for level i ∈ [1..levels], the spread from mid (in bps) is
 *  `spreadBps + (i - 1) * levelSpacingBps`. Tick-aligned for chain
 *  acceptance.  */
export interface GridLevelInput {
	readonly mid: bigint;
	readonly sizeBase: bigint;
	readonly tickSize: bigint;
	readonly lotSize: bigint;
	readonly levels: number;
	readonly spreadBps: number;
	readonly levelSpacingBps: number;
}

export interface GridLevels {
	readonly bids: ReadonlyArray<{ readonly price: bigint; readonly size: bigint }>;
	readonly asks: ReadonlyArray<{ readonly price: bigint; readonly size: bigint }>;
}

export const calculateGridLevels = (input: GridLevelInput): GridLevels => {
	const { mid, sizeBase, tickSize, lotSize } = input;
	const levels = Math.max(0, input.levels);
	const spreadBps = Math.max(0, input.spreadBps);
	const levelSpacingBps = Math.max(0, input.levelSpacingBps);

	const sizeAligned = alignToLotSize(sizeBase, lotSize);

	const bids: Array<{ price: bigint; size: bigint }> = [];
	const asks: Array<{ price: bigint; size: bigint }> = [];

	for (let i = 1; i <= levels; i++) {
		// Sandbox formula: spreadBps + (i - 1) * levelSpacingBps.
		const totalBps = BigInt(spreadBps) + BigInt(i - 1) * BigInt(levelSpacingBps);
		// `mid * totalBps / 10_000`, rounded to nearest tick.
		const rawOffset = (mid * totalBps) / 10_000n;
		const offset = alignToTickSize(rawOffset, tickSize);
		// Effective offset is at least one tick so each level differs.
		const effectiveOffset = offset === 0n ? tickSize : offset;

		const bidPrice = alignToTickSize(mid - effectiveOffset, tickSize);
		const askPrice = alignToTickSize(mid + effectiveOffset, tickSize);
		if (bidPrice > 0n) bids.push({ price: bidPrice, size: sizeAligned });
		asks.push({ price: askPrice, size: sizeAligned });
	}

	return { bids, asks };
};

// -----------------------------------------------------------------------------
// Helpers (cont.)
// -----------------------------------------------------------------------------

// Sum required base/quote deposits across pools, then issue one
// `balance_manager::deposit<T>` per coin type. The `useGasCoin: true`
// trick on SUI deposits — without it the SDK's coin
// resolver consumes every owned SUI coin as a deposit source and the
// gas-coin selector fails with "No valid gas coins found".
export function depositPreDeposits(args: DepositArgs): void {
	const { t, bm, packageId, quotedPools } = args;

	const totalsByCoinType = new Map<string, bigint>();
	for (const { spec, pool } of quotedPools) {
		const sizeBase = spec.sizePerLevel;
		const mid = spec.midPrice;
		const explicit = spec.preDeposit;
		const baseAmount = explicit?.base ?? DEFAULT_PREDEPOSIT_MULTIPLIER * sizeBase;
		const quoteAmount =
			explicit?.quote ?? (DEFAULT_PREDEPOSIT_MULTIPLIER * sizeBase * mid) / 1_000_000_000n + 1n;
		totalsByCoinType.set(pool.baseType, (totalsByCoinType.get(pool.baseType) ?? 0n) + baseAmount);
		totalsByCoinType.set(
			pool.quoteType,
			(totalsByCoinType.get(pool.quoteType) ?? 0n) + quoteAmount,
		);
	}

	for (const [coinType, amount] of totalsByCoinType) {
		const coin = t.coin({ balance: amount, type: coinType, useGasCoin: true });
		t.moveCall({
			target: `${packageId}::balance_manager::deposit`,
			typeArguments: [coinType],
			arguments: [bm, coin],
		});
	}
}
