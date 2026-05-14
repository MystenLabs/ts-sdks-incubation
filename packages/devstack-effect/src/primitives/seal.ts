// Seal — Phase 6c multi-impl primitive.
//
// Two factories, both targeting the narrow interface tags in
// `src/interfaces/seal.ts`:
//
//   sealLocalKeygen(opts) — full local stack. Builds the seal image,
//     runs `seal-cli genkey`, publishes the seal Move package,
//     registers a KeyServer on chain, renders the key-server config
//     yaml, starts the key-server container, then surfaces BOTH
//     `SealKeyServer` (read surface — anyone with the URL can verify
//     signatures) and `SealKeyManager` (local-only admin — master-key
//     env-file path + rotate Effect).
//   sealKnownKeyServer(opts) — read-only handle for a Mysten-run public
//     key server (e.g. testnet). Provides ONLY `SealKeyServer`; we
//     don't own the master key so there's no `SealKeyManager` to
//     produce. Defaults pulled from `knownDeployments.seal`.
//
// Topology for `sealLocalKeygen`: a single Effect.gen body runs all
// phases (port-alloc, image, keygen, publish, register, config-render,
// container, ready) and lands in a private `SealLocalKeygenInternal`
// tag. Two thin projection layers then read from it to satisfy
// `SealKeyServer` and `SealKeyManager`. The internal tag is what the
// engine lifecycle hooks key on, so the TUI shows ONE acquiring entry
// per `sealLocalKeygen()` rather than two (one per interface).
//
// The aggregate `SealLocalKeygenShape` is what gets serialized into
// `manifest.packages.seal` for frontends — the Effect-side surface is
// purely the two narrow tags.

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as nodeFs from 'node:fs/promises';
import { Context, Effect, FileSystem, Layer, Option, Path } from 'effect';
import { addFinalizer } from 'effect/Scope';
import { Transaction } from '@mysten/sui/transactions';
import * as Docker from '../internal/docker.js';
import {
	knownDeployments,
	type KnownNetwork,
	type SealDeployment,
} from '../internal/known-deployments.js';
import { PortAllocator } from '../internal/port-allocator.js';
import { StateStore, StateStoreConfig } from '../internal/state-store.js';
import { stringifyCause } from '../internal/stringify-cause.js';
import { buildMove } from '../internal/sui-cli.js';
import { dockerImage } from '../plugin-author/index.js';
import { gitFetch } from '../plugin-author/index.js';
import { awaitReady } from '../internal/ready-probe.js';
import { EndpointRegistry, PackageRegistry } from '../internal/registries.js';
import {
	SealKeyManager,
	SealKeyServer,
	type SealKeyManagerShape,
	type SealKeyServerShape,
} from '../interfaces/seal.js';
import { provideTag, setPhase, type PluginTag } from '../tag.js';
import type { StackMember } from '../define-devstack.js';
import { Sui } from './sui.js';
import { publishMove } from './publish-move.js';
import { SealError } from './errors.js';
import type { Account, SuiObjectChange } from './shared.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Upstream key-server binds 2024 inside the container by default. v3
// allocates a host port dynamically and threads it through register +
// container; we do the same via `PortAllocator` so two stacks can
// co-exist without colliding on 2024.
const DEFAULT_KEY_SERVER_PORT = 2024;
const DEFAULT_READY_TIMEOUT_MS = 60_000;

// Default seal release ref. Used both as `SEAL_VERSION` for the
// vendored Dockerfile (selects which platform binary to fetch from the
// seal release) and as the git ref the `move/seal` source fetch pins
// to. Keep the two in lockstep — the binary ABI and the Move package
// must match.
const DEFAULT_SEAL_VERSION = 'seal-v0.6.6';

// `seal-cli genkey` invocation override. The image's default ENTRYPOINT
// is `/usr/local/bin/key-server`, so we override to `seal-cli` for keygen
// and pass `genkey` as the only arg.
const SEAL_KEYGEN_ENTRYPOINT = 'seal-cli';
const SEAL_KEYGEN_ARGS = ['genkey'] as const;

// Boneh-Franklin BLS12-381 — the only `KEY_TYPE` accepted by upstream
// (`seal/move/seal/sources/key_server.move`).
const KEY_TYPE_BONEH_FRANKLIN_BLS12381 = 0;

// `Docker.run` wires `host.docker.internal:host-gateway` by default so
// containers can dial the host RPC via this hostname on Linux as well
// as Docker Desktop.
const SUI_NODE_URL_FROM_CONTAINER = 'http://host.docker.internal:9000';

// Default `gitFetch` coordinates for the upstream seal Move sources.
// The git ref reuses `DEFAULT_SEAL_VERSION` so the Move package and the
// in-image binary always advance in lockstep.
const DEFAULT_SEAL_REPO = 'https://github.com/MystenLabs/seal';
const DEFAULT_SEAL_MOVE_SUBDIR = 'move/seal';

// StateStore key prefixes. The full keys fold in `Sui.chainId` at the
// use site so a regenesis of the underlying chain naturally misses the
// cache — the keypair is regenerated and re-registered against the
// fresh chain rather than pinning to a stale on-chain KeyServer object.
const STATE_KEY_BLS_KEYPAIR_PREFIX = 'seal/bls-keypair';
const STATE_KEY_KEY_SERVER_ID_PREFIX = 'seal/key-server-id';

// Persisted shape for the BLS keypair cache entry. Two hex blobs round-
// tripped as-is through the StateStore JSON layer.
interface PersistedBlsKeypair {
	readonly masterKey: string;
	readonly publicKey: string;
}

// -----------------------------------------------------------------------------
// Combined shape (legacy `Seal` type)
// -----------------------------------------------------------------------------

// Aggregate shape carried by the projection back into `manifest.packages`
// (the on-disk JSON entry). Consumers writing Effect code should yield the
// narrow `SealKeyServer` / `SealKeyManager` tags directly rather than
// destructuring this shape.
export interface SealLocalKeygenShape {
	readonly packageId: string;
	readonly keyServer: {
		readonly id: string;
		readonly url: string;
	};
}

// -----------------------------------------------------------------------------
// sealLocalKeygen
// -----------------------------------------------------------------------------

export interface SealLocalKeygenOptions<Name extends string> {
	readonly name?: Name;
	readonly signer: PluginTag<any, Account, any, any>;
	/** Skip the local image build and use a pre-built key-server image
	 *  tag instead. When unset (the default) we build from the vendored
	 *  Dockerfile under `packages/devstack-effect/seal-image/`, fetching
	 *  the platform-specific binaries from the seal GitHub release at
	 *  `version`. */
	readonly image?: string;
	/** Pinned seal release tag. Default `'seal-v0.6.6'`. Threaded through
	 *  the vendored Dockerfile as `SEAL_VERSION` (selects which release
	 *  asset to fetch) and used as the git ref for the `move/seal`
	 *  source fetch when `movePackagePath` is not supplied. */
	readonly version?: string;
	/** Filesystem path to a vendored `seal/move/seal` Move package. When
	 *  unset we `gitFetch` `MystenLabs/seal` at `version` and use the
	 *  `move/seal` subdir. Setting this skips the fetch entirely. */
	readonly movePackagePath?: string;
	/** Preferred host port the key-server binds on the host. Default 2024
	 *  (matches upstream's container default). The actual bound port is
	 *  obtained from `PortAllocator.allocate(preferred)`, so two stacks
	 *  can coexist. */
	readonly hostPort?: number;
	/** Ready-probe timeout for the key-server's HTTP endpoint. Default
	 *  60s — matches the v3 default. */
	readonly readyTimeoutMs?: number;
	/** On-chain `KeyServer.name` field. Default `devstack-local`. */
	readonly keyServerName?: string;
	/** Explicit ordering edges. Same shape as walrus/deepbook. */
	readonly dependsOn?: ReadonlyArray<PluginTag<any, any, any, any>>;
}

// Combined intermediate shape produced by the heavy acquire effect.
// Drives both projection layers (`SealKeyServer` + `SealKeyManager`)
// from a single resolved value.
interface SealLocalKeygenInternalShape {
	readonly keyServer: SealKeyServerShape;
	readonly keyManager: SealKeyManagerShape;
	readonly packageId: string;
}

/**
 * Local-only seal stack: builds + runs the seal key-server, owns the
 * master key, registers a KeyServer on chain. Provides both
 * `SealKeyServer` (read surface) and `SealKeyManager` (local admin).
 */
export const sealLocalKeygen = <const Name extends string = 'seal'>(
	options: SealLocalKeygenOptions<Name>,
): StackMember & { readonly key: Name } => {
	const name = (options.name ?? 'seal') as Name;
	const version = options.version ?? DEFAULT_SEAL_VERSION;
	const preferredHostPort = options.hostPort ?? DEFAULT_KEY_SERVER_PORT;
	const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const keyServerName = options.keyServerName ?? 'devstack-local';

	// Sibling tags. Image: caller-supplied `options.image` wins (pure
	// pull of a pre-built tag), otherwise we build from the vendored
	// Dockerfile under `packages/devstack-effect/seal-image/`. The
	// Dockerfile fetches the platform-specific `seal-cli` + `key-server`
	// binaries from the seal GitHub release — no Rust compile.
	const sealImage =
		options.image !== undefined
			? dockerImage({ name: `${name}.image` as const, pull: options.image })
			: dockerImage({
					name: `${name}.image` as const,
					build: {
						context: new URL('../../seal-image/', import.meta.url).pathname,
						dockerfile: 'Dockerfile',
						buildArgs: { SEAL_VERSION: version },
					},
				});

	// Source resolution: caller-provided path wins; otherwise we plug in
	// a `gitFetch` factory tag whose runtime result feeds the inlined
	// publish flow below. We only construct the publishMove factory tag
	// when the path is known here at factory time — when we fall back to
	// gitFetch, the publish flow runs inline so the path resolves at
	// runtime.
	const movePackagePath = options.movePackagePath;
	const sourceFetch =
		movePackagePath === undefined
			? gitFetch({
					name: `${name}.source` as const,
					repo: DEFAULT_SEAL_REPO,
					ref: version,
					subdirectory: DEFAULT_SEAL_MOVE_SUBDIR,
				})
			: undefined;
	const publish =
		movePackagePath !== undefined
			? publishMove({
					name: `${name}.publish` as const,
					path: movePackagePath,
					signer: options.signer,
				})
			: undefined;

	// Inner sibling-tag layers that defineDevstack must merge so the
	// inner tags resolve at runtime. Only include the tags we actually
	// built — skipping a path keeps its layer out of the engine's
	// mergeAll, so a stack that supplies `movePackagePath` never
	// triggers gitFetch (and vice versa).
	const innerLayers: Array<Layer.Layer<any, any, any>> = [...sealImage.__layers];
	if (sourceFetch !== undefined) innerLayers.push(...sourceFetch.__layers);
	if (publish !== undefined) innerLayers.push(...publish.__layers);

	// Private "internal" tag class. Both the `SealKeyServer` and
	// `SealKeyManager` projection layers read from it. Kept inside the
	// factory closure (Context key folds in `name`) so two
	// `sealLocalKeygen()` calls in the same stack don't share state.
	class SealLocalKeygenInternal extends Context.Service<
		SealLocalKeygenInternal,
		SealLocalKeygenInternalShape
	>()(`@devstack/SealLocalKeygenInternal/${name}` as const) {}

	const acquire = Effect.gen(function* () {
		// 0. Explicit ordering edges first — pins consumers before the
		//    heavy docker / publish work kicks off.
		for (const tag of options.dependsOn ?? []) {
			yield* tag;
		}
		const sui = yield* Sui;
		const signer = yield* options.signer;
		const portAllocator = yield* PortAllocator;
		const stateStore = yield* StateStore;

		// Fold the chain identifier into both StateStore keys. A
		// regenesis of the underlying chain flips `sui.chainId`,
		// naturally missing the cache and forcing a fresh keypair +
		// on-chain registration against the new chain state.
		const blsKeypairKey = `${STATE_KEY_BLS_KEYPAIR_PREFIX}/${sui.chainId}`;
		const keyServerIdKey = `${STATE_KEY_KEY_SERVER_ID_PREFIX}/${sui.chainId}`;

		// 1. Allocate the host port up-front. The on-chain registration
		//    URL must match the URL the container will later bind on,
		//    so we need the port before step 5 (register) — not just
		//    before step 8 (run container).
		const hostPort = yield* portAllocator.allocate(preferredHostPort).pipe(
			Effect.mapError(
				(cause) =>
					new SealError({
						phase: 'port-alloc',
						message: `seal(${name}): could not allocate host port near ${preferredHostPort}: ${cause.message}`,
						cause,
					}),
			),
		);
		const keyServerUrl = `http://localhost:${hostPort}`;
		yield* Effect.annotateCurrentSpan({ 'seal.hostPort': hostPort });

		// 2. Ensure the key-server image is present. Builds from the
		//    vendored Dockerfile under `packages/devstack-effect/
		//    seal-image/` when no `options.image` is supplied; pulls
		//    the caller-supplied tag otherwise.
		yield* setPhase('building image');
		const resolvedImage = yield* Effect.gen(function* () {
			return yield* sealImage;
		}).pipe(Effect.withSpan('seal.image'));
		const imageTag = resolvedImage.tag;

		// 3. Keygen — `seal-cli genkey` one-shot + stdout parse. We
		//    first check the StateStore cache; if a previous run
		//    persisted the keypair we reuse it and skip the docker
		//    call entirely. The on-chain key-server registration in
		//    step 5 is tied to this public key, so reusing it lets us
		//    skip the register tx too.
		yield* setPhase('generating master key');
		const cachedKeypair = yield* stateStore.get<PersistedBlsKeypair>(blsKeypairKey);
		const { masterKey, publicKey } = yield* Effect.gen(function* () {
			if (Option.isSome(cachedKeypair)) {
				yield* Effect.annotateCurrentSpan({ 'seal.keygen.cache': 'hit' });
				return cachedKeypair.value;
			}
			yield* Effect.annotateCurrentSpan({ 'seal.keygen.cache': 'miss' });
			const result = yield* Docker.runOneShot({
				name: `seal.${name}.keygen`,
				image: imageTag,
				entrypoint: SEAL_KEYGEN_ENTRYPOINT,
				args: [...SEAL_KEYGEN_ARGS],
			}).pipe(
				Effect.catchTag('DockerError', (cause) =>
					Effect.fail(
						new SealError({
							phase: 'keygen',
							message: `seal(${name}): keygen container failed: ${cause.message}`,
							cause,
						}),
					),
				),
			);
			if (result.exitCode !== 0) {
				// Redact `Master key:` lines from stdout/stderr. A failed
				// keygen that still echoed the master before exiting non-
				// zero would otherwise embed the secret in a SealError
				// visible to logs / traces / user terminals.
				return yield* Effect.fail(
					new SealError({
						phase: 'keygen',
						message: `seal(${name}): keygen container exited ${result.exitCode}`,
						stderr: redactMasterKey(result.stderr),
						stdout: redactMasterKey(result.stdout),
						exitCode: result.exitCode,
					}),
				);
			}
			const parsed = parseSealKeygenOutput(result.stdout);
			yield* stateStore.put<PersistedBlsKeypair>(blsKeypairKey, parsed);
			return parsed;
		}).pipe(Effect.withSpan('seal.keygen'));

		// 4. Publish the seal Move package. Two paths:
		//    a. Caller supplied `movePackagePath` → yield the factory
		//       `publish` tag. The tag's layer handles buildMove + the
		//       publish tx + PackageRegistry register.
		//    b. No path supplied → yield the `gitFetch` tag, then run
		//       the same publish steps inline against its `.path`.
		yield* setPhase('publishing contracts');
		let packageId: string;
		if (publish !== undefined) {
			const pkg = yield* Effect.gen(function* () {
				return yield* publish;
			}).pipe(Effect.withSpan('seal.publish'));
			packageId = pkg.packageId;
		} else {
			const fetchTag = sourceFetch!;
			const fetched = yield* Effect.gen(function* () {
				return yield* fetchTag;
			}).pipe(Effect.withSpan('seal.source'));
			packageId = yield* publishSealMoveInline({
				name,
				path: fetched.path,
				rpcUrl: sui.rpcUrl,
				faucetUrl: sui.faucetUrl,
				signer,
			});
		}

		// 5. Register the key server on chain — single Move call. URL
		//    MUST match the URL the container will later bind on; the
		//    allocated host port from step 1 satisfies that.
		const cachedKeyServerId = yield* stateStore.get<string>(keyServerIdKey);
		const keyServerObjectId = yield* Effect.gen(function* () {
			if (Option.isSome(cachedKeyServerId)) {
				yield* Effect.annotateCurrentSpan({ 'seal.register.cache': 'hit' });
				return cachedKeyServerId.value;
			}
			yield* Effect.annotateCurrentSpan({ 'seal.register.cache': 'miss' });
			const tx = new Transaction();
			const pkBytes = decodeHex(publicKey);
			tx.moveCall({
				target: `${packageId}::key_server::create_and_transfer_v2_independent_server`,
				arguments: [
					tx.pure.string(keyServerName),
					tx.pure.string(keyServerUrl),
					tx.pure.u8(KEY_TYPE_BONEH_FRANKLIN_BLS12381),
					tx.pure.vector('u8', Array.from(pkBytes)),
				],
			});

			const result = yield* signer.signAndExecute(tx).pipe(
				Effect.mapError(
					(cause) =>
						new SealError({
							phase: 'register',
							message: `seal(${name}): KeyServer register tx failed: ${cause.message}`,
							cause,
						}),
				),
			);

			const created = result.objectChanges.find(
				(c): c is Extract<SuiObjectChange, { type: 'created' }> =>
					c.type === 'created' &&
					'objectType' in c &&
					typeof c.objectType === 'string' &&
					c.objectType.endsWith('::key_server::KeyServer'),
			);
			if (created === undefined) {
				return yield* Effect.fail(
					new SealError({
						phase: 'register',
						message:
							`seal(${name}): KeyServer object missing from objectChanges ` +
							`(digest=${result.digest})`,
					}),
				);
			}
			yield* stateStore.put<string>(keyServerIdKey, created.objectId);
			return created.objectId;
		}).pipe(Effect.withSpan('seal.register'));

		// 6. Render the CONFIG_PATH yaml to a scoped temp dir + mount
		//    it into the container. `makeTempDirectoryScoped` cleans up
		//    on engine shutdown; the bind-mount keeps a docker volume
		//    off the table. The yaml hardcodes
		//    `host.docker.internal:9000` since `Docker.run` wires the
		//    add-host entry on every container by default.
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		const configDir = yield* fs
			.makeTempDirectoryScoped({ prefix: `devstack-seal-${name}-` })
			.pipe(
				Effect.mapError(
					(cause) =>
						new SealError({
							phase: 'config-render',
							message: `seal(${name}): could not create temp dir for config: ${cause.message}`,
							cause,
						}),
				),
			);
		const configPath = path.join(configDir, 'key-server-config.yaml');
		const yaml = renderSealKeyServerConfig({
			sealPackageId: packageId,
			keyServerObjectId,
			nodeUrl: SUI_NODE_URL_FROM_CONTAINER,
		});
		yield* fs.writeFileString(configPath, yaml).pipe(
			Effect.mapError(
				(cause) =>
					new SealError({
						phase: 'config-render',
						message: `seal(${name}): could not write key-server config to ${configPath}: ${cause.message}`,
						cause,
					}),
			),
		);

		// Stage the master key in an env-file under the state dir, then
		// hand docker `--env-file` instead of `-e MASTER_KEY=…`. The
		// `-e` form surfaces the value in host process env (PID-visible)
		// and in `docker inspect` output; routing through a 0o600 file
		// confines it to the file, the container's env, and whatever
		// the daemon does with it. The file is removed on scope close.
		const stateCfg = yield* StateStoreConfig;
		const stateBaseDir =
			stateCfg.stateDir ??
			`${process.env.DEVSTACK_APP_DIR ?? process.cwd()}/.devstack/stacks/${stateCfg.stack}`;
		const sealStateDir = path.join(stateBaseDir, '.seal');
		const masterKeyEnvFile = path.join(sealStateDir, 'master-key.env');
		yield* fs
			.makeDirectory(sealStateDir, { recursive: true })
			.pipe(Effect.catch(() => Effect.void));
		yield* fs.chmod(sealStateDir, 0o700).pipe(
			Effect.catch(() =>
				Effect.tryPromise({
					try: () => nodeFs.chmod(sealStateDir, 0o700),
					catch: () => undefined,
				}).pipe(Effect.catch(() => Effect.void)),
			),
		);
		yield* fs.writeFileString(masterKeyEnvFile, `MASTER_KEY=${masterKey}\n`).pipe(
			Effect.mapError(
				(cause) =>
					new SealError({
						phase: 'config-render',
						message: `seal(${name}): could not write master-key env-file to ${masterKeyEnvFile}: ${cause.message}`,
						cause,
					}),
			),
		);
		yield* fs.chmod(masterKeyEnvFile, 0o600).pipe(
			Effect.catch(() =>
				Effect.tryPromise({
					try: () => nodeFs.chmod(masterKeyEnvFile, 0o600),
					catch: () => undefined,
				}).pipe(Effect.catch(() => Effect.void)),
			),
		);
		const sealScope = yield* Effect.scope;
		yield* addFinalizer(
			sealScope,
			Effect.tryPromise({
				try: () => nodeFs.unlink(masterKeyEnvFile),
				catch: () => undefined,
			}).pipe(Effect.catch(() => Effect.void)),
		);

		// 7. Long-running key-server container. Scope-managed: the
		//    Docker.run finalizer `docker rm -f`s on shutdown.
		yield* setPhase('starting key server');
		yield* Docker.run({
			name: `seal-${name}-key-server`,
			image: imageTag,
			ports: { [hostPort]: DEFAULT_KEY_SERVER_PORT },
			env: {
				CONFIG_PATH: '/etc/seal/key-server-config.yaml',
				RUST_LOG: 'info',
			},
			envFiles: [masterKeyEnvFile],
			mounts: [{ host: configPath, container: '/etc/seal/key-server-config.yaml' }],
			detach: true,
		}).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new SealError({
						phase: 'container',
						message: `seal(${name}): failed to start key-server container: ${cause.message}`,
						cause,
					}),
				),
			),
		);

		// 8. Ready probe — `/health` returns a simple
		//    `{name,version,status:"up"}` payload once the binary has
		//    bound and parsed CONFIG_PATH; failure to load surfaces as
		//    a non-200 because the binary exits before the endpoint
		//    starts accepting traffic. The `/v1/*` endpoints require a
		//    `Client-Sdk-Version` header and reject the bare ready probe
		//    with 400.
		yield* awaitReady({
			kind: 'http',
			url: `${keyServerUrl}/health`,
			timeoutMs: readyTimeoutMs,
		}).pipe(
			Effect.catchTag('ReadyProbeError', (cause) =>
				Effect.fail(
					new SealError({
						phase: 'ready',
						message: `seal(${name}): key-server never became ready: ${cause.message}`,
						cause,
					}),
				),
			),
		);

		// 9. Registries — the package was already registered by
		//    publishMove (or the inline fallback); add the key-server
		//    endpoint so the manifest exposes it alongside sui-rpc /
		//    sui-faucet.
		void (yield* PackageRegistry);
		yield* EndpointRegistry.publish({
			name: 'seal-key-server',
			url: keyServerUrl,
			kind: 'seal-key-server',
		});

		// Rotation is a no-op for now — surfaced so consumers can keep
		// the manager-shape stable while we land an actual key-
		// regeneration flow (clear cache + restart container).
		const rotate: Effect.Effect<void, SealError> = Effect.fail(
			new SealError({
				phase: 'rotate',
				message: `seal(${name}): rotate is not implemented yet`,
			}),
		);

		return {
			keyServer: {
				// SDK-ready array. Local-mode publishes a single
				// key-server with weight 1; pass directly to
				// `new SealClient({ suiClient, serverConfigs })`.
				serverConfigs: [{ objectId: keyServerObjectId, weight: 1 }],
				keyServerUrl,
				objectId: keyServerObjectId,
			},
			keyManager: { masterKeyEnvFile, rotate },
			packageId,
		} satisfies SealLocalKeygenInternalShape;
	}).pipe(
		Effect.withSpan(`seal(${name})`),
		Effect.catchTag('SealError', Effect.fail),
		Effect.catch((cause: unknown) =>
			Effect.fail(
				new SealError({
					phase: 'seal',
					message: `seal(${name}): ${stringifyCause(cause)}`,
					cause,
				}),
			),
		),
	);

	// Engine lifecycle hooks fire once for the heavy acquire effect —
	// the TUI shows a single `seal` entry rather than separate entries
	// per interface tag. The two projection layers below are trivial
	// value extractions, not lifecycle-tracked.
	const { __layer: internalLayer } = provideTag(SealLocalKeygenInternal, acquire, {
		kind: 'service',
		displayTitle: 'seal.local',
		display: (s) => ({ title: 'seal.local', primary: s.keyServer.keyServerUrl }),
	});

	const keyServerLayer = Layer.effect(
		SealKeyServer,
		Effect.gen(function* () {
			const internal = yield* SealLocalKeygenInternal;
			return internal.keyServer;
		}),
	);

	const keyManagerLayer = Layer.effect(
		SealKeyManager,
		Effect.gen(function* () {
			const internal = yield* SealLocalKeygenInternal;
			return internal.keyManager;
		}),
	);

	// Order matters: `composeStackLayer` folds left-to-right with
	// `provideMerge(layer, acc)`, so each new layer consumes from the
	// accumulated acc. Providers come first, consumers last.
	// `innerLayers` (sealImage, sourceFetch, publish) provide tags that
	// `internalLayer`'s body yields, so they precede it; the two
	// projection layers consume `SealLocalKeygenInternal` so they come
	// after.
	return {
		__layer: internalLayer,
		__layers: [...innerLayers, internalLayer, keyServerLayer, keyManagerLayer],
		key: name,
		__kind: 'service' as const,
		__displayTitle: 'seal.local',
	};
};

// -----------------------------------------------------------------------------
// sealKnownKeyServer
// -----------------------------------------------------------------------------

export interface SealKnownKeyServerOptions {
	readonly name?: string;
	/** Network whose published key-server we point at. Looked up in
	 *  `knownDeployments.seal[network]`. Optional only when every field
	 *  below is set explicitly. */
	readonly network?: KnownNetwork;
	readonly objectId?: string;
	readonly keyServerUrl?: string;
}

/**
 * Read-only handle for a public seal key-server (e.g. Mysten's testnet
 * deployment). Provides ONLY `SealKeyServer` — we don't own the master
 * key, so there's no `SealKeyManager` layer to produce.
 */
export const sealKnownKeyServer = (options: SealKnownKeyServerOptions = {}): StackMember => {
	const name = options.name ?? 'seal';
	const fromKnown: SealDeployment | undefined =
		options.network !== undefined ? knownDeployments.seal[options.network] : undefined;

	const objectId = options.objectId ?? fromKnown?.keyServerObjectId;
	const keyServerUrl = options.keyServerUrl ?? fromKnown?.keyServerUrl;

	if (objectId === undefined || keyServerUrl === undefined) {
		throw new Error(
			`sealKnownKeyServer: missing required fields. Pass \`network\` (one of: ${Object.keys(
				knownDeployments.seal,
			).join(', ')}) or set objectId/keyServerUrl explicitly.`,
		);
	}

	const build = Effect.gen(function* () {
		yield* EndpointRegistry.publish({
			name: 'seal-key-server',
			url: keyServerUrl,
			kind: 'seal-key-server',
		});
		// SDK-ready array. Known-mode wraps the single registry entry
		// in a one-element `serverConfigs` array with weight 1 today;
		// multi-server known stacks (t-of-n committees) would extend
		// `SealKnownKeyServerOptions` with an explicit
		// `serverConfigs?` override — future work.
		return {
			serverConfigs: [{ objectId, weight: 1 }],
			keyServerUrl,
			objectId,
		} satisfies SealKeyServerShape;
	}).pipe(Effect.withSpan(`sealKnownKeyServer(${name})`));

	const { __layer, __kind, __displayTitle } = provideTag(SealKeyServer, build, {
		kind: 'service',
		displayTitle: 'seal.known',
		display: (s) => ({ title: 'seal.known', primary: s.keyServerUrl }),
	});
	return { __layer, key: name, __kind, __displayTitle };
};

// -----------------------------------------------------------------------------
// Inline publish — used when source comes from gitFetch
// -----------------------------------------------------------------------------

// Mirrors the publishMove tag's body but with an explicit `path` arg
// resolved at runtime from gitFetch. Kept in this file so the gitFetch
// fallback doesn't need to round-trip through publishMove (which takes
// `path` at factory time). Registers the package with `PackageRegistry`
// under `${name}.publish` to match the factory-tag naming.
const publishSealMoveInline = (args: {
	readonly name: string;
	readonly path: string;
	readonly rpcUrl: string;
	readonly faucetUrl: string | undefined;
	readonly signer: Account;
}): Effect.Effect<string, SealError, any> =>
	Effect.gen(function* () {
		const { modules, dependencies } = yield* buildMove({
			path: args.path,
			rpcUrl: args.rpcUrl,
			faucetUrl: args.faucetUrl,
		}).pipe(
			Effect.catchTag('SuiCliError', (cause) =>
				Effect.fail(
					new SealError({
						phase: 'publish',
						message: `seal(${args.name}): move build failed at ${args.path}: ${cause.message}`,
						cause,
					}),
				),
			),
		);

		const tx = new Transaction();
		const [upgradeCap] = tx.publish({ modules: [...modules], dependencies: [...dependencies] });
		tx.transferObjects([upgradeCap], args.signer.address);

		const result = yield* args.signer.signAndExecute(tx).pipe(
			Effect.mapError(
				(cause) =>
					new SealError({
						phase: 'publish',
						message: `seal(${args.name}): publish tx failed: ${cause.message}`,
						cause,
					}),
			),
		);

		const published = result.objectChanges.find(
			(c): c is Extract<SuiObjectChange, { type: 'published' }> => c.type === 'published',
		);
		if (published === undefined) {
			return yield* Effect.fail(
				new SealError({
					phase: 'publish',
					message: `seal(${args.name}): no 'published' change in publish tx result (digest=${result.digest})`,
				}),
			);
		}

		const upgradeCapId = result.objectChanges.find(
			(c): c is Extract<SuiObjectChange, { type: 'created' }> =>
				c.type === 'created' &&
				'objectType' in c &&
				typeof c.objectType === 'string' &&
				c.objectType.endsWith('0x2::package::UpgradeCap'),
		)?.objectId;

		yield* PackageRegistry.publish({
			name: `${args.name}.publish`,
			packageId: published.packageId,
			upgradeCapId,
			captured: undefined,
		});

		return published.packageId;
	}).pipe(Effect.withSpan('seal.publish'));

// -----------------------------------------------------------------------------
// Helpers (ported verbatim from v3)
// -----------------------------------------------------------------------------

/** Render the seal key-server's CONFIG_PATH yaml. Env-only mode silently
 *  forces `network: Testnet` + a public-fullnode URL, so for sui-localnet
 *  we MUST go through CONFIG_PATH. The `!Devnet` discriminator is what
 *  the binary expects for "custom chain via node_url". */
export function renderSealKeyServerConfig(opts: {
	sealPackageId: string;
	keyServerObjectId: string;
	nodeUrl: string;
	tsSdkVersionRequirement?: string;
}): string {
	const tsSdk = opts.tsSdkVersionRequirement ?? '>=0.4.5';
	return [
		'# Generated by devstack-effect seal primitive.',
		'# CONFIG_PATH-based config — env-only mode silently routes at the',
		'# public testnet fullnode regardless of NODE_URL, so we must use',
		'# this file to bind the daemon to sui-localnet.',
		'network: !Devnet',
		`  seal_package: '${opts.sealPackageId}'`,
		`node_url: ${opts.nodeUrl}`,
		'server_mode: !Open',
		`  key_server_object_id: '${opts.keyServerObjectId}'`,
		`ts_sdk_version_requirement: '${tsSdk}'`,
		'',
	].join('\n');
}

/** Parse `seal-cli genkey` stdout. Format (one line each):
 *    Master key: <hex>
 *    Public key: <hex>
 *  Both are BLS12-381 elements; the hex prefix may or may not include
 *  `0x` depending on the seal-cli build. */
export function parseSealKeygenOutput(stdout: string): {
	masterKey: string;
	publicKey: string;
} {
	const masterMatch = stdout.match(/^Master key:\s*(\S+)/m);
	const publicMatch = stdout.match(/^Public key:\s*(\S+)/m);
	const master = masterMatch?.[1];
	const pub = publicMatch?.[1];
	if (master === undefined || pub === undefined) {
		throw new Error(
			`seal.keygen: could not parse seal-cli genkey output (last 1KB):\n${redactMasterKey(stdout).slice(-1024)}`,
		);
	}
	return { masterKey: master, publicKey: pub };
}

// Replace any `Master key:`-style line with a stable placeholder so the
// failure shape remains observable in logs / spans / error messages while
// the secret never leaks. Case-insensitive, tolerates `master_key` and
// `master-key` separators upstream may switch to.
const MASTER_KEY_LINE_RE = /^.*master[ _-]?key.*$/gim;

export function redactMasterKey(stdout: string): string {
	return stdout.replace(MASTER_KEY_LINE_RE, '[REDACTED master key]');
}

// Hex → bytes. Tolerates a leading `0x`. Used to convert the public-key
// hex from seal-cli into the `vector<u8>` the Move call expects.
function decodeHex(s: string): Uint8Array {
	const hex = s.startsWith('0x') ? s.slice(2) : s;
	if (hex.length % 2 !== 0) {
		throw new Error(`seal.register: hex string has odd length: ${s.length}`);
	}
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}
