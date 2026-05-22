// Walrus deploy one-shot — Move publish via ArtifactPublisher.
//
// Distilled-doc reference (06-walrus.md §"Lifecycle phase 2"):
// the `walrus-deploy` one-shot:
//   - publishes the Walrus Move package on the local sui chain,
//   - mints a WAL exchange,
//   - emits per-node config files (`dryrun-node-<i>.yaml`,
//     `dryrun-node-<i>.keystore`) under `runtime/walrus/<name>/deploy/`.
//
// We route this through the substrate's `ArtifactPublisher`
// primitive (architecture §10 — "callable from any plugin; no
// plugin-side contract to implement"). The publisher owns:
//   - cache key derivation (folds `chainId`),
//   - verify probe (lenient — re-derives on transient RPC failure),
//   - produce-on-miss (runs `walrus-deploy`),
//   - register-on-every-cycle (so downstream consumers always see
//     the resolved state).
//
// Distilled-doc invariants honored here:
//   - 5: cache key folds `chainId`.
//   - 6: verify checks BOTH the on-disk `deploy` file AND on-chain
//        object existence (system + staking). Either failure
//        invalidates and re-deploys.
//   - 7: `runtime/walrus/<name>/deploy/` rides the snapshot tar
//        (declared via `Snapshotable.subtrees` in `snapshot.ts`).
//   - 10: deploy summary must contain `package_id` + `system_object`
//        + `staking_object`. We surface parse failure as
//        `WalrusPluginError{phase: 'deploy'}` (the publisher's
//        `produce-failed` reason).

import { Duration, Effect, Schema, type Scope } from 'effect';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ContainerRuntime, ImageRef } from '../../contracts/container-runtime.ts';
import type {
	ArtifactPublishError,
	ArtifactPublisher,
} from '../../primitives/artifact-publisher.ts';
import type { ChainProbe } from '../../contracts/chain-probe.ts';
import type { ChainId, ContentHash } from '../../substrate/brand.ts';
import type { SuiProbeKey } from '../sui/chain-probe.ts';
import { walrusDeployMountPaths } from './deploy-paths.ts';
import { walrusPluginError, type WalrusPluginError } from './errors.ts';

/** Cache-stored payload — what verify re-confirms on every cycle.
 *  Mirrors the v3 `CachedDeployState` shape (06-walrus.md §"State-
 *  store entries"). */
export interface CachedDeployState {
	readonly walrusPackageId: string;
	readonly systemObject: string;
	readonly stakingObject: string;
	readonly upgradeManagerObject?: string;
	readonly treasuryObject?: string;
	readonly exchangeObject?: string;
}

/** Verify-schema: the publisher decodes the cached id's on-chain
 *  object through this. Minimal — the substrate's `ChainProbe`
 *  decodes against this; any decode failure surfaces structured.
 *  Distilled-doc invariant 8: the probe MUST consume a stable
 *  identifier (the object id), NOT a derived hash. */
export const WalrusDeployVerifyShape = Schema.Struct({
	systemObjectId: Schema.String,
	stakingObjectId: Schema.String,
});
export type WalrusDeployVerified = Schema.Schema.Type<typeof WalrusDeployVerifyShape>;

const SuiObjectExistsShape = Schema.Struct({
	objectId: Schema.String,
});

const requiredDeployOutputFiles = (inputs: DeployInputs): ReadonlyArray<string> => [
	join(inputs.outputDirHostPath, 'deploy'),
	...Array.from({ length: inputs.committeeSize }, (_, nodeIndex) => [
		join(inputs.outputDirHostPath, `dryrun-node-${nodeIndex}.yaml`),
		join(inputs.outputDirHostPath, `dryrun-node-${nodeIndex}-sui.yaml`),
		join(inputs.outputDirHostPath, `dryrun-node-${nodeIndex}.keystore`),
	]).flat(),
];

const deployOutputFilesComplete = (
	inputs: DeployInputs,
): Effect.Effect<boolean, WalrusPluginError> =>
	Effect.tryPromise({
		try: async () => {
			await Promise.all(requiredDeployOutputFiles(inputs).map((file) => access(file)));
			return true;
		},
		catch: (cause) =>
			walrusPluginError(
				'deploy',
				`walrus deploy cache is missing local output files under ${inputs.outputDirHostPath}`,
				{ cause },
			),
	}).pipe(Effect.catch(() => Effect.succeed(false)));

/** Inputs to one deploy round. */
export interface DeployInputs {
	readonly walrusName: string;
	readonly chainId: ChainId;
	readonly contentHash: ContentHash;
	/** Pre-derived host output dir — substrate's `servicePath('walrus',
	 *  name, 'deploy')` equivalent. Persists across teardown
	 *  (distilled-doc §"What survives teardown"). */
	readonly outputDirHostPath: string;
	readonly suiRpcUrlInNetwork: string;
	readonly walrusFaucetUrlInNetwork: string;
	readonly committeeSize: number;
	readonly shards: number;
	readonly epochDuration: string;
	readonly publicHostsCsv: string;
	readonly listeningIpsCsv: string;
	/** Wrapper image — the cargo-built walrus image (bootstrap asset).
	 *  The deploy one-shot is `docker run --rm <image> deploy …`. */
	readonly walrusImage: ImageRef;
	/** Docker network the deploy one-shot attaches to, so its in-network
	 *  Sui RPC + faucet hostnames resolve. */
	readonly suiNetworkName: string;
	/** Centralized Sui funding readiness gate. Local Sui exposes this so
	 *  callers don't race the faucet's socket-ready / funds-ready gap. */
	readonly waitForFundsReady?: Effect.Effect<void, unknown>;
}

/** Default deploy one-shot timeout. Walrus genesis publish runs the
 *  Move publish + WAL exchange creation + per-node config emission;
 *  observed wall-clock is 30-60s. 5-minute ceiling absorbs cold-cache
 *  + slow CI runners. */
const DEPLOY_TIMEOUT_MS = 5 * 60_000;
const DEPLOY_BIND_SOURCE_RETRY_ATTEMPTS = 10;
const DEPLOY_BIND_SOURCE_RETRY_DELAY_MS = 500;

const ensureDeployOutputDir = (inputs: DeployInputs): Effect.Effect<void, WalrusPluginError> =>
	Effect.tryPromise({
		try: async () => {
			await mkdir(inputs.outputDirHostPath, { recursive: true });
			await writeFile(
				join(inputs.outputDirHostPath, '.devstack-bind-source'),
				'devstack walrus bind source\n',
				'utf8',
			);
		},
		catch: (cause) =>
			walrusPluginError(
				'deploy',
				`walrus deploy failed to prepare output directory ${inputs.outputDirHostPath}`,
				{ cause },
			),
	});

const hostBindMountOwner = (): string | undefined => {
	const process = (
		globalThis as {
			process?: { getuid?: () => number; getgid?: () => number };
		}
	).process;
	if (typeof process?.getuid !== 'function' || typeof process.getgid !== 'function') {
		return undefined;
	}
	return `${process.getuid()}:${process.getgid()}`;
};

const excerpt = (label: string, value: string): string => {
	const trimmed = value.trim();
	if (trimmed.length === 0) return '';
	const max = 2_400;
	const body =
		trimmed.length > max
			? `${trimmed.slice(0, 1_100)}...<truncated ${trimmed.length - 2_200} chars>...${trimmed.slice(-1_100)}`
			: trimmed;
	return ` ${label}=${JSON.stringify(body)}`;
};

const deployExitDetail = (
	result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
	inputs: DeployInputs,
): string => {
	const missingCommandHint =
		result.exitCode === 127
			? ' exit 127 usually means the deploy image is missing walrus-deploy or an entrypoint command.'
			: '';
	return (
		`walrus deploy exited with code ${result.exitCode}.` +
		missingCommandHint +
		` outputDir=${inputs.outputDirHostPath} committee=${inputs.committeeSize} shards=${inputs.shards}` +
		excerpt('stdout', result.stdout) +
		excerpt('stderr', result.stderr)
	);
};

const isBindSourceMissing = (result: {
	readonly exitCode: number;
	readonly stderr: string;
}): boolean =>
	result.exitCode === 125 &&
	/bind source path does not exist/i.test(result.stderr) &&
	/invalid mount config/i.test(result.stderr);

const stringifyCause = (cause: unknown): string => {
	if (cause instanceof Error) return cause.message;
	if (typeof cause === 'string') return cause;
	try {
		return JSON.stringify(cause);
	} catch {
		return String(cause);
	}
};

/** Parse the walrus deploy output into a `CachedDeployState`.
 *
 *  Expected output format (best-effort match against the v3 reference's
 *  deploy stdout — the walrus binary's exact format may drift between
 *  versions):
 *
 *    walrus_package_id: 0x<hex>
 *    system_object: 0x<hex>
 *    staking_object: 0x<hex>
 *    upgrade_manager_object: 0x<hex>      (optional)
 *    treasury_object: 0x<hex>             (optional)
 *    exchange_object: 0x<hex>             (optional)
 *
 *  Returns the parsed state OR a typed `WalrusPluginError('deploy')`
 *  surfaced with stdout/stderr capture for debugging. */
export const parseDeployOutput = (stdout: string): CachedDeployState | null => {
	// Match `key: value` (or `key = value`) lines; treat `None` as
	// "absent" per the upstream walrus-deploy output convention. The
	// pattern is permissive on the value (`\S+`) — walrus-deploy
	// versions have varied on the exact hex format, and the substrate's
	// downstream `ChainProbe` re-validates the id shape anyway.
	const pick = (k: string): string | undefined => {
		const re = new RegExp(`(?:^|\\n)\\s*${k}\\s*[:=]\\s*(\\S+)`);
		const m = re.exec(stdout);
		const v = m?.[1];
		if (v === undefined || v === 'None') return undefined;
		return v;
	};
	const walrusPackageId = pick('walrus_package_id') ?? pick('package_id');
	const systemObject = pick('system_object') ?? pick('system_object_id');
	const stakingObject =
		pick('staking_object') ?? pick('staking_pool_id') ?? pick('staking_object_id');
	if (!walrusPackageId || !systemObject || !stakingObject) return null;
	return {
		walrusPackageId,
		systemObject,
		stakingObject,
		upgradeManagerObject: pick('upgrade_manager_object'),
		treasuryObject: pick('treasury_object'),
		exchangeObject: pick('exchange_object'),
	};
};

/** Run the walrus-deploy one-shot and parse the output.
 *
 *  Implementation:
 *    1. `runtime.runOneShot({ image, argv: ['deploy', ...] })` —
 *       fresh `docker run --rm` container. Mount the host output dir
 *       at `/opt/walrus/outputs` so the per-node config files persist.
 *    2. Parse stdout for the deploy summary.
 *    3. Surface non-zero exits + parse failures as
 *       `WalrusPluginError('deploy')` with stdout/stderr capture. */
export const runDeployOneShot = (
	runtime: ContainerRuntime,
	inputs: DeployInputs,
): Effect.Effect<CachedDeployState, WalrusPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		if (inputs.waitForFundsReady !== undefined) {
			yield* inputs.waitForFundsReady.pipe(
				Effect.mapError((cause) =>
					walrusPluginError(
						'deploy',
						`walrus deploy funding gate failed before walrus-deploy: ${stringifyCause(cause)}`,
						{ cause },
					),
				),
			);
		}
		yield* ensureDeployOutputDir(inputs);

		const outputOwner = hostBindMountOwner();
		const outputMount = walrusDeployMountPaths(inputs.outputDirHostPath, '/opt/walrus/runtime');
		const argv: ReadonlyArray<string> = [
			'deploy',
			'--output-dir',
			outputMount.outputDirInContainer,
			'--committee-size',
			String(inputs.committeeSize),
			'--shards',
			String(inputs.shards),
			'--epoch-duration',
			inputs.epochDuration,
			'--sui-rpc-url',
			inputs.suiRpcUrlInNetwork,
			'--faucet-url',
			inputs.walrusFaucetUrlInNetwork,
			'--public-hosts',
			inputs.publicHostsCsv,
			'--listening-ips',
			inputs.listeningIpsCsv,
		];

		const runAttempt = () =>
			runtime
				.runOneShot({
					image: inputs.walrusImage,
					argv,
					mounts: [
						{
							source: outputMount.sourceHostPath,
							target: outputMount.mountTarget,
						},
					],
					...(outputOwner === undefined ? {} : { env: { DEVSTACK_HOST_UID_GID: outputOwner } }),
					network: inputs.suiNetworkName,
					// Same `host-gateway` rationale as storage-nodes.ts —
					// deploy one-shot dials sui's host-bound RPC + faucet via
					// `host.docker.internal`. Native Linux Docker needs the
					// explicit mapping; Docker Desktop is a no-op.
					extraHosts: { 'host.docker.internal': 'host-gateway' },
					timeoutMillis: DEPLOY_TIMEOUT_MS,
				})
				.pipe(
					Effect.catch((cause) =>
						Effect.fail(
							walrusPluginError(
								'deploy',
								`walrus deploy one-shot failed: ${cause.reason}: ${cause.detail}`,
								{ cause },
							),
						),
					),
				);

		let result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
		for (let attempt = 0; ; attempt += 1) {
			result = yield* runAttempt();
			if (!isBindSourceMissing(result) || attempt >= DEPLOY_BIND_SOURCE_RETRY_ATTEMPTS) break;
			yield* ensureDeployOutputDir(inputs);
			yield* Effect.sleep(Duration.millis(DEPLOY_BIND_SOURCE_RETRY_DELAY_MS));
		}

		if (result.exitCode !== 0) {
			return yield* Effect.fail(
				walrusPluginError('deploy', deployExitDetail(result, inputs), {
					exitCode: result.exitCode,
					stdout: result.stdout,
					stderr: result.stderr,
				}),
			);
		}

		const parsed = parseDeployOutput(result.stdout);
		if (!parsed) {
			return yield* Effect.fail(
				walrusPluginError(
					'deploy',
					`walrus deploy: parser could not find walrus_package_id / system_object / staking_object ` +
						`in deploy output. Confirm the walrus binary's output format and adjust ` +
						`\`parseDeployOutput\` regexes in deploy.ts. ` +
						`SEAM: see deploy.ts header for the expected format.`,
					{ stdout: result.stdout, stderr: result.stderr },
				),
			);
		}
		return parsed;
	}).pipe(
		Effect.withSpan('devstack.plugin.walrus.deploy.oneShot', {
			attributes: { 'walrus.committeeSize': inputs.committeeSize, 'walrus.shards': inputs.shards },
		}),
		Effect.timeoutOrElse({
			duration: Duration.millis(DEPLOY_TIMEOUT_MS + 5_000),
			orElse: () =>
				Effect.fail(
					walrusPluginError(
						'deploy',
						`walrus deploy: outer timeout ${DEPLOY_TIMEOUT_MS}ms exceeded`,
					),
				),
		}),
	);

/** Outputs of one deploy round — surfaced to the plugin's
 *  resolved value. */
export interface DeployOutputs {
	readonly state: CachedDeployState;
}

/** Compose the ArtifactSpec for a walrus deploy and dispatch
 *  through the substrate primitive. The publisher handles the full
 *  cache/verify/produce/register loop.
 *
 *  Produce: real wiring — `runDeployOneShot` runs
 *  `docker run --rm walrusImage deploy …` and parses the deploy stdout.
 *
 *  Verify-hit projection: the artifact publisher primitive returns the cached
 *  `Produced` payload after verify succeeds, so callers keep the full
 *  `CachedDeployState` shape across warm restarts. */
export const deployWalrusContracts = (
	publisher: ArtifactPublisher,
	probe: ChainProbe<SuiProbeKey>,
	runtime: ContainerRuntime,
	inputs: DeployInputs,
): Effect.Effect<DeployOutputs, WalrusPluginError | ArtifactPublishError, Scope.Scope> =>
	Effect.gen(function* () {
		const verified = yield* publisher.publish<CachedDeployState, WalrusDeployVerified>({
			namespace: 'walrus-deploy',
			chain: inputs.chainId,
			contentHash: inputs.contentHash,
			verifySchema: WalrusDeployVerifyShape,
			// Verify: lenient probes of the cached system + staking
			// objects. The Sui chain probe decodes raw `getObject`
			// responses, so the probe schema matches that envelope and
			// this closure returns the compact verified shape.
			verify: (cached) =>
				Effect.gen(function* () {
					if (!(yield* deployOutputFilesComplete(inputs))) return null;

					const system = yield* probe.get(
						{ kind: 'object', objectId: cached.systemObject },
						SuiObjectExistsShape,
						'lenient',
					);
					if (system === null) return null;

					const staking = yield* probe.get(
						{ kind: 'object', objectId: cached.stakingObject },
						SuiObjectExistsShape,
						'lenient',
					);
					if (staking === null) return null;

					return {
						systemObjectId: system.objectId,
						stakingObjectId: staking.objectId,
					} satisfies WalrusDeployVerified;
				}).pipe(Effect.catch(() => Effect.succeed(null as WalrusDeployVerified | null))),
			// Produce: real walrus-deploy one-shot.
			produce: runDeployOneShot(runtime, inputs).pipe(
				Effect.mapError(
					(err): ArtifactPublishError => ({
						_tag: 'ArtifactPublishError',
						reason: 'produce-failed',
						detail: `walrus.deploy ${err.phase}: ${err.message}`,
					}),
				),
			),
			// Register: fires on EVERY cycle. The plugin's outer body
			// performs the walrus-state / endpoint / package registry
			// publishes after both deploy + storage-nodes are up; this
			// closure is the publisher-side null-op so the substrate
			// satisfies its Invariant-6 contract.
			register: () => Effect.void,
		});

		// Project Produced ∪ Verified onto CachedDeployState. artifact publisher returns
		// the cached Produced payload on verify-hit, but keep a defensive
		// projection for custom publisher implementations in tests.
		const state: CachedDeployState =
			'walrusPackageId' in verified
				? verified
				: {
						// Verify-hit path: synthesize from the cached id's.
						// The richer fields (packageId, exchange etc.) live
						// in the on-disk artifact publisher cache; downstream consumers
						// surface them through the in-process registry. The
						// artifact publisher primitive's next API revision will hand the
						// full Produced payload back here directly —
						// architecture revision tracked in the file header.
						walrusPackageId: '<cache-hit-not-rehydrated>',
						systemObject: verified.systemObjectId,
						stakingObject: verified.stakingObjectId,
					};

		return { state };
	}).pipe(
		Effect.withSpan('devstack.plugin.walrus.deploy', {
			attributes: { 'walrus.name': inputs.walrusName, 'walrus.chain': inputs.chainId },
		}),
	);
