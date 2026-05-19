// `devstack wipe` — tear down the current (app, stack).
//
// Four responsibilities, all delegated to the shared `pruneStack` helper
// so `devstack prune` can reuse the same docker label-filter logic for
// cross-stack cleanup:
//
//   1. Kill any docker containers belonging to this `<app, stack>` pair.
//      `Docker.run` stamps every container with
//      `devstack.app=<app> / devstack.stack=<stack> / devstack.action=<name>`
//      (see `internal/docker/core.ts` + `internal/identity.ts`), so we
//      filter on `label=devstack.app=<app>,devstack.stack=<stack>`.
//      Filtering on stack alone is not enough — a wipe in one app would
//      clobber a sibling app's containers when both default to
//      `stack=main`.
//   2. Remove docker networks with matching labels. `Docker.networkCreate`
//      stamps the same `devstack.app` / `devstack.stack` labels; without
//      this pass networks accumulate forever and Docker's default 15-/16
//      IPAM pool eventually exhausts ("could not find an available,
//      non-overlapping IPv4 address pool").
//   3. Remove docker volumes with matching labels. `Docker.run`
//      pre-creates each named volume with the same labels (see
//      `ensureLabeledVolume` in `internal/docker/core.ts`). Without this
//      pass named volumes (RocksDB stores, postgres data, walrus blobs)
//      pile up at ~100MB per run.
//   4. Remove the per-stack state dir under `.devstack/stacks/<stack>/`.
//
// Phase A (`notes/cli-redesign.md` §6) — prompt by default on TTY,
// `--yes` bypasses, `--no-input` fails. `--also-upstream-cache` triggers
// the Tier 2 type-to-confirm phrase guard. `--dry-run` emits a preview
// envelope and exits 0. Every code path emits the canonical envelope
// under `--json`.

import { promises as nodeFs } from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { Console, Effect } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { sweepStaleGitLocks } from '../../engine/sui-build-container.js';
import { failAlreadyReported } from '../already-reported.js';
import { promptConfirm, promptTypeToConfirm } from '../cli-prompt.js';
import { emitEnvelope, errorEnvelope, jsonModeEnabled, successEnvelope } from '../envelope.js';
import { EX_USAGE, EX_CONFIRM_REQUIRED } from '../exit-codes.js';
import { resolveAppName, resolveForkCacheRoot, resolveStackFromEnv } from '../stack-resolution.js';
import { pruneStack } from './_prune-stack.js';

// Default reads `DEVSTACK_STACK` at action time (NOT at module load —
// tests + shell wrappers set the env after the binary's `import` graph
// has resolved). Mirrors `engine/supervisor.ts:567`'s precedence: `--stack`
// flag > DEVSTACK_STACK > 'main'. Without this, `DEVSTACK_STACK=foo
// devstack wipe --yes` would wipe `main` while the supervisor was
// running against `foo` — destructive cross-stack surprise.
const stackFlag = Flag.string('stack').pipe(
	Flag.withDescription('Per-stack name (default: DEVSTACK_STACK env or "main")'),
	Flag.withDefault(''),
);

const resolveStackFlag = (raw: string): string =>
	resolveStackFromEnv(raw.length > 0 ? raw : undefined);

// Optional + resolved at action-time so `DEVSTACK_APP_DIR` overrides
// applied via a fixture or shell wrapper after this module's import
// are honored. Without this we'd freeze whichever cwd / env was set
// the moment the CLI was loaded — surprising in tests that change
// cwd between subcommand invocations.
const appFlag = Flag.string('app').pipe(
	Flag.withDescription(
		"App identifier (default: <appDir>/package.json#name's basename, matching `defineDevstack`)",
	),
	Flag.optional,
);

const yesFlag = Flag.boolean('yes').pipe(
	Flag.withDescription(
		'Bypass the confirmation prompt (CI / non-interactive). Equivalent to typing the stack name when used with --also-upstream-cache.',
	),
	Flag.withDefault(false),
);

const keepSnapshotsFlag = Flag.boolean('keep-snapshots').pipe(
	Flag.withDescription("Don't delete labeled snapshots under snapshots/"),
	Flag.withDefault(false),
);

const noStopFlag = Flag.boolean('no-stop').pipe(
	Flag.withDescription('Skip the docker kill pass — only remove on-disk state'),
	Flag.withDefault(false),
);

const imagesFlag = Flag.boolean('images').pipe(
	Flag.withDescription('Also `docker rmi` devstack-* images with no running containers'),
	Flag.withDefault(false),
);

// Keep the shared `.devstack/sui-fork-cache/` intact by default. Wiping
// a fork stack should leave the warmed upstream state (object 0x5 +
// dynamic fields + every fetched object) so the next `apply` doesn't
// pay the cold-start GraphQL warming cost again. Pass
// `--also-upstream-cache` for a full reset.
//
// Mutually exclusive in spirit with `--keep-upstream-cache`, but for
// human ergonomics we accept both flags; `--keep-upstream-cache` is
// the explicit default-affirming form that the `SeedManifestMismatchError`
// recipe instructs the user to run.
const alsoUpstreamCacheFlag = Flag.boolean('also-upstream-cache').pipe(
	Flag.withDescription(
		'Also remove `.devstack/sui-fork-cache/` — the shared warmed upstream cache that survives ' +
			"a normal wipe so the next fork-mode `apply` doesn't re-warm system state. Severity tier 2: " +
			'requires typing the stack name to confirm interactively.',
	),
	Flag.withDefault(false),
);

const keepUpstreamCacheFlag = Flag.boolean('keep-upstream-cache').pipe(
	Flag.withDescription(
		'Explicitly affirm the default: preserve `.devstack/sui-fork-cache/`. Surfaced so the ' +
			'`SeedManifestMismatchError` recipe (`devstack wipe --keep-upstream-cache && devstack apply`) ' +
			'reads naturally even though `--also-upstream-cache` defaults to false.',
	),
	Flag.withDefault(false),
);

const jsonFlag = Flag.boolean('json').pipe(
	Flag.withDescription('Emit a machine-readable envelope to stdout instead of human-readable lines'),
	Flag.withDefault(false),
);

const dryRunFlag = Flag.boolean('dry-run').pipe(
	Flag.withDescription(
		'Print what would be removed and exit 0; no docker / disk mutation. Compatible with --json.',
	),
	Flag.withDefault(false),
);

const noInputFlag = Flag.boolean('no-input').pipe(
	Flag.withDescription('Fail rather than prompt (CI / piped stdin). Equivalent to DEVSTACK_NO_INPUT=1.'),
	Flag.withDefault(false),
);

const COMMAND_NAME = 'wipe' as const;

interface WipePlan {
	readonly app: string;
	readonly stack: string;
	readonly stateDir: string;
	readonly upstreamCachePath?: string;
	readonly includeImages: boolean;
	readonly keepSnapshots: boolean;
	readonly noStop: boolean;
}

const renderPreview = (plan: WipePlan): ReadonlyArray<string> => {
	const lines: Array<string> = [
		`app:    ${plan.app}`,
		`stack:  ${plan.stack}`,
		`state:  ${plan.stateDir}`,
	];
	if (plan.upstreamCachePath !== undefined) {
		lines.push(`upstream cache: ${plan.upstreamCachePath} (REMOVED — tier 2)`);
	} else {
		lines.push(`upstream cache: PRESERVED`);
	}
	lines.push(`docker containers + networks + volumes labelled devstack.app=${plan.app} stack=${plan.stack}`);
	if (plan.includeImages) lines.push(`docker images labelled devstack.image=true (no live container)`);
	if (plan.keepSnapshots) lines.push(`snapshots/ PRESERVED (--keep-snapshots)`);
	if (plan.noStop) lines.push(`docker kill pass SKIPPED (--no-stop)`);
	return lines;
};

export const wipeCommand = Command.make(
	'wipe',
	{
		stack: stackFlag,
		app: appFlag,
		yes: yesFlag,
		keepSnapshots: keepSnapshotsFlag,
		noStop: noStopFlag,
		images: imagesFlag,
		alsoUpstreamCache: alsoUpstreamCacheFlag,
		keepUpstreamCache: keepUpstreamCacheFlag,
		json: jsonFlag,
		dryRun: dryRunFlag,
		noInput: noInputFlag,
	},
	({
		stack,
		app,
		yes,
		keepSnapshots,
		noStop,
		images,
		alsoUpstreamCache,
		keepUpstreamCache,
		json,
		dryRun,
		noInput,
	}) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);

			if (alsoUpstreamCache && keepUpstreamCache) {
				const envelope = errorEnvelope({
					command: COMMAND_NAME,
					error: {
						code: 'MUTUALLY_EXCLUSIVE_FLAGS',
						exitCode: EX_USAGE,
						message:
							'devstack wipe: --also-upstream-cache and --keep-upstream-cache are mutually exclusive',
					},
					elapsedMs: Date.now() - startedAt,
				});
				if (useJson) {
					yield* emitEnvelope(envelope);
				}
				return yield* failAlreadyReported(envelope.error!.message);
			}

			const resolvedApp = resolveAppName(app);
			const resolvedStack = resolveStackFlag(stack);
			const stateDirPath = `${process.env.DEVSTACK_STATE_DIR ?? '.devstack'}/stacks/${resolvedStack}`;
			const upstreamCachePath = alsoUpstreamCache ? resolveForkCacheRoot() : undefined;
			const plan: WipePlan = {
				app: resolvedApp,
				stack: resolvedStack,
				stateDir: stateDirPath,
				...(upstreamCachePath !== undefined ? { upstreamCachePath } : {}),
				includeImages: images,
				keepSnapshots,
				noStop,
			};

			// Dry-run short-circuits BEFORE prompting. The point of
			// `--dry-run` is to surface a preview without any side effects
			// — that includes the interactive prompt.
			if (dryRun) {
				const dryEnvelope = successEnvelope({
					command: COMMAND_NAME,
					data: {
						app: resolvedApp,
						stack: resolvedStack,
						wouldRemove: {
							stateDir: stateDirPath,
							...(upstreamCachePath !== undefined ? { upstreamCache: upstreamCachePath } : {}),
							dockerContainers: `labelled devstack.app=${resolvedApp},devstack.stack=${resolvedStack}`,
							dockerNetworks: `labelled devstack.app=${resolvedApp},devstack.stack=${resolvedStack}`,
							dockerVolumes: `labelled devstack.app=${resolvedApp},devstack.stack=${resolvedStack}`,
							...(images ? { dockerImages: 'labelled devstack.image=true, no live container' } : {}),
						},
					},
					elapsedMs: Date.now() - startedAt,
					dryRun: true,
				});
				if (useJson) {
					yield* emitEnvelope(dryEnvelope);
				} else {
					yield* Console.log(
						`devstack wipe (dry-run, app=${resolvedApp}, stack=${resolvedStack}):`,
					);
					for (const line of renderPreview(plan)) {
						yield* Console.log(`  ${line}`);
					}
				}
				return;
			}

			// Severity-graded confirmation. Tier 2 (`--also-upstream-cache`)
			// makes the operator type the stack name; tier 1 is a plain
			// confirm. `--yes` bypasses both; `--no-input` fails both.
			const preview = renderPreview(plan);
			const outcome = alsoUpstreamCache
				? yield* promptTypeToConfirm({
						preview,
						phrase: resolvedStack,
						message: `Type the stack name '${resolvedStack}' to confirm wipe + upstream cache removal`,
						yes,
						noInput,
					})
				: yield* promptConfirm({
						message: `Wipe stack '${resolvedStack}' for app '${resolvedApp}'?`,
						preview,
						yes,
						noInput,
					});

			if (outcome.kind === 'non-interactive') {
				const code = outcome.exitCode;
				const envelope = errorEnvelope({
					command: COMMAND_NAME,
					error: {
						code: code === EX_CONFIRM_REQUIRED ? 'CONFIRM_REQUIRED' : 'CONFIRM_UNSUPPORTED',
						exitCode: code,
						message: `devstack wipe: ${outcome.reason}. Pass --yes to bypass.`,
						hint: 'devstack wipe --yes',
					},
					elapsedMs: Date.now() - startedAt,
				});
				if (useJson) {
					yield* emitEnvelope(envelope);
				}
				return yield* failAlreadyReported(envelope.error!.message);
			}
			if (outcome.kind === 'cancelled' || outcome.kind === 'declined') {
				const envelope = errorEnvelope({
					command: COMMAND_NAME,
					error: {
						code: outcome.kind === 'cancelled' ? 'CANCELLED' : 'DECLINED',
						exitCode: EX_USAGE,
						message: `devstack wipe: ${outcome.kind} by operator`,
					},
					elapsedMs: Date.now() - startedAt,
				});
				if (useJson) {
					yield* emitEnvelope(envelope);
				} else {
					yield* Console.log(`devstack wipe: ${outcome.kind} by operator — no changes made`);
				}
				return yield* failAlreadyReported(envelope.error!.message);
			}

			const result = yield* pruneStack({
				app: resolvedApp,
				stack: resolvedStack,
				keepSnapshots,
				noStop,
				removeImages: images,
			});

			// Optional upstream-cache pass. Default keeps the cache so a
			// `wipe` against a fork stack doesn't force the next `apply`
			// to re-warm upstream system state from scratch (R10 — first-
			// boot serial GraphQL reads). `--also-upstream-cache` drops
			// the cache for a full reset.
			let removedCachePath: string | undefined;
			if (alsoUpstreamCache) {
				const cacheRoot = resolveForkCacheRoot();
				const removed = yield* Effect.tryPromise({
					try: async () => {
						await nodeFs.rm(cacheRoot, { recursive: true, force: true });
						return true;
					},
					catch: () => false,
				}).pipe(Effect.orElseSucceed(() => false));
				if (removed) removedCachePath = cacheRoot;
			}

			// Sweep stale `~/.move/git/<repo>/.git/*.lock` files. wipe is
			// already destructive so removing 0-byte leftovers from a
			// previously SIGKILL'd `sui move build` is safe and removes a
			// recurring failure mode (next `apply` fails with "Unable to
			// create index.lock: File exists" — see
			// `engine/sui-build-container.ts::sweepStaleGitLocks`).
			// Runs unconditionally because (a) the locks have a 60s age
			// threshold so a real in-flight git op is never touched, and
			// (b) we don't want users to have to remember a separate flag
			// to recover from the most common publish-failure mode.
			const moveHome = nodePath.join(nodeOs.homedir(), '.move');
			const removedMoveGitLocks = yield* sweepStaleGitLocks(moveHome);

			const killed = result.killedContainers.length;
			const networks = result.removedNetworks.length;
			const volumes = result.removedVolumes.length;
			const stateFiles = result.removedStatePaths.length;

			if (useJson) {
				const successPayload = {
					app: resolvedApp,
					stack: resolvedStack,
					killedContainers: killed,
					removedNetworks: networks,
					removedVolumes: volumes,
					removedStatePaths: stateFiles,
					...(images ? { removedImages: result.removedImages.length } : {}),
					...(removedCachePath !== undefined ? { removedUpstreamCache: removedCachePath } : {}),
					...(removedMoveGitLocks.length > 0
						? { removedMoveGitLocks: removedMoveGitLocks.length }
						: {}),
				};
				yield* emitEnvelope(
					successEnvelope({
						command: COMMAND_NAME,
						data: successPayload,
						elapsedMs: Date.now() - startedAt,
					}),
				);
				return;
			}

			const parts: Array<string> = [
				`stopped ${killed} container${killed === 1 ? '' : 's'}`,
				`removed ${networks} network${networks === 1 ? '' : 's'}`,
				`removed ${volumes} volume${volumes === 1 ? '' : 's'}`,
				`removed ${stateFiles} state ${stateFiles === 1 ? 'file' : 'files'}`,
			];
			if (images) {
				const imageCount = result.removedImages.length;
				parts.push(`removed ${imageCount} image${imageCount === 1 ? '' : 's'}`);
			}
			if (removedCachePath !== undefined) {
				parts.push(`removed upstream cache ${removedCachePath}`);
			}
			if (removedMoveGitLocks.length > 0) {
				parts.push(
					`cleared ${removedMoveGitLocks.length} stale move-git lock${removedMoveGitLocks.length === 1 ? '' : 's'}`,
				);
			}
			yield* Console.log(
				`devstack wipe (app=${resolvedApp}, stack=${resolvedStack}): ${parts.join(', ')}.`,
			);
		}),
).pipe(
	Command.withDescription(
		'Tear down the current stack: kill devstack-* containers + networks + volumes and remove on-disk state. Prompts on TTY (use --yes to skip).',
	),
);
