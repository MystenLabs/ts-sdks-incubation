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
// Resource id: `'package:<name>'` — one tag per user-declared package
// (the symbolic name is part of the identity so two `localPackage`
// calls in the same stack don't collide on the substrate's tag
// registry). Substrate-side plugin key is the same string.

import { Effect } from 'effect';

import { definePlugin, resource, type ResourceRef } from '../../api/define-plugin.ts';
import { pluginErrorContributions } from '../../api/plugin-errors.ts';
import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { ProjectionDecl } from '../../contracts/projection.ts';
import {
	makeLocalPackagePublishedDecl,
	pickCreatedByType,
	type LocalPackagePublishOutput,
} from './publish-output.ts';
import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import type { ChainId } from '../../substrate/brand.ts';
import { ArtifactPublisherService } from '../../substrate/runtime/artifact-publisher/index.ts';
import { chainProbeFor } from '../../substrate/runtime/strategy-registry/index.ts';
import { suiResource } from '../sui/index.ts';
import type { SuiProbeKey } from '../sui/chain-probe.ts';
import type { AccountResourceId } from '../account/index.ts';
import type { AccountValue } from '../account/service.ts';
import { makeKnownCodegenable, makeLocalCodegenable } from './codegen.ts';
import { makePublishExecutor } from './publish-executor.ts';
import { bootPackageService, type PackageMode } from './service.ts';
import {
	PACKAGE_REGISTRY_CAPABILITY_KEY,
	PackageRegistryService,
	type ResolvedKnownPackage,
	type ResolvedLocalPackage,
} from './registry.ts';
import { makeSnapshotable } from './snapshot.ts';
import { PACKAGE_ERROR_TAGS, type PublishError } from './errors.ts';

const packageErrorContributions = pluginErrorContributions(PACKAGE_ERROR_TAGS);

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
export { PACKAGE_ERROR_TAGS } from './errors.ts';
export type { PackageBindings } from './codegen.ts';
export type { PublishExecutor } from './mode-local.ts';

/** Resolved value carried by the package resource. Local packages also
 *  expose the publish output so manifest emitters and capture-spec
 *  callers can read it. Sibling plugin folds consume the package-owned
 *  extension contribution instead of importing package internals. */
export type PackageCaptureMap = Readonly<Record<string, string>>;

export type PackageCaptureCallback = (
	output: LocalPackagePublishOutput,
) => Readonly<Record<string, string>>;

export type PackageCapture = PackageCaptureMap | PackageCaptureCallback;

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
	/** Optional Effect-resolved source path (distilled doc Invariant
	 *  15 — vendored-fetch round-trips through publish). When set,
	 *  `sourcePath` is the SYNCHRONOUS placeholder used for type
	 *  inference; the actual path is resolved at acquire time. */
	readonly resolveSourcePath?: Effect.Effect<string, PublishError>;
	readonly mvrPlaceholder?: string;
	readonly excludeFromCodegen?: boolean;
	/** Capture created objects from the publish output. The record
	 *  form maps output keys to object-type suffixes, e.g.
	 *  `{ boardId: '::board::Board' }`; the callback form is the
	 *  escape hatch for custom output projections. */
	readonly capture?: Capture;
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
	projection: PackageRegistryProjectionContribution,
): ProjectionDecl => {
	const updatedAt = Date.now();
	return {
		kind: 'projection',
		event: {
			tag: 'package.updated',
			package: {
				key: `package/${projection.name}` as `package/${string}`,
				rowKey: null,
				name: projection.name,
				kind: projection.kind,
				packageId: projection.packageId,
				upgradeCapId: projection.upgradeCapId,
				mvrPlaceholder: projection.mvrPlaceholder,
				sourcePath: projection.sourcePath,
				updatedAt,
			},
			at: updatedAt,
		},
	};
};

// ---------------------------------------------------------------------------
// Internal builders
// ---------------------------------------------------------------------------

const normalizeCapture = <Capture extends PackageCapture | undefined>(
	packageName: string,
	capture: Capture,
): PackageCaptureCallback | undefined => {
	if (capture === undefined) return undefined;
	if (typeof capture === 'function') return capture;
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
		start: ({ sui, publisher: publisherAccount }) =>
			Effect.gen(function* () {
				// Substrate-context primitives: ArtifactPublisher
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
				const publisher = yield* ArtifactPublisherService;
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

				const mode = {
					mode: 'local',
					packageName: name,
					sourcePath,
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
				return projected;
			}),
		errorContributions: packageErrorContributions,
		capabilities: ({ value, runtime }) => makeLocalCapabilities(name, opts, value, runtime.chain),
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
		start: ({ sui }) =>
			Effect.gen(function* () {
				const publisher = yield* ArtifactPublisherService;
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
				// Known mode never publishes — no output to walk, so
				// the coin-discovery hook is skipped here. Users who
				// want coin records for a knownPackage point a
				// `coin.known('0xPKG::module::Witness')` at the
				// fully-qualified type directly; the bare-type path
				// hits the live RPC for metadata rather than the
				// output-walker.
				return resolved;
			}),
		errorContributions: packageErrorContributions,
		capabilities: ({ value }) => makeKnownCapabilities(name, opts, value),
	});
};

const makeLocalCapabilities = (
	name: string,
	opts: { readonly excludeFromCodegen?: boolean },
	resolved: LocalPackageResolved,
	chain: ChainId,
) => {
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
		{ excluded: opts.excludeFromCodegen ?? false },
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
	return [
		snap,
		codegen,
		registryContribution,
		makePackageProjectionContribution(projection),
		...(resolved.publishResult === null
			? []
			: [
					makeLocalPackagePublishedDecl({
						packageName: name,
						packageId: resolved.packageId,
						chain,
						output: resolved.publishResult,
					}),
				]),
	] as const;
};

const makeKnownCapabilities = (
	name: string,
	opts: KnownPackageOptions,
	resolved: KnownPackageResolved,
) => {
	const snap: SnapshotableDecl = makeSnapshotable(name, `known:${resolved.packageId}`);
	const codegen: CodegenableDecl<'package'> = makeKnownCodegenable({
		kind: 'known',
		name,
		packageId: resolved.packageId,
		upgradeCapId: resolved.upgradeCapId ?? opts.upgradeCapId,
		mvrPlaceholder: resolved.mvrPlaceholder,
	});
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
	return [
		snap,
		codegen,
		registryContribution,
		makePackageProjectionContribution(projection),
	] as const;
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

/** Convenience entry point — branches on `'packageId' in opts`.
 *  Prefer the explicit `localPackage` / `knownPackage` factories
 *  at call sites; this exists so the user-facing `package(...)`
 *  vocabulary matches the distilled doc's surface. */
export function pkg<
	Name extends string,
	const Publisher extends PublisherAccountMember,
	const Capture extends PackageCapture | undefined = undefined,
>(
	name: Name,
	opts: LocalPackageOptions<Publisher, Capture>,
): ReturnType<typeof buildLocalPlugin<Name, Publisher, Capture>>;
export function pkg<Name extends string>(
	name: Name,
	opts: KnownPackageOptions,
): ReturnType<typeof buildKnownPlugin<Name>>;
export function pkg<
	Name extends string,
	const Publisher extends PublisherAccountMember,
	const Capture extends PackageCapture | undefined = undefined,
>(name: Name, opts: LocalPackageOptions<Publisher, Capture> | KnownPackageOptions) {
	return 'packageId' in opts ? buildKnownPlugin(name, opts) : buildLocalPlugin(name, opts);
}
