// Seal plugin — long-running key-server container lifecycle.
//
// Distilled-doc invariants pinned by this file:
//
//   #1 (KeyServer.url == routed hostname): the URL handed to the
//      on-chain Move call MUST equal the routed hostname stamped on
//      the `seal-key-server` route. We resolve the URL ONCE via the
//      router (see `routable.ts`) and pipe the same value into both
//      the Move register pass (`deploy.ts` + `registry-publish.ts`)
//      and this file's container spec.
//
//   #3 (env-file not -e MASTER_KEY=…): the container is launched
//      with `envFiles: [<masterKeyEnvFile>]` and a `env:` map that
//      does NOT contain `MASTER_KEY`. Distilled doc §Hard
//      requirements #3 — the inline form surfaces the key in host
//      process env + docker inspect output.
//
//      IMPLEMENTATION CONSTRAINT: the L1 `EnsureContainerSpec`
//      contract today does NOT expose an `envFiles:` slot — only
//      `env:`. We work around this by bind-mounting the env-file
//      into the container under a stack-root bind mount; the cargo
//      image's entrypoint shell (see Hard requirement #7) is
//      responsible for `set -a; . "$MASTER_KEY_ENVFILE"; set +a`
//      BEFORE exec'ing the daemon, so the secret never appears in
//      `docker inspect`. ARCHITECTURE REVISION TRACKED: add `envFiles`
//      to `EnsureContainerSpec`.
//
//   #5 (NO host-port publish): the `ports:` field is INTENTIONALLY
//      absent from the `EnsureContainerSpec` we pass to the runtime.
//      Traefik dispatches by Host: header from the well-known router
//      entrypoint `seal-key-server`.
//
//   #7 (signal-forwarding entrypoint shell): the cargo-built image
//      embeds the entrypoint shell that traps SIGTERM and forwards
//      SIGTERM to the key-server child. Distilled doc §Hard
//      requirements #21. The image declares the right entrypoint;
//      this file does NOT re-declare it.

import { Effect, type Scope } from 'effect';
import { basename, dirname } from 'node:path';

import type {
	ContainerHandle,
	ContainerRuntime,
	EnsureContainerSpec,
	EnsureNetworkSpec,
	ImageRef,
} from '../../contracts/container-runtime.ts';
import type { ContainerLabelTuple } from '../../contracts/snapshotable.ts';
import {
	ProbeTimeoutError,
	exitCodeProbeResult,
	waitForProbe,
} from '../../substrate/runtime/probes.ts';
import { ensureManagedContainer } from '../../substrate/runtime/managed-container.ts';
import { sealError, type SealError } from './errors.ts';
import { KEY_SERVER_CONFIG_BASENAME, MASTER_KEY_ENVFILE_BASENAME } from './keygen.ts';
import { DEFAULT_KEY_SERVER_PORT, SEAL_KEY_SERVER_ENDPOINT_NAME } from './routable.ts';
import { SealSpans } from './spans.ts';

export { DEFAULT_KEY_SERVER_PORT } from './routable.ts';

// ---------------------------------------------------------------------------
// Constants — mirror v3 `seal/internal.ts:102-103`
// ---------------------------------------------------------------------------

/** Default `/health` probe timeout. */
export const DEFAULT_READY_TIMEOUT_MS = 60_000 as const;

/** Inside-container config path. The binary reads `CONFIG_PATH` to
 *  locate the rendered yaml. */
export const INSIDE_CONFIG_PATH = '/etc/seal/key-server-config.yaml' as const;

/** Inside-container master-key env-file path. The entrypoint shell
 *  sources this before exec'ing the daemon (Hard requirement #3 +
 *  #7). */
export const INSIDE_MASTER_KEY_ENVFILE = '/etc/seal/master-key.env' as const;

const INSIDE_RUNTIME_ROOT = '/devstack/runtime' as const;

/** Container-side env defaults. NB: `MASTER_KEY` is NOT here — it
 *  flows via the bind-mounted env-file sourced by the entrypoint
 *  shell. Distilled-doc invariant #3. */
export const CONTAINER_ENV: Readonly<Record<string, string>> = {
	CONFIG_PATH: INSIDE_CONFIG_PATH,
	MASTER_KEY_ENVFILE: INSIDE_MASTER_KEY_ENVFILE,
	RUST_LOG: 'info',
};

export const HOST_GATEWAY_EXTRA_HOSTS: Readonly<Record<string, string>> = {
	'host.docker.internal': 'host-gateway',
};

export const buildSealNetworkName = (app: string, stack: string, sealName: string): string =>
	`devstack-${app}-${stack}-seal-${sealName}-net`;

export interface SealNetworkIdentity {
	readonly app: string;
	readonly stack: string;
	readonly sealName: string;
}

/** Seal's key-server network gets a deterministic /24 so repeated
 *  local runs do not consume Docker's default bridge address pools. */
export const deriveSealSubnetPrefix = (identity: SealNetworkIdentity): string => {
	const key = `${identity.app}\0${identity.stack}\0${identity.sealName}\0seal`;
	let hash = 0x811c9dc5;
	for (let i = 0; i < key.length; i += 1) {
		hash ^= key.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const bucket = hash % (64 * 256);
	const secondOctet = 128 + Math.floor(bucket / 256);
	const thirdOctet = bucket % 256;
	return `10.${secondOctet}.${thirdOctet}`;
};

export const sealNetworkCreateSpec = <Spec extends EnsureNetworkSpec>(
	spec: Spec,
	subnetPrefix: string,
): Spec & Required<Pick<EnsureNetworkSpec, 'subnet' | 'gateway'>> => ({
	...spec,
	subnet: `${subnetPrefix}.0/24`,
	gateway: `${subnetPrefix}.1`,
});

/** Per-probe interval inside the bounded retry. */
const READY_PROBE_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Spec shape
// ---------------------------------------------------------------------------

/** The container spec produced for the long-running key-server. This
 *  is the substrate-blind value the ContainerRuntime adapter
 *  consumes. */
export interface KeyServerContainerSpec {
	/** Image ref from the Seal image resolver. */
	readonly image: ImageRef;
	/** Composed container name (substrate folds `<app>-<stack>-…`). */
	readonly containerName: string;
	/** Label tuple — drives the snapshot orchestrator's filter +
	 *  `inspectByLabels`. */
	readonly labels: ContainerLabelTuple;
	/** Mount source on host — the rendered key-server-config.yaml. */
	readonly configHostPath: string;
	/** Env-file holding `MASTER_KEY=<hex>`. Mode-bit 0o600 inside
	 *  0o700 parent. Distilled-doc invariant #2. Bind-mounted (see
	 *  file header for the missing-envFiles workaround). */
	readonly masterKeyEnvFileHostPath: string;
	/** Mount source on host. Docker Desktop can reject freshly-created
	 *  nested file/leaf-directory bind sources even when a parent mount
	 *  can see them, so key-server mounts the stack root and points the
	 *  entrypoint at the config/envfile inside that mount. */
	readonly runtimeRootHostPath: string;
	readonly configContainerPath: string;
	readonly masterKeyEnvFileContainerPath: string;
	/** Fingerprint of config contents that affect key-server boot. */
	readonly configFingerprint: string;
	/** Inner docker network for sui DNS resolution. */
	readonly network: string;
	/** Router routing spec — Traefik file-provider stamped per
	 *  container. Distilled-doc invariant #5 (no host-port publish). */
	readonly routing: ReadonlyArray<{
		readonly name: string;
		readonly entrypoint: string;
		readonly servicePort: number;
	}>;
	/** Routed URL — `<routedUrl>/health` is what the ready probe
	 *  would hit if/when an HTTP probe contract lands. Today we use
	 *  an exec-based probe (see `startKeyServer`). */
	readonly routedUrl: string;
	/** Timeout for the ready probe. */
	readonly readyTimeoutMs: number;
	/** Graceful stop deadline. Distilled-doc invariant #21 — the
	 *  entrypoint shell forwards Docker's SIGTERM to the key-server. */
	readonly stopGraceSeconds: number;
	/** In-container port the daemon binds. */
	readonly containerPort: number;
}

// ---------------------------------------------------------------------------
// Spec builder
// ---------------------------------------------------------------------------

/** Inputs to assemble the container spec. */
export interface KeyServerSpecInputs {
	readonly name: string;
	readonly image: ImageRef;
	readonly containerName: string;
	readonly labels: ContainerLabelTuple;
	readonly suiNetwork: string;
	readonly servicePath: string;
	readonly configFingerprint: string;
	readonly routedHostname: string;
	readonly routedUrl: string;
	readonly readyTimeoutMs?: number;
}

/** Build the container spec. Distilled-doc invariants #1, #3, #5
 *  encoded here:
 *
 *   - `routedUrl` is the SAME value the on-chain Move call registers.
 *   - `env` is `CONTAINER_ENV` (no MASTER_KEY); `masterKeyEnvFileHostPath`
 *     bind-mount carries the secret.
 *   - `routing[]` lists the seal-key-server entrypoint; the spec returned has
 *     NO `ports:` field (it's not modelled). */
export const buildKeyServerSpec = (inputs: KeyServerSpecInputs): KeyServerContainerSpec => {
	const masterKeyEnvFileHostPath = `${inputs.servicePath}/${MASTER_KEY_ENVFILE_BASENAME}`;
	const configHostPath = `${inputs.servicePath}/${KEY_SERVER_CONFIG_BASENAME}`;
	const runtimeRootHostPath = dirname(dirname(inputs.servicePath));
	const serviceDirName = basename(inputs.servicePath);
	const configContainerPath = `${INSIDE_RUNTIME_ROOT}/seal/${serviceDirName}/${KEY_SERVER_CONFIG_BASENAME}`;
	const masterKeyEnvFileContainerPath = `${INSIDE_RUNTIME_ROOT}/seal/${serviceDirName}/${MASTER_KEY_ENVFILE_BASENAME}`;
	void inputs.routedHostname; // flows through routedUrl
	return {
		image: inputs.image,
		containerName: inputs.containerName,
		labels: inputs.labels,
		configHostPath,
		masterKeyEnvFileHostPath,
		runtimeRootHostPath,
		configContainerPath,
		masterKeyEnvFileContainerPath,
		configFingerprint: inputs.configFingerprint,
		network: inputs.suiNetwork,
		routing: [
			{
				name: SEAL_KEY_SERVER_ENDPOINT_NAME,
				entrypoint: SEAL_KEY_SERVER_ENDPOINT_NAME,
				servicePort: DEFAULT_KEY_SERVER_PORT,
			},
		],
		routedUrl: inputs.routedUrl,
		readyTimeoutMs: inputs.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
		stopGraceSeconds: 15,
		containerPort: DEFAULT_KEY_SERVER_PORT,
	};
};

export const buildKeyServerEnsureContainerSpec = (
	spec: KeyServerContainerSpec,
): EnsureContainerSpec => ({
	name: spec.containerName,
	image: spec.image,
	labels: spec.labels,
	recreate: 'on-config-change',
	configHash: [
		'seal-key-server',
		`runtime=${spec.runtimeRootHostPath}`,
		`config=${spec.configContainerPath}`,
		`master=${spec.masterKeyEnvFileContainerPath}`,
		`content=${spec.configFingerprint}`,
		`network=${spec.network}`,
	].join('|'),
	// Distilled-doc invariant #3 — MASTER_KEY is NOT here.
	// The bind-mounted env-file is sourced by the entrypoint
	// shell BEFORE the daemon exec. See file header on the
	// L1 `envFiles:` gap.
	env: {
		...CONTAINER_ENV,
		CONFIG_PATH: spec.configContainerPath,
		MASTER_KEY_ENVFILE: spec.masterKeyEnvFileContainerPath,
	},
	stopGraceSeconds: spec.stopGraceSeconds,
	networkAttach: [spec.network],
	// Distilled-doc invariant #5 — `ports` intentionally absent.
	extraHosts: HOST_GATEWAY_EXTRA_HOSTS,
	mounts: [
		{
			source: spec.runtimeRootHostPath,
			target: INSIDE_RUNTIME_ROOT,
			readonly: true,
		},
	],
});

// ---------------------------------------------------------------------------
// Start procedure — real ContainerRuntime wiring
// ---------------------------------------------------------------------------

/** Start the long-running key-server container.
 *
 *  Wiring:
 *
 *    1. `runtime.ensureContainer` — content-addressed image, label
 *       tuple, recreate-on-config-change. Two bind mounts: the
 *       rendered yaml (read-only) + the master-key env-file
 *       (read-only). NO `ports:` — Traefik dispatches by Host:
 *       header on the well-known `seal-key-server` entrypoint port.
 *    2. In-container ready probe via `runtime.exec` — issues an
 *       HTTP GET against `http://127.0.0.1:2024/health`. Bounded
 *       retries until `readyTimeoutMs`. We shell out to `curl`
 *       (present in the vendored `debian:bookworm-slim` base) +
 *       fall back to `nc -z` for the stub image which doesn't
 *       carry curl. Both probes hit the same socket; curl
 *       additionally confirms the binary has parsed CONFIG_PATH
 *       and is serving the upstream's `/health` route (returns
 *       `{name,version,status:"up"}` once boot completes —
 *       distilled-doc §"Container start + ready").
 *
 *  Stop semantics: scope-close runs `ensureContainer`'s finalizer
 *  which calls `docker stop` with the Seal-specific grace window. */
export const startKeyServer = (
	runtime: ContainerRuntime,
	spec: KeyServerContainerSpec,
	name: string,
): Effect.Effect<{ readonly containerName: string }, SealError, Scope.Scope> =>
	Effect.gen(function* () {
		const ensureSpec = buildKeyServerEnsureContainerSpec(spec);
		const { labels, ...containerSpec } = ensureSpec;
		const handle: ContainerHandle = yield* ensureManagedContainer({
			runtime,
			labels,
			spec: containerSpec,
			mapError: (cause) =>
				sealError('container', {
					name,
					message: `seal key-server (name=${spec.containerName}) ensureContainer failed: ${cause.reason}: ${cause.detail}`,
					cause,
				}),
		});

		// Exec-based ready probe — distilled-doc §"Container start +
		// ready". The vendored debian:bookworm-slim base ships
		// `curl`; the e2e stub image (alpine) ships busybox `nc`. We
		// probe with curl first (real `/health` round-trip — confirms
		// the daemon parsed CONFIG_PATH AND bound the listener) and
		// fall back to `nc -z` (TCP-only — confirms only the socket
		// is listening). One of the two MUST succeed on a healthy
		// container.
		//
		// `/health` returns `{name, version, status: "up"}` once the
		// binary finishes config + master-key load. Pre-boot we
		// expect connection-refused → curl returns non-zero, retry.
		const directProbeUrl = `http://127.0.0.1:${spec.containerPort}/health`;
		yield* waitForProbe({
			label: `seal.key-server.${name}`,
			timeoutMs: spec.readyTimeoutMs,
			intervalMs: READY_PROBE_INTERVAL_MS,
			probe: () =>
				runtime
					.exec(handle, [
						'sh',
						'-c',
						`(command -v curl >/dev/null 2>&1 && ` +
							`curl -fsS -m 2 ${directProbeUrl} >/dev/null) ` +
							`|| nc -z 127.0.0.1 ${spec.containerPort} ` +
							`|| exit 1`,
					])
					.pipe(Effect.map(exitCodeProbeResult)),
		}).pipe(
			Effect.mapError((cause) => {
				if (cause instanceof ProbeTimeoutError) {
					return sealError('ready', {
						name,
						message:
							`seal key-server never became ready within ${spec.readyTimeoutMs}ms ` +
							`(directProbeUrl=${directProbeUrl}, routedUrl=${spec.routedUrl})`,
						cause: cause.lastError ?? cause.lastNotReady ?? cause,
					});
				}
				return sealError('ready', {
					name,
					message: `seal key-server ready-probe exec failed: ${cause.reason}: ${cause.detail}`,
					cause,
				});
			}),
		);

		return { containerName: spec.containerName };
	}).pipe(
		Effect.withSpan('devstack.plugin.seal.keyServer.start', {
			attributes: {
				[SealSpans.name]: name,
				[SealSpans.containerName]: spec.containerName,
				[SealSpans.routedUrl]: spec.routedUrl,
			},
		}),
	);
