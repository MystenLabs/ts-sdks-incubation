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
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ContainerRuntime, ImageRef } from '../../contracts/container-runtime.ts';
import {
	artifactPublishError,
	type ArtifactPublishError,
	type ArtifactPublisher,
} from '../../primitives/artifact-publisher.ts';
import type { ChainProbe } from '../../contracts/chain-probe.ts';
import type { ContentHash } from '../../substrate/brand.ts';
import { atomicWriteFileSync } from '../../substrate/runtime/atomic-write.ts';
import { hostBindMountOwner } from '../../substrate/runtime/host-bind-mount-owner.ts';
import { HOST_GATEWAY_EXTRA_HOSTS } from '../../substrate/runtime/host-gateway.ts';
import { probeManyLenient } from '../../substrate/runtime/probes.ts';
import {
	DEPLOY_BIND_SOURCE_RETRY_PROFILE,
	makeSpacedRetrySchedule,
} from '../../substrate/runtime/retry-policy.ts';
import { formatUnknownError } from '../../substrate/runtime/format-unknown-error.ts';
import { labelledExcerpt } from '../../substrate/runtime/observability/index.ts';
import type { SuiProbeKey } from '../sui/index.ts';
import { walrusDeployMountPaths } from './deploy-paths.ts';
import { walrusPluginError, type WalrusPluginError } from './errors.ts';
import { WalrusSpans } from './spans.ts';

/** Cache-stored payload — what verify re-confirms on every cycle
 *  (06-walrus.md §"State-store entries"). */
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

/** Short readiness tolerance for a transient not-found on the cached
 *  deploy objects (sui/system/staking).
 *
 *  The big post-restore catch-up window — `sui start` re-executes its
 *  committed checkpoint store from seq=0, and `getObject(systemObject)`
 *  reads not-found until the replay reaches the object's checkpoint — is
 *  now absorbed by the sui plugin's caught-up-to-head ready-gate
 *  (`waitForCheckpointCatchUp` in plugins/sui/mode/local.ts): the
 *  validator does not report ready until its head has stabilized to live
 *  cadence, so by the time this verify runs the committed deploy objects
 *  are already served. This budget only needs to cover the small RPC
 *  index-visibility lag, NOT the whole replay.
 *
 *  If it gives up too soon it reads the objects as not-found and triggers
 *  a SPURIOUS redeploy, which mints FRESH walrus ids and orphans every
 *  pre-snapshot blob (the snapshot-survival-matrix walrus-S2 failure:
 *  "Too many failures while writing blob to nodes"). A genuinely-wiped
 *  chain still redeploys once the budget lapses.
 *
 *  Budget: 5 probes × 3s = 15s. */
const WALRUS_DEPLOY_VERIFY_READINESS_RETRIES = 5;
const WALRUS_DEPLOY_VERIFY_READINESS_DELAY = '3 seconds';

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
	readonly chainId: string;
	readonly contentHash: ContentHash;
	/** Pre-derived host output dir — substrate's `servicePath('walrus',
	 *  name, 'deploy')` equivalent. Persists across teardown
	 *  (distilled-doc §"What survives teardown"). */
	readonly outputDirHostPath: string;
	/** On-disk per-stack root from `StackPathsService.stackRoot`. The
	 *  bind-mount source is `stackRoot`; `outputDirHostPath` MUST be a
	 *  descendant. Threaded explicitly to remove the previous
	 *  `dirname(dirname(dirname(...)))` walk-up footgun in
	 *  `walrusDeployMountPaths`. */
	readonly stackRoot: string;
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

const ensureDeployOutputDir = (inputs: DeployInputs): Effect.Effect<void, WalrusPluginError> =>
	Effect.tryPromise({
		try: async () => {
			await mkdir(inputs.outputDirHostPath, { recursive: true });
			// Route the bind-source marker through the canonical atomic
			// primitive (STYLE_GUIDE §17) — tempfile + fsync + rename so a
			// crashed writer can't leave the bind-mount probe reading a
			// half-written marker. 0o644 so the in-container deploy user can
			// stat it. Sync variant: the marker is a tiny one-liner and it
			// keeps the durability boundary the raw `writeFile` lacked.
			atomicWriteFileSync(
				join(inputs.outputDirHostPath, '.devstack-bind-source'),
				'devstack walrus bind source\n',
				{ mode: 0o644 },
			);
		},
		catch: (cause) =>
			walrusPluginError(
				'deploy',
				`walrus deploy failed to prepare output directory ${inputs.outputDirHostPath}`,
				{ cause },
			),
	});

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
		labelledExcerpt('stdout', result.stdout) +
		labelledExcerpt('stderr', result.stderr)
	);
};

const isBindSourceMissing = (result: {
	readonly exitCode: number;
	readonly stderr: string;
}): boolean =>
	result.exitCode === 125 &&
	/bind source path does not exist/i.test(result.stderr) &&
	/invalid mount config/i.test(result.stderr);

/** Parse the walrus deploy output into a `CachedDeployState`.
 *
 *  Expected output format (best-effort match against the walrus
 *  binary's deploy stdout — its exact format may drift between
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
	// "absent" per the upstream walrus-deploy output convention.
	//
	// Value pattern: `0x<hex>` strictly. The previous `\S+` regex
	// happily matched values like `None,` (with a trailing comma) or
	// `[unset]` and passed them through as fake object ids; downstream
	// `ChainProbe.get(...)` would then issue a `getObject` against
	// garbage, surfacing a confusing "object not found" instead of a
	// parse failure. Enforcing the hex shape here makes the parse-
	// failure surface (`walrusPluginError('deploy', 'parser could not
	// find ...')`) catch the bad value at its real source.
	const pick = (k: string): string | undefined => {
		const re = new RegExp(`(?:^|\\n)\\s*${k}\\s*[:=]\\s*(\\S+)`);
		const m = re.exec(stdout);
		const v = m?.[1];
		if (v === undefined || v === 'None') return undefined;
		if (!/^0x[0-9a-fA-F]+$/u.test(v)) return undefined;
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
						`walrus deploy funding gate failed before walrus-deploy: ${formatUnknownError(cause)}`,
						{ cause },
					),
				),
			);
		}
		yield* ensureDeployOutputDir(inputs);

		const outputOwner = hostBindMountOwner();
		const outputMount = walrusDeployMountPaths({
			stackRoot: inputs.stackRoot,
			deployOutputDirHostPath: inputs.outputDirHostPath,
			mountTarget: '/opt/walrus/runtime',
		});
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
					// `host.docker.internal`. See substrate/runtime/host-gateway.ts
					// for the platform rationale.
					extraHosts: HOST_GATEWAY_EXTRA_HOSTS,
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

		const attempt = Effect.gen(function* () {
			const result = yield* runAttempt();
			if (isBindSourceMissing(result)) {
				yield* ensureDeployOutputDir(inputs);
			}
			return result;
		});
		const result = yield* attempt.pipe(
			Effect.repeat({
				schedule: makeSpacedRetrySchedule(
					DEPLOY_BIND_SOURCE_RETRY_PROFILE.delayMs,
					DEPLOY_BIND_SOURCE_RETRY_PROFILE.attempts,
				),
				until: (r) => !isBindSourceMissing(r),
			}),
		);

		// `Effect.repeat` with a bounded `schedule` + `until` exits SUCCESS
		// in two cases: (a) `until(r)` returned true (bind source is now
		// visible — the happy path) OR (b) the schedule recurrence cap was
		// reached while `until(r)` still returned false (the bind source
		// remained missing through every retry). The follow-up
		// `result.exitCode !== 0` check below would already surface case
		// (b) as a deploy-failure exit, but the failure message would be
		// the bind-source stderr — not the more diagnostic "we exhausted
		// the bind-source retry budget" message. Surface that explicitly
		// here so operators see the retry budget in the failure shape.
		if (isBindSourceMissing(result)) {
			return yield* Effect.fail(
				walrusPluginError(
					'deploy',
					`walrus deploy: bind-source visibility race did not resolve after ` +
						`${DEPLOY_BIND_SOURCE_RETRY_PROFILE.attempts} retries ` +
						`(${DEPLOY_BIND_SOURCE_RETRY_PROFILE.delayMs}ms spacing). ` +
						`outputDir=${inputs.outputDirHostPath} — Docker Desktop's bind-source ` +
						`propagation lagged past the retry budget. ` +
						deployExitDetail(result, inputs),
					{
						exitCode: result.exitCode,
						stdout: result.stdout,
						stderr: result.stderr,
					},
				),
			);
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
			attributes: {
				[WalrusSpans.committeeSize]: inputs.committeeSize,
				[WalrusSpans.shards]: inputs.shards,
			},
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
 *  The substrate's `ArtifactPublisher.publish` returns the full
 *  `CachedDeployState` on EVERY path (decoded cached payload on hit,
 *  fresh produce on miss) — no projection dance required. */
export const deployWalrusContracts = (
	publisher: ArtifactPublisher,
	probe: ChainProbe<SuiProbeKey>,
	runtime: ContainerRuntime,
	inputs: DeployInputs,
): Effect.Effect<DeployOutputs, WalrusPluginError | ArtifactPublishError, Scope.Scope> =>
	Effect.gen(function* () {
		const state = yield* publisher.publish<CachedDeployState, WalrusDeployVerified>({
			namespace: 'walrus-deploy',
			chain: inputs.chainId,
			contentHash: inputs.contentHash,
			// Verify: lenient probes of the cached system + staking
			// objects. The Sui chain probe decodes raw `getObject`
			// responses, so the probe schema matches that envelope and
			// this closure returns the compact verified shape.
			verify: (cached) =>
				Effect.gen(function* () {
					if (!(yield* deployOutputFilesComplete(inputs))) return null;

					// Both cached on-chain objects are independent lenient
					// probes — fan them out via `probeManyLenient` so the
					// substrate owns the iteration shape. Any null means
					// "re-deploy"; both non-null gives us the composite
					// verified payload. The short retry (see the constants
					// above) only covers RPC index-visibility lag — the
					// validator's post-restore catch-up is already gated by
					// the sui plugin's caught-up-to-head ready-gate — so a
					// transient not-found doesn't force a spurious redeploy.
					const probeBoth = probeManyLenient([
						probe.get(
							{ kind: 'object', objectId: cached.systemObject },
							SuiObjectExistsShape,
							'lenient',
						),
						probe.get(
							{ kind: 'object', objectId: cached.stakingObject },
							SuiObjectExistsShape,
							'lenient',
						),
					]);
					let [system, staking] = yield* probeBoth;
					for (
						let attempt = 0;
						(system == null || staking == null) && attempt < WALRUS_DEPLOY_VERIFY_READINESS_RETRIES;
						attempt++
					) {
						yield* Effect.sleep(WALRUS_DEPLOY_VERIFY_READINESS_DELAY);
						[system, staking] = yield* probeBoth;
					}
					if (system === undefined || system === null) return null;
					if (staking === undefined || staking === null) return null;

					return {
						systemObjectId: system.objectId,
						stakingObjectId: staking.objectId,
					} satisfies WalrusDeployVerified;
				}).pipe(
					// `verify` must satisfy `Effect<… | null, never>` per
					// the publisher contract. Narrow the cache-miss
					// collapse to genuine cache-corruption signals
					// (`decode-failed`) and missing-registration
					// (`no-probe-registered`). The lenient probe already
					// maps `not-found`/`transient` to `null`, so the
					// remaining ChainProbeError values that reach here
					// are authoritative — `decode-failed` is stale shape
					// (re-produce) and `no-probe-registered` means the
					// plugin booted before the chain probe was
					// contributed (treat as miss). Anything else is a
					// real RPC failure we want visible in the logs
					// rather than silently collapsed to "re-deploy".
					Effect.catchTag('ChainProbeError', (err) => {
						if (err.reason === 'decode-failed' || err.reason === 'no-probe-registered') {
							return Effect.succeed(null as WalrusDeployVerified | null);
						}
						return Effect.logWarning(
							`walrus.deploy verify probe surfaced an authoritative error (` +
								`reason=${err.reason}, chain=${err.chain}, detail=${err.detail}); ` +
								`re-deploying.`,
						).pipe(Effect.as(null as WalrusDeployVerified | null));
					}),
				),
			// Produce: real walrus-deploy one-shot.
			produce: runDeployOneShot(runtime, inputs).pipe(
				Effect.mapError(
					(err): ArtifactPublishError =>
						artifactPublishError('produce-failed', `walrus.deploy ${err.phase}: ${err.message}`),
				),
			),
			// Register: fires on EVERY cycle. The plugin's outer body
			// performs the walrus-state / endpoint / package registry
			// publishes after both deploy + storage-nodes are up; this
			// closure is the publisher-side null-op so the substrate
			// satisfies its Invariant-6 contract.
			register: () => Effect.void,
		});

		return { state };
	}).pipe(
		Effect.withSpan('devstack.plugin.walrus.deploy', {
			attributes: { [WalrusSpans.name]: inputs.walrusName, [WalrusSpans.chain]: inputs.chainId },
		}),
	);
