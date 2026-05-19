// Seal — multi-impl primitive.
//
// Two factories, both targeting the narrow interface tag classes in
// `src/services/seal.ts` (`SealKeyServerTag` + `SealKeyManagerTag`):
//
//   sealLocalKeygen(opts) — full local stack. Builds the seal image,
//     runs `seal-cli genkey`, publishes the seal Move package,
//     registers a KeyServer on chain, renders the key-server config
//     yaml, starts the key-server container, then surfaces BOTH
//     `SealKeyServerTag` (read surface — anyone with the URL can verify
//     signatures) and `SealKeyManagerTag` (local-only admin — master-key
//     env-file path + rotate Effect).
//   sealKnownKeyServer(opts) — read-only handle for a Mysten-run public
//     key server (e.g. testnet). Provides ONLY `SealKeyServerTag`; we
//     don't own the master key so there's no `SealKeyManagerTag` to
//     produce. Defaults pulled from `knownDeployments.seal`.
//
// Topology for `sealLocalKeygen`: a single Effect.gen body runs all
// phases (port-alloc, image, keygen, publish, register, config-render,
// container, ready) and lands in a private `SealLocalKeygenInternal`
// tag. Two thin projection layers then read from it to satisfy
// `SealKeyServerTag` and `SealKeyManagerTag`. The internal tag is what the
// engine lifecycle hooks key on, so the TUI shows ONE acquiring entry
// per `sealLocalKeygen()` rather than two (one per interface).
//
// The aggregate `SealLocalKeygenShape` is what gets serialized into
// `manifest.packages.seal` for frontends — the Effect-side surface is
// purely the two narrow tags.
//
// Snapshot participation (per AGENTS.md § "Snapshot participation"),
// `sealLocalKeygen` variant only — `sealKnownKeyServer` is a network-only
// handle with nothing local to persist:
//   - **What this service persists:** the BLS12-381 keypair as two hex
//     blobs in the state-store under
//     `StateStoreKeys.sealBlsKeypair({chainId})` (so a regenesis misses
//     the cache and a fresh keypair is generated); the on-chain
//     `KeyServer` object id under `StateStoreKeys.sealKeyServerId(...)`;
//     and the master-key env-file at `runtime/seal/master-key.env`
//     (`runtime/` is the path the `snapshot save` tar captures, so the
//     env-file rides along the snapshot tarball). The rendered
//     key-server YAML config also lives under `runtime/seal/`.
//   - **What re-derives from on-chain state on apply:** the published
//     seal Move package + the on-chain `KeyServer` object are read live
//     from chain state on resume (their object IDs come back out of the
//     state-store cache; the chain itself either restored from a sui
//     snapshot or is being re-deployed against).
//   - **What is intentionally lost on snapshot restore:** the
//     key-server's in-memory session caches + rate-limit counters; any
//     in-flight `/v1/fetch_key` requests; container-side logs (not under
//     `runtime/`). The master-key on disk is *not* lost — that's the
//     point of housing it under `runtime/seal/`.

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as nodeFs from 'node:fs/promises';
import { Context, Effect, FileSystem, Layer, Option, Path } from 'effect';
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
import { routerHostname } from '../../engine/router-hostname.js';
import { servicePath } from '../../engine/service-paths.js';
import { StateStore } from '../../engine/state-store.js';
import { withCache, buildCacheKey } from '../../engine/cache.js';
import { contentHash } from '../../engine/content-hash.js';
import { jsonBigintReplacer } from '../../engine/json-bigint.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { pickCreatedByType } from '../../engine/sui-helpers.js';
import { dockerImage, runDockerContainer } from '../../advanced/plugin-author/index.js';
import { gitFetch } from '../../advanced/plugin-author/index.js';
import { PackageRegistry, publishEndpoint, publishSealState } from '../../engine/registries.js';
import { EndpointName } from '../../runtime/endpoint-names.js';
import {
	SealKeyManagerTag,
	SealKeyServerTag,
	type SealKeyManager,
	type SealKeyServer,
} from '../seal.js';
import { composeLayers, provide, setPhase, type LayeredTag } from '../../advanced/tag.js';
import type { StackMember } from '../../engine/supervisor.js';
import { SuiTag, suiNetworkName, type Sui } from '../sui.js';
import { publishMove } from '../package/internal.js';
import { ForkIncompatibleError, SealError } from '../../engine/errors.js';
import { resolveNetwork } from '../../engine/network.js';
import type { Account } from '../../engine/shared.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Upstream key-server binds 2024 inside the container by default. The
// Traefik router dispatches by `Host:` header so two stacks coexist on
// the same external port — no per-stack dynamic allocation needed.
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

// Per-level filter for the container output sink — mirrors the pattern in
// `services/walrus/{nodes,deploy}.ts`. The seal key-server emits routine
// INFO narration (`/v1/*` request acks, periodic health checks, master-key
// load confirmations) that's useful in `docker logs` for debugging but
// noise in the TUI log panel. Default min-level = 'warn' suppresses INFO
// from the supervisor's sink WITHOUT silencing the container stream.
// Override via `DEVSTACK_LOG_LEVEL=info` (also accepts trace/debug → info,
// warning → warn, fatal → error) to surface everything in the TUI.
const LEVEL_RANK: Record<Docker.OutputLineLevel, number> = { info: 0, warn: 1, error: 2 };
const resolveMinLevel = (defaultMin: Docker.OutputLineLevel): Docker.OutputLineLevel => {
	const env = process.env.DEVSTACK_LOG_LEVEL?.toLowerCase();
	if (env === 'trace' || env === 'debug' || env === 'info') return 'info';
	if (env === 'warn' || env === 'warning') return 'warn';
	if (env === 'error' || env === 'fatal') return 'error';
	return defaultMin;
};

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

// State-store keys for seal moved to `engine/state-store-keys.ts` as
// part of Phase 5.1 of `notes/api-simplification.md`. Canonical
// builders: `StateStoreKeys.sealBlsKeypair({chainId})` and
// `StateStoreKeys.sealKeyServerId({chainId})`. The chainId fold-in
// is preserved so a regenesis of the underlying chain misses the
// cache and forces a fresh keypair + on-chain registration.

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
// narrow `SealKeyServerTag` / `SealKeyManagerTag` tags directly rather than
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
	readonly signer: LayeredTag<any, Account, any, any>;
	/** Skip the local image build and use a pre-built key-server image
	 *  tag instead. When unset (the default) we build from the vendored
	 *  Dockerfile under `packages/devstack/images/seal/`, fetching
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
	/** Ready-probe timeout for the key-server's HTTP endpoint. Default
	 *  60s. */
	readonly readyTimeoutMs?: number;
	/** On-chain `KeyServer.name` field. Default `devstack-local`. */
	readonly keyServerName?: string;
	/** Explicit ordering edges. Same shape as walrus/deepbook. */
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
}

// Combined intermediate shape produced by the heavy acquire effect.
// Drives both projection layers (`SealKeyServerTag` + `SealKeyManagerTag`)
// from a single resolved value.
interface SealLocalKeygenInternalShape {
	readonly keyServer: SealKeyServer;
	readonly keyManager: SealKeyManager;
	readonly packageId: string;
}

/**
 * Local-only seal stack: builds + runs the seal key-server, owns the
 * master key, registers a KeyServer on chain. Provides both
 * `SealKeyServerTag` (read surface) and `SealKeyManagerTag` (local admin).
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
	const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const keyServerName = options.keyServerName ?? 'devstack-local';

	// D5 / Phase 3 P3.5: sealLocalKeygen runs the key-server binary which
	// dials the chain via a baked-in client. Fork mode doesn't expose the
	// surfaces the binary expects: upstream `SuiRpcClient` (see
	// `crates/key-server/src/sui_rpc_client.rs`) carries BOTH an
	// `sui_sdk::SuiClient` (JSON-RPC) and a `sui_rpc::client::Client`
	// (gRPC); `check_policy.dry_run_transaction_block` is JSON-RPC-bound
	// and the fork's own `simulate_transaction` returns "unsupported"
	// (R3 of `notes/sui-fork-integration.md`). Phase 5 P5.3 audit
	// finalised 2026-05-19 — see
	// `notes/sui-fork-phase-5-walrus-seal-audit.md` §2. Refuse composition
	// at factory time so failures are actionable.
	const resolvedNetwork = resolveNetwork();
	if (resolvedNetwork.endsWith('-fork')) {
		throw new ForkIncompatibleError({
			variant: 'sealLocalKeygen',
			network: resolvedNetwork,
			message:
				`sealLocalKeygen is incompatible with fork mode (${resolvedNetwork}) — ` +
				`the key-server binary's chain client is bound to JSON-RPC, which sui-fork does ` +
				`not expose. Use \`Seal()\` (which auto-routes to the known-key-server branch ` +
				`in fork mode) or \`sealKnownKeyServer({network})\` directly.`,
			hint: `replace sealLocalKeygen() with Seal() or sealKnownKeyServer({network: '${resolvedNetwork.replace('-fork', '')}'})`,
		});
	}

	// Sibling tags. Image: caller-supplied `options.image` wins (pure
	// pull of a pre-built tag), otherwise we build from the vendored
	// Dockerfile under `packages/devstack/images/seal/`. The
	// Dockerfile fetches the platform-specific `seal-cli` + `key-server`
	// binaries from the seal GitHub release — no Rust compile.
	const sealImage =
		options.image !== undefined
			? dockerImage({ name: `${name}.image` as const, pull: options.image })
			: dockerImage({
					name: `${name}.image` as const,
					build: {
						context: new URL('../../images/seal/', import.meta.url).pathname,
						dockerfile: 'Dockerfile',
						buildArgs: { SEAL_VERSION: version },
					},
				});

	// Source resolution: caller-provided path wins; otherwise we plug in
	// a `gitFetch` factory tag whose runtime result feeds into
	// `publishMove` via the runtime-Effect `path` form (Phase C §5.6).
	// Two flows used to live here: a `publishMove` factory tag for the
	// `movePackagePath` branch, and an `publishSealMoveInline` body that
	// duplicated the publish flow for the gitFetch branch. The inline
	// path was uncached, so every restart re-built + re-published the
	// seal Move package. Pre-fix that was ~5-15s of wall-clock burn per
	// resume; now both branches share `publishMove`'s
	// `(name, sourceHash, chainId)` cache discipline, so warm restarts
	// skip build + publish entirely.
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
	const publish = publishMove({
		name: `${name}.publish` as const,
		// String path when the caller vendored the source; otherwise the
		// gitFetch's `path` field surfaced via a runtime Effect.
		path:
			movePackagePath !== undefined
				? movePackagePath
				: Effect.gen(function* () {
						const fetched = yield* sourceFetch!;
						return fetched.path;
					}),
		signer: options.signer,
	});

	// Private "internal" tag class. Both the `SealKeyServerTag` and
	// `SealKeyManagerTag` projection layers read from it. Kept inside the
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
		// can pre-provide it. Required because the `SealKeyManager`
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
		const minRank = LEVEL_RANK[resolveMinLevel('warn')];
		const makeSealOutputSink =
			(label: string): Docker.OutputLineCallback =>
			(level, line) => {
				if (LEVEL_RANK[level] < minRank) return Effect.void;
				return engineOpt._tag === 'None'
					? Effect.void
					: engineOpt.value
							.appendLog({ ts: Date.now(), level, message: `[${label}] ${line}` })
							.pipe(Effect.ignore);
			};

		// State-store cache keys for keygen + register. Derived via
		// `buildCacheKey` so they're byte-identical to the keys
		// `withCache(spec)` writes below; this lets the cross-cache
		// eviction in the keygen verify probe AND `rotate` reach into
		// the entries directly without going through `withCache`. The
		// `chainId` fold-in is implicit — a regenesis of the chain
		// flips it, naturally missing the cache and forcing a fresh
		// keypair + on-chain registration against the new chain state.
		const nameInputsHash = contentHash(JSON.stringify({ name }, jsonBigintReplacer), {
			length: 16,
		});
		const blsKeypairKey = buildCacheKey({
			namespace: 'seal/bls-keypair/v1',
			chainId: sui.chainId,
			inputsHash: nameInputsHash,
		});
		const keyServerIdKey = buildCacheKey({
			namespace: 'seal/key-server-id/v1',
			chainId: sui.chainId,
			inputsHash: nameInputsHash,
		});

		// 1. Router exposure — derive the stack-scoped hostname and the
		//    well-known seal entrypoint port (2024). The on-chain
		//    `KeyServer` object's URL needs to match where the daemon
		//    actually serves, so we resolve both here before step 5
		//    (register). No `PortAllocator.allocate` — two stacks of the
		//    same app coexist on `seal.<app>.localhost:2024` (main) and
		//    `<stack>.seal.<app>.localhost:2024` (non-main) because the
		//    Traefik router dispatches by `Host:` header.
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
		//    images/seal/` when no `options.image` is supplied; pulls
		//    the caller-supplied tag otherwise.
		yield* setPhase('building image');
		const resolvedImage = yield* Effect.gen(function* () {
			return yield* sealImage;
		}).pipe(Effect.withSpan('SealImage'));
		const imageTag = resolvedImage.tag;

		// 3. Keygen — `seal-cli genkey` one-shot + stdout parse, cached
		//    in the StateStore so warm restarts skip the docker call
		//    entirely. The cache lives at `seal/bls-keypair/<chainId>/...`
		//    so a regenesis misses cleanly.
		//
		//    Verify probe (§4.2): the keypair itself is off-chain, but a
		//    matching on-chain `KeyServer` object exists when we've
		//    previously registered. We piggy-back the cached keyServerId
		//    here — if the recorded object is missing on chain, the
		//    register cache is stale and so is the keypair (a fresh
		//    registration needs a fresh keypair). Eviction cascades: we
		//    remove the register cache here so the next step also misses
		//    and re-registers. Closes the §2.5 keyServer-survived-chain-
		//    regenesis hole.
		yield* setPhase('generating master key');
		const { masterKey, publicKey } = yield* withCache({
			namespace: 'seal/bls-keypair/v1',
			chainId: sui.chainId,
			inputs: Effect.succeed({ name }),
			verify: (cachedKeypair: PersistedBlsKeypair) =>
				Effect.gen(function* () {
					const cachedKeyServerId = yield* stateStore.get<string>(keyServerIdKey);
					if (Option.isNone(cachedKeyServerId)) {
						// No prior registration — keypair will be used to
						// register fresh. Trust the cached value.
						return cachedKeypair;
					}
					const ok = yield* probeObjectExists(sui.client, cachedKeyServerId.value);
					if (ok) return cachedKeypair;
					// Object missing on chain — register cache is stale.
					// Evict it here so the register withCache below also
					// misses and re-runs.
					yield* stateStore.remove(keyServerIdKey).pipe(Effect.ignore);
					return undefined;
				}),
			produce: Effect.gen(function* () {
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
				return parseSealKeygenOutput(result.stdout) satisfies PersistedBlsKeypair;
			}),
		}).pipe(Effect.withSpan('SealKeygen'));

		// 4. Publish the seal Move package. Always goes through
		//    `publishMove` — Phase C of the parallel-graph rework killed
		//    the inline-publish fallback so the gitFetch-vendored path
		//    inherits the same cache discipline as the caller-supplied
		//    `movePackagePath` branch. When `movePackagePath` is unset,
		//    `publishMove`'s `path` field carries an `Effect.Effect<string>`
		//    that resolves the gitFetch's `.path` at acquire time.
		yield* setPhase('publishing contracts');
		const pkg = yield* Effect.gen(function* () {
			return yield* publish;
		}).pipe(Effect.withSpan('SealPublish'));
		const packageId = pkg.packageId;

		// 5. Register the key server on chain — single Move call. URL
		//    MUST match the URL the container will later bind on; the
		//    allocated host port from step 1 satisfies that.
		//
		//    Verify probe (§4.2): confirm the cached `KeyServer` object
		//    still resolves on chain. The keygen verify above already
		//    eagerly evicts this key when its piggy-backed probe sees a
		//    missing object — by the time we get here, the cache is
		//    either valid OR has been pre-cleared. The local probe is
		//    still load-bearing for the case where the chain object was
		//    deleted between the two withCache calls (vanishingly rare,
		//    but cheap to guard).
		const keyServerObjectId = yield* withCache({
			namespace: 'seal/key-server-id/v1',
			chainId: sui.chainId,
			inputs: Effect.succeed({ name }),
			verify: (cachedId: string) =>
				Effect.gen(function* () {
					const ok = yield* probeObjectExists(sui.client, cachedId);
					return ok ? cachedId : undefined;
				}),
			produce: Effect.gen(function* () {
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

				const createdId = pickCreatedByType(result.objectChanges, {
					suffix: '::key_server::KeyServer',
				});
				if (createdId === undefined) {
					return yield* Effect.fail(
						new SealError({
							phase: 'register',
							message:
								`seal(${name}): KeyServer object missing from objectChanges ` +
								`(digest=${result.digest})`,
						}),
					);
				}
				return createdId;
			}),
		}).pipe(Effect.withSpan('SealRegister'));

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

		// Persist the rendered key-server config under the runtime dir
		// (NOT a scoped temp dir). The docker container bind-mounts this
		// file at `/etc/seal/key-server-config.yaml`; if the host path
		// gets cleaned up between `pnpm dev` invocations, `docker start`
		// of the prior container fails with `not a directory: Are you
		// trying to mount a directory onto a file (or vice-versa)?` and
		// devstack falls back to `rm -f` + fresh run on every resume.
		// Sibling of `master-key.env` so the same `runtime/seal/`
		// chmod 0o700 covers it; `snapshot save` already tars
		// `runtime/seal/` so the config rides along with the keypair.
		const sealStateDir = yield* servicePath('seal');
		yield* fs.chmod(sealStateDir, 0o700).pipe(
			Effect.catch(() =>
				Effect.tryPromise({
					try: () => nodeFs.chmod(sealStateDir, 0o700),
					catch: () => undefined,
				}).pipe(Effect.ignore),
			),
		);
		const configPath = path.join(sealStateDir, 'key-server-config.yaml');
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

		// Stage the master key in an env-file under the canonical runtime
		// dir at `runtime/seal/master-key.env`, then hand docker
		// `--env-file` instead of `-e MASTER_KEY=…`. The `-e` form
		// surfaces the value in host process env (PID-visible) and in
		// `docker inspect` output; routing through a 0o600 file confines
		// it to the file, the container's env, and whatever the daemon
		// does with it.
		//
		// Living under `runtime/seal/` (not a hidden dir) is load-bearing
		// for snapshots: `snapshot save` tars `runtime/` so the master
		// key + BLS keypair (recorded in state-store) ride along, and
		// restore gets a complete seal world without re-running keygen.
		// `sealStateDir` was already resolved above (chmod 0o700 already
		// applied); reuse it here for the master-key env-file sibling.
		const masterKeyEnvFile = path.join(sealStateDir, 'master-key.env');
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
				}).pipe(Effect.ignore),
			),
		);
		// The master-key env-file is intentionally NOT unlinked on scope
		// close. Unlinking would give the "secret never touches disk
		// after the supervisor exits" property but break snapshots: a
		// `snapshot save` + `stack down` + `snapshot restore` round-trip
		// would lose the master key, and the seal key-server would refuse
		// to start against the chain-registered public key. The file is
		// kept on disk between cycles; `devstack wipe` is the canonical
		// place to nuke it (along with the rest of `runtime/seal/`).
		// On-disk perms (0o600 + 0o700 parent dir) keep it confined to
		// the owner.

		// 7. Long-running key-server container. `runDockerContainer`
		//    owns the spawn, the `docker stop` finalizer on this
		//    primitive's own layer scope, the traefik file-provider
		//    materialization, AND the `/health` ready probe (raced
		//    against `docker wait` so a crashed container surfaces its
		//    log tail instead of timing out blind).
		yield* setPhase('starting key server');
		const keyServerContainerName = `seal-${name}-key-server`;
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
		yield* runDockerContainer(keyServerContainerName, {
			image: { tag: imageTag },
			env: {
				CONFIG_PATH: '/etc/seal/key-server-config.yaml',
				RUST_LOG: 'info',
			},
			envFiles: [masterKeyEnvFile],
			mounts: [{ source: configPath, target: '/etc/seal/key-server-config.yaml' }],
			...(suiNet !== undefined ? { network: suiNet } : {}),
			// Single router entry for the key-server. The on-chain
			// `KeyServer.url` registered above MUST match this hostname:port
			// — the SDK reads the chain to discover the endpoint.
			// `routing[].name = 'seal'` ↔ same router id / hostname the
			// previous `routerId(identity, 'seal')` callsite minted.
			routing: [
				{
					name: 'seal',
					entrypoint: 'seal',
					servicePort: DEFAULT_KEY_SERVER_PORT,
				},
			],
			// `/health` returns `{name,version,status:"up"}` once the
			// binary has bound and parsed CONFIG_PATH; failure to load
			// surfaces as a non-200 because the binary exits before
			// the endpoint starts accepting traffic. The `/v1/*`
			// endpoints require a `Client-Sdk-Version` header and
			// reject the bare ready probe with 400. `awaitExit: true`
			// (default) races against `docker wait` so a crash during
			// boot surfaces the log tail instead of timing out blind.
			ready: {
				kind: 'http',
				url: `${keyServerUrl}/health`,
				timeoutMs: readyTimeoutMs,
			},
			// Stream the key-server's docker-logs into the supervisor.
			// Catches the `RUST_LOG=info` lines that document
			// `CONFIG_PATH` parse failures, master-key load issues, and
			// per-request errors — all of which were previously invisible
			// to the user until they manually ran `docker logs`.
			onOutputLine: makeSealOutputSink(`seal.${name}.key-server`),
			// Key-server is mostly stateless (in-memory key material loaded
			// from envFile), but a clean SIGTERM lets in-flight `/v1/*`
			// requests finish vs being torn mid-decrypt. 15s is comfortable.
			stopGraceSeconds: 15,
		}).effect.pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new SealError({
						phase: 'container',
						message: `seal(${name}): failed to start key-server container: ${cause.message}`,
						cause,
					}),
				),
			),
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
		yield* publishEndpoint({
			name: EndpointName.SEAL_KEY_SERVER,
			url: keyServerUrl,
			kind: 'seal-key-server',
		});
		yield* publishSealState({ name, objectId: keyServerObjectId });

		// Key rotation: regenerate the BLS keypair, register a NEW on-chain
		// KeyServerV2 Independent (the upstream contract has no in-place
		// `pk` mutation for Independent servers — `key_server.move` exposes
		// only `update()` for URL), re-render the yaml + env-file with the
		// new identity, restart the container so it picks up the new
		// master key, and update the StateStore cache so the next
		// `pnpm dev` resumes against the rotated keys.
		//
		// IMPORTANT — in-memory staleness: callers that already captured
		// `SealKeyServerTag`'s shape (objectId / serverConfigs) by yielding
		// the tag BEFORE rotate hold pre-rotation values. The Layer
		// caches `SealKeyServerTag`, so re-yielding inside the same scope
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
			const newObjectId = pickCreatedByType(registerResult.objectChanges, {
				suffix: '::key_server::KeyServer',
			});
			if (newObjectId === undefined) {
				return yield* Effect.fail(
					new SealError({
						phase: 'rotate',
						message:
							`seal(${name}): rotated KeyServer object missing from objectChanges ` +
							`(digest=${registerResult.digest})`,
					}),
				);
			}

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
					}).pipe(Effect.ignore),
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
			Effect.withSpan(`SealRotate(${name})`),
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
	//
	// Phase B (notes/parallel-graph-resolution.md §3.1): declare every
	// upstream this composite yields inside `acquire`, so the
	// topological-level scheduler in `composeStackLayer` puts seal at
	// the right level (strictly after sui + signer + inner image / source
	// / publish tags + any explicit dependsOn edges). Inner sibling tags
	// — `sealImage`, `sourceFetch`, `publish` — also enter the upstream
	// list so the inner layers settle before seal's acquire body
	// resolves them via `yield* sealImage` / `yield* sourceFetch` /
	// `yield* publish`. Conditional siblings pass `undefined` and are
	// dropped by `resolveUpstreamKeys`.
	// `SuiTag` is the canonical Context.Service class, not a LayeredTag,
	// so reach for its `key` directly. Inner sibling tags feed in via
	// their `.key` strings. `publish` is unconditional now (Phase C
	// killed the inline-publish branch); `sourceFetch` is still
	// conditional on whether the caller vendored a Move path.
	const upstreamKeys: Array<LayeredTag<any, any, any, any> | string> = [
		SuiTag.key,
		options.signer,
		sealImage,
		...(sourceFetch !== undefined ? [sourceFetch] : []),
		publish,
		...(options.dependsOn ?? []),
	];
	const { __layer: internalLayer } = provide(SealLocalKeygenInternal, acquire, {
		kind: 'service',
		plugin: 'seal',
		displayTitle: 'seal.local',
		display: (s) => ({ title: 'seal.local', primary: s.keyServer.keyServerUrl }),
		upstreamKeys,
	});

	const keyServerLayer = Layer.effect(
		SealKeyServerTag,
		Effect.gen(function* () {
			const internal = yield* SealLocalKeygenInternal;
			return internal.keyServer;
		}),
	);

	const keyManagerLayer = Layer.effect(
		SealKeyManagerTag,
		Effect.gen(function* () {
			const internal = yield* SealLocalKeygenInternal;
			return internal.keyManager;
		}),
	);

	// Phase D (notes/parallel-graph-resolution.md §6.4): the inner sibling
	// tags `sealImage` and `sourceFetch` are LIFTED to top-level via
	// `__extraMembers` so the topo scheduler can build seal's image
	// alongside sui's boot and seal's Move-source gitFetch alongside
	// walrus's source fetch. `publish` stays inner: it carries a runtime
	// dependency on `sourceFetch.path` via its `path: Effect.Effect<string>`
	// form, and the cache discipline + state-store writes are tightly
	// coupled with the composite's own acquire body, so leaving it as a
	// sibling layer that builds against the composite's level keeps the
	// surface tidy (publishMove's own MemoMap entry serves the same
	// dedupe role any future lift would gain).
	//
	// `composeLayers` lays out the remaining `inner → primary →
	// projections` chain. Inner is now just `[publish]` (conditionally
	// undefined when the caller vendors a Move path — composeLayers
	// drops `undefined` entries). The lifted siblings are surfaced via
	// `__extraMembers`, which `flattenStackMembers` (in supervisor.ts)
	// expands to top-level entries during compose. The body still
	// `yield*`s the lifted tags inside `acquire`; Effect's MemoMap
	// resolves them against the level-0 instances the topo scheduler
	// built.
	//
	// `key` is the internal tag's namespaced key
	// (`@devstack/SealLocalKeygenInternal/${name}`). `defineDevstack`
	// pre-populates an engine entry per StackMember at boot, and
	// `withEngineLifecycle` (inside `provide`) keys its
	// `markAcquiring` / `markReady` calls on the tag's key — using the
	// same key here collapses both into a single TUI row. The field is
	// the engine-internal lookup key, NOT the user-facing primitive
	// name; the public label is carried by `__displayTitle` / `display`.
	// `provide(SealLocalKeygenInternal, …)` above mutated the class with
	// `__layer` and `key`. Augment it with the composite `__layers` (so
	// the supervisor merges inner + projection layers, not just the
	// internal one) and return the class itself rather than a fresh
	// POJO. The class is a yieldable `Context.Service`, so callers that
	// pass `seal` into `Dev({ needs: [seal] })` (or any other
	// `dependsOn`-style ordering edge) get a `yield* seal` that resolves
	// against the internal tag — without the class wrapper they'd hit
	// "object is not iterable" on the dependent's first acquire.
	const liftedSiblings: ReadonlyArray<LayeredTag<any, any, any, any>> =
		sourceFetch !== undefined ? [sealImage, sourceFetch] : [sealImage];
	return Object.assign(SealLocalKeygenInternal, {
		__layers: composeLayers({
			inner: [publish],
			primary: internalLayer,
			projections: [keyServerLayer, keyManagerLayer],
		}),
		__extraMembers: liftedSiblings as unknown as ReadonlyArray<StackMember>,
		__kind: 'service' as const,
		__pluginName: 'seal',
		__displayTitle: 'seal.local',
	}) as unknown as StackMember;
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
 * deployment). Provides ONLY `SealKeyServerTag` — we don't own the master
 * key, so there's no `SealKeyManagerTag` layer to produce.
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
		yield* publishEndpoint({
			name: EndpointName.SEAL_KEY_SERVER,
			url: keyServerUrl,
			kind: 'seal-key-server',
		});
		yield* publishSealState({ name, objectId });
		// SDK-ready array. Known-mode wraps the single registry entry
		// in a one-element `serverConfigs` array with weight 1 today;
		// multi-server known stacks (t-of-n committees) would extend
		// `SealKnownKeyServerOptions` with an explicit
		// `serverConfigs?` override — future work.
		return {
			serverConfigs: [{ objectId, weight: 1 }],
			keyServerUrl,
			objectId,
		} satisfies SealKeyServer;
	})();

	const { __layer, __kind, __displayTitle } = provide(SealKeyServerTag, build, {
		kind: 'service',
		plugin: 'seal',
		displayTitle: 'seal.known',
		display: (s) => ({ title: 'seal.known', primary: s.keyServerUrl }),
	});
	return { __layer, key: name, __kind, __displayTitle };
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Probe whether `objectId` is currently resolvable on chain. Returns
 *  `true` when `client.core.getObject` succeeds; `false` on any error
 *  (object missing, RPC transient, network down). Used by the seal
 *  withCache verify probes (§4.2 of `notes/parallel-graph-resolution.md`)
 *  so a stale cache entry — chain regenesis, snapshot mismatch,
 *  user-initiated rotation — gets invalidated cleanly instead of
 *  silently feeding downstream consumers a dead reference.
 *
 *  Conservatively falls back to `false` on any failure: over-deriving
 *  on the next produce cycle is cheaper than booting against a broken
 *  cache entry. */
const probeObjectExists = (client: Sui['client'], objectId: string): Effect.Effect<boolean> =>
	Effect.tryPromise({
		try: () => client.core.getObject({ objectId }),
		catch: (cause) => cause,
	}).pipe(
		Effect.as(true),
		Effect.orElseSucceed(() => false),
	);

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
