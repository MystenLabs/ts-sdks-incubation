// Coin plugin — Codegenable contribution, via the UNIFIED config-binding
// declaration.
//
// Distilled-doc 13-coin.md §"Files written": the codegen orchestrator
// projects the per-stack CoinRegistry into a generated `coins.ts` table:
//
//   export const coins = {
//     mUSDC: { type, decimals, sdkCoin, symbol, ... },
//     mWETH: { type, decimals, sdkCoin, symbol, ... },
//   } as const;
//
// ONE declaration, TWO derivations. A coin declares its `coins.ts`
// contribution ONCE as a `ConfigBindingSet` (rooted under its symbol key).
// The framework derives both behaviors (see `contracts/config-bindings.ts`):
//   - LIVE (boot): bakes the resolved on-chain values (fullCoinType,
//     decimals, ids) AND feeds the generic deployment `values` channel.
//   - STATIC (committed tree): emits `resolveValue('coin:<symbol>', '<key>')`
//     so the committed `coins.ts` carries NO baked coin type / object id.
//
// STRUCTURAL fields (symbol, source) stay literals; the coin type, decimals,
// icon URL, and on-chain object ids are RUNTIME (loaded config data),
// resolved at app build/dev time via the injected `__DEVSTACK_IDS__` global.

import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import {
	keyedBucketSpec,
	liveBucketCodegen,
	staticBucketCodegen,
	type BucketField,
	type SiblingBucketSpec,
} from '../../contracts/config-bindings.ts';
import type { JsonValue } from '../../orchestrators/codegen/deployment.ts';

/** The typed shape per emitted coin record. */
export interface CoinBindings {
	readonly symbol: string;
	readonly fullCoinType: string;
	readonly decimals: number;
	readonly displayName?: string;
	readonly iconUrl?: string;
	readonly treasuryCapId?: string;
	readonly metadataId?: string;
	readonly packageId?: string;
	readonly source: 'registry' | 'on-chain' | 'builtin';
}

/** Static-config shape a coin can describe BEFORE acquire — the fields the
 *  stack-free `staticCodegen` hook needs to emit a deterministic committed
 *  stub for this symbol. `source` is the address-form provenance (known at
 *  factory time). `constants` is set ONLY for a `'builtin'` coin (SUI),
 *  whose coin type + decimals are protocol-defined constants the stub bakes
 *  as literals (no `resolveValue` that would throw at module load). */
export interface CoinStaticConfig {
	readonly symbol: string;
	readonly source: CoinBindings['source'];
	readonly constants?: { readonly fullCoinType: string; readonly decimals: number };
	/** A user-declared on-chain coin type (the `coin.known('0x…::m::W')`
	 *  argument). This is DECLARED config (not loaded-at-runtime data), so the
	 *  committed `coins.ts` bakes it as a LITERAL `fullCoinType`. `decimals` and
	 *  `packageId` still resolve at runtime (they come from `getCoinMetadata`,
	 *  genuinely only known after a live probe), so they stay `resolveValue`.
	 *  Absent for `fromPackage` (registry/local) coins whose type is dynamic. */
	readonly knownCoinType?: string;
}

/** The state the LIVE binding derivation reads — the resolved coin record. */
type CoinLiveState = CoinBindings;

/** Build the coin's config-binding spec for symbol `key`. `symbol` and
 *  `source` are structural literals; the coin type, decimals, and on-chain
 *  object ids are runtime-resolved (`resolveValue`).
 *
 *  Field-set DETERMINISM. A committed `resolveValue(...)` call evaluates at
 *  module-load and THROWS when the id is absent, so the static stub must
 *  emit ONLY fields the injected ids will carry. `source` (known at factory
 *  time) decides this: a `'builtin'` coin (SUI) is fully protocol-defined —
 *  it carries NO package id and its coin type / decimals are constants, so
 *  it emits them as LITERALS (no `resolveValue` that would throw at load).
 *  A `'registry'` / `'on-chain'` coin carries a real `packageId`, so it
 *  emits `fullCoinType` / `decimals` / `packageId` as resolved. The OPTIONAL
 *  discovery-only ids (`treasuryCapId` / `metadataId` / `iconUrl` /
 *  `displayName`) are non-deterministic — the static stub omits them; the
 *  LIVE record emits whatever it actually surfaced (consumers read them
 *  through optional chaining). */
const coinBucketSpec = (
	key: string,
	structural: CoinStaticConfig,
	live: CoinLiveState | null,
): SiblingBucketSpec<CoinLiveState> => {
	const builtin = structural.source === 'builtin';
	const fields: Array<BucketField<CoinLiveState>> = [
		{ key: 'symbol', variant: 'literal', value: structural.symbol },
		{ key: 'source', variant: 'literal', value: structural.source },
	];
	const constants =
		structural.constants ??
		(live !== null && builtin
			? { fullCoinType: live.fullCoinType, decimals: live.decimals }
			: undefined);
	if (builtin && constants !== undefined) {
		// A builtin coin (SUI) is protocol-defined: bake its constants as
		// literals in BOTH paths (no `resolveValue` to throw at module load).
		// The coin type carries `::` so it is not a baked on-chain id.
		fields.push({ key: 'fullCoinType', variant: 'literal', value: constants.fullCoinType });
		fields.push({ key: 'decimals', variant: 'literal', value: constants.decimals });
	} else {
		// A package / on-chain coin: decimals + package id are LOADED CONFIG
		// DATA (from `getCoinMetadata`) — resolve at app build/dev time. The
		// `fullCoinType` is DECLARED config when the caller passed an explicit
		// `coin.known('0x…::m::W')` type (`knownCoinType`) — bake it as a
		// LITERAL; otherwise (`fromPackage`) it is dynamic, so resolve it.
		if (structural.knownCoinType !== undefined) {
			fields.push({ key: 'fullCoinType', variant: 'literal', value: structural.knownCoinType });
		} else {
			fields.push({
				key: 'fullCoinType',
				variant: 'resolved',
				tsType: 'string',
				live: (s) => s.fullCoinType,
			});
		}
		fields.push({
			key: 'decimals',
			variant: 'resolved',
			tsType: 'number',
			live: (s) => s.decimals,
		});
		fields.push({
			key: 'packageId',
			variant: 'resolved',
			tsType: 'string | null',
			live: (s) => (s.packageId ?? null) as JsonValue,
		});
	}
	// Discovery-only optional ids — emitted ONLY on the LIVE path, and only
	// when the resolved record carries them (non-deterministic, so the
	// committed static stub omits them; consumers read via optional chaining).
	if (live !== null) {
		const optional: ReadonlyArray<keyof CoinBindings> = [
			'displayName',
			'iconUrl',
			'treasuryCapId',
			'metadataId',
		];
		for (const field of optional) {
			if (live[field] !== undefined) {
				fields.push({
					key: field,
					variant: 'resolved',
					live: (s) => (s[field] ?? null) as JsonValue,
				});
			}
		}
	}
	return keyedBucketSpec({ bucket: 'coins.ts', kind: 'coin', key, fields });
};

/** Construct the LIVE Codegenable contribution for one coin instance.
 *  Bakes the resolved record + feeds the generic deployment `values` channel.
 *  Mirrors `account/${name}` naming. */
export const makeCoinCodegen = <Symbol extends string>(parts: {
	readonly symbol: Symbol;
	readonly resolved: CoinBindings;
}): CodegenableDecl =>
	liveBucketCodegen(
		coinBucketSpec(
			parts.symbol,
			{ symbol: parts.resolved.symbol, source: parts.resolved.source },
			parts.resolved,
		),
		parts.resolved,
	);

/** Construct the STATIC (stack-free) Codegenable contribution for one coin.
 *  Emits `resolveValue('coin:<symbol>', '<key>')` for runtime fields; the
 *  committed `coins.ts` carries no baked coin type / object id. */
export const makeCoinStaticCodegen = (config: CoinStaticConfig): CodegenableDecl =>
	staticBucketCodegen(coinBucketSpec(config.symbol, config, null));
