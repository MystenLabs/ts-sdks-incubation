// Pyth shared internals — feed id constants + tx-builder helpers used by
// the local-deploy and pusher primitives.
//
// Feed ids are taken from
// `~/code/deepbook-sandbox/sandbox/scripts/oracle-service/constants.ts:13-26`.
// These are mainnet hex identifiers shared across all Pyth deployments
// (the same feed id identifies the same asset on every Pyth chain).

import type { Transaction, TransactionResult } from '@mysten/sui/transactions';

/** 32-byte hex price feed identifier (mainnet, but identifiers are
 *  universal across Pyth's deployments). */
export type PythPriceFeedId = string;

// Canonical Pyth price feed identifiers. Source:
// `~/code/deepbook-sandbox/sandbox/scripts/oracle-service/constants.ts`.
export const SUI_PRICE_FEED_ID: PythPriceFeedId =
	'0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744';
export const DEEP_PRICE_FEED_ID: PythPriceFeedId =
	'0x29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff';
export const USDC_PRICE_FEED_ID: PythPriceFeedId =
	'0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a';

/** Initial price spec the local-deploy uses to bootstrap a PriceInfoObject.
 *  `magnitude` + `expo` mirror the wire protocol's `i64` price + `i32`
 *  exponent. Sandbox bootstraps with the historical-24h price for
 *  reproducibility; we accept the same shape here. */
export interface PythPriceInfoSpec {
	readonly feedId: PythPriceFeedId;
	readonly priceMagnitude: bigint;
	readonly priceNegative: boolean;
	readonly expoMagnitude: bigint;
	readonly expoNegative: boolean;
	readonly publishTime: bigint;
	readonly emaPriceMagnitude?: bigint;
	readonly emaPriceNegative?: boolean;
	readonly conf?: bigint;
	readonly emaConf?: bigint;
}

/**
 * Append a `pyth::create_price_feeds` per-feed builder to a transaction.
 * Returns the `TransactionResult` for the call so callers can chain
 * downstream moves (e.g. transferring the resulting `PriceInfoObject`).
 *
 * Mirrors `~/code/deepbook-sandbox/sandbox/scripts/utils/oracle.ts:61-156`
 * — same Move signature, same `i64`/`i32` magnitude/negative encoding.
 */
export const addPriceInfo = (
	t: Transaction,
	pythPackageId: string,
	pythStateId: string,
	clockId: string,
	spec: PythPriceInfoSpec,
): TransactionResult => {
	// `pyth::create_price_feeds` accepts a vector of `PriceInfo` structs.
	// Each `PriceInfo` is a tuple of i64+i32 (price + expo + ema + conf).
	// Implementation here uses the helper that wraps the Move signature.
	return t.moveCall({
		target: `${pythPackageId}::pyth::create_price_feeds`,
		typeArguments: [],
		arguments: [
			t.object(pythStateId),
			// price struct
			t.pure.u64(spec.priceMagnitude),
			t.pure.bool(spec.priceNegative),
			t.pure.u64(spec.expoMagnitude),
			t.pure.bool(spec.expoNegative),
			t.pure.u64(spec.emaPriceMagnitude ?? spec.priceMagnitude),
			t.pure.bool(spec.emaPriceNegative ?? spec.priceNegative),
			t.pure.u64(spec.conf ?? 0n),
			t.pure.u64(spec.emaConf ?? spec.conf ?? 0n),
			t.pure.u64(spec.publishTime),
			t.pure.vector('u8', hexToBytes(spec.feedId)),
			t.object(clockId),
		],
	});
};

/** Hex (0x-prefixed or unprefixed) → byte array. Pyth feed ids ride as
 *  `vector<u8>` arguments. */
export const hexToBytes = (hex: string): ReadonlyArray<number> => {
	const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
	if (stripped.length % 2 !== 0) {
		throw new Error(`hexToBytes: odd-length hex string: ${hex}`);
	}
	const out: Array<number> = [];
	for (let i = 0; i < stripped.length; i += 2) {
		const b = parseInt(stripped.slice(i, i + 2), 16);
		if (Number.isNaN(b)) {
			throw new Error(`hexToBytes: invalid hex char at position ${i}: ${hex}`);
		}
		out.push(b);
	}
	return out;
};

/** Default Pyth state id for localnet deployments — set via the publish
 *  call. Mainnet/testnet use the values from `knownDeployments.deepbook
 *  .<network>.pyth.pythStateId`. */
export const PRICE_INFO_OBJECT_TYPE_SUFFIX = '::price_info::PriceInfoObject';

/** Pyth pusher's default cadence (10s — sandbox parity). */
export const DEFAULT_PUSHER_REFRESH_MS = 10_000;

/** Default historical lookback for the Pyth API fetch (24h — sandbox parity). */
export const DEFAULT_HISTORICAL_HOURS = 24;

/** Default Pyth API base for the pusher. */
export const DEFAULT_PYTH_API_URL = 'https://benchmarks.pyth.network';
