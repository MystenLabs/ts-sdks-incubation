// `devstack wipe` — tear down the current (app, stack).
//
// V3 parity port. Four responsibilities, all delegated to the shared
// `pruneStack` helper so `devstack prune` can reuse the same docker
// label-filter logic for cross-stack cleanup:
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
//   4. Remove the per-stack state dir under `.devstack/stacks/<stack>/`,
//      or the legacy flat `.devstack/state.json` if no per-stack layout
//      exists.
//
// Refuses to run without `--yes` so a stray shell-history invocation
// doesn't wipe a developer's stack. For cross-app cleanup (or an
// interactive selection across every stack on the machine) reach for
// `devstack prune` instead — same teardown logic, broader scope.

import { Console, Effect, Option } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { deriveAppName } from '../../engine/identity.js';
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

const resolveStackFlag = (raw: string): string => {
	if (raw.length > 0) return raw;
	const env = process.env.DEVSTACK_STACK;
	return env !== undefined && env.length > 0 ? env : 'main';
};

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

const resolveAppName = (override: Option.Option<string>): string =>
	Option.getOrElse(override, () => deriveAppName(process.env.DEVSTACK_APP_DIR ?? process.cwd()));

const yesFlag = Flag.boolean('yes').pipe(
	Flag.withDescription('Required. Confirms the wipe.'),
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

export const wipeCommand = Command.make(
	'wipe',
	{
		stack: stackFlag,
		app: appFlag,
		yes: yesFlag,
		keepSnapshots: keepSnapshotsFlag,
		noStop: noStopFlag,
		images: imagesFlag,
	},
	({ stack, app, yes, keepSnapshots, noStop, images }) =>
		Effect.gen(function* () {
			if (!yes) {
				yield* Console.error(
					'devstack wipe: --yes is required (refusing to wipe without explicit confirmation)',
				);
				return yield* Effect.fail(new Error('wipe: --yes required'));
			}

			const resolvedApp = resolveAppName(app);
			const resolvedStack = resolveStackFlag(stack);
			const result = yield* pruneStack({
				app: resolvedApp,
				stack: resolvedStack,
				keepSnapshots,
				noStop,
				removeImages: images,
			});

			// Single summary line — the prior per-id `console.log` spam
			// scaled badly when a wipe across a busy app removed dozens of
			// containers / volumes. Counts are what the operator actually
			// needs to know ("did wipe find anything?"); the per-id detail
			// is recoverable from `docker ps -a` history if needed.
			const killed = result.killedContainers.length;
			const networks = result.removedNetworks.length;
			const volumes = result.removedVolumes.length;
			const stateFiles = result.removedStatePaths.length;
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
			yield* Console.log(
				`devstack wipe (app=${resolvedApp}, stack=${resolvedStack}): ${parts.join(', ')}.`,
			);
		}),
).pipe(
	Command.withDescription(
		'Tear down the current stack: kill devstack-* containers + networks + volumes and remove on-disk state. Requires --yes.',
	),
);
