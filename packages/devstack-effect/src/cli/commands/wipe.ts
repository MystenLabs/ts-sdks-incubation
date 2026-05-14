// `devstack wipe` — tear down the current stack.
//
// V3 parity port. Two responsibilities:
//
//   1. Best-effort kill of any docker containers belonging to this stack.
//      `Docker.run` stamps every container with
//      `devstack.app=<app> / devstack.stack=<stack> / devstack.action=<name>`
//      (see `internal/docker.ts` + `internal/identity.ts`), so we filter
//      on `label=devstack.stack=<stack>` rather than the older
//      `name=^devstack-` prefix heuristic. That keeps a wipe in one app
//      from clobbering a sibling app's containers.
//
//   2. Remove the per-stack state dir under `.devstack/stacks/<stack>/`, or
//      the legacy flat `.devstack/state.json` if no per-stack layout exists.
//
// Refuses to run without `--yes` so a stray shell-history invocation doesn't
// wipe a developer's stack.

import { Console, Effect, FileSystem } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { Command, Flag } from 'effect/unstable/cli';
import { join as joinPath } from 'node:path';

const STATE_DIR = process.env.DEVSTACK_STATE_DIR ?? '.devstack';

type Spawner = ReturnType<typeof ChildProcessSpawner.make>;
type Fs = ReturnType<typeof FileSystem.make>;

const stackFlag = Flag.string('stack').pipe(
	Flag.withDescription('Per-stack name (default: main)'),
	Flag.withDefault('main'),
);

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

// `docker ps -aq --filter label=devstack.stack=<stack>` then
// `docker rm -f` each. Best-effort: a failure to enumerate or kill never
// fails the wipe.
const killDevstackContainers = (spawner: Spawner, stack: string) =>
	Effect.gen(function* () {
		const lsCmd = ChildProcess.make('docker', [
			'ps',
			'-aq',
			'--filter',
			`label=devstack.stack=${stack}`,
		]);
		const idsText = yield* spawner.string(lsCmd).pipe(Effect.catch(() => Effect.succeed('')));
		const ids = idsText
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const killed: Array<string> = [];
		for (const id of ids) {
			const rmCmd = ChildProcess.make('docker', ['rm', '-f', id]);
			const ok = yield* spawner.string(rmCmd).pipe(
				Effect.map(() => true),
				Effect.catch(() => Effect.succeed(false)),
			);
			if (ok) killed.push(id);
		}
		return killed as ReadonlyArray<string>;
	});

// `docker images --format {{.Repository}}:{{.Tag}} devstack-*` then
// `docker rmi` each. Best-effort: dangling refs / running containers
// keep the image alive and that's fine.
const removeDevstackImages = (spawner: Spawner) =>
	Effect.gen(function* () {
		const lsCmd = ChildProcess.make('docker', [
			'images',
			'--format',
			'{{.Repository}}:{{.Tag}}',
			'devstack-*',
		]);
		const out = yield* spawner.string(lsCmd).pipe(Effect.catch(() => Effect.succeed('')));
		const tags = out
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0 && !s.endsWith(':<none>'));
		const removed: Array<string> = [];
		for (const tag of tags) {
			const rmiCmd = ChildProcess.make('docker', ['rmi', tag]);
			const ok = yield* spawner.string(rmiCmd).pipe(
				Effect.map(() => true),
				Effect.catch(() => Effect.succeed(false)),
			);
			if (ok) removed.push(tag);
		}
		return removed as ReadonlyArray<string>;
	});

// Remove the per-stack state. Two layouts coexist in v4:
//   - Per-stack: <STATE_DIR>/stacks/<stack>/  (forward-looking; what
//     `stack new/use` lays down)
//   - Flat: <STATE_DIR>/state.json  (what `state-store.ts` currently
//     reads/writes)
// We attempt both and report whichever we touched.
const removeStateOnDisk = (fs: Fs, stack: string, keepSnapshots: boolean) =>
	Effect.gen(function* () {
		const removed: Array<string> = [];

		const stackDir = joinPath(STATE_DIR, 'stacks', stack);
		const stackExists = yield* fs.exists(stackDir).pipe(Effect.catch(() => Effect.succeed(false)));
		if (stackExists) {
			if (keepSnapshots) {
				const entries = yield* fs
					.readDirectory(stackDir)
					.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
				for (const entry of entries) {
					if (entry === 'snapshots') continue;
					const full = joinPath(stackDir, entry);
					yield* fs
						.remove(full, { recursive: true, force: true })
						.pipe(Effect.catch(() => Effect.void));
					removed.push(full);
				}
			} else {
				yield* fs
					.remove(stackDir, { recursive: true, force: true })
					.pipe(Effect.catch(() => Effect.void));
				removed.push(stackDir);
			}
		}

		// Flat-layout fallback. The current v4 state-store writes one file
		// per process, regardless of the stack name. Remove it too so
		// `wipe` actually clears state for a default run.
		const flatStateFile = joinPath(STATE_DIR, 'state.json');
		const flatExists = yield* fs
			.exists(flatStateFile)
			.pipe(Effect.catch(() => Effect.succeed(false)));
		if (flatExists) {
			yield* fs.remove(flatStateFile, { force: true }).pipe(Effect.catch(() => Effect.void));
			removed.push(flatStateFile);
		}

		return removed as ReadonlyArray<string>;
	});

export const wipeCommand = Command.make(
	'wipe',
	{
		stack: stackFlag,
		yes: yesFlag,
		keepSnapshots: keepSnapshotsFlag,
		noStop: noStopFlag,
		images: imagesFlag,
	},
	({ stack, yes, keepSnapshots, noStop, images }) =>
		Effect.gen(function* () {
			if (!yes) {
				yield* Console.error(
					'devstack wipe: --yes is required (refusing to wipe without explicit confirmation)',
				);
				return yield* Effect.fail(new Error('wipe: --yes required'));
			}

			const fs = yield* FileSystem.FileSystem;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

			let killed: ReadonlyArray<string> = [];
			if (!noStop) {
				killed = yield* killDevstackContainers(spawner, stack);
				if (killed.length === 0) {
					yield* Console.log('nothing running to stop.');
				} else {
					for (const id of killed) {
						yield* Console.log(`stopped container ${id.slice(0, 12)}`);
					}
				}
			}

			const removed = yield* removeStateOnDisk(fs, stack, keepSnapshots);
			if (removed.length === 0) {
				yield* Console.log('nothing on disk to remove.');
			} else {
				for (const p of removed) yield* Console.log(`removed ${p}`);
			}

			if (images) {
				const removedImages = yield* removeDevstackImages(spawner);
				if (removedImages.length === 0) {
					yield* Console.log('no devstack-* images to remove.');
				} else {
					for (const tag of removedImages) yield* Console.log(`removed image ${tag}`);
				}
			}
		}),
).pipe(
	Command.withDescription(
		'Tear down the current stack: kill devstack-* containers and remove on-disk state. Requires --yes.',
	),
);
