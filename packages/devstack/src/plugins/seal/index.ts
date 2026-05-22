// Seal plugin — barrel + factories.
//
// Architecture (07-seal.md): Seal is a SIBLING composite primitive
// to walrus. Three operative modes:
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
//   - `seal(opts?)`             — env-driven mode selection.
//   - `sealFor.for(network).<mode>` — mode-narrowed factory namespace.
//     Mode-narrowing makes `sealFor.for(forkNetwork).localKeygen(...)`
//     a COMPILE-time refusal (architecture Tension 11 + type-prototype
//     finding #4).
//
// Capability decls emitted:
//
//   1. CompositePrimitive  — inner participants + lifted siblings.
//   2. Snapshotable        — local-keygen contributes secret material
//                            subtree; known modes contribute the
//                            empty shape.
//   3. Codegenable         — `seal-key-server` bindings (server
//                            configs + URL + objectId).
//   4. Routable            — `seal-key-server` endpoint, local-keygen
//                            only (known modes route to a remote URL
//                            outside Traefik's purview).

import { Effect, FileSystem, Path } from 'effect';

import { definePlugin, type ResourceRef } from '../../api/define-plugin.ts';
import { defineModeNamespace } from '../../api/mode-narrowed-factory.ts';
import { pluginErrorContributions } from '../../api/plugin-errors.ts';
import type { NetworkConfig } from '../../substrate/network.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import { IdentityContext, StackPathsService } from '../../substrate/runtime/paths.ts';
import { OnChainArtifactPublisherService } from '../../substrate/runtime/on-chain-artifact/index.ts';
import { chainProbeFor } from '../../substrate/runtime/strategy-registry/index.ts';
import type { AccountResourceId } from '../account/index.ts';
import type { AccountValue } from '../account/service.ts';
import { suiResource } from '../sui/index.ts';

import type { SealObjectProbeKey } from './deploy.ts';
import { makeSealComposite } from './composite.ts';
import { makeSealCodegenable, type SealBindings } from './codegen.ts';
import {
	forkIncompatibleError,
	sealConfigError,
	SEAL_ERROR_TAGS,
	type SealError,
} from './errors.ts';
import { defaultSealCargoImageSiblingKey } from './lifted-siblings/cargo-image.ts';
import { defaultSealSourceSiblingKey } from './lifted-siblings/source-fetch.ts';
import type { ForkUpstream } from './mode/fork-known.ts';
import type { KnownNetwork } from './mode/live.ts';
import { validateLiveInputs } from './mode/live.ts';
import {
	buildSealNetworkName,
	DEFAULT_KEY_SERVER_PORT,
	deriveSealSubnetPrefix,
	sealNetworkCreateSpec,
} from './key-server.ts';
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
import { parseDevstackNetwork } from '../../api/inference-network.ts';

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
export {
	sealCargoImageKey,
	type SealCargoImageKey,
	type SealCargoImageResolved,
} from './lifted-siblings/cargo-image.ts';
export {
	sealSourceFetchKey,
	type SealSourceFetchKey,
	type SealSourceFetchResolved,
	DEFAULT_SEAL_REPO,
	DEFAULT_SEAL_VERSION,
	DEFAULT_SEAL_MOVE_SUBDIR,
} from './lifted-siblings/source-fetch.ts';

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

/** Build the local-keygen-mode plugin. The composite contributes
 *  CompositePrimitive + Snapshotable (secret) + Codegenable +
 *  Routable.
 *
 *  Architecture mirror (walrus): `kind: 'composite'`, lifted siblings
 *  declared at factory time, `ContainerRuntimeService` +
 *  `IdentityContext` wired via the supervisor's plugin runtime
 *  context, OCA publisher + chain probe yielded inside `acquire`. */
const buildLocalKeygenPlugin = <const Signer extends SealSignerMember>(
	opts: SealLocalKeygenOptions<Signer>,
) => {
	// Synchronous factory-time defaults. Localnet-signer-required is
	// enforced one layer up by the type-narrowed `sealLocalKeygenStrict`
	// + the typed `signer:` field on SealLocalKeygenOptions.
	const resolved = resolveLocalKeygenOptions(opts, '<default-seal-version>');

	const sealResource = makeSealResource(resolved.name);

	// Lifted siblings — declared at factory time so the topo scheduler
	// places them at level 0 (parallel with sui's boot). Two siblings:
	//   1. cargo-image — upstream cargo build (key includes seal ref +
	//                    rust toolchain).
	//   2. move-source — git checkout of the seal Move package subdir
	//                    (key includes repo@ref/subdir).
	// The move-source sibling is dropped when the user pinned a
	// `movePackagePath` opt (lifted-sibling discipline: don't pull a
	// fetch the user already short-circuited).
	const cargoImageKey = defaultSealCargoImageSiblingKey();
	const moveSourceKey = defaultSealSourceSiblingKey();
	const siblingKeys = resolved.movePackagePath ? [cargoImageKey] : [cargoImageKey, moveSourceKey];

	const composite = makeSealComposite({
		name: resolved.name,
		liftedSiblings: siblingKeys,
		// `innerParticipants` is empty at factory time — the substrate's
		// composite scheduler synthesises the keygen + publish + register
		// + container child members from the composite's acquire return
		// value.
		innerParticipants: [],
	});
	return definePlugin({
		id: sealResource.id,
		dependsOn: { sui: suiResource, signer: opts.signer },
		kind: 'composite',
		rebootCost: 'heavy',
		start: (_ctx, deps) =>
			Effect.gen(function* () {
				const { sui, signer: signerAccount } = deps;
				// Substrate-context primitives:
				//   - `ContainerRuntimeService` + `IdentityContext` arrive
				//     via the supervisor's plugin runtime context.
				//   - `OnChainArtifactPublisher` is the substrate-level
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
				const publisher = yield* OnChainArtifactPublisherService;
				const stackPaths = yield* StackPathsService;
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const probe = yield* chainProbeFor<SealObjectProbeKey>(sui.chain);

				// Resolve the seal service dir from the per-stack paths
				// bundle. The dir must exist before the key-server's
				// bind-mounts (config yaml + master-key env-file).
				const servicePath = path.join(stackPaths.stackRoot, 'seal', resolved.name);
				yield* fs
					.makeDirectory(servicePath, { recursive: true })
					.pipe(Effect.catch(() => Effect.void));

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
					sealNetworkCreateSpec(
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
				return resolvedValue;
			}),
		// Dynamic capability factory — receives the resolved
		// `SealKeyServer` + acquire context. Stamps the REAL
		// objectId / keyServerUrl into codegen bindings and the
		// real identity app/stack into the snapshot decl.
		capabilities: ({ value: resolvedKs, runtime: acquireCtx }) => {
			const bindings: SealBindings = {
				name: resolved.name,
				objectId: resolvedKs.objectId,
				keyServerUrl: resolvedKs.keyServerUrl,
				serverConfigs: resolvedKs.serverConfigs,
				mode: 'local-keygen',
			};
			const snap = makeLocalKeygenSnapshotable({
				name: resolved.name,
				app: acquireCtx.identity.app,
				stack: acquireCtx.identity.stack,
			});
			const codegen = makeSealCodegenable(bindings);
			const routable = makeSealRoutable({
				name: resolved.name,
				containerName: `devstack-${acquireCtx.identity.app}-${acquireCtx.identity.stack}-seal-${resolved.name}-key-server`,
			});
			return [composite, snap, codegen, routable] as const;
		},
		errorContributions: sealErrorContributions,
		liftedSiblings: siblingKeys,
	});
};

/** Build the live-mode plugin. No CompositePrimitive (no inner
 *  participants), no Routable (URL is remote). */
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
	const codegen = makeSealCodegenable(bindings);

	return definePlugin({
		id: sealResource.id,
		kind: 'leaf-one-shot',
		rebootCost: 'cheap',
		start: () =>
			Effect.gen(function* () {
				const mode: SealMode = { mode: 'live', name, ...opts };
				const publisher = yield* OnChainArtifactPublisherService;
				const resolved = (yield* bootSealService(publisher, mode)) as SealKnownResolved;
				return {
					...resolved.keyServer,
					mode: 'live',
					manager: null,
				} satisfies SealResolved;
			}),
		capabilities: [snap, codegen] as const,
		errorContributions: sealErrorContributions,
	});
};

/** Build the fork-known-mode plugin. Same structure as live, but with
 *  dynamic capabilities so the codegen bindings carry the REAL
 *  objectId / keyServerUrl resolved at acquire (the user-supplied
 *  options may be undefined → resolved by the upstream lookup). */
const buildForkKnownPlugin = (opts: SealForkKnownOptions) => {
	const name = opts.name ?? DEFAULT_NAME;
	const sealResource = makeSealResource(name);
	const snap = makeKnownSnapshotable({ name });

	return definePlugin({
		id: sealResource.id,
		kind: 'leaf-one-shot',
		rebootCost: 'cheap',
		start: () =>
			Effect.gen(function* () {
				const mode: SealMode = { mode: 'fork-known', name, ...opts };
				const publisher = yield* OnChainArtifactPublisherService;
				const resolved = (yield* bootSealService(publisher, mode)) as SealKnownResolved;
				return {
					...resolved.keyServer,
					mode: 'fork-known',
					manager: null,
				} satisfies SealResolved;
			}),
		capabilities: ({ value: resolvedKs }) => {
			const bindings: SealBindings = {
				name,
				objectId: resolvedKs.objectId,
				keyServerUrl: resolvedKs.keyServerUrl,
				serverConfigs: resolvedKs.serverConfigs,
				mode: 'fork-known',
			};
			return [snap, makeSealCodegenable(bindings)] as const;
		},
		errorContributions: sealErrorContributions,
	});
};

// ---------------------------------------------------------------------------
// Default option resolution
// ---------------------------------------------------------------------------

/** Read `DEVSTACK_NETWORK` env to pick a mode default. Mirrors the
 *  sui plugin's resolver — `*-fork` networks route to fork-known
 *  with the wrapped upstream. */
const resolveDefaultMode = (): Exclude<SealOptions, { readonly mode: 'local-keygen' }> => {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env?.DEVSTACK_NETWORK;
	const parsed = parseDevstackNetwork(env);
	switch (parsed.mode) {
		case 'local':
			// Local-keygen requires a signer; the env-default path
			// cannot satisfy that. Callers MUST pass opts on localnet.
			throw sealConfigError({
				field: 'signer',
				message:
					'seal: localnet mode requires opts.signer — pass { mode: "local-keygen", signer } or use sealFor.for(network).localKeygen({...}).',
			});
		case 'live':
			return { mode: 'live', network: parsed.network };
		case 'fork':
			return { mode: 'fork-known', upstream: parsed.upstream };
	}
};

// ---------------------------------------------------------------------------
// User-facing factories
// ---------------------------------------------------------------------------

/** Env-driven factory. Defaults to local-keygen if `DEVSTACK_NETWORK`
 *  is unset (but throws synchronously without an explicit signer).
 *
 *  Distilled-doc invariant #14: synchronous throw when `signer` is
 *  missing on localnet. */
export const seal = <const Signer extends SealSignerMember = SealSignerMember>(
	opts?: SealOptions<Signer>,
) => {
	const resolved = opts ?? resolveDefaultMode();
	switch (resolved.mode) {
		case 'local-keygen':
			return buildLocalKeygenPlugin(resolved);
		case 'live':
			return buildLivePlugin(resolved);
		case 'fork-known':
			return buildForkKnownPlugin(resolved);
	}
};

/** Mode-narrowed factory namespace.
 *
 *  Usage:
 *      const local = { mode: 'local' } as const;
 *      sealFor.for(local).localKeygen({signer})    // OK
 *      sealFor.for(local).forkKnown(...)           // type error: not in 'local' branch
 *
 *      const fork = { mode: 'fork' } as const;
 *      sealFor.for(fork).forkKnown({upstream})     // OK
 *      sealFor.for(fork).localKeygen({signer})     // type error: not in 'fork' branch
 *                                              // (distilled-doc invariant #8)
 *
 *  Distilled-doc invariant #8 (fork-localkeygen-refused): the
 *  fork-mode branch has NO `localKeygen` entry — that's the
 *  type-level refusal. For callers that explicitly opt out of the
 *  type narrowing (e.g. dynamic compose code), the local-keygen
 *  factory ALSO throws synchronously if invoked under a `*-fork`
 *  network — see `localKeygenStrict` below. */
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
// fork-localkeygen-refused — the synchronous throw form
// ---------------------------------------------------------------------------

/** Direct local-keygen factory with explicit fork-network check.
 *
 *  The mode-narrowed namespace above makes `sealFor.for(forkNetwork)
 *  .localKeygen(...)` a TYPE-LEVEL refusal (the `fork` branch has
 *  no `localKeygen` key). Callers that bypass the type narrowing
 *  (e.g. by computing the network at runtime) can use this
 *  factory; it RUNTIME-throws `ForkIncompatibleError` on `*-fork`
 *  networks.
 *
 *  Distilled-doc invariant #8 + §Failure modes. */
export const sealLocalKeygenStrict = <const Signer extends SealSignerMember>(
	network: NetworkConfig,
	opts: SealLocalKeygenOptions<Signer>,
) => {
	if (network.mode === 'fork') {
		throw forkIncompatibleError({
			variant: 'sealLocalKeygen',
			network: network.chain,
			message: `seal.localKeygen does not support fork networks. The seal key-server's chain client is JSON-RPC-bound; sui-fork only exposes gRPC for simulate_transaction.`,
			hint: `Use sealFor.for({mode:'fork'}).forkKnown({upstream:'<mainnet|testnet|devnet>'}) — routes to the wrapped upstream's known-deployment key server.`,
		});
	}
	return buildLocalKeygenPlugin(opts);
};

// ---------------------------------------------------------------------------
// Type-only error re-export
// ---------------------------------------------------------------------------

export type { SealError as SealAcquireError };
