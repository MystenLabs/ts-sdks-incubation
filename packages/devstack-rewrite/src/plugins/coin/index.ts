// Coin plugin — barrel + `coin(...)` factory family.
//
// Architecture (13-coin.md): Coin is the user-facing primitive family
// for *addressing* custom Move coin types. It does NOT publish Move
// modules itself — the Package plugin publishes; coin auto-discovery
// (in `discovery.ts`) folds the publish receipt into the per-stack
// `CoinRegistry`; this factory resolves user-supplied addresses
// (symbol / witness / bare-type / builtin) against that registry plus
// the live RPC.
//
// User-facing factory shape — FOUR variants mirroring the address
// forms:
//
//   coin.local('mUSDC')                      // symbol → registry
//   coin.fromPackage(pkg, 'MOCK_USDC')       // package member → registry
//   coin.known('0x...::deep::DEEP')          // bare → live RPC
//   coin.builtin('sui')                      // protocol-defined constant
//
// (A `coin(identifier)` convenience entry is intentionally NOT
// exposed — distilled-doc 13-coin.md Pain point #6 documents how the
// "guess the form from the string" path is a footgun. The four-form
// surface forces the user to make the disambiguation explicit at the
// call site.)
//
// Tag id: `'coin:<symbol>'` — one tag per declared coin instance, so
// the substrate's compose-time dedup detects collisions cleanly (two
// `coin.local('mUSDC')` calls in one stack → typed error at compose
// time). Mirrors the Package plugin's per-instance tag identity.
//
// IMPORTANT (distilled-doc 13-coin.md Pain point #4): the SYMBOL
// form (`coin.local('SYMBOL')`) does NOT auto-derive a dependency edge
// on the publisher. The registry is a substrate-context lookup; the
// type system can't see the producer→consumer edge. Consumers that
// need the coin available BEFORE acquisition MUST include the
// publishing `localPackage(...)` in their `needs:` list (or in the
// `defineDevstack(...)` composition before the consumer). The
// `coin.fromPackage(pkg, ...)` form forces the edge explicitly via the
// `consumes` tuple — prefer it when the publisher is reachable.

import { Effect } from 'effect';

import { capabilities } from '../../api/define-capabilities.ts';
import { consumeMember } from '../../api/consume-members.ts';
import { defineNodePlugin } from '../../api/define-plugin.ts';
import { defineTag } from '../../api/tag.ts';
import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import { OnChainArtifactPublisherService } from '../../substrate/runtime/on-chain-artifact/index.ts';
import type { StackMember } from '../../substrate/plugin.ts';
import type { Tag } from '../../substrate/tag.ts';
import { SuiTag } from '../sui/index.ts';
import type { SuiClient } from '../sui/index.ts';
import type { PackageTagId, PackageResolved } from '../package/index.ts';

import { makeCoinCodegen, type CoinBindings } from './codegen.ts';
import { makeCoinSnapshotable } from './snapshot.ts';
import { COIN_REGISTRY_CAPABILITY_KEY, CoinRegistryService } from './registry.ts';
import { COIN_ERROR_TAGS } from './errors.ts';
import { acquireCoin, type CoinAddressForm, type CoinValue } from './service.ts';
import { BUILTIN_COINS } from './address-resolution.ts';
import type { MetadataSdkShim } from './metadata.ts';
import type { MintSdkShim } from './mint.ts';

const coinErrorContribution = {
	_tag: 'PluginErrorContribution' as const,
	errorTags: COIN_ERROR_TAGS as ReadonlyArray<string>,
};
const coinErrorContributions = [coinErrorContribution] as const;

// ---------------------------------------------------------------------------
// Tag — one per declared coin instance, keyed by symbol/witness/etc.
// ---------------------------------------------------------------------------

/** Tag id constructor. The symbolic name is part of the tag identity
 *  so the substrate's compose-time dedup catches collisions. */
export const coinTagId = <Sym extends string>(symbol: Sym): `coin:${Sym}` => `coin:${symbol}`;

export type CoinTagId<Sym extends string> = `coin:${Sym}`;

// ---------------------------------------------------------------------------
// SDK shim projection
// ---------------------------------------------------------------------------
//
// The coin plugin's resolvers need three Sui surfaces: `core.getObject`
// (mint verify probe), `core.getCoinMetadata` (bare-type address form),
// and the opaque `client` (`Transaction.build({client})` in the mint
// produce body).
//
// `sui.sdk.core.getObject` is on the typed `SuiSdkShim`; `getCoinMetadata`
// lives on the underlying `SuiGrpcClient` reached via the opaque
// `sui.sdk.client`. We project both onto a single `MetadataSdkShim &
// MintSdkShim` here at the boundary — the cast mirrors STYLE_GUIDE §14
// (localized cast through an opaque SDK surface), kept narrow to one
// method projection.

const projectCoinSdk = (sui: SuiClient): MetadataSdkShim & MintSdkShim => {
	const grpcClient = sui.sdk.client as {
		readonly core: {
			readonly getCoinMetadata: (args: { readonly coinType: string }) => Promise<unknown>;
		};
	};
	return {
		core: {
			getObject: sui.sdk.core.getObject,
			getCoinMetadata: (args) => grpcClient.core.getCoinMetadata(args),
		},
		client: sui.sdk.client,
	};
};

// ---------------------------------------------------------------------------
// Per-form capability builders — dynamic (POST-acquire). Receive the
// resolved `CoinValue` so codegen bindings stamp the REAL fullCoinType
// + decimals instead of placeholder values.
// ---------------------------------------------------------------------------

const buildCapabilities = (symbol: string, resolved: CoinValue) => {
	const bindings: CoinBindings = {
		symbol,
		fullCoinType: resolved.fullCoinType,
		decimals: resolved.decimals,
		source: resolved.source,
		...(resolved.displayName !== undefined ? { displayName: resolved.displayName } : {}),
		...(resolved.iconUrl !== undefined ? { iconUrl: resolved.iconUrl } : {}),
		...(resolved.treasuryCapId !== undefined ? { treasuryCapId: resolved.treasuryCapId } : {}),
		...(resolved.metadataId !== undefined ? { metadataId: resolved.metadataId } : {}),
		...(resolved.packageId !== undefined ? { packageId: resolved.packageId } : {}),
	};
	const snap: SnapshotableDecl = makeCoinSnapshotable({ symbol });
	const codegen: CodegenableDecl<CoinBindings, `coin/${string}`> = makeCoinCodegen({
		symbol,
		resolved: bindings,
	});
	// Auto-mounted strategy contribution — siblings (Wallet, Faucet's
	// treasury-cap mint, Deepbook market-maker) read the per-stack
	// registry via this seam. The actual `CoinRegistry` instance is
	// wired at compose time (one registry per stack); each coin
	// contributes its `register(record)` call as a side effect at
	// acquire.
	const registryContribution: StrategyContributorDecl<
		typeof COIN_REGISTRY_CAPABILITY_KEY,
		{ readonly symbol: string }
	> = {
		kind: 'strategy-contributor',
		capabilityKey: COIN_REGISTRY_CAPABILITY_KEY,
		strategy: { symbol },
		autoMounted: true,
	};
	return capabilities(snap, codegen, registryContribution);
};

// ---------------------------------------------------------------------------
// Form 1: coin.local(symbol) — registry lookup
// ---------------------------------------------------------------------------

/** Resolve a coin by symbol against the per-stack registry. NO dep
 *  edge on the publisher — see the file header for the rationale.
 *  Compose the publisher's `localPackage(...)` before this in the
 *  `defineDevstack(...)` member list. */
export const local = <Sym extends string>(symbol: Sym) => {
	const tag = defineTag<CoinTagId<Sym>, CoinValue>(coinTagId(symbol), 'coin');
	return defineNodePlugin({
		provides: tag,
		// Dep edge on SuiTag — we still need the live chain id even
		// when the user-facing rationale is "no publisher edge".
		consumes: [SuiTag] as const,
		kind: 'leaf-one-shot',
		rebootCost: 'cheap',
		acquire: (ctx) =>
			Effect.gen(function* () {
				const sui = ctx.get(SuiTag);
				const publisher = yield* OnChainArtifactPublisherService;
				const registry = yield* CoinRegistryService;
				const form: CoinAddressForm = { kind: 'symbol', symbol };
				return yield* acquireCoin(form, {
					registry,
					sdk: projectCoinSdk(sui),
					chain: sui.chain,
					publisher,
				});
			}),
		errorContributions: coinErrorContributions,
		capabilities: (resolved) => buildCapabilities(symbol, resolved),
	});
};

// ---------------------------------------------------------------------------
// Form 2: coin.fromPackage(pkg, witness) — package-scoped registry lookup
// ---------------------------------------------------------------------------

/** A user-supplied package member ref. The user passes the result of
 *  `localPackage('foo', …)` / `knownPackage('foo', …)` (a `StackMember`
 *  providing the per-name package tag) — NOT a bare tag value. Generic
 *  over the literal package name so the witness-form coin's
 *  `consumes: [SuiTag, package:<name>]` preserves the per-package tag
 *  id for the substrate's `MissingProviders` check. Mirrors the
 *  Package plugin's `PublisherAccountMember`. */
export type PackageMember<Name extends string = string> = StackMember<
	Tag<PackageTagId<Name>, PackageResolved>,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ReadonlyArray<Tag<string, any>>,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	any,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	any
>;

/** Resolve a coin by `(publishing package member, witness)`. Forces
 *  a dep edge on the publishing package's tag — the substrate ensures
 *  the publish has completed before this resolves.
 *
 *  Symbol used for the tag id is the witness name (lower-cased) so
 *  two witness-form coins for different packages get distinct tag
 *  ids.
 *
 *  Pass the package MEMBER (the value returned by `localPackage(...)`
 *  / `knownPackage(...)`), not its `.provides` tag. The factory
 *  projects `.provides` internally; the resolved-value type is read
 *  via `ctx.use(member)` in the acquire body. */
export const fromPackage = <PkgName extends string, Wit extends string>(
	pkg: PackageMember<PkgName>,
	witnessName: Wit,
) => {
	const symbol = witnessName.toLowerCase();
	const tag = defineTag<CoinTagId<Lowercase<Wit>>, CoinValue>(
		coinTagId(symbol) as CoinTagId<Lowercase<Wit>>,
		'coin',
	);
	// Project the package tag from the user-supplied `StackMember`. The
	// `consumes` tuple below carries the literal `package:<PkgName>` so
	// the substrate's compose-time `MissingProviders` check confirms
	// the named package is in the stack, and the acquire body's
	// resolved-value read goes through `consumeMember(pkg)` (which
	// hides the §14 localized cast).
	const pkgMember = consumeMember(pkg);
	const consumesTuple = [pkgMember.consumesTag, SuiTag] as const;

	return defineNodePlugin({
		provides: tag,
		// Distilled-doc 13-coin.md Lifecycle path 3: witness form MUST
		// yield the package tag first. Also depends on Sui for the live
		// chain id and publisher seam.
		consumes: consumesTuple,
		kind: 'leaf-one-shot',
		rebootCost: 'cheap',
		acquire: (ctx) =>
			Effect.gen(function* () {
				const sui = ctx.get(SuiTag);
				// Direct member-ref accessor for the package upstream —
				// `consumeMember(pkg)` (built above) encapsulates the §14
				// localized cast for the resolved-value projection.
				const resolved = pkgMember.projectInScope(ctx);
				const oca = yield* OnChainArtifactPublisherService;
				const registry = yield* CoinRegistryService;
				const form: CoinAddressForm = {
					kind: 'witness',
					publishingPackageName: resolved.name,
					witness: witnessName,
				};
				return yield* acquireCoin(form, {
					registry,
					sdk: projectCoinSdk(sui),
					chain: sui.chain,
					publisher: oca,
				});
			}),
		errorContributions: coinErrorContributions,
		capabilities: (resolved) => buildCapabilities(symbol, resolved),
	});
};

// ---------------------------------------------------------------------------
// Form 3: coin.known(fullCoinType) — bare on-chain type
// ---------------------------------------------------------------------------

/** Resolve a coin by bare on-chain type via `getCoinMetadata`.
 *  Used for live-net coins (mainnet DEEP, USDC etc.) that no local
 *  `Package(...)` publishes.
 *
 *  Soft-degrades to `decimals: 0` on RPC failure — distilled-doc
 *  invariant. Tag id uses a deterministic-but-readable derivation of
 *  the coin type so collisions surface at compose time. */
export const known = <FullType extends string>(fullCoinType: FullType) => {
	// Derive a tag id from the type: keep it readable but unique. The
	// substrate's compose-time dedup uses string equality on the id.
	const id = fullCoinType.replace(/^0x/, '').replace(/::/g, '_').slice(0, 60);
	const tag = defineTag<CoinTagId<typeof id>, CoinValue>(
		coinTagId(id) as CoinTagId<typeof id>,
		'coin',
	);
	return defineNodePlugin({
		provides: tag,
		consumes: [SuiTag] as const,
		kind: 'leaf-one-shot',
		rebootCost: 'cheap',
		acquire: (ctx) =>
			Effect.gen(function* () {
				const sui = ctx.get(SuiTag);
				const publisher = yield* OnChainArtifactPublisherService;
				const registry = yield* CoinRegistryService;
				const form: CoinAddressForm = { kind: 'known', fullCoinType };
				return yield* acquireCoin(form, {
					registry,
					sdk: projectCoinSdk(sui),
					chain: sui.chain,
					publisher,
				});
			}),
		errorContributions: coinErrorContributions,
		capabilities: (resolved) => buildCapabilities(id, resolved),
	});
};

// ---------------------------------------------------------------------------
// Form 4: coin.builtin('sui') — protocol-defined constant
// ---------------------------------------------------------------------------

/** Resolve a protocol-defined builtin coin. Currently `'sui'` only —
 *  distilled-doc 13-coin.md Invariant 4: SUI is `0x2::sui::SUI`,
 *  decimals=9. No RPC, no registry. */
export const builtin = <Name extends keyof typeof BUILTIN_COINS>(name: Name) => {
	const symbol = name; // 'sui' today
	const tag = defineTag<CoinTagId<Name>, CoinValue>(coinTagId(name), 'coin');
	return defineNodePlugin({
		provides: tag,
		consumes: [SuiTag] as const,
		kind: 'leaf-one-shot',
		rebootCost: 'cheap',
		acquire: (ctx) =>
			Effect.gen(function* () {
				const sui = ctx.get(SuiTag);
				const publisher = yield* OnChainArtifactPublisherService;
				const registry = yield* CoinRegistryService;
				const form: CoinAddressForm = { kind: 'builtin', name };
				return yield* acquireCoin(form, {
					registry,
					sdk: projectCoinSdk(sui),
					chain: sui.chain,
					publisher,
				});
			}),
		errorContributions: coinErrorContributions,
		capabilities: (resolved) => buildCapabilities(symbol, resolved),
	});
};

// ---------------------------------------------------------------------------
// Public `coin` namespace
// ---------------------------------------------------------------------------

/** User-facing factory namespace. Four variants — see file header for
 *  the rationale on not exposing a `coin(identifier)` form-guessing
 *  entry. */
export const coin = {
	local,
	fromPackage,
	known,
	builtin,
} as const;

// ---------------------------------------------------------------------------
// Re-exports — advanced callers (Wallet, Faucet, Deepbook, examples)
// ---------------------------------------------------------------------------

export type { CoinValue, CoinAddressForm } from './service.ts';
export type { ResolvedCoin, BuiltinCoinName } from './address-resolution.ts';
export { BUILTIN_COINS } from './address-resolution.ts';

export type { CoinRecord, CoinRegistry, CoinKey } from './registry.ts';
export {
	COIN_REGISTRY_CAPABILITY_KEY,
	CoinRegistryService,
	coinRegistryLayer,
} from './registry.ts';

export type { CoinBindings } from './codegen.ts';

export type { DiscoveredCoin } from './discovery.ts';
export { discoverCoinsFromPublish } from './discovery.ts';

export type { MetadataSdkShim, OnchainCoinMetadata, CoinMetadataCache } from './metadata.ts';
export {
	OnchainCoinMetadataShape,
	METADATA_FETCH_TIMEOUT_MS,
	METADATA_RETRY_SCHEDULE,
	fetchCoinMetadataOnce,
	fetchCoinMetadataMany,
	makeCoinMetadataCache,
	isBareCoinType,
	validateBareCoinType,
} from './metadata.ts';

export type { MintInputs, MintResult, MintSigner, MintSdkShim, CachedMint } from './mint.ts';
export { performMint, MintedCoinVerifyShape, mintTxError, mintParseError } from './mint.ts';

export type { CoinError, CoinPhase } from './errors.ts';
export { coinError, COIN_ERROR_TAGS } from './errors.ts';

// Surface the no-edge-warning constant for code generators / docs
// consumers that want to render the footgun callout. Distilled-doc
// 13-coin.md Pain point #4.
export const SYMBOL_FORM_NO_DEP_EDGE_WARNING =
	`coin.local(symbol) does not auto-derive a dep edge on the publishing package.\n` +
	`If the package isn't already composed BEFORE this coin, you'll see CoinError({phase: 'not-found'}).\n` +
	`Prefer coin.fromPackage(packageMember, witnessName) when the publisher is reachable.`;
