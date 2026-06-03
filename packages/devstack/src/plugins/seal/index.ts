// Seal plugin — barrel + factories.
//
// Architecture (07-seal.md): Seal is a local or known service plugin.
// Three operative modes:
//
//   - `local-keygen`  — localnet, owns the master key. Heavy boot.
//   - `live`          — testnet / mainnet, read-only handle to a
//                       known deployment.
//   - `fork-known`    — `*-fork` networks; routes to the wrapped
//                       upstream's known deployment.
//
// Plus one type-level refusal:
//
//   - `fork-localkeygen-refused` — local-keygen ON `*-fork` is a
//     synchronous throw at factory time (distilled-doc invariant #8).
//
// Public surface:
//
//   - `seal(opts)`              — explicit mode selection.
//   - `sealFor(network).<mode>` — mode-narrowed factory namespace.
//     Mode-narrowing makes `sealFor(forkNetwork).localKeygen(...)`
//     a COMPILE-time refusal (architecture Tension 11 + type-prototype
//     finding #4).
//
// Capability decls emitted:
//
//   1. Snapshotable        — local-keygen contributes secret material
//                            subtree; known modes contribute the
//                            empty shape.
//   2. Codegenable         — `seal-key-server` bindings (server
//                            configs + URL + objectId).
//   3. Routable            — `seal-key-server` endpoint, local-keygen
//                            only (known modes route to a remote URL
//                            outside Traefik's purview).

import { Effect, FileSystem, Path } from 'effect';

import { definePlugin, type ResourceRef, type ResourceValueOf } from '../../api/define-plugin.ts';
import { defineModeNamespace } from '../../api/mode-narrowed-factory.ts';
import { pluginErrorContributions } from '../../api/plugin-errors.ts';
import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { RoutableDecl } from '../../contracts/routable.ts';
import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import { IdentityContext, StackPathsService } from '../../substrate/runtime/paths.ts';
import type { PluginCtx } from '../../substrate/plugin-ctx.ts';
import { ArtifactPublisherService } from '../../substrate/runtime/artifact-publisher/index.ts';
import { chainProbeFor } from '../../substrate/runtime/strategy-registry/index.ts';
import type { AccountResourceId, AccountValue } from '../account/index.ts';
import { suiResource } from '../sui/index.ts';

import type { SealObjectProbeKey } from './deploy.ts';
import { sealPluginKey } from './plugin-key.ts';
import { makeSealCodegenable, type SealBindings } from './codegen.ts';
import { sealError, SEAL_ERROR_TAGS, type SealError } from './errors.ts';
import { validateForkKnownInputs, type ForkUpstream } from './mode/fork-known.ts';
import type { KnownNetwork } from './mode/live.ts';
import { validateLiveInputs } from './mode/live.ts';
import {
	buildSealNetworkName,
	DEFAULT_KEY_SERVER_PORT,
	deriveSealSubnetPrefix,
} from './key-server.ts';
import { withSubnetAddressing } from '../../substrate/runtime/subnet-broker.ts';
import {
	bootLocalKeygen,
	resolveLocalKeygenOptions,
	type LocalKeygenDeps,
} from './mode/local-keygen.ts';
import {
	makeSealResource,
	type SealLocalKeygenResolved,
	type SealKnownResolved,
	type SealResolved,
} from './registry-publish.ts';
import { buildSealKeyServerPublicRoute, makeSealRoutable } from './routable.ts';
import { makeKnownSnapshotable, makeLocalKeygenSnapshotable } from './snapshot.ts';
import { bootSealService, type SealMode } from './service.ts';
import { DEFAULT_SEAL_VERSION } from './bootstrap-assets/source-fetch.ts';

const sealErrorContributions = pluginErrorContributions(SEAL_ERROR_TAGS);

// ---------------------------------------------------------------------------
// Resource exports — distilled-doc §"TypeScript exports consumed elsewhere"
// ---------------------------------------------------------------------------

export {
	makeSealResource,
	sealResourceId,
	type SealKeyServer,
	type SealKeyServerEntry,
	type SealResolved,
	type SealLocalKeygenResolved,
	type SealKnownResolved,
	type SealResourceId,
} from './registry-publish.ts';
export type { SealKeyManager } from './key-manager.ts';
export {
	type SealError,
	type SealAnyError,
	type SealConfigError,
	SEAL_ERROR_TAGS,
} from './errors.ts';
export type { SealBindings } from './codegen.ts';
export { SealSpans } from './spans.ts';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Common options shared across all three modes. */
export interface SealCommonOptions {
	readonly name?: string;
}

/** A user-supplied signer account ref. The user passes the result of
 *  `account('publisher')` — NOT a magic-string token. Generic over the
 *  literal account name so the seal dependency edge preserves the
 *  per-account resource id. */
export type SealSignerMember<Name extends string = string> = ResourceRef<
	AccountResourceId<Name>,
	AccountValue
>;

/** Local-keygen mode options. The `signer` field is REQUIRED — the
 *  Move publish + on-chain register both need it. The mode-narrowed
 *  factory's TypeScript shape enforces this (no `signer?` here). */
export interface SealLocalKeygenOptions<
	Signer extends SealSignerMember = SealSignerMember,
> extends SealCommonOptions {
	/** Signer for the seal Move publish + on-chain key-server register.
	 *  Pass the result of `account('publisher')` — the same plugin/resource
	 *  ref used elsewhere in the stack. The ref is threaded through
	 *  `dependsOn` so the publish tx waits for the account's acquire
	 *  (keypair mint + funding) to complete. */
	readonly signer: Signer;
	readonly version?: string;
	readonly movePackagePath?: string;
	readonly readyTimeoutMs?: number;
	readonly keyServerName?: string;
	readonly image?: { readonly pull: string } | { readonly build: { readonly context: string } };
}

/** Live-mode options (testnet / mainnet). */
export interface SealLiveOptions extends SealCommonOptions {
	readonly network?: KnownNetwork;
	readonly objectId?: string;
	readonly keyServerUrl?: string;
}

/** Fork-known-mode options. */
export interface SealForkKnownOptions extends SealCommonOptions {
	readonly upstream: ForkUpstream;
	readonly objectId?: string;
	readonly keyServerUrl?: string;
}

export type SealOptions<Signer extends SealSignerMember = SealSignerMember> =
	| ({ readonly mode: 'local-keygen' } & SealLocalKeygenOptions<Signer>)
	| ({ readonly mode: 'live' } & SealLiveOptions)
	| ({ readonly mode: 'fork-known' } & SealForkKnownOptions);

// ---------------------------------------------------------------------------
// Plugin construction
// ---------------------------------------------------------------------------

/** Constants + shared knobs for the buildXyz helpers below. */
const DEFAULT_NAME = 'seal';

// ---------------------------------------------------------------------------
// Per-mode capability builders — pure helpers that RETURN the ordered decl
// tuple; the three `start` bodies emit them inline via the typed `ctx` verbs
// (`emit*Capabilities`) after resolving the value, instead of the legacy
// `capabilities` second-closure. The decl shapes + emit ORDER are
// byte-identical to the closure/array path the supervisor used to harvest.
//
// ⚠ ID-STABILITY: the snapshotable decl captures the seal vault / master-key
// secret material subtree; its shape (subtree paths, container label tuple,
// secretMaterial / missingTolerance flags) MUST stay byte-identical. Only the
// EMISSION moves from the `capabilities` field into `start`.
// ---------------------------------------------------------------------------

/** Build the local-keygen-mode ordered decl tuple POST-acquire. Pure helper
 *  — receives the resolved `SealResolved` value + the stack identity app/stack
 *  so decls stamp the REAL objectId / keyServerUrl / serverConfigs into the
 *  codegen bindings and the real identity into the snapshot + routable decls
 *  (was the `capabilities: ({ value, runtime }) => …` closure's
 *  `value` / `runtime.identity`). */
const buildLocalKeygenCapabilities = (
	name: string,
	resolvedKs: SealResolved,
	identity: { readonly app: string; readonly stack: string },
): readonly [SnapshotableDecl, CodegenableDecl<`seal/${string}`>, RoutableDecl] => {
	const bindings: SealBindings = {
		name,
		objectId: resolvedKs.objectId,
		keyServerUrl: resolvedKs.keyServerUrl,
		serverConfigs: resolvedKs.serverConfigs,
		mode: 'local-keygen',
	};
	const snap = makeLocalKeygenSnapshotable({
		name,
		app: identity.app,
		stack: identity.stack,
	});
	const codegen = makeSealCodegenable(bindings);
	const routable = makeSealRoutable({
		name,
		containerName: `devstack-${identity.app}-${identity.stack}-seal-${name}-key-server`,
	});
	return [snap, codegen, routable] as const;
};

/** Emit the pure decls from `buildLocalKeygenCapabilities` inline via the
 *  typed `ctx` verbs, routing each by its `kind` discriminator IN RETURN
 *  ORDER (snapshotable → `ctx.snapshotExtra`, codegenable → `ctx.codegen`,
 *  routable → `ctx.endpoint`). Order + decl shapes are byte-identical to the
 *  supervisor's legacy `capabilities`-closure harvest.
 *
 *  Exported as the Stage-B emit seam (mirrors sui/coin): feed a resolved
 *  `SealResolved` + identity here and assert the captured verbs to drive the
 *  contribution half of `start` without a live boot. */
export const emitLocalKeygenCapabilities = (
	ctx: PluginCtx,
	name: string,
	resolvedKs: SealResolved,
	identity: { readonly app: string; readonly stack: string },
): void => {
	for (const decl of buildLocalKeygenCapabilities(name, resolvedKs, identity)) {
		switch (decl.kind) {
			case 'snapshotable':
				ctx.snapshotExtra(decl);
				break;
			case 'codegenable':
				ctx.codegen(decl);
				break;
			case 'routable':
				ctx.endpoint(decl);
				break;
		}
	}
};

/** Build the known-deployment ordered decl tuple. Pure helper for live +
 *  fork-known modes. The snapshotable decl is mode-shared (empty shape, no
 *  host state); only the codegen bindings' `mode` marker differs.
 *
 *  Live mode resolves its bindings at FACTORY time (validated `{objectId,
 *  keyServerUrl}`) so it passes a precomputed `bindings`; fork-known builds
 *  bindings from the post-acquire `resolvedKs` (preserving the legacy
 *  callback-form behaviour). Both route through this single builder. */
const buildKnownCapabilities = (
	snap: SnapshotableDecl,
	bindings: SealBindings,
): readonly [SnapshotableDecl, CodegenableDecl<`seal/${string}`>] => {
	return [snap, makeSealCodegenable(bindings)] as const;
};

/** Emit the known-deployment decls inline via the typed `ctx` verbs, routing
 *  each by its `kind` discriminator IN RETURN ORDER (snapshotable →
 *  `ctx.snapshotExtra`, codegenable → `ctx.codegen`). Byte-identical to the
 *  legacy live (`[snap, codegen]` static array) / fork-known (callback-form)
 *  harvest. */
export const emitKnownCapabilities = (
	ctx: PluginCtx,
	snap: SnapshotableDecl,
	bindings: SealBindings,
): void => {
	for (const decl of buildKnownCapabilities(snap, bindings)) {
		switch (decl.kind) {
			case 'snapshotable':
				ctx.snapshotExtra(decl);
				break;
			case 'codegenable':
				ctx.codegen(decl);
				break;
		}
	}
};

/** Build the local-keygen-mode plugin. The service contributes
 *  Snapshotable (secret) + Codegenable + Routable.
 *
 *  Architecture mirror (walrus): `ContainerRuntimeService` +
 *  `IdentityContext` wired via the supervisor's plugin runtime context,
 *  artifact publisher publisher + chain probe yielded inside `acquire`. */
const buildLocalKeygenPlugin = <const Signer extends SealSignerMember>(
	opts: SealLocalKeygenOptions<Signer>,
) => {
	// Synchronous factory-time defaults. Localnet-signer-required is
	// enforced by the typed `signer:` field on
	// SealLocalKeygenOptions.
	const resolved = resolveLocalKeygenOptions(opts, DEFAULT_SEAL_VERSION);

	const sealResource = makeSealResource(resolved.name);

	return definePlugin({
		id: sealResource.id,
		dependsOn: { sui: suiResource, signer: opts.signer },
		role: 'service',
		section: 'service',
		pluginKey: sealPluginKey(resolved.name),
		// `deps` is annotated explicitly: a required `ctx` 2nd param means the
		// destructured object no longer arity-matches the single-arg
		// `PluginStart` contextual default, so TS would otherwise infer the
		// bindings as `any`. The annotation reproduces the resolved
		// `{ sui, signer }` dependency object the default supplied for seal's
		// `dependsOn: { sui: suiResource, signer: opts.signer }`. `ctx` is the
		// typed plugin-authoring surface the contribution emission below drives
		// (Stage B inversion — replaced the legacy `capabilities`
		// second-closure).
		start: (
			deps: {
				sui: ResourceValueOf<typeof suiResource>;
				signer: AccountValue;
			},
			ctx: PluginCtx,
		) =>
			Effect.gen(function* () {
				const { sui, signer: signerAccount } = deps;
				// Substrate-context primitives:
				//   - `ContainerRuntimeService` + `IdentityContext` arrive
				//     via the supervisor's plugin runtime context.
				//   - `ArtifactPublisher` is the substrate-level
				//     publisher (cache → verify → produce → register cycle).
				//   - Chain probe is looked up via the
				//     StrategyRegistry under `chain-probe:<chainId>`; the
				//     Sui plugin registered it during its own acquire.
				//     The probe is yielded eagerly so the dep edge fails
				//     fast if sui's chain-probe registration is missing,
				//     matching walrus's pattern.
				//   - `StackPathsService` resolves the per-stack on-disk
				//     root so the key-server config + master-key.env
				//     bind-mount sources are real paths (not the
				//     `<runtime>/...` template).
				const runtime = yield* ContainerRuntimeService;
				const identity = yield* IdentityContext;
				const publisher = yield* ArtifactPublisherService;
				const stackPaths = yield* StackPathsService;
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const probe = yield* chainProbeFor<SealObjectProbeKey>(sui.chain);

				// Resolve the seal service dir from the per-stack paths
				// bundle. The dir must exist before the key-server's
				// bind-mounts (config yaml + master-key env-file).
				const servicePath = path.join(stackPaths.stackRoot, 'seal', resolved.name);
				yield* fs.makeDirectory(servicePath, { recursive: true }).pipe(
					Effect.catch((cause) =>
						Effect.fail(
							sealError('config-render', {
								name: resolved.name,
								message: `seal.config-render: failed to create service directory at ${servicePath} — downstream config + master-key writes would all fail; surfacing the underlying filesystem error.`,
								cause,
							}),
						),
					),
				);

				// Cross-container DNS: seal's key-server dials sui RPC via
				// `host.docker.internal`. The sui plugin binds a brokered
				// host port; the SDK publish/register path runs from the host
				// process and does not need the container network.
				//
				// Architectural decision (B5): seal owns its OWN docker
				// network for the key-server's network attachment;
				// sui-side hops go through the host gateway. Mirrors
				// walrus's pattern (see plugins/walrus/index.ts §B5).
				const sealNetworkName = buildSealNetworkName(identity.app, identity.stack, resolved.name);
				const suiRpcUrlInNetwork = sui.hostGateway.rpcUrl;
				const routed = buildSealKeyServerPublicRoute({
					app: identity.app,
					stack: identity.stack,
					port: DEFAULT_KEY_SERVER_PORT,
				});

				// Idempotent network create — the long-running key-server
				// attaches to this name. The seal boot pipeline doesn't own
				// the create (unlike walrus's local-cluster which calls
				// `ensureNetwork` from its mode body); we call it here
				// because the substrate's `acquire` is the only seam that
				// holds both the runtime + the identity needed for the
				// per-stack label tuple.
				const sealSubnetPrefix = deriveSealSubnetPrefix({
					app: identity.app,
					stack: identity.stack,
					sealName: resolved.name,
				});
				yield* runtime.ensureNetwork(
					withSubnetAddressing(
						{
							name: sealNetworkName,
							app: identity.app,
							stack: identity.stack,
						},
						sealSubnetPrefix,
					),
				);

				const localKeygenDeps: LocalKeygenDeps = {
					runtime,
					publisher,
					signer: signerAccount,
					sdk: sui.sdk,
					...(sui.buildImage !== null ? { buildImage: sui.buildImage } : {}),
					chainProbe: probe,
					chain: sui.chain,
					servicePath,
					containerName: `devstack-${identity.app}-${identity.stack}-seal-${resolved.name}-key-server`,
					labels: {
						app: identity.app,
						stack: identity.stack,
						plugin: 'seal',
						role: 'key-server',
					},
					suiNetworkName: sealNetworkName,
					suiRpcUrlInNetwork,
					routedHostname: routed.hostname,
					routedUrl: routed.url,
				};

				const boot = (yield* bootLocalKeygen(
					localKeygenDeps,
					resolved,
				)) satisfies SealLocalKeygenResolved;

				const resolvedValue: SealResolved = {
					...boot.keyServer,
					mode: 'local-keygen',
					manager: boot.keyManager,
				};
				// Stage B: emit the resolved contributions inline (was the
				// `capabilities: ({ value: resolvedKs, runtime: acquireCtx }) =>
				// …` closure). `resolvedValue` is the just-resolved `SealResolved`
				// the closure received as `value`; `identity` is the same
				// `Identity` the legacy `acquireCtx.identity` carried (read here
				// from `IdentityContext` above, NOT re-fetched). The snapshotable
				// decl stamping the seal vault / master-key secret-material
				// subtree is byte-identical — same name/app/stack inputs.
				emitLocalKeygenCapabilities(ctx, resolved.name, resolvedValue, identity);
				return resolvedValue;
			}),
		errorContributions: sealErrorContributions,
	});
};

/** Build the live-mode plugin. No Routable (URL is remote). */
const buildLivePlugin = (opts: SealLiveOptions) => {
	const name = opts.name ?? DEFAULT_NAME;
	const sealResource = makeSealResource(name);
	// Validate inputs at factory time so misconfigurations fail
	// before any plugin row starts work.
	const validated = validateLiveInputs({ name, ...opts });
	const bindings: SealBindings = {
		name,
		objectId: validated.objectId,
		keyServerUrl: validated.keyServerUrl,
		serverConfigs: [{ objectId: validated.objectId, weight: 1 }],
		mode: 'live',
	};
	const snap = makeKnownSnapshotable({ name });

	return definePlugin({
		id: sealResource.id,
		role: 'task',
		section: 'service',
		// Live mode has no `dependsOn`, so `_deps` is always `undefined`; it is
		// annotated explicitly because the required `ctx` 2nd param means the
		// start closure no longer arity-matches the single-arg `PluginStart`
		// contextual default, so TS would otherwise widen the params to `any`.
		// `ctx` drives the contribution emission below (Stage B inversion —
		// replaced the legacy static `capabilities: [snap, codegen]` array).
		start: (_deps: undefined, ctx: PluginCtx) =>
			Effect.gen(function* () {
				const mode: SealMode = { mode: 'live', name, resolved: validated };
				const publisher = yield* ArtifactPublisherService;
				const resolved = (yield* bootSealService(publisher, mode)) as SealKnownResolved;
				// Stage B: emit inline (was the static `capabilities: [snap,
				// codegen]` array). `snap` + `bindings` are resolved at FACTORY
				// time for live mode (validated `{objectId, keyServerUrl}`), so
				// the emit reuses the same precomputed values — byte-identical
				// decls in the same order.
				emitKnownCapabilities(ctx, snap, bindings);
				return {
					...resolved.keyServer,
					mode: 'live',
					manager: null,
				} satisfies SealResolved;
			}),
		errorContributions: sealErrorContributions,
	});
};

/** Build the fork-known-mode plugin. Structurally symmetric with
 *  `buildLivePlugin` — both resolve their `{objectId, keyServerUrl}`
 *  tuple at factory time via `validateLiveInputs` (the fork-known
 *  side maps `upstream → KnownNetwork` first via
 *  `validateForkKnownInputs`) and thread it through SealMode's
 *  `resolved:` envelope.
 *
 *  Capabilities are kept on the dynamic shape (callback form)
 *  rather than precomputed — leaves room for a future on-acquire
 *  override path (e.g. the substrate dynamically rewrites the
 *  bindings) without restructuring the factory. Not load-bearing
 *  today; static capabilities would also work. */
const buildForkKnownPlugin = (opts: SealForkKnownOptions) => {
	const name = opts.name ?? DEFAULT_NAME;
	const sealResource = makeSealResource(name);
	const snap = makeKnownSnapshotable({ name });
	// Validate inputs at factory time so misconfigurations fail
	// before any plugin row starts work — symmetric with
	// `buildLivePlugin`'s factory-boundary `validateLiveInputs` call.
	// `validateForkKnownInputs` maps the upstream alias to a
	// `KnownNetwork` and runs the same validation pipeline as live mode.
	const validated = validateForkKnownInputs({ name, ...opts });

	return definePlugin({
		id: sealResource.id,
		role: 'task',
		section: 'service',
		// Fork-known mode has no `dependsOn`, so `_deps` is always `undefined`;
		// it is annotated explicitly because the required `ctx` 2nd param means
		// the start closure no longer arity-matches the single-arg
		// `PluginStart` contextual default, so TS would otherwise widen the
		// params to `any`. `ctx` drives the contribution emission below (Stage B
		// inversion — replaced the legacy `capabilities` callback-form closure).
		start: (_deps: undefined, ctx: PluginCtx) =>
			Effect.gen(function* () {
				// Symmetric with the live branch's `{ mode, name, resolved }`
				// envelope. `upstream` rides through for downstream
				// span attribution; `resolved` carries the validated
				// `{objectId, keyServerUrl}` tuple.
				const mode: SealMode = {
					mode: 'fork-known',
					name,
					upstream: opts.upstream,
					resolved: validated,
				};
				const publisher = yield* ArtifactPublisherService;
				const resolved = (yield* bootSealService(publisher, mode)) as SealKnownResolved;
				const resolvedValue: SealResolved = {
					...resolved.keyServer,
					mode: 'fork-known',
					manager: null,
				};
				// Stage B: emit inline (was the `capabilities: ({ value:
				// resolvedKs }) => [snap, makeSealCodegenable(bindings)]`
				// closure). `bindings` is built from the post-acquire
				// `resolved.keyServer` — the SAME `{objectId, keyServerUrl,
				// serverConfigs}` fields the closure read off `resolvedKs`
				// (which was `{ ...resolved.keyServer, mode, manager }`). The
				// `snap` decl is factory-scoped + byte-identical.
				const bindings: SealBindings = {
					name,
					objectId: resolved.keyServer.objectId,
					keyServerUrl: resolved.keyServer.keyServerUrl,
					serverConfigs: resolved.keyServer.serverConfigs,
					mode: 'fork-known',
				};
				emitKnownCapabilities(ctx, snap, bindings);
				return resolvedValue;
			}),
		errorContributions: sealErrorContributions,
	});
};

// ---------------------------------------------------------------------------
// User-facing factories
// ---------------------------------------------------------------------------

/** Explicit Seal factory. `local-keygen` requires a signer; live and
 *  fork-known modes must be selected directly or through `sealFor`. */
export const seal = <const Signer extends SealSignerMember = SealSignerMember>(
	opts: SealOptions<Signer>,
) => {
	switch (opts.mode) {
		case 'local-keygen':
			return buildLocalKeygenPlugin(opts);
		case 'live':
			return buildLivePlugin(opts);
		case 'fork-known':
			return buildForkKnownPlugin(opts);
	}
};

/** Mode-narrowed factory namespace.
 *
 *  Usage:
 *      const local = { mode: 'local' } as const;
 *      sealFor(local).localKeygen({signer})    // OK
 *      sealFor(local).forkKnown(...)           // type error: not in 'local' branch
 *
 *      const fork = { mode: 'fork' } as const;
 *      sealFor(fork).forkKnown({upstream})     // OK
 *      sealFor(fork).localKeygen({signer})     // type error: not in 'fork' branch
 *                                              // (distilled-doc invariant #8)
 *
 *  Distilled-doc invariant #8 (fork-localkeygen-refused): the
 *  fork-mode branch has NO `localKeygen` entry — that's the
 *  type-level refusal. */
export const sealFor = defineModeNamespace({
	local: {
		localKeygen: <const Signer extends SealSignerMember>(opts: SealLocalKeygenOptions<Signer>) =>
			buildLocalKeygenPlugin(opts),
	},
	live: {
		testnet: (opts: Omit<SealLiveOptions, 'network'> = {}) =>
			buildLivePlugin({ network: 'testnet', ...opts }),
		mainnet: (opts: Omit<SealLiveOptions, 'network'> = {}) =>
			buildLivePlugin({ network: 'mainnet', ...opts }),
		custom: (
			opts: Required<Pick<SealLiveOptions, 'objectId' | 'keyServerUrl'>> & SealLiveOptions,
		) => buildLivePlugin(opts),
	},
	fork: {
		forkKnown: (opts: SealForkKnownOptions) => buildForkKnownPlugin(opts),
	},
});

// ---------------------------------------------------------------------------
// Type-only error re-export
// ---------------------------------------------------------------------------

export type { SealError as SealAcquireError };
