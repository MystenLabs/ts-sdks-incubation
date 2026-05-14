// Shared per-(app, stack) tear-down used by `wipe` (single in-repo
// stack) and `prune` (cross-stack cleanup, possibly across apps).
//
// Kept under `cli/commands/` (vs `internal/docker/`) because the
// removeStateOnDisk step depends on the CLI's view of where state
// lives (`<DEVSTACK_APP_DIR>/.devstack/...`), which is a CLI concern
// rather than a docker primitive.
//
// All four steps are best-effort: a failure in any one (e.g. a network
// with attached endpoints we couldn't kill) never aborts the others.
// The returned `PruneResult` carries the counts the caller renders.

import { Effect, FileSystem } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { join as joinPath } from 'node:path';

type Spawner = ReturnType<typeof ChildProcessSpawner.make>;
type Fs = ReturnType<typeof FileSystem.make>;

export interface PruneStackOptions {
	readonly app: string;
	readonly stack: string;
	/**
	 * If true, leave `<stackDir>/snapshots/` in place after removing
	 * the rest of the per-stack directory. Mirrors `wipe --keep-snapshots`.
	 */
	readonly keepSnapshots?: boolean;
	/** Skip the docker kill/remove pass; only clear on-disk state. */
	readonly noStop?: boolean;
	/** Also remove `devstack-*` images. Off by default. */
	readonly removeImages?: boolean;
	/**
	 * Override the on-disk state root. Defaults to
	 * `DEVSTACK_STATE_DIR` || `<DEVSTACK_APP_DIR or cwd>/.devstack`.
	 */
	readonly stateDir?: string;
	/**
	 * Optional state dirs to remove in addition to (or instead of) the
	 * resolved `stateDir`. Used by `prune` when the inventory already
	 * resolved the per-stack directory paths.
	 */
	readonly extraStateDirs?: ReadonlyArray<string>;
}

export interface PruneStackResult {
	readonly killedContainers: ReadonlyArray<string>;
	readonly removedNetworks: ReadonlyArray<string>;
	readonly removedVolumes: ReadonlyArray<string>;
	readonly removedStatePaths: ReadonlyArray<string>;
	readonly removedImages: ReadonlyArray<string>;
}

export const resolveStateDir = (override?: string): string => {
	if (override !== undefined && override.length > 0) return override;
	const envOverride = process.env.DEVSTACK_STATE_DIR;
	if (envOverride !== undefined && envOverride.length > 0) return envOverride;
	const appDir = process.env.DEVSTACK_APP_DIR ?? process.cwd();
	return joinPath(appDir, '.devstack');
};

// `docker ps -aq --filter label=devstack.app=<app> --filter
// label=devstack.stack=<stack>` then `docker rm -f` each.
const killDevstackContainers = (
	spawner: Spawner,
	app: string,
	stack: string,
): Effect.Effect<ReadonlyArray<string>> =>
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

const removeDevstackNetworks = (
	spawner: Spawner,
	app: string,
	stack: string,
): Effect.Effect<ReadonlyArray<string>> =>
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

const removeDevstackVolumes = (
	spawner: Spawner,
	app: string,
	stack: string,
): Effect.Effect<ReadonlyArray<string>> =>
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

const removeDevstackImages = (spawner: Spawner): Effect.Effect<ReadonlyArray<string>> =>
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

// Two layouts: per-stack (<stateDir>/stacks/<stack>/) and flat
// (<stateDir>/state.json). Best-effort: missing paths are silent.
const removeStateOnDisk = (
	fs: Fs,
	stateDir: string,
	stack: string,
	keepSnapshots: boolean,
): Effect.Effect<ReadonlyArray<string>> =>
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

const removeExtraStateDirs = (
	fs: Fs,
	dirs: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		const removed: Array<string> = [];
		for (const dir of dirs) {
			const exists = yield* fs.exists(dir).pipe(Effect.catch(() => Effect.succeed(false)));
			if (!exists) continue;
			yield* fs.remove(dir, { recursive: true, force: true }).pipe(Effect.catch(() => Effect.void));
			removed.push(dir);
		}
		return removed as ReadonlyArray<string>;
	});

export const pruneStack = (
	options: PruneStackOptions,
): Effect.Effect<
	PruneStackResult,
	never,
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const stateDir = resolveStateDir(options.stateDir);

		let killedContainers: ReadonlyArray<string> = [];
		let removedNetworks: ReadonlyArray<string> = [];
		let removedVolumes: ReadonlyArray<string> = [];
		if (options.noStop !== true) {
			killedContainers = yield* killDevstackContainers(spawner, options.app, options.stack);
			// Network + volume removal must wait for the kill pass: docker
			// rejects `network rm` / `volume rm` against live endpoints /
			// mounts.
			removedNetworks = yield* removeDevstackNetworks(spawner, options.app, options.stack);
			removedVolumes = yield* removeDevstackVolumes(spawner, options.app, options.stack);
		}

		const fromStateDir = yield* removeStateOnDisk(
			fs,
			stateDir,
			options.stack,
			options.keepSnapshots === true,
		);
		const fromExtra =
			options.extraStateDirs !== undefined && options.extraStateDirs.length > 0
				? yield* removeExtraStateDirs(fs, options.extraStateDirs)
				: ([] as ReadonlyArray<string>);
		// Dedup: the inventory-supplied `extraStateDirs` typically point
		// at the same path the resolved stateDir already removed.
		const stateSet = new Set<string>();
		for (const p of fromStateDir) stateSet.add(p);
		for (const p of fromExtra) stateSet.add(p);
		const removedStatePaths = [...stateSet];

		let removedImages: ReadonlyArray<string> = [];
		if (options.removeImages === true) {
			removedImages = yield* removeDevstackImages(spawner);
		}

		return {
			killedContainers,
			removedNetworks,
			removedVolumes,
			removedStatePaths,
			removedImages,
		};
	}).pipe(Effect.withSpan('prune.stack', { attributes: { app: options.app, stack: options.stack } }));
