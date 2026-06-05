// Seal local-keygen mode — the full localnet path.
//
// Distilled-doc reference (07-seal.md §"Lifecycle / Startup —
// `sealLocalKeygen`"). Eight ordered phases:
//
//   0. Yield deps (Sui, Identity, ContainerRuntime, artifact publisher publisher).
//   1. Image build (bootstrap asset — parallel with sui's boot).
//  1a. Move source resolve (bootstrap asset, conditional).
//   2. BLS keygen one-shot (real `runtime.runOneShot` against cargo
//                            image; output parsed via regex).
//   3. Publish seal Move package (via artifact publisher primitive).
//   4. Register on-chain KeyServer (via artifact publisher primitive).
//   5. Render config yaml + stage master-key env-file (atomic
//                                                       FileSystem
//                                                       writes).
//   6. Start long-running key-server container (real
//                                               `runtime.ensureContainer`
//                                               + exec-based ready
//                                               probe).
//   7. Project the plugin's aggregate value.
//
// Distilled-doc invariants pinned by this file:
//
//   #1  KeyServer.url == routed hostname        — single mint point
//                                                 (`routedUrl` passed
//                                                 identically into
//                                                 `registerKeyServer`
//                                                 and `buildKeyServerSpec`).
//   #2  Boot order keygen → publish → register → config → container.
//   #4  env-file for secret loading (not -e MASTER_KEY=…).
//   #5  No host-port publish.
//   #6  Keypair B8 verify cascade (deploy.ts:buildKeypairVerify).
//   #7  Signal-forwarding entrypoint shell (image-side).
//   #8  Fork incompatibility throw — handled at the barrel
//       (`index.ts`), NOT here.
//   #9  Peer-dep structural assignability (compile-time check
//       lives in registry-publish.ts).
//
// This is the substrate-name-LEAK boundary. Inside this file we can
// say "seal"; outside `src/plugins/seal/`, the substrate doesn't
// know seal exists.

import { Effect, FileSystem, Path, Schema, type Scope } from 'effect';

import { decodeJsonText } from '../../../substrate/runtime/runtime-decode.ts';

import type { ChainProbe } from '../../../contracts/chain-probe.ts';
import type { ContainerLabelTuple } from '../../../contracts/snapshotable.ts';
import type { ContainerRuntime, ImageRef } from '../../../contracts/container-runtime.ts';
import type {
	ArtifactPublishError,
	ArtifactPublisher,
} from '../../../primitives/artifact-publisher.ts';
import type { AccountValue } from '../../account/index.ts';
import {
	parseMasterKeyEnvFile,
	renderSealKeyServerConfig,
	stageSealConfig,
} from '../config-render.ts';
import {
	publishSealPackage,
	registerKeyServer,
	type SealObjectProbeKey,
	type SealSuiSdk,
} from '../deploy.ts';
import { sealError, type SealError } from '../errors.ts';
import { MASTER_KEY_ENVFILE_BASENAME, runSealKeygen, type PersistedBlsKeypair } from '../keygen.ts';
import { makeKeyManager } from '../key-manager.ts';
import { buildKeyServerSpec, startKeyServer, type KeyServerContainerSpec } from '../key-server.ts';
import type { SealKeyServerEntry, SealLocalKeygenResolved } from '../registry-publish.ts';
import { resolveDefaultSealCargoImage } from '../bootstrap-assets/cargo-image.ts';
import { resolveDefaultSealSource } from '../bootstrap-assets/source-fetch.ts';
import { atomicWriteFile } from '../../../substrate/runtime/atomic-write.ts';
import { versionedDocSchema } from '../../../substrate/versioned-doc-schema.ts';

// ---------------------------------------------------------------------------
// Options (factory-time)
// ---------------------------------------------------------------------------

/** Options the local-keygen mode accepts (07-seal.md
 *  §"Configuration"). The
 *  barrel (`index.ts`) folds the typed `SealLocalKeygenOptions`
 *  surface into this internal shape after default resolution. */
export interface LocalKeygenOptions {
	readonly name?: string;
	readonly version?: string;
	readonly movePackagePath?: string;
	readonly readyTimeoutMs?: number;
	readonly keyServerName?: string;
}

/** Resolved options after defaults are applied. */
export interface ResolvedLocalKeygenOptions {
	readonly name: string;
	readonly version: string;
	readonly readyTimeoutMs: number;
	readonly keyServerName: string;
	readonly movePackagePath?: string;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_KEY_SERVER_NAME = 'devstack-local';

/** Synchronous factory-time defaults application. Pure — no
 *  validation throws because the localnet signer requirement is
 *  enforced one layer up in the barrel (the type-narrowed
 *  `sealFor(local).localKeygen({signer})` makes signer required). */
export const resolveLocalKeygenOptions = (
	opts: LocalKeygenOptions,
	defaultVersion: string,
): ResolvedLocalKeygenOptions => ({
	name: opts.name ?? 'seal',
	version: opts.version ?? defaultVersion,
	readyTimeoutMs: opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
	keyServerName: opts.keyServerName ?? DEFAULT_KEY_SERVER_NAME,
	movePackagePath: opts.movePackagePath,
});

// ---------------------------------------------------------------------------
// Inputs to the boot pipeline (acquire-time)
// ---------------------------------------------------------------------------

/** Acquire-time deps the boot pipeline consumes. Sourced by the
 *  barrel (`index.ts`) from a mix of:
 *
 *   - substrate-resolved values (`IdentityContext`,
 *     `ContainerRuntimeService`, `ArtifactPublisher`);
 *   - substrate-derived identifiers (chainId, servicePath,
 *     subnet, etc.);
 *   - router-resolved URL (single mint — distilled-doc invariant #1).
 *
 *  The barrel composes these from substrate services
 *  (ContainerRuntime, IdentityContext, ArtifactPublisher,
 *  StackPathsService) at acquire-time. */
export interface LocalKeygenDeps {
	readonly runtime: ContainerRuntime;
	readonly publisher: ArtifactPublisher;
	readonly signer: AccountValue;
	readonly sdk: SealSuiSdk;
	readonly buildImage?: ImageRef;
	readonly chainProbe: ChainProbe<SealObjectProbeKey>;
	readonly chain: string;
	/** Per-stack on-disk dir under `runtime/seal/`. Host path for the
	 *  config yaml + master-key env-file. */
	readonly servicePath: string;
	/** Container name composed by the substrate (app + stack + name +
	 *  role). */
	readonly containerName: string;
	/** Label tuple driving snapshot/inspect by labels. */
	readonly labels: ContainerLabelTuple;
	/** Seal's per-stack docker network — the key-server daemon attaches
	 *  to this network. */
	readonly suiNetworkName: string;
	/** In-network sui RPC URL — the daemon's CONFIG_PATH yaml carries
	 *  this. */
	readonly suiRpcUrlInNetwork: string;
	/** Router-resolved single mint (distilled-doc invariant #1). */
	readonly routedHostname: string;
	readonly routedUrl: string;
}

interface PersistedLocalKeygenKeyMaterial {
	readonly masterKey: string;
	readonly publicKey: string;
	readonly masterKeyEnvFile: string;
}

interface PersistedLocalKeygenState extends PersistedLocalKeygenKeyMaterial {
	readonly packageId: string;
	readonly keyServerObjectId: string;
}

const LOCAL_KEYGEN_STATE_VERSION = 1;
const LOCAL_KEYGEN_STATE_BASENAME = 'local-keygen-state.v1.json';

const PersistedLocalKeygenMetadataSchema = versionedDocSchema(LOCAL_KEYGEN_STATE_VERSION, {
	publicKey: Schema.String,
});

type PersistedLocalKeygenMetadata = Schema.Schema.Type<typeof PersistedLocalKeygenMetadataSchema>;

const localKeygenMetadataPath = (servicePath: string): string =>
	`${servicePath}/${LOCAL_KEYGEN_STATE_BASENAME}`;

const readPersistedLocalKeygenMetadata = (
	servicePath: string,
): Effect.Effect<PersistedLocalKeygenMetadata | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = localKeygenMetadataPath(servicePath);
		const raw = yield* fs.readFileString(path).pipe(Effect.catch(() => Effect.succeed(null)));
		if (raw === null) return null;
		// Parse + decode failures here mean "no usable persisted metadata"
		// and the caller treats this as a miss; the typed
		// `RuntimeDecodeIssue` carries the parse/decode diagnostic for
		// debugging but is collapsed to `null` so the boot loop falls
		// through to a fresh keygen.
		return yield* decodeJsonText(PersistedLocalKeygenMetadataSchema, raw, {
			source: path,
			mkError: (issue) => issue,
		}).pipe(Effect.catch(() => Effect.succeed(null)));
	});

const stagePersistedLocalKeygenMetadata = (
	servicePath: string,
	name: string,
	metadata: PersistedLocalKeygenMetadata,
): Effect.Effect<void, SealError, FileSystem.FileSystem> =>
	atomicWriteFile(
		localKeygenMetadataPath(servicePath),
		new TextEncoder().encode(`${JSON.stringify(metadata, null, 2)}\n`),
		{
			mode: 0o644,
			parentMode: 0o700,
		},
	).pipe(
		Effect.catch((cause) =>
			Effect.fail(
				sealError('config-render', {
					name,
					message: `seal.config-render: failed to write ${LOCAL_KEYGEN_STATE_BASENAME} (${cause.stage})`,
					cause,
				}),
			),
		),
	);

const readPersistedLocalKeygenState = (
	servicePath: string,
): Effect.Effect<PersistedLocalKeygenKeyMaterial | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const masterKeyEnvFile = `${servicePath}/${MASTER_KEY_ENVFILE_BASENAME}`;
		const masterKeyBody = yield* fs
			.readFileString(masterKeyEnvFile)
			.pipe(Effect.catch(() => Effect.succeed(null)));
		if (masterKeyBody === null) return null;
		const masterKey = parseMasterKeyEnvFile(masterKeyBody);
		if (masterKey === null) return null;
		const metadata = yield* readPersistedLocalKeygenMetadata(servicePath);
		if (metadata === null) return null;

		return {
			masterKey,
			publicKey: metadata.publicKey,
			masterKeyEnvFile,
		};
	});

/** BLS12-381 master key — 32 bytes, persisted as 64 hex chars. */
const BLS_MASTER_KEY_HEX_LEN = 64;
/** BLS12-381 G2 uncompressed public key — 96 bytes, persisted as 192 hex chars. */
const BLS_PUBLIC_KEY_HEX_LEN = 192;
const HEX_ONLY_RE = /^[0-9a-fA-F]+$/;

/** Stricter decode than the JSON-shape Schema alone — verifies the
 *  persisted master key + public key are well-formed BLS12-381 hex of
 *  the expected widths. The Schema validation alone accepts any
 *  string, so a corrupt-on-disk JSON whose `publicKey` was overwritten
 *  to a shorter / wrong-width value would otherwise be silently
 *  reused on boot — leading to a master-key / KeyServer mismatch
 *  (the master-key.env carries one key, the registered KeyServer's
 *  on-chain `publicKey` carries a different one). Distilled-doc
 *  invariant #6 (keypair B8 verify cascade) covers the on-chain
 *  side; this is the on-disk side.
 *
 *  We cannot in-process re-derive the G2 public key from the master
 *  scalar without bundling a BLS12-381 implementation (the keygen
 *  binary owns this in cargo-land). The width invariant is the
 *  cheapest defense that catches the realistic corruption modes:
 *  truncated writes, hand-edited JSON, stale persistence from an
 *  older devstack version. */
const validatePersistedKeyMaterialShape = (
	material: PersistedLocalKeygenKeyMaterial,
	name: string,
): Effect.Effect<void, SealError> => {
	if (
		material.masterKey.length !== BLS_MASTER_KEY_HEX_LEN ||
		!HEX_ONLY_RE.test(material.masterKey)
	) {
		return Effect.fail(
			sealError('config-render', {
				name,
				message:
					`seal.local-keygen: persisted master key in ${MASTER_KEY_ENVFILE_BASENAME} ` +
					`is not ${BLS_MASTER_KEY_HEX_LEN}-char hex (got ${material.masterKey.length} chars). ` +
					'The on-disk state is corrupt; delete the seal service directory and ' +
					're-boot to regenerate, or restore from a known-good snapshot.',
			}),
		);
	}
	if (
		material.publicKey.length !== BLS_PUBLIC_KEY_HEX_LEN ||
		!HEX_ONLY_RE.test(material.publicKey)
	) {
		return Effect.fail(
			sealError('config-render', {
				name,
				message:
					`seal.local-keygen: persisted publicKey in ${LOCAL_KEYGEN_STATE_BASENAME} ` +
					`is not ${BLS_PUBLIC_KEY_HEX_LEN}-char hex (got ${material.publicKey.length} chars). ` +
					'The on-disk state is corrupt; reusing it would publish a KeyServer ' +
					'whose on-chain publicKey diverges from the local master key. ' +
					'Delete the seal service directory and re-boot to regenerate.',
			}),
		);
	}
	return Effect.void;
};

const sealConfigFingerprint = (parts: {
	readonly packageId: string;
	readonly keyServerObjectId: string;
	readonly nodeUrl: string;
}): string =>
	[
		`package=${parts.packageId}`,
		`keyServer=${parts.keyServerObjectId}`,
		`nodeUrl=${parts.nodeUrl}`,
	].join('|');

const resolveMovePackagePath = (
	deps: LocalKeygenDeps,
	opts: ResolvedLocalKeygenOptions,
): Effect.Effect<string, SealError, Scope.Scope | FileSystem.FileSystem | Path.Path> =>
	opts.movePackagePath
		? Effect.succeed(opts.movePackagePath)
		: resolveDefaultSealSource(deps.runtime).pipe(Effect.map((s) => s.path));

const ensureLocalKeygenArtifacts = (
	deps: LocalKeygenDeps,
	opts: ResolvedLocalKeygenOptions,
	publicKey: string,
): Effect.Effect<
	{
		readonly packageId: string;
		readonly keyServerObjectId: string;
	},
	SealError | ArtifactPublishError,
	Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const movePackagePath = yield* resolveMovePackagePath(deps, opts);
		const { packageId } = yield* publishSealPackage(deps.publisher, {
			name: opts.name,
			chain: deps.chain,
			movePackagePath,
			signer: deps.signer,
			sdk: deps.sdk,
			runtime: deps.runtime,
			chainProbe: deps.chainProbe,
			...(deps.buildImage !== undefined ? { buildImage: deps.buildImage } : {}),
		});
		const { objectId: keyServerObjectId } = yield* registerKeyServer(deps.publisher, {
			name: opts.name,
			chain: deps.chain,
			keyServerUrl: deps.routedUrl,
			sealPackageId: packageId,
			publicKeyHex: publicKey,
			keyServerName: opts.keyServerName,
			signer: deps.signer,
			sdk: deps.sdk,
			chainProbe: deps.chainProbe,
		});
		return { packageId, keyServerObjectId };
	});

const stageResolvedLocalKeygenState = (
	deps: LocalKeygenDeps,
	opts: ResolvedLocalKeygenOptions,
	artifacts: {
		readonly packageId: string;
		readonly keyServerObjectId: string;
	},
	keypair: Pick<PersistedBlsKeypair, 'masterKey' | 'publicKey'>,
): Effect.Effect<PersistedLocalKeygenState, SealError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const yaml = renderSealKeyServerConfig({
			sealPackageId: artifacts.packageId,
			nodeUrl: deps.suiRpcUrlInNetwork,
			keyServerObjectId: artifacts.keyServerObjectId,
		});
		const { masterKeyEnvFile } = yield* stageSealConfig(
			yaml,
			keypair.masterKey,
			deps.servicePath,
			opts.name,
		);
		yield* stagePersistedLocalKeygenMetadata(deps.servicePath, opts.name, {
			version: LOCAL_KEYGEN_STATE_VERSION,
			publicKey: keypair.publicKey,
		});
		return {
			packageId: artifacts.packageId,
			keyServerObjectId: artifacts.keyServerObjectId,
			masterKey: keypair.masterKey,
			publicKey: keypair.publicKey,
			masterKeyEnvFile,
		};
	});

const startLocalKeygenContainer = (
	deps: LocalKeygenDeps,
	opts: ResolvedLocalKeygenOptions,
	cargoImage: ImageRef,
	state: PersistedLocalKeygenState,
): Effect.Effect<SealLocalKeygenResolved, SealError, Scope.Scope> =>
	Effect.gen(function* () {
		const spec: KeyServerContainerSpec = buildKeyServerSpec({
			name: opts.name,
			image: cargoImage,
			containerName: deps.containerName,
			labels: deps.labels,
			suiNetwork: deps.suiNetworkName,
			servicePath: deps.servicePath,
			configFingerprint: sealConfigFingerprint({
				packageId: state.packageId,
				keyServerObjectId: state.keyServerObjectId,
				nodeUrl: deps.suiRpcUrlInNetwork,
			}),
			routedHostname: deps.routedHostname,
			routedUrl: deps.routedUrl,
			readyTimeoutMs: opts.readyTimeoutMs,
		});
		const { containerName } = yield* startKeyServer(deps.runtime, spec, opts.name);
		void containerName;

		const serverConfigs: ReadonlyArray<SealKeyServerEntry> = [
			{ objectId: state.keyServerObjectId, weight: 1 },
		];
		const keyManager = makeKeyManager({
			masterKeyEnvFile: state.masterKeyEnvFile,
		});
		return {
			keyServer: {
				serverConfigs,
				keyServerUrl: deps.routedUrl,
				objectId: state.keyServerObjectId,
			},
			keyManager,
			packageId: state.packageId,
		} satisfies SealLocalKeygenResolved;
	});

// ---------------------------------------------------------------------------
// Boot pipeline
// ---------------------------------------------------------------------------

/** The plugin's aggregate acquire body. Calls each phase in
 *  order; failures surface as typed `SealError` /
 *  `ArtifactPublishError` through the Effect's error channel.
 *
 *  Distilled-doc invariant #2 — phase order is keygen → publish →
 *  register → config-render → container. Any phase failure short-
 *  circuits before downstream phases (cheap on warm restart because
 *  the ArtifactPublisher cache + verify covers steps 3-4). */
export const bootLocalKeygen = (
	deps: LocalKeygenDeps,
	opts: ResolvedLocalKeygenOptions,
): Effect.Effect<
	SealLocalKeygenResolved,
	SealError | ArtifactPublishError,
	Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		// ---- cargo image (bootstrap asset) -----------------------
		// The cargo image's resolver honors `SEAL_CARGO_IMAGE_OVERRIDE`
		// for the pre-baked path; falls back to a documented seam error
		// pointing at the override hatch.
		const cargoImage: ImageRef = yield* resolveDefaultSealCargoImage(deps.runtime, {
			app: deps.labels.app,
			stack: deps.labels.stack,
		});

		const persisted = yield* readPersistedLocalKeygenState(deps.servicePath);
		if (persisted !== null) {
			// Defensive invariant — if the on-disk publicKey or master key
			// has the wrong shape, the ArtifactPublisher cache might
			// happily reuse a stale on-chain KeyServer whose registered
			// publicKey no longer matches the master key the daemon
			// loads at boot. Refuse to proceed so the operator gets a
			// clear typed error instead of a silently-broken stack.
			yield* validatePersistedKeyMaterialShape(persisted, opts.name);
			const artifacts = yield* ensureLocalKeygenArtifacts(deps, opts, persisted.publicKey);
			const refreshed = yield* stageResolvedLocalKeygenState(deps, opts, artifacts, persisted);
			return yield* startLocalKeygenContainer(deps, opts, cargoImage, refreshed);
		}

		// ---- keygen (BLS12-381 master + public) -----------------
		// The keypair flows into publish + register inputs. The
		// artifact publisher still owns the on-chain artifacts; this
		// local state only persists key material.
		const keypair: PersistedBlsKeypair = yield* runSealKeygen(deps.runtime, opts.name, cargoImage);

		// ---- render config + stage master-key -------------------
		// Distilled-doc invariant #19 — `network: !Devnet` is hardcoded
		// by `renderSealKeyServerConfig`. Invariant #4 — `master-key.env`
		// MUST NOT be unlinked on scope close. `stageSealConfig` does
		// NOT register a finalizer.
		const artifacts = yield* ensureLocalKeygenArtifacts(deps, opts, keypair.publicKey);
		const state = yield* stageResolvedLocalKeygenState(deps, opts, artifacts, keypair);
		return yield* startLocalKeygenContainer(deps, opts, cargoImage, state);
	}).pipe(
		Effect.catchTag('ArtifactPublishError', (err) =>
			Effect.fail(
				sealError('seal', {
					name: opts.name,
					message: `seal.local-keygen: on-chain artifact failure (${err.reason}): ${err.detail}`,
					cause: err,
				}),
			),
		),
	);
