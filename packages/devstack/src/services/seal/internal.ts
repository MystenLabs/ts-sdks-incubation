// Seal — Phase 6c multi-impl primitive.
//
// Two factories, both targeting the narrow interface tag classes in
// `src/services/seal.ts` (`SealKeyServer` + `SealKeyManager`):
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
import { ChildProcessSpawner } from 'effect/unstable/process';
import { Transaction } from '@mysten/sui/transactions';
import * as Docker from '../../engine/docker.js';
import { EngineHandle } from '../../engine/engine.js';
import {
	knownDeployments,
	type KnownNetwork,
	type SealDeployment,
} from '../../engine/known-deployments.js';
import { Identity } from '../../engine/identity.js';
import { routerEntrypoint } from '../../engine/docker/router.js';
import { routerHostname, routerId } from '../../engine/router-hostname.js';
import { StateStore, StateStoreConfig } from '../../engine/state-store.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { buildMove } from '../../engine/sui-cli.js';
import { dockerImage } from '../../advanced/plugin-author/index.js';
import { gitFetch } from '../../advanced/plugin-author/index.js';
import { EndpointRegistry, PackageRegistry } from '../../engine/registries.js';
import {
	SealKeyManager,
	SealKeyServer,
	type SealKeyManagerShape,
	type SealKeyServerShape,
} from '../seal.js';
import { composeLayers, provide, setPhase, type Ref } from '../../advanced/tag.js';
import type { StackMember } from '../../engine/supervisor.js';
import { SuiTag, suiNetworkName } from '../sui.js';
import { publishMove } from '../../primitives/publish-move.js';
import { SealError } from '../../primitives/errors.js';
import type { Account, SuiObjectChange } from '../../primitives/shared.js';

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

// Container-side sui RPC URL comes from `Sui.rpc.container` (the
// docker-DNS alias `http://sui-localnet:9000`). The key-server's
// container joins the per-stack sui docker network (one of
// `Sui.rpc.containerNetworks`) so the alias resolves; no
// `--add-host` plumbing or host-gateway rewrites needed.

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
	readonly signer: Ref<any, Account, any, any>;
	/** Skip the local image build and use a pre-built key-server image
	 *  tag instead. When unset (the default) we build from the vendored
	 *  Dockerfile under `packages/devstack/seal-image/`, fetching
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
	readonly dependsOn?: ReadonlyArray<Ref<any, any, any, any>>;
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
 *
 * Return type is the plain `StackMember`. The `key` field on the
 * returned StackMember is the engine-internal lookup key
 * (`@devstack/SealLocalKeygenInternal/${name}`), NOT the user-facing
 * primitive name — there's no narrow tag class for the public `name`
 * to bind to, since the internal acquire tag is what the engine
 * lifecycle keys on. Use `display`/`displayTitle` for the user-facing
 * label; the engine-internal `key` is opaque to user code.
 */
export const sealLocalKeygen = <const Name extends string = 'seal'>(
	options: SealLocalKeygenOptions<Name>,
): StackMember => {
	const name = (options.name ?? 'seal') as Name;
	const version = options.version ?? DEFAULT_SEAL_VERSION;
	const preferredHostPort = options.hostPort ?? DEFAULT_KEY_SERVER_PORT;
	const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const keyServerName = options.keyServerName ?? 'devstack-local';

	// Sibling tags. Image: caller-supplied `options.image` wins (pure
	// pull of a pre-built tag), otherwise we build from the vendored
	// Dockerfile under `packages/devstack/seal-image/`. The
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

	// Private "internal" tag class. Both the `SealKeyServer` and
	// `SealKeyManager` projection layers read from it. Kept inside the
	// factory closure (Context key folds in `name`) so two
	// `sealLocalKeygen()` calls in the same stack don't share state.
	class SealLocalKeygenInternal extends Context.Service<
		SealLocalKeygenInternal,
		SealLocalKeygenInternalShape
	>()(`@devstack/SealLocalKeygenInternal/${name}` as const) {}

	const acquire = Effect.fn(`seal(${name})`)(function* () {
		// 0. Explicit ordering edges first — pins consumers before the
		//    heavy docker / publish work kicks off.
		for (const tag of options.dependsOn ?? []) {
			yield* tag;
		}
		const sui = yield* SuiTag;
		const signer = yield* options.signer;
		const stateStore = yield* StateStore;
		const identity = yield* Identity;
		// Captured at acquire time so the closure-bound `rotate` Effect
		// can pre-provide it. Required because the `SealKeyManagerShape`
		// interface declares `rotate: Effect.Effect<void, SealError>` with
		// R = never — the consumer holding the manager shape isn't
		// expected to provide ChildProcessSpawner / FileSystem / etc.
		// The other services (FileSystem, Path) flow through captured
		// values (`fs`, `path`) whose methods don't add R.
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		// Per-line output sink — funnels seal-cli / key-server output
		// into the supervisor's TUI log tail. The `<label>` prefix
		// disambiguates which seal phase (keygen / container / rotate
		// keygen) emitted a given line. The engine may not be wired
		// (standalone tests), in which case the callback is a no-op.
		const engineOpt = yield* Effect.serviceOption(EngineHandle);
		const makeSealOutputSink = (label: string): Docker.OutputLineCallback =>
			(level, line) =>
				engineOpt._tag === 'None'
					? Effect.void
					: engineOpt.value
							.appendLog({ ts: Date.now(), level, message: `[${label}] ${line}` })
							.pipe(Effect.ignore);

		// Fold the chain identifier into both StateStore keys. A
		// regenesis of the underlying chain flips `sui.chainId`,
		// naturally missing the cache and forcing a fresh keypair +
		// on-chain registration against the new chain state.
		const blsKeypairKey = `${STATE_KEY_BLS_KEYPAIR_PREFIX}/${sui.chainId}`;
		const keyServerIdKey = `${STATE_KEY_KEY_SERVER_ID_PREFIX}/${sui.chainId}`;

		// 1. Router exposure — derive the stack-scoped hostname and the
		//    well-known seal entrypoint port (2024). The on-chain
		//    `KeyServer` object's URL needs to match where the daemon
		//    actually serves, so we resolve both here before step 5
		//    (register). No `PortAllocator.allocate` — two stacks of the
		//    same app coexist on `seal.<app>.localhost:2024` (main) and
		//    `<stack>.seal.<app>.localhost:2024` (non-main) because the
		//    Traefik router dispatches by `Host:` header. `preferredHostPort`
		//    is kept on the options shape for back-compat but is ignored
		//    on the router path.
		void preferredHostPort;
		const sealHostname = routerHostname(identity, 'seal');
		const sealEntrypointInfo = routerEntrypoint('seal');
		if (sealEntrypointInfo === undefined) {
			return yield* Effect.fail(
				new SealError({
					phase: 'port-alloc',
					message: `seal(${name}): router entrypoint 'seal' not registered`,
				}),
			);
		}
		const sealEntrypointPort = sealEntrypointInfo.port;
		const keyServerUrl = `http://${sealHostname}:${sealEntrypointPort}`;
		yield* Effect.annotateCurrentSpan({ 'seal.hostname': sealHostname });

		// 2. Ensure the key-server image is present. Builds from the
		//    vendored Dockerfile under `packages/devstack/
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
				onOutputLine: makeSealOutputSink(`seal.${name}.keygen`),
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
				// `publishSealMoveInline` shells out to the host `sui`
				// CLI via `buildMove`; pass the host URLs.
				rpcUrl: sui.rpc.host,
				faucetUrl: sui.faucet?.host,
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
		//    off the table. `node_url` is taken from `Sui.rpc.container`
		//    (the docker-DNS alias `http://sui-localnet:9000`) so the
		//    seal key-server can reach sui from inside its container —
		//    glibc bypasses `/etc/hosts` for `.localhost`, so the
		//    routed `Sui.rpc.host` would NXDOMAIN here.
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
		// Container-side sui RPC URL. Prefer the docker-DNS alias
		// (`http://sui-localnet:9000`) populated by `suiLocalnet`; fall
		// back to `sui.rpc.host` for externally-managed RPCs where the
		// caller is responsible for in-container reachability.
		const containerNodeUrl = sui.rpc.container ?? sui.rpc.host;
		const yaml = renderSealKeyServerConfig({
			sealPackageId: packageId,
			keyServerObjectId,
			nodeUrl: containerNodeUrl,
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
		const keyServerContainerName = `seal-${name}-key-server`;
		// `onPortConflict` releases the conflicting host port and
		// re-allocates with the same value as preferred, so a
		// resume-after-pause where another stack now holds 2024
		// shifts to 2025 (etc) instead of landing on a random
		// ephemeral. Note: the on-chain KeyServer registration above
		// pinned `keyServerUrl` to the originally-allocated port — if
		// `onPortConflict` actually fires on a resume, downstream
		// dApps still resolve via the registry, so the manifest is
		// updated but the on-chain `key_server_object_id` still
		// points at the original URL. Acceptable: on a port shift,
		// callers using the manifest's published `seal-key-server`
		// endpoint hit the right port; the chain-level handle is
		// authoritative for cryptographic identity, not for routing.
		// Per-stack sui network the key-server joins so docker DNS
		// resolves the `sui-localnet` alias referenced from
		// `node_url`. The first entry of `rpc.containerNetworks` is
		// the per-stack sui network (suiLocalnet's container-boot
		// path is the only producer of a container-side URL today).
		// `undefined` when sui is externally-managed (no in-network
		// alias exists). The traefik attachment is orthogonal — the
		// key-server still publishes its own routed hostname for SDK
		// consumers. We keep `suiNetworkName(identity)` as a
		// fallback so the per-stack network name stays consistent
		// with the producer even when no `containerNetworks` slot is
		// surfaced (defensive — current sui primitive always sets
		// both when `container` is defined).
		const suiNet =
			sui.rpc.container !== undefined
				? (sui.rpc.containerNetworks?.[0] ?? suiNetworkName(identity))
				: undefined;
		yield* Docker.run({
			name: keyServerContainerName,
			image: imageTag,
			env: {
				CONFIG_PATH: '/etc/seal/key-server-config.yaml',
				RUST_LOG: 'info',
			},
			envFiles: [masterKeyEnvFile],
			mounts: [{ host: configPath, container: '/etc/seal/key-server-config.yaml' }],
			detach: true,
			...(suiNet !== undefined ? { network: suiNet } : {}),
			// Single router entry for the key-server. The on-chain
			// `KeyServer.url` registered above MUST match this hostname:port
			// — the SDK reads the chain to discover the endpoint.
			traefik: [
				{
					id: routerId(identity, 'seal'),
					hostname: sealHostname,
					entrypoint: 'seal',
					servicePort: DEFAULT_KEY_SERVER_PORT,
				},
			],
			// Stream the key-server's docker-logs into the supervisor.
			// Catches the `RUST_LOG=info` lines that document
			// `CONFIG_PATH` parse failures, master-key load issues, and
			// per-request errors — all of which were previously invisible
			// to the user until they manually ran `docker logs`.
			onOutputLine: makeSealOutputSink(`seal.${name}.key-server`),
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
		// (key-server container is a fire-and-forget detach; scope
		// finalizer takes care of teardown — no captured run-result.)

		// 8. Ready probe — `/health` returns a simple
		//    `{name,version,status:"up"}` payload once the binary has
		//    bound and parsed CONFIG_PATH; failure to load surfaces as
		//    a non-200 because the binary exits before the endpoint
		//    starts accepting traffic. The `/v1/*` endpoints require a
		//    `Client-Sdk-Version` header and reject the bare ready probe
		//    with 400.
		//
		// `Docker.awaitContainerReady` races the probe against
		// `docker wait` so if the key-server crashes (bad CONFIG_PATH,
		// unreachable sui node_url, missing master-key envfile), we
		// surface the container's stderr instead of waiting out the
		// full timeout with a generic "timed out" error.
		yield* Docker.awaitContainerReady({
			containerName: keyServerContainerName,
			probe: {
				kind: 'http',
				url: `${keyServerUrl}/health`,
				timeoutMs: readyTimeoutMs,
			},
		}).pipe(
			Effect.catchTag('ReadyProbeError', (cause) =>
				Effect.fail(
					new SealError({
						phase: 'ready',
						message: `seal(${name}): key-server never became ready: ${cause.message}`,
						stderr: cause.detail,
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

		// Key rotation: regenerate the BLS keypair, register a NEW on-chain
		// KeyServerV2 Independent (the upstream contract has no in-place
		// `pk` mutation for Independent servers — `key_server.move` exposes
		// only `update()` for URL), re-render the yaml + env-file with the
		// new identity, restart the container so it picks up the new
		// master key, and update the StateStore cache so the next
		// `pnpm dev` resumes against the rotated keys.
		//
		// IMPORTANT — in-memory staleness: callers that already captured
		// `SealKeyServer`'s shape (objectId / serverConfigs) by yielding
		// the tag BEFORE rotate hold pre-rotation values. The Layer
		// caches `SealKeyServer`, so re-yielding inside the same scope
		// returns the same cached shape too. To pick up the new identity
		// the stack needs to be hot-restarted (`r` in the TUI / SIGUSR2 /
		// a watched-file edit). Until then, the rotated key-server is
		// running on the same routed URL but answers under the NEW
		// on-chain object id; any consumer still keyed on the OLD id
		// hits a key mismatch. Treat rotate as an admin/operator action,
		// not a hot-swap.
		//
		// Old KeyServer object: the upstream contract has no delete
		// entry, so it persists on-chain after rotation. Acceptable for
		// localnet (the chain itself is ephemeral); on testnet/mainnet
		// rotations would orphan objects — not a path we currently
		// support for `Known*` factories.
		const rotate: Effect.Effect<void, SealError> = Effect.gen(function* () {
			// 1. Fresh keypair via `seal-cli genkey` one-shot. We DON'T
			//    consult the StateStore cache — rotation is explicit, the
			//    whole point is to bypass the cache.
			yield* setPhase('rotate: generating new master key');
			const result = yield* Docker.runOneShot({
				name: `seal.${name}.keygen.rotate.${Date.now()}`,
				image: imageTag,
				entrypoint: SEAL_KEYGEN_ENTRYPOINT,
				args: [...SEAL_KEYGEN_ARGS],
				onOutputLine: makeSealOutputSink(`seal.${name}.rotate.keygen`),
			}).pipe(
				Effect.catchTag('DockerError', (cause) =>
					Effect.fail(
						new SealError({
							phase: 'rotate',
							message: `seal(${name}): rotate keygen container failed: ${cause.message}`,
							cause,
						}),
					),
				),
			);
			if (result.exitCode !== 0) {
				return yield* Effect.fail(
					new SealError({
						phase: 'rotate',
						message: `seal(${name}): rotate keygen exited ${result.exitCode}`,
						stderr: redactMasterKey(result.stderr),
						stdout: redactMasterKey(result.stdout),
						exitCode: result.exitCode,
					}),
				);
			}
			const fresh = parseSealKeygenOutput(result.stdout);

			// 2. Register a NEW on-chain KeyServerV2 Independent. URL stays
			//    the same (routed hostname is stable per stack); only the
			//    on-chain object id + pk change.
			yield* setPhase('rotate: registering new on-chain key-server');
			const tx = new Transaction();
			const freshPkBytes = decodeHex(fresh.publicKey);
			tx.moveCall({
				target: `${packageId}::key_server::create_and_transfer_v2_independent_server`,
				arguments: [
					tx.pure.string(keyServerName),
					tx.pure.string(keyServerUrl),
					tx.pure.u8(KEY_TYPE_BONEH_FRANKLIN_BLS12381),
					tx.pure.vector('u8', Array.from(freshPkBytes)),
				],
			});
			const registerResult = yield* signer.signAndExecute(tx).pipe(
				Effect.mapError(
					(cause) =>
						new SealError({
							phase: 'rotate',
							message: `seal(${name}): rotate register tx failed: ${cause.message}`,
							cause,
						}),
				),
			);
			const created = registerResult.objectChanges.find(
				(c): c is Extract<SuiObjectChange, { type: 'created' }> =>
					c.type === 'created' &&
					'objectType' in c &&
					typeof c.objectType === 'string' &&
					c.objectType.endsWith('::key_server::KeyServer'),
			);
			if (created === undefined) {
				return yield* Effect.fail(
					new SealError({
						phase: 'rotate',
						message:
							`seal(${name}): rotated KeyServer object missing from objectChanges ` +
							`(digest=${registerResult.digest})`,
					}),
				);
			}
			const newObjectId = created.objectId;

			// 3. Re-render yaml + env-file with the new identity. Both are
			//    bind-mounted into the container — overwriting in place is
			//    what the daemon will read on restart.
			yield* setPhase('rotate: writing new config');
			const newYaml = renderSealKeyServerConfig({
				sealPackageId: packageId,
				keyServerObjectId: newObjectId,
				nodeUrl: containerNodeUrl,
			});
			yield* fs.writeFileString(configPath, newYaml).pipe(
				Effect.mapError(
					(cause) =>
						new SealError({
							phase: 'rotate',
							message: `seal(${name}): could not write rotated config to ${configPath}: ${cause.message}`,
							cause,
						}),
				),
			);
			yield* fs.writeFileString(masterKeyEnvFile, `MASTER_KEY=${fresh.masterKey}\n`).pipe(
				Effect.mapError(
					(cause) =>
						new SealError({
							phase: 'rotate',
							message: `seal(${name}): could not write rotated env-file to ${masterKeyEnvFile}: ${cause.message}`,
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

			// 4. Bounce the daemon so it loads the new env + config.
			yield* setPhase('rotate: restarting key-server');
			yield* Docker.restartContainer(keyServerContainerName).pipe(
				Effect.catchTag('DockerError', (cause) =>
					Effect.fail(
						new SealError({
							phase: 'rotate',
							message: `seal(${name}): rotate restart failed: ${cause.message}`,
							cause,
						}),
					),
				),
			);

			// 5. Ready probe — same shape as initial acquire. The endpoint
			//    URL is unchanged but the on-chain identity behind it is
			//    new, so a fresh probe also catches misconfiguration
			//    (bad new yaml, env-file perms wrong) before rotate
			//    returns success.
			yield* Docker.awaitContainerReady({
				containerName: keyServerContainerName,
				probe: {
					kind: 'http',
					url: `${keyServerUrl}/health`,
					timeoutMs: readyTimeoutMs,
				},
			}).pipe(
				Effect.catchTag('ReadyProbeError', (cause) =>
					Effect.fail(
						new SealError({
							phase: 'rotate',
							message: `seal(${name}): rotated key-server never became ready: ${cause.message}`,
							stderr: cause.detail,
							cause,
						}),
					),
				),
			);

			// 6. Update StateStore caches. The next `pnpm dev` resumes
			//    against these values; without them, resume would short-
			//    circuit the keygen + register paths with the OLD pair
			//    against the NEW on-chain object id, leaving the daemon
			//    serving pre-rotation keys.
			yield* stateStore.put<PersistedBlsKeypair>(blsKeypairKey, fresh);
			yield* stateStore.put<string>(keyServerIdKey, newObjectId);
		}).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
			// `Docker.runOneShot` now yields Identity to stack-scope
			// container names. Pre-provide the captured value so the
			// consumer-facing `rotate` stays R=never (mirrors the
			// spawner pre-provide above).
			Effect.provideService(Identity, identity),
			Effect.withSpan(`seal(${name}).rotate`),
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
	})().pipe(
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
	const { __layer: internalLayer } = provide(SealLocalKeygenInternal, acquire, {
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

	// `composeLayers` lays out `inner → primary → projections` so the
	// fold in `composeStackLayer` finds each layer's deps already
	// satisfied. Inner sibling tags (sealImage, sourceFetch, publish)
	// provide the services `internalLayer`'s body yields; the projection
	// layers (keyServer, keyManager) consume `SealLocalKeygenInternal` so
	// they come last. Conditional siblings (sourceFetch / publish) pass
	// `undefined` and are dropped — no `push` loop, no comment-heavy
	// ordering invariants for future maintainers to violate.
	//
	// `key` is the internal tag's namespaced key
	// (`@devstack/SealLocalKeygenInternal/${name}`). `defineDevstack`
	// pre-populates an engine entry per StackMember at boot, and
	// `withEngineLifecycle` (inside `provide`) keys its
	// `markAcquiring` / `markReady` calls on the tag's key — using the
	// same key here collapses both into a single TUI row. The field is
	// the engine-internal lookup key, NOT the user-facing primitive
	// name; the public label is carried by `__displayTitle` / `display`.
	return {
		__layer: internalLayer,
		__layers: composeLayers({
			inner: [sealImage, sourceFetch, publish],
			primary: internalLayer,
			projections: [keyServerLayer, keyManagerLayer],
		}),
		key: SealLocalKeygenInternal.key,
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

	const build = Effect.fn(`sealKnownKeyServer(${name})`)(function* () {
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
	})();

	const { __layer, __kind, __displayTitle } = provide(SealKeyServer, build, {
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
	Effect.fn('seal.publish')(function* () {
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
	})();

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
		'# Generated by devstack seal primitive.',
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
