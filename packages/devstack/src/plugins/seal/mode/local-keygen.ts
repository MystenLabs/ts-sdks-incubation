// Seal local-keygen mode — the full localnet path.
//
// Distilled-doc reference (07-seal.md §"Lifecycle / Startup —
// `sealLocalKeygen`"). Eight ordered phases:
//
//   0. Yield deps (Sui, Identity, ContainerRuntime, OCA publisher).
//   1. Image build (lifted sibling — parallel with sui's boot).
//  1a. Move source resolve (lifted sibling, conditional).
//   2. BLS keygen one-shot (real `runtime.runOneShot` against cargo
//                            image; output parsed via regex).
//   3. Publish seal Move package (via OCA primitive).
//   4. Register on-chain KeyServer (via OCA primitive).
//   5. Render config yaml + stage master-key env-file (atomic
//                                                       FileSystem
//                                                       writes).
//   6. Start long-running key-server container (real
//                                               `runtime.ensureContainer`
//                                               + exec-based ready
//                                               probe).
//   7. Project the composite's aggregate value.
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
//       lives in `composite.ts`).
//
// This is the substrate-name-LEAK boundary. Inside this file we can
// say "seal"; outside `src/plugins/seal/`, the substrate doesn't
// know seal exists.

import { Effect, FileSystem, Path, type Scope } from 'effect';

import type { ChainId } from '../../../substrate/brand.ts';
import type { ChainProbe } from '../../../contracts/chain-probe.ts';
import type { ContainerLabelTuple } from '../../../contracts/snapshotable.ts';
import type { ContainerRuntime, ImageRef } from '../../../contracts/container-runtime.ts';
import type {
	OnChainArtifactError,
	OnChainArtifactPublisher,
} from '../../../primitives/on-chain-artifact.ts';
import type { AccountValue } from '../../account/service.ts';
import { renderSealKeyServerConfig, stageSealConfig } from '../config-render.ts';
import {
	publishSealPackage,
	registerKeyServer,
	type SealObjectProbeKey,
	type SealSuiSdk,
} from '../deploy.ts';
import { sealError, type SealError } from '../errors.ts';
import { runSealKeygen, type PersistedBlsKeypair } from '../keygen.ts';
import { makeKeyManager, stubRotate } from '../key-manager.ts';
import { buildKeyServerSpec, startKeyServer, type KeyServerContainerSpec } from '../key-server.ts';
import type { SealKeyServerEntry, SealLocalKeygenResolved } from '../registry-publish.ts';
import { resolveDefaultSealCargoImage } from '../lifted-siblings/cargo-image.ts';
import { resolveDefaultSealSource } from '../lifted-siblings/source-fetch.ts';

// ---------------------------------------------------------------------------
// Options (factory-time)
// ---------------------------------------------------------------------------

/** Options the local-keygen mode accepts. Mirrors v3
 *  `SealLocalKeygenOptions` (07-seal.md §"Configuration"). The
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
 *  `sealFor.for(local).localKeygen({signer})` makes signer required). */
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
 *     `ContainerRuntimeService`, `OnChainArtifactPublisher`);
 *   - substrate-derived identifiers (chainId, servicePath,
 *     subnet, etc.);
 *   - router-resolved URL (single mint — distilled-doc invariant #1).
 *
 *  The barrel composes these from substrate services
 *  (ContainerRuntime, IdentityContext, OnChainArtifactPublisher,
 *  StackPathsService) at acquire-time. */
export interface LocalKeygenDeps {
	readonly runtime: ContainerRuntime;
	readonly publisher: OnChainArtifactPublisher;
	readonly signer: AccountValue;
	readonly sdk: SealSuiSdk;
	readonly buildImage?: ImageRef;
	readonly chainProbe: ChainProbe<SealObjectProbeKey>;
	readonly chain: ChainId;
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

// ---------------------------------------------------------------------------
// Boot pipeline
// ---------------------------------------------------------------------------

/** The composite's aggregate acquire body. Calls each phase in
 *  order; failures surface as typed `SealError` /
 *  `OnChainArtifactError` through the Effect's error channel.
 *
 *  Distilled-doc invariant #2 — phase order is keygen → publish →
 *  register → config-render → container. Any phase failure short-
 *  circuits before downstream phases (cheap on warm restart because
 *  the OnChainArtifactPublisher cache + verify covers steps 3-4). */
export const bootLocalKeygen = (
	deps: LocalKeygenDeps,
	opts: ResolvedLocalKeygenOptions,
): Effect.Effect<
	SealLocalKeygenResolved,
	SealError | OnChainArtifactError,
	Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		// ---- cargo image (lifted sibling) -----------------------
		// The cargo image's resolver honors `SEAL_CARGO_IMAGE_OVERRIDE`
		// for the pre-baked path; falls back to a documented seam error
		// pointing at the override hatch.
		const cargoImage: ImageRef = yield* resolveDefaultSealCargoImage(deps.runtime);

		// ---- move source resolve (lifted sibling, conditional) --
		// Source is only fetched when no user-pinned path is provided.
		const movePackagePath: string = opts.movePackagePath
			? opts.movePackagePath
			: yield* resolveDefaultSealSource(deps.runtime).pipe(Effect.map((s) => s.path));

		// ---- keygen (BLS12-381 master + public) -----------------
		// The keypair flows directly into the publish + register
		// passes rather than through the OCA primitive — the publisher
		// only sees the artifacts the keygen produces (packageId,
		// keyServerObjectId).
		const keypair: PersistedBlsKeypair = yield* runSealKeygen(deps.runtime, opts.name, cargoImage);

		// ---- publish seal Move package --------------------------
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

		// ---- register on-chain KeyServer ------------------------
		// Distilled-doc invariant #1 — `routedUrl` is the SAME value
		// the container's routing entry will be stamped with.
		const { objectId: keyServerObjectId } = yield* registerKeyServer(deps.publisher, {
			name: opts.name,
			chain: deps.chain,
			keyServerUrl: deps.routedUrl,
			sealPackageId: packageId,
			publicKeyHex: keypair.publicKey,
			keyServerName: opts.keyServerName,
			signer: deps.signer,
			sdk: deps.sdk,
			chainProbe: deps.chainProbe,
		});

		// ---- render config + stage master-key -------------------
		// Distilled-doc invariant #19 — `network: !Devnet` is hardcoded
		// by `renderSealKeyServerConfig`. Invariant #4 — `master-key.env`
		// MUST NOT be unlinked on scope close. `stageSealConfig` does
		// NOT register a finalizer.
		const yaml = renderSealKeyServerConfig({
			sealPackageId: packageId,
			nodeUrl: deps.suiRpcUrlInNetwork,
			keyServerObjectId,
		});
		const { configPath, masterKeyEnvFile } = yield* stageSealConfig(
			yaml,
			keypair.masterKey,
			deps.servicePath,
			opts.name,
		);
		void configPath; // referenced via servicePath assembly in the spec

		// ---- start long-running key-server container ------------
		// Distilled-doc invariants #3 (env-file via bind-mount + entrypoint
		// shell sourcing — see key-server.ts header), #5 (no host-port),
		// #7 (signal-forwarding entrypoint) encoded in `buildKeyServerSpec`
		// + `startKeyServer`.
		const spec: KeyServerContainerSpec = buildKeyServerSpec({
			name: opts.name,
			image: cargoImage,
			containerName: deps.containerName,
			labels: deps.labels,
			suiNetwork: deps.suiNetworkName,
			servicePath: deps.servicePath,
			routedHostname: deps.routedHostname,
			routedUrl: deps.routedUrl,
			readyTimeoutMs: opts.readyTimeoutMs,
		});
		const { containerName } = yield* startKeyServer(deps.runtime, spec, opts.name);
		void containerName;

		// ---- assemble the composite's aggregate value -----------
		const serverConfigs: ReadonlyArray<SealKeyServerEntry> = [
			{ objectId: keyServerObjectId, weight: 1 },
		];
		// Distilled-doc invariant #23 — `rotate` has R = never (the
		// substrate services were pre-provided when assembling the
		// rotate body). The current `stubRotate` body fails-closed
		// with a typed error; see `key-manager.ts`.
		const keyManager = makeKeyManager({
			name: opts.name,
			masterKeyEnvFile,
			rotateImpl: stubRotate(opts.name),
		});
		return {
			keyServer: {
				serverConfigs,
				keyServerUrl: deps.routedUrl,
				objectId: keyServerObjectId,
			},
			keyManager,
			packageId,
		} satisfies SealLocalKeygenResolved;
	}).pipe(
		Effect.catchTag('OnChainArtifactError', (err) =>
			Effect.fail(
				sealError('seal', {
					name: opts.name,
					message: `seal.local-keygen: on-chain artifact failure (${err.reason}): ${err.detail}`,
					cause: err,
				}),
			),
		),
		Effect.withSpan('devstack.plugin.seal.localKeygen.boot', {
			attributes: {
				'devstack.plugin': 'seal',
				'seal.name': opts.name,
				'seal.version': opts.version,
			},
		}),
	);
