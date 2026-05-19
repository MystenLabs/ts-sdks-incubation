// `Coin(...)` factory family — the user-facing primitive for addressing
// a Move coin by symbol, by package + witness, by bare on-chain coin
// type, or by canonical builtin (`SUI`). Coin auto-discovery in
// `Package(...)` (`notes/coin-auto-discovery.md`) registers every coin
// a Move package creates in `CoinRegistry` by the time the matching
// `Package(...)` resolves. The user only needs a yieldable handle to
// address a registered coin.
//
//   const usdc = Package('mock_usdc', USDC_DIR, { signer: publisher });
//   const musdc = Coin('MUSDC');                          // symbol from CoinMetadata
//   const mweth = Coin.fromPackage(weth, 'MOCK_WETH');    // package + witness
//   const deep  = Coin('0xdeec...::deep::DEEP');          // bare on-chain coin type
//   const sui   = Coin.builtin('sui');                    // 0x2::sui::SUI
//
// `Coin('SYMBOL')` reads the live `CoinRegistry` snapshot at acquire
// time — it does NOT auto-derive a dependency edge on the publisher.
// Consumers that need the coin available BEFORE acquisition must include
// the publishing `Package(...)` in their `needs:` list (or in the
// `devstack(...)` composition before the consumer). `Coin.fromPackage`
// yields the package directly, so the dep edge is forced.
//
// Live-net coin handles route through the bare-string form
// `Coin('0x...::T')` — it calls `getCoinMetadata` directly against the
// resolved `SuiTag`, bypassing the registry. Use when the coin exists on
// the target chain but no local publish runs (e.g. mainnet DEEP).

import { Effect, Option, Schema } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { tag, setPhase, type LayeredTag } from '../advanced/tag.js';
import { CoinRegistry, type CoinRecord } from '../engine/registries.js';
import { StateStore } from '../engine/state-store.js';
import { PublishError } from '../engine/errors.js';
import { pickCreatedByType } from '../engine/sui-helpers.js';
import { SuiTag } from './sui.js';
import { toSdkCoin } from '../runtime/sdk-coin.js';
import { fetchCoinMetadataOnce } from './coin/loader.js';
import type { Account } from '../engine/shared.js';
import type { Coin as CoinShape } from './package.js';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** Raised when a `Coin('SYMBOL')` call can't find a single matching entry
 *  in the `CoinRegistry` snapshot at acquire time. The error message lists
 *  every coin currently registered so the user can copy-paste the right
 *  identifier or switch to `Coin.fromPackage(pkg, witness)` for an
 *  unambiguous handle. */
export class CoinNotFoundError extends Schema.TaggedErrorClass<CoinNotFoundError>()(
	'CoinNotFoundError',
	{
		/** The exact identifier the user passed to `Coin(...)`. */
		identifier: Schema.String,
		/** Symbols / names currently visible in the registry at lookup time.
		 *  Empty when the user yields a `Coin(...)` ref before any publish
		 *  has resolved (composition order issue — fix by adding the
		 *  publishing `Package` to `needs:`). */
		registered: Schema.Array(Schema.String),
		message: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

/** Raised when `Coin('SYMBOL')` matches more than one registered coin.
 *  Two packages legally can publish coins with the same symbol (e.g. an
 *  app's mock USDC alongside a vendored DeepBook USDC); disambiguate via
 *  `Coin.fromPackage(pkg, witness)`. */
export class CoinAmbiguousError extends Schema.TaggedErrorClass<CoinAmbiguousError>()(
	'CoinAmbiguousError',
	{
		/** The exact identifier the user passed to `Coin(...)`. */
		identifier: Schema.String,
		/** Full coin types of every candidate match. */
		candidates: Schema.Array(Schema.String),
		message: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

// -----------------------------------------------------------------------------
// CoinValue — the shape every Coin(...) ref yields
// -----------------------------------------------------------------------------

/** The runtime value `Coin(...)` resolves to. Extends `Coin` (the minimal
 *  contract from `services/package.ts` — `{ name, fullCoinType, decimals,
 *  sdkCoin }`) with the optional discovery-populated metadata fields
 *  (`symbol`, `displayName`, `iconUrl`, `treasuryCapId`, `metadataId`,
 *  `packageId`) so a `yield* coin` access surfaces the full record without
 *  another registry roundtrip.
 *
 *  `Coin.builtin('sui')` and bare-string `Coin('0x...::T')` populate the
 *  required fields only; `treasuryCapId` is undefined for SUI (no mint
 *  authority outside the validator). */
export interface CoinValue extends CoinShape {
	readonly symbol?: string;
	readonly displayName?: string;
	readonly iconUrl?: string;
	readonly treasuryCapId?: string;
	readonly metadataId?: string;
	readonly packageId?: string;
}

// -----------------------------------------------------------------------------
// Internal — build a CoinValue from a CoinRecord
// -----------------------------------------------------------------------------

/** Project a `CoinRecord` from the registry into the `CoinValue` shape
 *  `Coin(...)` refs yield. Backfills `sdkCoin` defensively for entries
 *  that landed in the registry without one. */
const coinValueFromRecord = (record: CoinRecord): CoinValue => ({
	name: record.name,
	fullCoinType: record.type,
	decimals: record.decimals,
	sdkCoin: record.sdkCoin ?? toSdkCoin({ fullCoinType: record.type, decimals: record.decimals }),
	...(record.symbol !== undefined ? { symbol: record.symbol } : {}),
	...(record.displayName !== undefined ? { displayName: record.displayName } : {}),
	...(record.iconUrl !== undefined ? { iconUrl: record.iconUrl } : {}),
	...(record.treasuryCapId !== undefined ? { treasuryCapId: record.treasuryCapId } : {}),
	...(record.metadataId !== undefined ? { metadataId: record.metadataId } : {}),
	...(record.packageId !== undefined ? { packageId: record.packageId } : {}),
});

// -----------------------------------------------------------------------------
// Bare-string vs symbol detection
// -----------------------------------------------------------------------------

/** A bare on-chain coin type looks like `0xHEX::module::Witness`. The
 *  three-segment `::` split and the `0x` prefix distinguish it from a
 *  symbol (`'MUSDC'`, `'sui'`). */
const isBareCoinType = (s: string): boolean =>
	s.startsWith('0x') && s.includes('::') && s.split('::').length === 3;

// -----------------------------------------------------------------------------
// Builtin coin records (SUI)
// -----------------------------------------------------------------------------

/** Canonical builtin coins. `Coin.builtin('sui')` short-circuits the
 *  registry / RPC roundtrip entirely — the values are protocol-defined. */
const BUILTIN_COINS = {
	sui: {
		name: 'sui',
		fullCoinType: '0x2::sui::SUI',
		decimals: 9,
		sdkCoin: toSdkCoin({ fullCoinType: '0x2::sui::SUI', decimals: 9 }),
		symbol: 'SUI',
		displayName: 'Sui',
		packageId: '0x2',
	},
} satisfies Record<string, CoinValue>;

export type BuiltinCoinName = keyof typeof BUILTIN_COINS;

// -----------------------------------------------------------------------------
// Coin('SYMBOL') / Coin('0x...::T')
// -----------------------------------------------------------------------------

/** Resolve a symbol against a snapshot of the `CoinRegistry`. Lookup is
 *  case-insensitive: `Coin('musdc')` and `Coin('MUSDC')` resolve
 *  identically. Matches both the canonical `symbol` field (from
 *  CoinMetadata) AND the `name` field (the registry key the discovery
 *  pass derives from witness/symbol fallback). */
const resolveBySymbol = (
	records: ReadonlyArray<CoinRecord>,
	identifier: string,
):
	| { kind: 'found'; record: CoinRecord }
	| { kind: 'not-found' }
	| { kind: 'ambiguous'; candidates: ReadonlyArray<CoinRecord> } => {
	const lower = identifier.toLowerCase();
	const matches = records.filter((r) => {
		if (r.symbol !== undefined && r.symbol.toLowerCase() === lower) return true;
		if (r.name.toLowerCase() === lower) return true;
		return false;
	});
	if (matches.length === 0) return { kind: 'not-found' };
	if (matches.length === 1) return { kind: 'found', record: matches[0]! };
	// Multiple matches: check whether they all point at the same coin type
	// (registry can hold the same coin under both `symbol` and `name`
	// keys, or multiple `publishCoin` calls per cycle). If so, treat as a
	// unique match.
	const types = new Set(matches.map((m) => m.type));
	if (types.size === 1) return { kind: 'found', record: matches[0]! };
	return { kind: 'ambiguous', candidates: matches };
};

/** The factory's overload signature. Returns a `LayeredTag` yielding
 *  `CoinValue`. The `R` channel carries `CoinRegistry` (for symbol
 *  resolution) and `SuiTag` (for bare-coin-type metadata lookup). */
export type CoinFactory = {
	(
		identifier: string,
	): LayeredTag<string, CoinValue, CoinRegistry | SuiTag, CoinNotFoundError | CoinAmbiguousError>;
	readonly fromPackage: <P extends { readonly coins: Record<string, unknown> }>(
		pkg: LayeredTag<any, P, any, any>,
		witness: string,
	) => LayeredTag<string, CoinValue, any, CoinNotFoundError>;
	readonly builtin: (name: BuiltinCoinName) => LayeredTag<string, CoinValue, never, never>;
};

/** `Coin(identifier)` body — yields the live registry / RPC, resolves to
 *  a `CoinValue`. Returned LayeredTag carries the user's identifier in
 *  its tag name for TUI display + state-store key derivation. */
const coinByIdentifier = (identifier: string) =>
	tag(
		`coin/${identifier}` as const,
		Effect.gen(function* () {
			// Bare coin type → direct getCoinMetadata. The CoinRegistry
			// snapshot is bypassed entirely; this is the live-net code path.
			if (isBareCoinType(identifier)) {
				const sui = yield* SuiTag;
				const md = yield* fetchCoinMetadataOnce(sui.client, identifier);
				const decimals = Option.isSome(md) ? md.value.decimals : 0;
				const out: CoinValue = {
					name: identifier,
					fullCoinType: identifier,
					decimals,
					sdkCoin: toSdkCoin({ fullCoinType: identifier, decimals }),
					...(Option.isSome(md) && md.value.symbol !== undefined && md.value.symbol.length > 0
						? { symbol: md.value.symbol }
						: {}),
					...(Option.isSome(md) && md.value.name !== undefined && md.value.name.length > 0
						? { displayName: md.value.name }
						: {}),
					...(Option.isSome(md) && md.value.iconUrl !== undefined
						? { iconUrl: md.value.iconUrl }
						: {}),
					packageId: identifier.split('::')[0]!,
				};
				yield* Effect.annotateCurrentSpan({
					'coin.identifier': identifier,
					'coin.resolution': 'bare-type',
					'coin.fullCoinType': out.fullCoinType,
				});
				return out;
			}

			// Symbol path → CoinRegistry snapshot.
			const registry = yield* CoinRegistry;
			const records = yield* registry.snapshot;
			const hit = resolveBySymbol(records, identifier);
			yield* setPhase('resolving');
			if (hit.kind === 'not-found') {
				const known = Array.from(
					new Set(records.flatMap((r) => (r.symbol !== undefined ? [r.symbol, r.name] : [r.name]))),
				).sort();
				return yield* Effect.fail(
					new CoinNotFoundError({
						identifier,
						registered: known,
						message:
							`Coin('${identifier}'): no coin with that symbol or name is registered. ` +
							(known.length === 0
								? `No coins have published into the registry yet — make sure the publishing ` +
									`Package(...) is included in needs:/devstack(...) before this Coin ref.`
								: `Registered: ${known.join(', ')}. ` +
									`For live-net coins use Coin('0x...::module::TYPE'); for builtins use Coin.builtin('sui').`),
					}),
				);
			}
			if (hit.kind === 'ambiguous') {
				return yield* Effect.fail(
					new CoinAmbiguousError({
						identifier,
						candidates: hit.candidates.map((c) => c.type),
						message:
							`Coin('${identifier}'): matches ${hit.candidates.length} registered coins. ` +
							`Candidates: ${hit.candidates.map((c) => c.type).join(', ')}. ` +
							`Use Coin.fromPackage(pkg, '<WITNESS>') to disambiguate.`,
					}),
				);
			}
			yield* Effect.annotateCurrentSpan({
				'coin.identifier': identifier,
				'coin.resolution': 'symbol',
				'coin.fullCoinType': hit.record.type,
			});
			return coinValueFromRecord(hit.record);
		}),
		{
			kind: 'action',
			displayTitle: `coin.${identifier}`,
			display: (s) => ({ title: `coin.${s.name}`, primary: s.fullCoinType }),
		},
	);

/** `Coin.fromPackage(pkg, witness)` body — yields the package first (so
 *  the dependency edge is forced), then reads `pkg.coins[witness]`. The
 *  lookup is case-insensitive. */
const coinFromPackage = <P extends { readonly coins: Record<string, unknown> }>(
	pkg: LayeredTag<any, P, any, any>,
	witness: string,
) =>
	tag(
		`coin/fromPackage/${witness}` as const,
		Effect.gen(function* () {
			const resolved = yield* pkg;
			const coins = resolved.coins as Record<string, CoinValue | undefined>;
			// Lookup is case-insensitive against the available keys so the
			// user can pass either the registry name (`'musdc'`) or the
			// canonical symbol (`'MUSDC'`) the discovery pass extracted from
			// CoinMetadata.
			const lower = witness.toLowerCase();
			let hit: CoinValue | undefined = coins[witness];
			if (hit === undefined) {
				for (const [k, v] of Object.entries(coins)) {
					if (k.toLowerCase() === lower && v !== undefined) {
						hit = v;
						break;
					}
				}
			}
			if (hit === undefined) {
				const available = Object.keys(coins).sort();
				return yield* Effect.fail(
					new CoinNotFoundError({
						identifier: witness,
						registered: available,
						message:
							`Coin.fromPackage(${'name' in resolved ? String((resolved as { name?: unknown }).name) : '<pkg>'}, '${witness}'): ` +
							`witness not found on the resolved package. Available: ${available.join(', ') || '<none>'}.`,
					}),
				);
			}
			yield* Effect.annotateCurrentSpan({
				'coin.fromPackage.witness': witness,
				'coin.fullCoinType': hit.fullCoinType,
			});
			return hit;
		}),
		{
			kind: 'action',
			displayTitle: `coin.${witness}`,
			display: (s) => ({ title: `coin.${s.name}`, primary: s.fullCoinType }),
		},
	);

/** `Coin.builtin(name)` body — returns a hardcoded canonical record. No
 *  yield, no registry, no RPC. */
const coinBuiltin = (name: BuiltinCoinName) =>
	tag(`coin/builtin/${name}` as const, Effect.succeed(BUILTIN_COINS[name] as CoinValue), {
		kind: 'action',
		displayTitle: `coin.${name}`,
		display: (s) => ({ title: `coin.${s.name}`, primary: s.fullCoinType }),
	});

/** The `Coin` factory family. See module header for usage. */
export const Coin: CoinFactory = Object.assign(coinByIdentifier, {
	fromPackage: coinFromPackage,
	builtin: coinBuiltin,
}) as unknown as CoinFactory;

// -----------------------------------------------------------------------------
// mintFromTreasury (P0.9 — generic mint primitive)
// -----------------------------------------------------------------------------

// State-store key prefix for cached mint results. Folds in chainId (so
// regenesis misses), the treasuryCap id (so a republish under a new
// TreasuryCap misses), the recipient address, and the amount string.
// Versioned so future shape bumps invalidate cleanly. New artifact, new
// key: existing v1 entries that never existed are not a concern.
const STATE_KEY_COIN_MINT_PREFIX = 'coin/mint/v1';

/** Resolved reference shape for either a TreasuryCap or a coin type. The
 *  `fromPackage` form yields the upstream package tag at mint time and
 *  reads the named field; the `string` form is used directly. */
export type TreasuryCapRef =
	| string
	| {
			readonly fromPackage: LayeredTag<
				any,
				{ readonly captured?: Record<string, unknown> },
				any,
				any
			>;
			readonly capturedField: string;
	  };

export type CoinTypeRef =
	| string
	| {
			readonly fromPackage: LayeredTag<any, { readonly packageId: string }, any, any>;
			readonly module: string;
			readonly type: string;
	  };

export interface MintFromTreasuryOptions<Name extends string> {
	readonly name: Name;
	readonly signer: LayeredTag<any, Account, any, any>;
	/** TreasuryCap object id, or a reference to a package's captured
	 *  treasury cap. */
	readonly treasuryCap: TreasuryCapRef;
	/** Fully-qualified Move coin type, or a reference to a package's
	 *  `<packageId>::<module>::<type>` shape. */
	readonly coinType: CoinTypeRef;
	/** Recipient address (0x-prefixed). */
	readonly to: string;
	/** Amount in the coin's smallest units. */
	readonly amount: bigint;
	/** Optional gas budget. Default 100_000_000n. */
	readonly gasBudget?: bigint;
	/** Refs this mint depends on (in addition to `treasuryCap.fromPackage`
	 *  / `coinType.fromPackage` when those are ref forms). */
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
}

interface CachedMint {
	readonly digest: string;
	readonly mintedCoinId: string;
	readonly recipient: string;
	readonly amount: string; // bigint serialized
}

export interface MintFromTreasuryResult {
	readonly digest: string;
	readonly mintedCoinId: string;
	readonly recipient: string;
	readonly amount: bigint;
	readonly coinType: string;
}

/**
 * Mint a Move coin from a `TreasuryCap` to a recipient and cache the
 * result. Implements `0x2::coin::mint_and_transfer<T>` with a state-store
 * cache keyed by `(chainId, treasuryCapId, recipient, amount)` so resume
 * cycles don't double-mint. On cache hit, the helper verifies the
 * minted Coin still exists on chain (mismatch ⇒ re-mint).
 *
 * Sugar `DeepbookMintDEEP` / `DeepbookMintUSDC` wrap this with deepbook-
 * specific treasury-cap references.
 */
export const mintFromTreasury = <const Name extends string>(opts: MintFromTreasuryOptions<Name>) =>
	tag(
		opts.name,
		Effect.gen(function* () {
			for (const dep of opts.dependsOn ?? []) {
				yield* dep;
			}
			const sui = yield* SuiTag;
			const signer = yield* opts.signer;
			const state = yield* StateStore;

			// Resolve TreasuryCap id. Yielding the upstream tag pins the
			// dependency edge before any work runs. Hoist `opts.treasuryCap`
			// / `opts.coinType` into local bindings so TS keeps the union
			// narrowing alive across the inner Effect.gen.
			const treasuryCapOpt = opts.treasuryCap;
			let treasuryCapId: string;
			if (typeof treasuryCapOpt === 'string') {
				treasuryCapId = treasuryCapOpt;
			} else {
				const pkg = yield* treasuryCapOpt.fromPackage;
				const captured = pkg.captured ?? {};
				const v = captured[treasuryCapOpt.capturedField];
				if (typeof v !== 'string' || v.length === 0) {
					return yield* Effect.fail(
						new PublishError({
							phase: 'publish-tx',
							message:
								`mintFromTreasury(${opts.name}): package did not capture ` +
								`treasury cap under field '${treasuryCapOpt.capturedField}' ` +
								`(got ${JSON.stringify(v)})`,
						}),
					);
				}
				treasuryCapId = v;
			}

			// Resolve coin type.
			const coinTypeOpt = opts.coinType;
			let fullCoinType: string;
			if (typeof coinTypeOpt === 'string') {
				fullCoinType = coinTypeOpt;
			} else {
				const pkg = yield* coinTypeOpt.fromPackage;
				fullCoinType = `${pkg.packageId}::${coinTypeOpt.module}::${coinTypeOpt.type}`;
			}

			yield* Effect.annotateCurrentSpan({
				'mintFromTreasury.treasuryCap': treasuryCapId,
				'mintFromTreasury.coinType': fullCoinType,
				'mintFromTreasury.recipient': opts.to,
				'mintFromTreasury.amount': opts.amount.toString(),
			});

			const cacheKey = `${STATE_KEY_COIN_MINT_PREFIX}/${sui.chainId}/${treasuryCapId}/${opts.to}/${opts.amount.toString()}`;

			// Cache lookup + on-chain verification. Cache hits that point
			// at a vanished coin re-mint; otherwise return the cached
			// result.
			const cached = yield* state.get<CachedMint>(cacheKey);
			if (Option.isSome(cached)) {
				const candidate = cached.value.mintedCoinId;
				const verified = yield* Effect.tryPromise({
					try: () => sui.client.core.getObject({ objectId: candidate }),
					catch: (cause) => cause,
				}).pipe(
					Effect.map(() => true),
					Effect.orElseSucceed(() => false),
				);
				if (verified) {
					yield* Effect.annotateCurrentSpan({ 'mintFromTreasury.cache': 'hit' });
					return {
						digest: cached.value.digest,
						mintedCoinId: cached.value.mintedCoinId,
						recipient: cached.value.recipient,
						amount: BigInt(cached.value.amount),
						coinType: fullCoinType,
					} satisfies MintFromTreasuryResult;
				}
				yield* Effect.annotateCurrentSpan({ 'mintFromTreasury.cache': 'stale' });
				yield* state.remove(cacheKey).pipe(Effect.ignore);
			} else {
				yield* Effect.annotateCurrentSpan({ 'mintFromTreasury.cache': 'miss' });
			}

			yield* setPhase('minting');
			const t = new Transaction();
			t.setGasBudget(opts.gasBudget ?? 100_000_000n);
			t.moveCall({
				target: '0x2::coin::mint_and_transfer',
				typeArguments: [fullCoinType],
				arguments: [t.object(treasuryCapId), t.pure.u64(opts.amount), t.pure.address(opts.to)],
			});

			const result = yield* signer.signAndExecute(t).pipe(
				Effect.mapError(
					(cause) =>
						new PublishError({
							phase: 'publish-tx',
							message: `mintFromTreasury(${opts.name}): sign+execute failed: ${cause.message}`,
							cause,
						}),
				),
			);

			// `mint_and_transfer` emits a `Coin<T>` to the recipient; find it
			// by type substring (the inner generic carries the full coin
			// type so `pickCreatedByType(..., {includes: 'Coin<${fullCoinType}>'})`
			// is unambiguous).
			const mintedCoinId = pickCreatedByType(result.objectChanges, {
				includes: `0x2::coin::Coin<${fullCoinType}>`,
			});
			if (mintedCoinId === undefined) {
				return yield* Effect.fail(
					new PublishError({
						phase: 'publish-tx',
						message:
							`mintFromTreasury(${opts.name}): minted Coin<${fullCoinType}> not found in ` +
							`objectChanges (digest=${result.digest})`,
					}),
				);
			}

			// Best-effort cache write. The mint already settled on chain;
			// a state-store IO defect just means the next supervisor cycle
			// re-mints (acceptable cost).
			yield* state
				.put(cacheKey, {
					digest: result.digest,
					mintedCoinId,
					recipient: opts.to,
					amount: opts.amount.toString(),
				} satisfies CachedMint)
				.pipe(Effect.ignore);

			return {
				digest: result.digest,
				mintedCoinId,
				recipient: opts.to,
				amount: opts.amount,
				coinType: fullCoinType,
			} satisfies MintFromTreasuryResult;
		}),
		{
			kind: 'action',
			displayTitle: `mintFromTreasury.${opts.name}`,
			display: (s) => ({
				title: `mintFromTreasury.${opts.name}`,
				primary: `${s.amount.toString()} → ${s.recipient}`,
				extras: [s.coinType],
			}),
		},
	);

// Test-only: expose the prefix so tests can assert key shape.
export const STATE_KEY_COIN_MINT_PREFIX_INTERNAL = STATE_KEY_COIN_MINT_PREFIX;
