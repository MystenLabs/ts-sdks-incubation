// Package plugin — barrel + factories.
//
// Architecture: Package is the canonical implementation of the
// `ArtifactPublisher` substrate primitive. Many service
// plugins depend on its publish output (Coin types, Walrus/Seal/
// Deepbook contracts, Action outputs).
//
// Public surface:
//
//   - `localPackage(name, opts)`  — build + publish a Move source tree.
//   - `knownPackage(name, opts)`  — verify-only against a fixed id.
//
// Type split (distilled doc Invariant 9): `localPackage` resolves to
// `LocalPackage`; `knownPackage` resolves to `KnownPackage`. The
// bindings emitter (in the codegen orchestrator) types-out KnownPackage
// at compose time, so misuse fails at compile time rather than at
// emit time.
//
// Resource id: `'package:<name>'` — one tag per user-declared package
// (the symbolic name is part of the identity so two `localPackage`
// calls in the same stack don't collide on the substrate's tag
// registry). Substrate-side plugin key is the same string.

import { Effect } from 'effect';

import { projection } from '../../api/define-capabilities.ts';
import { definePlugin, resource, type ResourceRef } from '../../api/define-plugin.ts';
import type { Contribution } from '../../substrate/plugin-ctx.ts';
import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { ProjectionDecl } from '../../contracts/projection.ts';
import { pickCreatedByType, type LocalPackagePublishOutput } from './publish-output.ts';
import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import { emitContributions, PluginContext } from '../../substrate/plugin-ctx.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import {
	CoinRegistryService,
	discoverCoinsFromPublish,
	type CoinRecord,
	type CoinRegistry,
} from '../coin/index.ts';
import { CacheService } from '../../substrate/runtime/cache/index.ts';
import { chainProbeFor } from '../../substrate/runtime/strategy-registry/index.ts';
import { suiResource, type SuiProbeKey } from '../sui/index.ts';
import type { AccountResourceId, AccountValue } from '../account/index.ts';
import { makeKnownCodegenable, makeLocalCodegenable, type PackageNetworks } from './codegen.ts';
import { makePublishExecutor } from './publish-executor.ts';
import { bootPackageService, type PackageMode } from './service.ts';
import {
	PACKAGE_REGISTRY_CAPABILITY_KEY,
	PackageRegistryService,
	type ResolvedKnownPackage,
	type ResolvedLocalPackage,
} from './registry.ts';
import { makeSnapshotable } from './snapshot.ts';

// ---------------------------------------------------------------------------
// Publisher account ref — explicit upstream
// ---------------------------------------------------------------------------

/** A user-supplied publisher account ref. The user passes the result
 *  of `account('alice')` — NOT a bare string. Generic over the
 *  literal account name so the package dependency preserves the
 *  per-account resource id. */
export type PublisherAccountMember<Name extends string = string> = ResourceRef<
	AccountResourceId<Name>,
	AccountValue
>;

// ---------------------------------------------------------------------------
// Resource — one per declared package, keyed by symbolic name
// ---------------------------------------------------------------------------

/** Resource id constructor. The symbolic package name is part of the tag
 *  identity so the substrate's compose-time dedup detects collisions
 *  cleanly (two `localPackage('foo', ...)` calls in one stack → typed
 *  error at compose time). */
export const packageResourceId = <Name extends string>(name: Name): `package:${Name}` =>
	`package:${name}`;

/** The literal-template resource id for a package by symbolic name. */
export type PackageResourceId<Name extends string> = `package:${Name}`;

/** Public resolved value shapes — re-exported from `registry.ts` to
 *  give consumers one stable import path. */
export type { ResolvedLocalPackage, ResolvedKnownPackage, ResolvedPackage } from './registry.ts';
export type {
	PickCreatedByTypeOptions,
	LocalPackagePublishOutput,
	PackagePublishObjectChange,
} from './publish-output.ts';
export { pickCreatedByType } from './publish-output.ts';
export type { PublishError } from './errors.ts';
export type { PackageBindings, PackageNetworks, PackageNetworkEntry } from './codegen.ts';
export type { PublishExecutor } from './mode-local.ts';

/** Resolved value carried by the package resource. Local packages also
 *  expose the publish output so manifest emitters and capture-spec
 *  callers can read it. Sibling plugin folds consume the package-owned
 *  extension contribution instead of importing package internals. */
export type PackageCaptureMap = Readonly<Record<string, string>>;

type PackageCaptureCallback = (
	output: LocalPackagePublishOutput,
) => Readonly<Record<string, string>>;

export type PackageCapture = PackageCaptureMap;

export type CapturedPackageValues<Capture> = Capture extends PackageCaptureCallback
	? Readonly<Record<string, string>>
	: Capture extends PackageCaptureMap
		? { readonly [K in keyof Capture]: string }
		: Readonly<Record<string, string>>;

export interface LocalPackageResolved<Capture = undefined> extends Omit<
	ResolvedLocalPackage,
	'captured'
> {
	/** Captured object ids keyed by the user's `capture` option. */
	readonly captured: CapturedPackageValues<Capture>;
	/** Publisher account that signed this package. Kept on the live
	 *  resource value so downstream local coin plugins can mint from
	 *  publisher-owned TreasuryCaps through the centralized funding
	 *  strategy path. It is intentionally not written to generated
	 *  bindings or the package registry. */
	readonly publisher: AccountValue;
	/** Publish output — present after a fresh publish, null on
	 *  cache hit (verify-only path). Consumers that need the
	 *  output MUST tolerate null and fall back to chain reads via
	 *  the ChainProbe. */
	readonly publishResult: LocalPackagePublishOutput | null;
}

export type KnownPackageResolved = ResolvedKnownPackage;

export type PackageResolved = LocalPackageResolved | KnownPackageResolved;

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface LocalPackageOptions<
	Publisher extends PublisherAccountMember = PublisherAccountMember,
	Capture extends PackageCapture | undefined = undefined,
> {
	readonly sourcePath: string;
	readonly mvrPlaceholder?: string;
	readonly excludeFromCodegen?: boolean;
	/** Capture created objects from the publish output. The record
	 *  form maps output keys to object-type suffixes, e.g.
	 *  `{ boardId: '::board::Board' }`. */
	readonly capture?: Capture;
	/** Per-network declared package ids (+ optional object ids) for
	 *  prod-targeting. Pure literals, no resolution: codegen merges the
	 *  resolved-local id into `config.packages.<name>.byNetwork.local`
	 *  and these literals into `byNetwork.testnet` / `byNetwork.mainnet`.
	 *  A consumer flips `config.network` (env) to select active ids. */
	readonly networks?: PackageNetworks;
	/** Publisher account — the signer for the publish tx. Pass the
	 *  result of `account('alice')` (the same plugin/resource ref used
	 *  in the rest of the stack — NOT a duplicate factory call).
	 *
	 *  Required for local packages: a publish tx must be signed by
	 *  SOMEONE; we make the choice explicit so two packages in the
	 *  same stack can publish under different accounts (no implicit
	 *  "first account" convention to memorise). Distilled doc Invariant
	 *  4 — "Signer MUST be an explicit upstream". */
	readonly publisher: Publisher;
}

export interface KnownPackageOptions {
	readonly packageId: string;
	readonly upgradeCapId?: string;
	readonly mvrPlaceholder?: string;
	/** Per-network declared package ids (+ optional object ids) for
	 *  prod-targeting — same as `LocalPackageOptions.networks`. Pure
	 *  literals; codegen fills `config.packages.<name>.byNetwork`. */
	readonly networks?: PackageNetworks;
}

interface PackageRegistryProjectionContribution {
	readonly kind: 'local' | 'known';
	readonly name: string;
	readonly packageId: string;
	readonly upgradeCapId: string | null;
	readonly mvrPlaceholder: string;
	readonly sourcePath: string | null;
}

const makePackageProjectionContribution = (
	contribution: PackageRegistryProjectionContribution,
): ProjectionDecl => {
	const updatedAt = Date.now();
	const key = `package/${contribution.name}` as `package/${string}`;
	return projection({
		kind: 'package',
		key,
		payload: {
			key,
			rowKey: null,
			name: contribution.name,
			kind: contribution.kind,
			packageId: contribution.packageId,
			upgradeCapId: contribution.upgradeCapId,
			mvrPlaceholder: contribution.mvrPlaceholder,
			sourcePath: contribution.sourcePath,
			updatedAt,
		},
		at: updatedAt,
	});
};

// ---------------------------------------------------------------------------
// Internal builders
// ---------------------------------------------------------------------------

const normalizeCapture = <Capture extends PackageCapture | undefined>(
	packageName: string,
	capture: Capture,
): PackageCaptureCallback | undefined => {
	if (capture === undefined) return undefined;
	return (output) => {
		const captured: Record<string, string> = {};
		for (const [key, suffix] of Object.entries(capture)) {
			const objectId = pickCreatedByType(output.objectChanges, { suffix });
			if (objectId === undefined) {
				throw new Error(
					`localPackage('${packageName}') capture '${key}' matched no created object with suffix '${suffix}'.`,
				);
			}
			captured[key] = objectId;
		}
		return captured;
	};
};

const buildLocalPlugin = <
	Name extends string,
	const Publisher extends PublisherAccountMember,
	Capture extends PackageCapture | undefined,
>(
	name: Name,
	opts: LocalPackageOptions<Publisher, Capture>,
) => {
	const packageRef = resource<PackageResourceId<Name>, LocalPackageResolved<Capture>>(
		packageResourceId(name),
	);
	const capture = normalizeCapture(name, opts.capture);

	return definePlugin({
		id: packageRef.id,
		dependsOn: { sui: suiResource, publisher: opts.publisher },
		role: 'task',
		section: 'package',
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
		// `deps` auto-infers the resolved `{ sui, publisher }` dependency
		// object; `ctx` arrives via the `PluginContext` service.
		start: ({ sui, publisher: publisherAccount }) =>
			Effect.gen(function* () {
				const ctx = yield* PluginContext;
				// Substrate-context primitives: ArtifactPublisher
				// is provided by the supervisor's pluginContext;
				// ChainProbe is looked up via the StrategyRegistry
				// (Sui registered itself there at acquire). The
				// PackageRegistry is a per-stack plugin-owned service
				// (a self-contained last-write-wins map — see
				// `registry.ts`) — every
				// package plugin in the stack yields the SAME instance
				// via `PackageRegistryService`, so cross-plugin lookups
				// stay consistent and warm-restart verify can use the
				// previous packageId as a hint.
				const publisher = yield* CacheService;
				const probe = yield* chainProbeFor<SuiProbeKey>(sui.chain);
				const registry = yield* PackageRegistryService;
				// The per-stack CoinRegistry — same instance every plugin in
				// the stack yields via `CoinRegistryService` (the boot wiring
				// adds it to the plugin context via
				// `extendBuiltInPluginContext`). Local publish folds its
				// discovered coins into it directly (was the orchestrator's
				// `publishResultSink`).
				const coinRegistry = yield* CoinRegistryService;
				// ContainerRuntime + the Sui plugin's resolved image feed
				// `runMoveBuild`'s path-(b) (`docker run --rm`) build path.
				// Sui surfaces `buildImage` on its resolved client; modes
				// without an in-stack image (external, live) surface null
				// — runMoveBuild then surfaces a typed error from path (c)
				// (host CLI not routed).
				const containerRuntime = yield* ContainerRuntimeService;

				// Build the concrete `PublishExecutor` once per acquire.
				// Hands the resolved SuiSdkShim (for `Transaction.build`,
				// `executeTransaction`, `waitForTransaction`) and the
				// publisher account (for `signAndExecute`) to the executor
				// methods; mode-local's produce body drives them.
				const executor = makePublishExecutor({
					sdk: sui.sdk,
					account: publisherAccount,
					runtime: containerRuntime,
					forkMode: sui.fork !== null,
					...(sui.buildImage !== null ? { buildImage: sui.buildImage } : {}),
				});

				const mode = {
					mode: 'local',
					packageName: name,
					sourcePath: opts.sourcePath,
					chainId: sui.chain,
					publisherAddress: publisherAccount.address,
					mvrOverride: opts.mvrPlaceholder,
					...(capture !== undefined ? { capture } : {}),
					executor,
				} satisfies PackageMode;

				const { resolved, output } = yield* bootPackageService(publisher, probe, registry, mode);

				const projected: LocalPackageResolved<Capture> = {
					...resolved,
					captured: resolved.captured as CapturedPackageValues<Capture>,
					publisher: publisherAccount,
					publishResult: output,
				};
				// Emit the resolved package's contributions inline via the
				// shared `emitContributions` router. `projected` is the
				// just-resolved local value; `makeLocalCapabilities` builds the
				// ordered decl list (snapshot, codegen, registry, projection).
				emitContributions(ctx, makeLocalCapabilities(name, opts, projected));
				// Part 2 (custom-kind re-home): on a fresh publish, fold the
				// output's coins into the per-stack CoinRegistry DIRECTLY (was
				// the orchestrator's `publishResultSink` consuming the now-
				// dead `LOCAL_PACKAGE_PUBLISHED` decl). `output` is null on a
				// cache hit (verify path), so discovery is skipped then — the
				// registry was already populated on the fresh-publish run that
				// seeded the cache.
				if (output !== null) {
					yield* discoverPublishedCoins(coinRegistry, name, projected.packageId, output);
				}
				return projected;
			}),
	});
};

const buildKnownPlugin = <Name extends string>(name: Name, opts: KnownPackageOptions) => {
	const packageRef = resource<PackageResourceId<Name>, KnownPackageResolved>(
		packageResourceId(name),
	);
	return definePlugin({
		id: packageRef.id,
		dependsOn: { sui: suiResource },
		role: 'task',
		section: 'package',
		start: ({ sui }) =>
			Effect.gen(function* () {
				const ctx = yield* PluginContext;
				const publisher = yield* CacheService;
				const probe = yield* chainProbeFor<SuiProbeKey>(sui.chain);
				const registry = yield* PackageRegistryService;
				const mode = {
					mode: 'known',
					packageName: name,
					packageId: opts.packageId,
					upgradeCapId: opts.upgradeCapId,
					mvrOverride: opts.mvrPlaceholder,
				} satisfies PackageMode;
				const { resolved } = yield* bootPackageService(publisher, probe, registry, mode);
				// Emit the resolved package's contributions inline via the
				// shared `emitContributions` router. `makeKnownCapabilities`
				// builds the ordered decl list (snapshot, codegen, registry,
				// projection).
				emitContributions(ctx, makeKnownCapabilities(name, opts, resolved));
				// Known mode never publishes — no output to walk, so
				// the coin-discovery hook is skipped here. Users who
				// want coin records for a knownPackage point a
				// `coin.known('0xPKG::module::Witness')` at the
				// fully-qualified type directly; the bare-type path
				// hits the live RPC for metadata rather than the
				// output-walker.
				return resolved;
			}),
	});
};

// ---------------------------------------------------------------------------
// Capability builders — pure helpers returning the ordered decl list.
//
// The package `start` bodies feed these into the shared `emitContributions`
// router after resolving the value. Decl shapes + emit ORDER are load-bearing.
//
// NOTE: the LOCAL builder does NOT append a custom published-coin decl.
// Coin discovery runs DIRECTLY in the local `start` body (see
// `discoverPublishedCoins`); appending a decl here would double-discover.
// ---------------------------------------------------------------------------

const makeLocalCapabilities = (
	name: string,
	opts: { readonly excludeFromCodegen?: boolean; readonly networks?: PackageNetworks },
	resolved: LocalPackageResolved,
): ReadonlyArray<Contribution> => {
	// Snapshot + codegen lift their typed fields off the resolved
	// publish (real packageId + captured object ids). The static-form
	// placeholders are gone.
	const snap: SnapshotableDecl = makeSnapshotable(
		name,
		resolved.publishResult?.packageId ?? resolved.packageId,
	);
	const codegen: CodegenableDecl<'package'> = makeLocalCodegenable(
		{
			kind: 'local',
			name,
			packageId: resolved.packageId,
			upgradeCapId: resolved.upgradeCapId,
			sourcePath: resolved.sourcePath,
			mvrPlaceholder: resolved.mvrPlaceholder,
			captured: resolved.captured,
		},
		{
			excluded: opts.excludeFromCodegen ?? false,
			...(opts.networks !== undefined ? { networks: opts.networks } : {}),
		},
	);
	// The plugin contributes to the package-registry strategy under a
	// fixed key — the substrate orchestrator wires all packages'
	// contributions into the same per-stack registry.
	const projection: PackageRegistryProjectionContribution = {
		kind: 'local',
		name,
		packageId: resolved.packageId,
		upgradeCapId: resolved.upgradeCapId ?? null,
		mvrPlaceholder: resolved.mvrPlaceholder,
		sourcePath: resolved.sourcePath,
	};
	const registryContribution: StrategyContributorDecl<
		typeof PACKAGE_REGISTRY_CAPABILITY_KEY,
		PackageRegistryProjectionContribution
	> = {
		kind: 'strategy-contributor',
		capabilityKey: PACKAGE_REGISTRY_CAPABILITY_KEY,
		strategy: projection,
		autoMounted: true,
	};
	return [snap, codegen, registryContribution, makePackageProjectionContribution(projection)];
};

const makeKnownCapabilities = (
	name: string,
	opts: KnownPackageOptions,
	resolved: KnownPackageResolved,
): ReadonlyArray<Contribution> => {
	const snap: SnapshotableDecl = makeSnapshotable(name, `known:${resolved.packageId}`);
	const codegen: CodegenableDecl<'package'> = makeKnownCodegenable(
		{
			kind: 'known',
			name,
			packageId: resolved.packageId,
			upgradeCapId: resolved.upgradeCapId ?? opts.upgradeCapId,
			mvrPlaceholder: resolved.mvrPlaceholder,
		},
		{ ...(opts.networks !== undefined ? { networks: opts.networks } : {}) },
	);
	const projection: PackageRegistryProjectionContribution = {
		kind: 'known',
		name,
		packageId: resolved.packageId,
		upgradeCapId: resolved.upgradeCapId ?? opts.upgradeCapId ?? null,
		mvrPlaceholder: resolved.mvrPlaceholder,
		sourcePath: null,
	};
	const registryContribution: StrategyContributorDecl<
		typeof PACKAGE_REGISTRY_CAPABILITY_KEY,
		PackageRegistryProjectionContribution
	> = {
		kind: 'strategy-contributor',
		capabilityKey: PACKAGE_REGISTRY_CAPABILITY_KEY,
		strategy: projection,
		autoMounted: true,
	};
	return [snap, codegen, registryContribution, makePackageProjectionContribution(projection)];
};

/** Fold a fresh local-package publish output into the per-stack
 *  `CoinRegistry`. Lifted VERBATIM from the orchestrator's former
 *  `publishResultSink` (orchestrators/boot.ts): the same
 *  `discoverCoinsFromPublish` walk + the same `CoinRecord` projection
 *  (including the publisher-owns-cap gate on `treasuryCapId`).
 *
 *  Re-homing this into the local `start` body — AFTER the publish output
 *  is known, BEFORE `start` returns — preserves discovery timing: the
 *  coin plugin `dependsOn` package, so it acquires only after package
 *  readies, by which point the registry is already populated. The
 *  previous decl-driven sink ran at the same point in the lifecycle
 *  (post-`start` dispatch), so consumers see no ordering change. */
export const discoverPublishedCoins = (
	coinRegistry: CoinRegistry,
	packageName: string,
	packageId: string,
	output: LocalPackagePublishOutput,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		for (const discovered of discoverCoinsFromPublish(output)) {
			const record: CoinRecord = {
				key: (discovered.symbol ?? discovered.witness).toLowerCase(),
				type: discovered.fullCoinType,
				witness: discovered.witness,
				moduleName: discovered.moduleName,
				decimals: discovered.decimals ?? 0,
				...(discovered.symbol === undefined ? {} : { symbol: discovered.symbol }),
				...(discovered.displayName === undefined ? {} : { displayName: discovered.displayName }),
				...(discovered.iconUrl === undefined ? {} : { iconUrl: discovered.iconUrl }),
				...(!discovered.publisherOwnsCap || discovered.treasuryCapId === undefined
					? {}
					: { treasuryCapId: discovered.treasuryCapId }),
				...(discovered.metadataId === undefined ? {} : { metadataId: discovered.metadataId }),
				packageId,
				publishingPackageName: packageName,
			};
			yield* coinRegistry.register(record);
		}
	});

// ---------------------------------------------------------------------------
// Public factories
// ---------------------------------------------------------------------------

/** Build + publish a local Move package. The resolved value is
 *  `LocalPackageResolved` so consumers that need bindings / source
 *  path are typed correctly.
 *
 *  Required `opts.publisher`: the account that signs the publish tx.
 *  Pass the same `account('alice')` reference used elsewhere in the
 *  stack — the package.s `dependsOn` includes `account/<publisher>`
 *  so the substrate orders the publisher's keypair + funding strictly
 *  before publish. */
export const localPackage = <
	Name extends string,
	const Publisher extends PublisherAccountMember,
	const Capture extends PackageCapture | undefined = undefined,
>(
	name: Name,
	opts: LocalPackageOptions<Publisher, Capture>,
) => buildLocalPlugin(name, opts);

/** Verify-only against a fixed on-chain package id. The resolved
 *  value is `KnownPackageResolved` — narrower than local, so the
 *  bindings emitter rejects this at compose time. */
export const knownPackage = <Name extends string>(name: Name, opts: KnownPackageOptions) =>
	buildKnownPlugin(name, opts);
