// DeepBook v3 shared internals — constants, fee/order-type math, the
// `DeepbookPoolSpec` / `DeepbookPool` types, and the helpers
// (`resolveCoinRef`, `makeFindPool`, `depositPreDeposits`) used by
// more than one factory. Re-exported through `./index.ts` for any
// type that lands on the public surface; helpers stay file-local.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Effect } from 'effect';
import type { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions';
import { type Ref } from '../../advanced/tag.js';
import { DeepbookError } from '../../engine/errors.js';
import {
	type DeepbookCore,
	type DeepbookPoolRef,
} from '../deepbook.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const SUI_CLOCK_OBJECT_ID = '0x6';

export const DEEPBOOK_REGISTRY_TYPE_SUFFIX = '::registry::Registry';
export const DEEPBOOK_ADMIN_CAP_TYPE_SUFFIX = '::registry::DeepbookAdminCap';

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
// `fullCoinType` — the shape `registerCoin` produces. The tag form
// lets pools reference coins published earlier in the same devstack,
// where the on-chain id (and therefore the full Move type) isn't
// known until the publish step resolves at runtime.
//
// `Context.Service` is invariant in its value parameter, so a coin
// tag with a richer shape (extra `name` / `packageId` fields from
// `registerCoin`) isn't assignable to `Ref<any, { fullCoinType:
// string }, any, any>`. The pool spec's coin slots accept any tag
// (`AnyCoinTag`); the `fullCoinType` field is read structurally
// inside the body.
export type DeepbookCoinRef = string | Ref<any, { readonly fullCoinType: string }, any, any>;

export type AnyCoinTag = Ref<any, any, any, any>;

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

// Sum required base/quote deposits across pools, then issue one
// `balance_manager::deposit<T>` per coin type. v3's `useGasCoin: true`
// trick on SUI deposits is preserved — without it the SDK's coin
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
		totalsByCoinType.set(
			pool.baseType,
			(totalsByCoinType.get(pool.baseType) ?? 0n) + baseAmount,
		);
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
