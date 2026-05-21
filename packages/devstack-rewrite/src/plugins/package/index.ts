// Package plugin — barrel + factories.
//
// Architecture: Package is the canonical implementation of the
// `OnChainArtifactPublisher` substrate primitive. Many composite
// services depend on its publish output (Coin types, Walrus/Seal/
// Deepbook contracts, Action receipts).
//
// Public surface:
//
//   - `localPackage(name, opts)`  — build + publish a Move source tree.
//   - `knownPackage(name, opts)`  — verify-only against a fixed id.
//   - `package(name, opts)`       — convenience: switches on the
//                                    presence of `opts.packageId`.
//                                    Prefer the explicit factories at
//                                    call sites — the convenience form
//                                    is for ergonomic compose blocks
//                                    where the user is paging through
//                                    options.
//
// Type split (distilled doc Invariant 9): `localPackage` resolves to
// `LocalPackage`; `knownPackage` resolves to `KnownPackage`. The
// bindings emitter (in the codegen orchestrator) types-out KnownPackage
// at compose time, so misuse fails at compile time rather than at
// emit time.
//
// Tag id: `'package:<name>'` — one tag per user-declared package
// (the symbolic name is part of the identity so two `localPackage`
// calls in the same stack don't collide on the substrate's tag
// registry). Substrate-side plugin key is the same string.

import { Effect } from 'effect';

import { capabilities } from '../../api/define-capabilities.ts';
import { consumeMember } from '../../api/consume-members.ts';
import { defineNodePlugin } from '../../api/define-plugin.ts';
import { defineTag } from '../../api/tag.ts';
import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import { OnChainArtifactPublisherService } from '../../substrate/runtime/on-chain-artifact/index.ts';
// Cross-plugin import — Open slot O5 (STYLE_GUIDE §7, ARCHITECTURE.md
// "Plugin A ↔ Plugin B coupling"). Package fires coin auto-discovery
// at publish time because the supply ordering is: localPackage acquires →
// publish receipt → coin records must land BEFORE downstream coin.local/
// witness consumers run. The substrate-correct fix is a raised
// `PublishReceiptEmitted` event the coin plugin subscribes to via the
// supervisor's harvest loop (PR2-A) OR a future event-bus primitive —
// at which point this import disappears in favour of `events.publish(...)`.
import { CoinRegistryService, type CoinRecord } from '../coin/registry.ts';
import { chainProbeFor } from '../../substrate/runtime/strategy-registry/index.ts';
import { SuiTag } from '../sui/index.ts';
import type { SuiProbeKey } from '../sui/chain-probe.ts';
import type { StackMember } from '../../substrate/plugin.ts';
import type { Tag } from '../../substrate/tag.ts';
import type { AccountTagId } from '../account/index.ts';
import type { AccountValue } from '../account/service.ts';
// Cross-plugin import — Open slot O5. The coin-discovery walker is a
// PURE projection over `PublishReceipt`; it lives in the coin plugin
// because the discovery shape (`CoinRecord` rows) belongs to coin's
// domain. Pending substrate harvest loop / event-bus (see comment above)
// the walker is called directly from this barrel.
import { discoverCoinsFromPublish } from '../coin/discovery.ts';
import { makeKnownCodegenable, makeLocalCodegenable, type PackageBindings } from './codegen.ts';
import { makePublishExecutor } from './publish-executor.ts';
import { bootPackageService, type PackageMode } from './service.ts';
import {
	PACKAGE_REGISTRY_CAPABILITY_KEY,
	PackageRegistryService,
	type ResolvedKnownPackage,
	type ResolvedLocalPackage,
} from './registry.ts';
import { makeSnapshotable } from './snapshot.ts';
import type { PublishReceipt } from './publish-receipt.ts';
import { PACKAGE_ERROR_TAGS, type PublishError } from './errors.ts';

// Plugin-error contribution — surfaced to the supervisor's harvest loop,
// which folds the `_tag` set into the substrate `FormatterRegistry` so
// the cascade formatter renders package-tagged failures with the right
// taxonomy header (STYLE_GUIDE §2, ARCHITECTURE.md "PluginErrorContribution").
const packageErrorContribution = {
	_tag: 'PluginErrorContribution' as const,
	errorTags: PACKAGE_ERROR_TAGS as ReadonlyArray<string>,
};
const packageErrorContributions = [packageErrorContribution] as const;

// ---------------------------------------------------------------------------
// Publisher account ref — explicit upstream
// ---------------------------------------------------------------------------

/** A user-supplied publisher account ref. The user passes the result
 *  of `account('alice')` (a `StackMember` providing the per-name
 *  account tag) — NOT a bare tag value. Generic over the literal
 *  account name so the package's `consumes: [SuiTag, account/<name>]`
 *  preserves the per-account tag id for the substrate's
 *  `MissingProviders` check (mirrors the wallet plugin's per-account
 *  tag handling). */
export type PublisherAccountMember<Name extends string = string> = StackMember<
	Tag<AccountTagId<Name>, AccountValue>,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ReadonlyArray<Tag<string, any>>,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	any,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	any
>;

// ---------------------------------------------------------------------------
// Tag — one per declared package, keyed by symbolic name
// ---------------------------------------------------------------------------

/** Tag id constructor. The symbolic package name is part of the tag
 *  identity so the substrate's compose-time dedup detects collisions
 *  cleanly (two `localPackage('foo', ...)` calls in one stack → typed
 *  error at compose time). */
export const packageTagId = <Name extends string>(name: Name): `package:${Name}` =>
	`package:${name}`;

/** The literal-template tag id for a package by symbolic name. */
export type PackageTagId<Name extends string> = `package:${Name}`;

/** Public resolved value shapes — re-exported from `registry.ts` to
 *  give consumers one stable import path. */
export type { ResolvedLocalPackage, ResolvedKnownPackage, ResolvedPackage } from './registry.ts';
export type { PublishReceipt, PublishObjectChange } from './publish-receipt.ts';
export type { PublishError } from './errors.ts';
export { PACKAGE_ERROR_TAGS } from './errors.ts';
export type { PackageBindings } from './codegen.ts';
export type { PublishExecutor } from './mode-local.ts';

/** Resolved value carried by the package tag. Local packages also
 *  expose the publish receipt so downstream consumers (Coin plugin,
 *  manifest emitter, capture-spec callers) can read it. */
export interface LocalPackageResolved extends ResolvedLocalPackage {
	/** Publish receipt — present after a fresh publish, null on
	 *  cache hit (verify-only path). Consumers that need the
	 *  receipt MUST tolerate null and fall back to chain reads via
	 *  the ChainProbe. */
	readonly publishReceipt: PublishReceipt | null;
}

export type KnownPackageResolved = ResolvedKnownPackage;

export type PackageResolved = LocalPackageResolved | KnownPackageResolved;

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface LocalPackageOptions<PublisherName extends string = string> {
	readonly sourcePath: string;
	/** Optional Effect-resolved source path (distilled doc Invariant
	 *  15 — vendored-fetch round-trips through publish). When set,
	 *  `sourcePath` is the SYNCHRONOUS placeholder used for type
	 *  inference; the actual path is resolved at acquire time. */
	readonly resolveSourcePath?: Effect.Effect<string, PublishError>;
	readonly mvrPlaceholder?: string;
	readonly excludeFromCodegen?: boolean;
	/** Capture spec — projection from publish receipt to named ids.
	 *  Two accepted forms; we accept the callback form here (the
	 *  declarative form sugars over it). */
	readonly captureSpec?: (receipt: PublishReceipt) => Readonly<Record<string, string>>;
	/** Publisher account — the signer for the publish tx. Pass the
	 *  result of `account('alice')` (the same `StackMember` reference
	 *  used in the rest of the stack — NOT a duplicate factory call).
	 *
	 *  Required for local packages: a publish tx must be signed by
	 *  SOMEONE; we make the choice explicit so two packages in the
	 *  same stack can publish under different accounts (no implicit
	 *  "first account" convention to memorise). Distilled doc Invariant
	 *  4 — "Signer MUST be an explicit upstream". */
	readonly publisher: PublisherAccountMember<PublisherName>;
}

export interface KnownPackageOptions {
	readonly packageId: string;
	readonly upgradeCapId?: string;
	readonly mvrPlaceholder?: string;
}

// ---------------------------------------------------------------------------
// Internal builders
// ---------------------------------------------------------------------------

const buildLocalPlugin = <Name extends string, PublisherName extends string>(
	name: Name,
	opts: LocalPackageOptions<PublisherName>,
) => {
	// Project the publisher account tag from the user-supplied
	// `StackMember`. The `consumes` tuple below carries the literal
	// `account/<PublisherName>` so the substrate's compose-time
	// `MissingProviders` check can confirm the named account is in
	// the stack, and the acquire body's `ctx.use(opts.publisher)`
	// has the literal tag id in its `Consumes[number]` union (which
	// the `BuildContext.use<M>` conditional requires to reduce — TS
	// does not reduce `T extends X | T` for a template-literal
	// generic `T`, so the literal MUST be in the tuple type).
	const publisherMember = consumeMember(opts.publisher);
	const consumesTuple = [SuiTag, publisherMember.consumesTag] as const;

	return defineNodePlugin({
		// Tag identity carries the package's symbolic name so the
		// substrate's compose-time dedup catches collisions.
		provides: defineTag<PackageTagId<Name>, LocalPackageResolved>(
			packageTagId(name),
			packageTagId(name),
		),
		// `consumes: [SuiTag, account/<publisher>]` — package publishing
		// needs the live chain AND the publisher account signer. The
		// dep edges ensure Sui's acquire (which registers the chain-
		// probe) AND the publisher's acquire (which mints / funds the
		// keypair) both complete before publish starts.
		consumes: consumesTuple,
		kind: 'leaf-long-running',
		rebootCost: 'heavy',
		watch: {
			// File-watcher contribution — restart on Move source edits.
			// Distilled doc §Outputs: literal-path Packages contribute
			// watch roots. Effect-resolved paths do NOT auto-attach.
			paths: [
				`${opts.sourcePath}/**/*.move`,
				`${opts.sourcePath}/Move.toml`,
				`${opts.sourcePath}/Move.lock`,
			],
			cascade: true,
		},
		acquire: (ctx) =>
			Effect.gen(function* () {
				const sui = ctx.get(SuiTag);
				// Direct member-ref accessor for the publisher upstream —
				// `consumeMember(opts.publisher)` (built above) encapsulates
				// the §14 localized cast for the resolved-value projection.
				const publisherAccount = publisherMember.projectInScope(ctx);
				// Substrate-context primitives: OnChainArtifactPublisher
				// is provided by the supervisor's pluginContext;
				// ChainProbe is looked up via the StrategyRegistry
				// (Sui registered itself there at acquire). The
				// PackageRegistry is a per-stack plugin-owned service
				// (instantiated from the substrate's generic
				// ScopedRefMap primitive — see `registry.ts`) — every
				// package plugin in the stack yields the SAME instance
				// via `PackageRegistryService`, so cross-plugin lookups
				// stay consistent and warm-restart verify can use the
				// previous packageId as a hint.
				const publisher = yield* OnChainArtifactPublisherService;
				const probe = yield* chainProbeFor<SuiProbeKey>(sui.chain);
				const registry = yield* PackageRegistryService;
				// ContainerRuntime + the Sui plugin's resolved image feed
				// `runMoveBuild`'s path-(b) (`docker run --rm`) build path.
				// Sui surfaces `buildImage` on its resolved client; modes
				// without an in-stack image (external, live) surface null
				// — runMoveBuild then surfaces a typed error from path (c)
				// (host CLI not routed).
				const containerRuntime = yield* ContainerRuntimeService;

				const sourcePath = opts.resolveSourcePath ? yield* opts.resolveSourcePath : opts.sourcePath;

				// Build the concrete `PublishExecutor` once per acquire.
				// Hands the resolved SuiSdkShim (for `Transaction.build`,
				// `executeTransaction`, `waitForTransaction`) and the
				// publisher account (for `signAndExecute`) to the executor
				// methods; mode-local's produce body drives them.
				const executor = makePublishExecutor({
					sdk: sui.sdk,
					account: publisherAccount,
					runtime: containerRuntime,
					...(sui.buildImage !== null ? { buildImage: sui.buildImage } : {}),
				});

				const mode: PackageMode = {
					mode: 'local',
					packageName: name,
					sourcePath,
					chainId: sui.chain,
					publisherAddress: publisherAccount.address,
					mvrOverride: opts.mvrPlaceholder,
					captureSpec: opts.captureSpec,
					executor,
				};

				const { resolved, receipt } = yield* bootPackageService(publisher, probe, registry, mode);

				// Coin auto-discovery hook (Coin plugin pattern).
				//
				// Walks the fresh publish receipt for paired
				// `TreasuryCap<T>` + `CoinMetadata<T>` and registers a
				// `CoinRecord` into the per-stack `CoinRegistry` for
				// each discovered coin. This is the canonical "Package
				// emits a receipt; Coin consumes it" seam (distilled-doc
				// 13-coin.md §Cross-component references): the walker
				// lives in the coin plugin (`plugins/coin/discovery.ts`)
				// — keeping the projection close to the registry shape
				// it folds into — and we fire it from the package's
				// acquire so the records land BEFORE downstream
				// `coin.local(...)` / `coin.witness(...)` plugins run
				// their lookup. The substrate's compose-time ordering
				// (`coin.local('USDC')` consumes SuiTag; localPackage
				// consumes SuiTag + publisher account) doesn't carry an
				// edge between Package → Coin — the symbol-form coin's
				// no-edge documentation calls this out, and we close
				// the loop here.
				//
				// On cache-hit (receipt === null) we skip discovery: the
				// records from the previous boot are already in the
				// registry under the same fullCoinType keys.
				//
				// Open slot O5 (cross-plugin coupling): Package reaches
				// into the coin plugin (`CoinRegistryService` +
				// `discoverCoinsFromPublish`) here because the substrate
				// lacks a plugin-author event-bus today. The architectural
				// fix is a substrate-raised `PublishReceiptEmitted` event
				// the coin plugin subscribes to via the supervisor harvest
				// loop (PR2-A) OR a generic event-bus primitive — at which
				// point this block becomes `events.publish({ kind:
				// 'PublishReceiptEmitted', receipt })` with no direct
				// import of the coin plugin from this barrel.
				if (receipt !== null) {
					const coinRegistry = yield* CoinRegistryService;
					const discovered = discoverCoinsFromPublish(receipt);
					for (const d of discovered) {
						// Project the discovery walker's output into the
						// substrate's CoinRecord shape. Metadata enrichment
						// (decimals, symbol, displayName, iconUrl) lives in
						// the coin plugin's `metadata.ts`; we register the
						// on-chain identity here without the RPC fold so
						// the registry surfaces a degraded record
						// immediately (distilled-doc 13-coin.md Invariant
						// 8 — soft-degrade on metadata fetch).
						const record: CoinRecord = {
							key: d.witness,
							type: d.fullCoinType,
							witness: d.witness,
							moduleName: d.moduleName,
							decimals: 0,
							...(d.treasuryCapId !== undefined ? { treasuryCapId: d.treasuryCapId } : {}),
							...(d.metadataId !== undefined ? { metadataId: d.metadataId } : {}),
							packageId: receipt.packageId,
							publishingPackageName: name,
						};
						yield* coinRegistry.register(record);
					}
				}

				const projected: LocalPackageResolved = {
					...(resolved as ResolvedLocalPackage),
					publishReceipt: receipt,
				};
				return projected;
			}),
		errorContributions: packageErrorContributions,
		capabilities: (resolved) => makeLocalCapabilities(name, opts, resolved),
	});
};

const buildKnownPlugin = <Name extends string>(name: Name, opts: KnownPackageOptions) =>
	defineNodePlugin({
		provides: defineTag<PackageTagId<Name>, KnownPackageResolved>(
			packageTagId(name),
			packageTagId(name),
		),
		// `consumes: [SuiTag]` — knownPackage verifies against the
		// live chain via ChainProbe. The probe lives on Sui's
		// scope-local StrategyRegistry entry; Sui must acquire first.
		consumes: [SuiTag] as const,
		kind: 'leaf-long-running',
		rebootCost: 'cheap',
		acquire: (ctx) =>
			Effect.gen(function* () {
				const sui = ctx.get(SuiTag);
				const publisher = yield* OnChainArtifactPublisherService;
				const probe = yield* chainProbeFor<SuiProbeKey>(sui.chain);
				const registry = yield* PackageRegistryService;
				const mode: PackageMode = {
					mode: 'known',
					packageName: name,
					packageId: opts.packageId,
					upgradeCapId: opts.upgradeCapId,
					mvrOverride: opts.mvrPlaceholder,
				};
				const { resolved } = yield* bootPackageService(publisher, probe, registry, mode);
				// Known mode never publishes — no receipt to walk, so
				// the coin-discovery hook is skipped here. Users who
				// want coin records for a knownPackage point a
				// `coin.known('0xPKG::module::Witness')` at the
				// fully-qualified type directly; the bare-type path
				// hits the live RPC for metadata rather than the
				// receipt-walker.
				return resolved as KnownPackageResolved;
			}),
		errorContributions: packageErrorContributions,
		capabilities: (resolved) => makeKnownCapabilities(name, opts, resolved),
	});

const makeLocalCapabilities = (
	name: string,
	opts: LocalPackageOptions<string>,
	resolved: LocalPackageResolved,
) => {
	// Snapshot + codegen lift their typed fields off the resolved
	// publish (real packageId + captured object ids). The static-form
	// placeholders are gone.
	const snap: SnapshotableDecl = makeSnapshotable(
		name,
		resolved.publishReceipt?.packageId ?? resolved.packageId,
	);
	const codegen: CodegenableDecl<PackageBindings, 'package'> = makeLocalCodegenable(
		{
			kind: 'local',
			name,
			packageId: resolved.packageId,
			upgradeCapId: resolved.upgradeCapId,
			sourcePath: resolved.sourcePath,
			mvrPlaceholder: resolved.mvrPlaceholder,
			captured: resolved.captured,
		},
		{ excluded: opts.excludeFromCodegen ?? false },
	);
	// The plugin contributes to the package-registry strategy under a
	// fixed key — the substrate orchestrator wires all packages'
	// contributions into the same per-stack registry.
	const registryContribution: StrategyContributorDecl<
		typeof PACKAGE_REGISTRY_CAPABILITY_KEY,
		{ readonly noteName: string }
	> = {
		kind: 'strategy-contributor',
		capabilityKey: PACKAGE_REGISTRY_CAPABILITY_KEY,
		strategy: { noteName: name },
		autoMounted: true,
	};
	return capabilities(snap, codegen, registryContribution);
};

const makeKnownCapabilities = (
	name: string,
	opts: KnownPackageOptions,
	resolved: KnownPackageResolved,
) => {
	const snap: SnapshotableDecl = makeSnapshotable(name, `known:${resolved.packageId}`);
	const codegen: CodegenableDecl<PackageBindings, 'package'> = makeKnownCodegenable({
		kind: 'known',
		name,
		packageId: resolved.packageId,
		upgradeCapId: resolved.upgradeCapId ?? opts.upgradeCapId,
		mvrPlaceholder: resolved.mvrPlaceholder,
	});
	const registryContribution: StrategyContributorDecl<
		typeof PACKAGE_REGISTRY_CAPABILITY_KEY,
		{ readonly noteName: string }
	> = {
		kind: 'strategy-contributor',
		capabilityKey: PACKAGE_REGISTRY_CAPABILITY_KEY,
		strategy: { noteName: name },
		autoMounted: true,
	};
	return capabilities(snap, codegen, registryContribution);
};

// ---------------------------------------------------------------------------
// Public factories
// ---------------------------------------------------------------------------

/** Build + publish a local Move package. The resolved value is
 *  `LocalPackageResolved` so consumers that need bindings / source
 *  path are typed correctly.
 *
 *  Required `opts.publisher`: the account that signs the publish tx.
 *  Pass the same `account('alice')` reference used elsewhere in the
 *  stack — the package's `consumes:` includes `account/<publisher>`
 *  so the substrate orders the publisher's keypair + funding strictly
 *  before publish. */
export const localPackage = <Name extends string, PublisherName extends string>(
	name: Name,
	opts: LocalPackageOptions<PublisherName>,
) => buildLocalPlugin(name, opts);

/** Verify-only against a fixed on-chain package id. The resolved
 *  value is `KnownPackageResolved` — narrower than local, so the
 *  bindings emitter rejects this at compose time. */
export const knownPackage = <Name extends string>(name: Name, opts: KnownPackageOptions) =>
	buildKnownPlugin(name, opts);

/** Convenience entry point — branches on `'packageId' in opts`.
 *  Prefer the explicit `localPackage` / `knownPackage` factories
 *  at call sites; this exists so the user-facing `package(...)`
 *  vocabulary matches the distilled doc's surface. */
export function pkg<Name extends string, PublisherName extends string>(
	name: Name,
	opts: LocalPackageOptions<PublisherName>,
): ReturnType<typeof buildLocalPlugin<Name, PublisherName>>;
export function pkg<Name extends string>(
	name: Name,
	opts: KnownPackageOptions,
): ReturnType<typeof buildKnownPlugin<Name>>;
export function pkg<Name extends string, PublisherName extends string>(
	name: Name,
	opts: LocalPackageOptions<PublisherName> | KnownPackageOptions,
) {
	return 'packageId' in opts ? buildKnownPlugin(name, opts) : buildLocalPlugin(name, opts);
}
