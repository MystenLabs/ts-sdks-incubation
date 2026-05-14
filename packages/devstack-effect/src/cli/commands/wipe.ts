// `devstack wipe` — tear down the current stack.
//
// V3 parity port. Four responsibilities, each best-effort:
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
// doesn't wipe a developer's stack.

import { Console, Effect, FileSystem } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { Command, Flag } from 'effect/unstable/cli';
import { join as joinPath } from 'node:path';
import { deriveAppName } from '../../internal/identity.js';

// Resolve the on-disk state dir the same way `state-store.ts` does:
// `DEVSTACK_STATE_DIR` is the legacy explicit override (kept for back-
// compat with existing dev rigs); otherwise we look at
// `DEVSTACK_APP_DIR` (falling back to `cwd`) and use `<appDir>/.devstack`
// as the root. Keeping the two in lock-step is essential — if `wipe`
// looked at `cwd/.devstack` while the supervisor wrote to
// `${DEVSTACK_APP_DIR}/.devstack`, wipe would silently leave state on
// disk and the next run would resume the half-wiped stack.
const resolveStateDir = (): string => {
	const envOverride = process.env.DEVSTACK_STATE_DIR;
	if (envOverride !== undefined && envOverride.length > 0) return envOverride;
	const appDir = process.env.DEVSTACK_APP_DIR ?? process.cwd();
	return joinPath(appDir, '.devstack');
};

type Spawner = ReturnType<typeof ChildProcessSpawner.make>;
type Fs = ReturnType<typeof FileSystem.make>;

const stackFlag = Flag.string('stack').pipe(
	Flag.withDescription('Per-stack name (default: main)'),
	Flag.withDefault('main'),
);

// Default to `deriveAppName(<appDir>)` so a bare `devstack wipe --yes`
// behaves intuitively: it only touches THIS app's containers/networks/
// volumes, mirroring how `defineDevstack` infers `Identity.app` from
// the same `package.json#name`. Without an `--app` filter, wipe would
// match `devstack.stack=main` across EVERY repo on the machine that
// uses devstack — a footgun if a developer is running two apps side
// by side.
const appFlag = Flag.string('app').pipe(
	Flag.withDescription(
		"App identifier (default: <appDir>/package.json#name's basename, matching `defineDevstack`)",
	),
	Flag.withDefault(deriveAppName(process.env.DEVSTACK_APP_DIR ?? process.cwd())),
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

// `docker ps -aq --filter label=devstack.app=<app> --filter
// label=devstack.stack=<stack>` then `docker rm -f` each. Best-effort:
// a failure to enumerate or kill never fails the wipe.
const killDevstackContainers = (spawner: Spawner, app: string, stack: string) =>
	Effect.gen(function* () {
		const lsCmd = ChildProcess.make('docker', [
			'ps',
			'-aq',
			'--filter',
			`label=devstack.app=${app}`,
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

// `docker network ls -q --filter label=devstack.app=<app> --filter
// label=devstack.stack=<stack>` then `docker network rm` each.
// Best-effort: `network rm` fails when endpoints are still attached
// (i.e. a stray container slipped past the kill pass). That's fine —
// we surface the count we DID remove and move on.
const removeDevstackNetworks = (spawner: Spawner, app: string, stack: string) =>
	Effect.gen(function* () {
		const lsCmd = ChildProcess.make('docker', [
			'network',
			'ls',
			'-q',
			'--filter',
			`label=devstack.app=${app}`,
			'--filter',
			`label=devstack.stack=${stack}`,
		]);
		const idsText = yield* spawner.string(lsCmd).pipe(Effect.catch(() => Effect.succeed('')));
		const ids = idsText
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const removed: Array<string> = [];
		for (const id of ids) {
			const rmCmd = ChildProcess.make('docker', ['network', 'rm', id]);
			const ok = yield* spawner.string(rmCmd).pipe(
				Effect.map(() => true),
				Effect.catch(() => Effect.succeed(false)),
			);
			if (ok) removed.push(id);
		}
		return removed as ReadonlyArray<string>;
	});

// `docker volume ls -q --filter label=devstack.app=<app> --filter
// label=devstack.stack=<stack>` then `docker volume rm` each.
// Best-effort: `volume rm` fails when a container still references the
// volume (it shouldn't after the kill pass, but a sibling stack might
// share the volume — we never force-remove). Pre-`Docker.run` upgrade
// volumes won't have labels and will be left in place; that's
// acceptable as a one-time bleed-through and visible via
// `docker volume ls --filter label=devstack.app=…`.
const removeDevstackVolumes = (spawner: Spawner, app: string, stack: string) =>
	Effect.gen(function* () {
		const lsCmd = ChildProcess.make('docker', [
			'volume',
			'ls',
			'-q',
			'--filter',
			`label=devstack.app=${app}`,
			'--filter',
			`label=devstack.stack=${stack}`,
		]);
		const namesText = yield* spawner.string(lsCmd).pipe(Effect.catch(() => Effect.succeed('')));
		const names = namesText
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const removed: Array<string> = [];
		for (const n of names) {
			const rmCmd = ChildProcess.make('docker', ['volume', 'rm', n]);
			const ok = yield* spawner.string(rmCmd).pipe(
				Effect.map(() => true),
				Effect.catch(() => Effect.succeed(false)),
			);
			if (ok) removed.push(n);
		}
		return removed as ReadonlyArray<string>;
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
//   - Per-stack: <stateDir>/stacks/<stack>/  (forward-looking; what
//     `stack new/use` lays down)
//   - Flat: <stateDir>/state.json  (what `state-store.ts` currently
//     reads/writes)
// We attempt both and report whichever we touched.
const removeStateOnDisk = (fs: Fs, stateDir: string, stack: string, keepSnapshots: boolean) =>
	Effect.gen(function* () {
		const removed: Array<string> = [];

		const stackDir = joinPath(stateDir, 'stacks', stack);
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
		const flatStateFile = joinPath(stateDir, 'state.json');
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

			const fs = yield* FileSystem.FileSystem;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const stateDir = resolveStateDir();

			let killed: ReadonlyArray<string> = [];
			let removedNetworks: ReadonlyArray<string> = [];
			let removedVolumes: ReadonlyArray<string> = [];
			if (!noStop) {
				killed = yield* killDevstackContainers(spawner, app, stack);
				// Networks + volumes only after containers are gone:
				// `network rm` / `volume rm` reject endpoints / mounts that
				// are still live, so running them in the other order would
				// be a no-op on a fresh dev cycle.
				removedNetworks = yield* removeDevstackNetworks(spawner, app, stack);
				removedVolumes = yield* removeDevstackVolumes(spawner, app, stack);
			}

			const removedState = yield* removeStateOnDisk(fs, stateDir, stack, keepSnapshots);

			let removedImages: ReadonlyArray<string> = [];
			if (images) {
				removedImages = yield* removeDevstackImages(spawner);
			}

			// Single summary line — the prior per-id `console.log` spam
			// scaled badly when a wipe across a busy app removed dozens of
			// containers / volumes. Counts are what the operator actually
			// needs to know ("did wipe find anything?"); the per-id detail
			// is recoverable from `docker ps -a` history if needed.
			const parts: Array<string> = [
				`stopped ${killed.length} container${killed.length === 1 ? '' : 's'}`,
				`removed ${removedNetworks.length} network${removedNetworks.length === 1 ? '' : 's'}`,
				`removed ${removedVolumes.length} volume${removedVolumes.length === 1 ? '' : 's'}`,
				`removed ${removedState.length} state ${removedState.length === 1 ? 'file' : 'files'}`,
			];
			if (images) {
				parts.push(
					`removed ${removedImages.length} image${removedImages.length === 1 ? '' : 's'}`,
				);
			}
			yield* Console.log(`devstack wipe (app=${app}, stack=${stack}): ${parts.join(', ')}.`);
		}),
).pipe(
	Command.withDescription(
		'Tear down the current stack: kill devstack-* containers + networks + volumes and remove on-disk state. Requires --yes.',
	),
);
