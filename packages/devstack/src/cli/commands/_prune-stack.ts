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

import { Effect, FileSystem, Option, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { join as joinPath } from 'node:path';
import { removeDockerByLabel } from '../../engine/docker/inventory.js';
import { isHolderLive } from '../../engine/process-liveness.js';
import { Registry, type RegistryNetwork } from '../../engine/registry.js';
import { resolveStateDir } from '../stack-resolution.js';

export class PruneStackBlockedError extends Schema.TaggedErrorClass<PruneStackBlockedError>()(
	'PruneStackBlockedError',
	{
		app: Schema.String,
		stack: Schema.String,
		lockPath: Schema.String,
		holderPid: Schema.Number,
	},
) {}

// Inspect the per-stack state.json.lock; if it carries a live holder
// (start-time-aware liveness defends against PID reuse, cross-host
// holders are conservatively treated as live), refuse to prune. The
// caller's `--yes` confirmation gates user intent; this gate prevents
// the user from accidentally tearing state out from under a live
// supervisor that's still mid-write.
const readJsonOpt = (fs: Fs, path: string): Effect.Effect<unknown> =>
	fs.readFileString(path).pipe(
		Effect.flatMap((txt) =>
			Effect.try({ try: () => JSON.parse(txt) as unknown, catch: () => undefined }).pipe(
				Effect.orElseSucceed(() => undefined),
			),
		),
		Effect.orElseSucceed(() => undefined),
	);

const ensureNoLiveHolder = (
	fs: Fs,
	app: string,
	stack: string,
	stateDir: string,
): Effect.Effect<void, PruneStackBlockedError> =>
	Effect.gen(function* () {
		const lockPath = joinPath(stateDir, 'stacks', stack, 'state.json.lock');
		const exists = yield* fs.exists(lockPath).pipe(Effect.orElseSucceed(() => false));
		if (!exists) return;
		const parsed = yield* readJsonOpt(fs, lockPath);
		if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return;
		const body = parsed as { pid?: unknown; startedAt?: unknown; host?: unknown };
		const pid =
			typeof body.pid === 'number' && Number.isFinite(body.pid) && body.pid > 0
				? body.pid
				: undefined;
		if (pid === undefined) return;
		const startedAt = typeof body.startedAt === 'string' ? body.startedAt : '';
		const host = typeof body.host === 'string' ? body.host : '';
		if (!isHolderLive({ pid, startedAt, host })) return;
		return yield* Effect.fail(new PruneStackBlockedError({ app, stack, lockPath, holderPid: pid }));
	});

type Spawner = ReturnType<typeof ChildProcessSpawner.make>;
type Fs = ReturnType<typeof FileSystem.make>;

export interface PruneStackOptions {
	readonly app: string;
	readonly stack: string;
	/**
	 * Network dimension of the (app, stack) we're tearing down. Used
	 * to drop the matching registry entry on the way out. Defaults to
	 * `'localnet'` for backward compatibility — `wipe` doesn't yet
	 * propagate network (single-stack-per-cwd assumption), so this
	 * lines up with how state-store paths are written.
	 */
	readonly network?: RegistryNetwork;
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

// The three per-(app, stack) docker-ls + iterate-and-rm loops live in
// `engine/docker/inventory.ts:removeDockerByLabel` now (CC-6). Image
// removal stays inline below because it matches on a repo-name glob
// rather than the app/stack labels.

const removeDevstackImages = (spawner: Spawner): Effect.Effect<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		const lsCmd = ChildProcess.make('docker', [
			'images',
			'--format',
			'{{.Repository}}:{{.Tag}}',
			'devstack-*',
		]);
		const out = yield* spawner.string(lsCmd).pipe(Effect.orElseSucceed(() => ''));
		const tags = out
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0 && !s.endsWith(':<none>'));
		const removed: Array<string> = [];
		for (const tag of tags) {
			const rmiCmd = ChildProcess.make('docker', ['rmi', tag]);
			const ok = yield* spawner.string(rmiCmd).pipe(
				Effect.map(() => true),
				Effect.orElseSucceed(() => false),
			);
			if (ok) removed.push(tag);
		}
		return removed as ReadonlyArray<string>;
	});

/**
 * Remove every image carrying the `devstack.image=true` label that no
 * surviving container references. Used by `prune --include-images` as
 * the global-image-cleanup pass (kept distinct from
 * `removeDevstackImages` which matches on the `devstack-*`
 * repo-name glob).
 *
 * Skips in-use images silently: `docker rmi` against a referenced
 * image errors with `image is being used by stopped container <id>`.
 * Filtering up front avoids the noise.
 */
export const removeLabelledImagesNotInUse = (): Effect.Effect<
	ReadonlyArray<string>,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const lsCmd = ChildProcess.make('docker', [
			'images',
			'--filter',
			'label=devstack.image=true',
			'--format',
			'{{.ID}}\t{{.Repository}}:{{.Tag}}',
		]);
		const out = yield* spawner.string(lsCmd).pipe(Effect.orElseSucceed(() => ''));
		const inUseCmd = ChildProcess.make('docker', [
			'ps',
			'-a',
			'--format',
			'{{.Image}}\t{{.ImageID}}',
		]);
		const inUseRaw = yield* spawner.string(inUseCmd).pipe(Effect.orElseSucceed(() => ''));
		const inUse = new Set<string>();
		for (const line of inUseRaw.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			const parts = trimmed.split('\t');
			for (const p of parts) if (p.length > 0) inUse.add(p);
		}
		const removed: Array<string> = [];
		const seen = new Set<string>();
		for (const line of out.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			const parts = trimmed.split('\t');
			if (parts.length < 2) continue;
			const [id, tag] = parts as [string, string];
			if (seen.has(id)) continue;
			seen.add(id);
			if (inUse.has(id) || inUse.has(tag)) continue;
			const target = tag.endsWith(':<none>') ? id : tag;
			const rmiCmd = ChildProcess.make('docker', ['rmi', target]);
			const ok = yield* spawner.string(rmiCmd).pipe(
				Effect.map(() => true),
				Effect.orElseSucceed(() => false),
			);
			if (ok) removed.push(target);
		}
		return removed as ReadonlyArray<string>;
	});

// Two layouts: per-stack (<stateDir>/stacks/<stack>/) and flat
// (<stateDir>/state.json). Best-effort: missing paths are silent.
//
// Extras-aware traversal: the shared upstream cache
// `<stateDir>/sui-fork-cache/` lives at the state-root level, NOT under
// `stacks/<stack>/`, so it's already out of scope for this function.
// Per-stack `sui-fork/` (data dir + meta.json + seed-manifest.json +
// data.lock) lives inside `<stateDir>/stacks/<stack>/sui-fork/` and IS
// removed alongside the rest of the per-stack state — that's the
// correct contract for `wipe`: per-stack data goes, shared cache stays.
// `--also-upstream-cache` in `wipe.ts` is the explicit knob for clearing
// the shared cache in one pass.
const removeStateOnDisk = (
	fs: Fs,
	stateDir: string,
	stack: string,
	keepSnapshots: boolean,
): Effect.Effect<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		const removed: Array<string> = [];
		const stackDir = joinPath(stateDir, 'stacks', stack);
		const stackExists = yield* fs.exists(stackDir).pipe(Effect.orElseSucceed(() => false));
		if (stackExists) {
			if (keepSnapshots) {
				const entries = yield* fs
					.readDirectory(stackDir)
					.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
				for (const entry of entries) {
					if (entry === 'snapshots') continue;
					const full = joinPath(stackDir, entry);
					yield* fs.remove(full, { recursive: true, force: true }).pipe(Effect.ignore);
					removed.push(full);
				}
			} else {
				yield* fs.remove(stackDir, { recursive: true, force: true }).pipe(Effect.ignore);
				removed.push(stackDir);
			}
		}
		const flatStateFile = joinPath(stateDir, 'state.json');
		const flatExists = yield* fs.exists(flatStateFile).pipe(Effect.orElseSucceed(() => false));
		if (flatExists) {
			yield* fs.remove(flatStateFile, { force: true }).pipe(Effect.ignore);
			removed.push(flatStateFile);
		}
		// Defensive: explicitly verify the shared upstream cache at
		// `<stateDir>/sui-fork-cache/` is NOT under the loop above. If a
		// future layout change moves the cache under `stacks/<stack>/`, the
		// integration test in P4.T7 (`wipe.fork-keeps-cache.docker.test.ts`)
		// catches the regression. No-op today; documents the invariant.
		void joinPath(stateDir, 'sui-fork-cache');
		return removed as ReadonlyArray<string>;
	});

const removeExtraStateDirs = (
	fs: Fs,
	dirs: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		const removed: Array<string> = [];
		for (const dir of dirs) {
			const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
			if (!exists) continue;
			yield* fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore);
			removed.push(dir);
		}
		return removed as ReadonlyArray<string>;
	});

export const pruneStack = (
	options: PruneStackOptions,
): Effect.Effect<
	PruneStackResult,
	PruneStackBlockedError,
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Registry
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const registry = yield* Registry;
		const stateDir = resolveStateDir({
			override: options.stateDir !== undefined ? Option.some(options.stateDir) : Option.none(),
		});

		// State-store lock check at the lowest mutating layer. Both `wipe`
		// and `prune` already do similar live-supervisor checks in their
		// own paths, but centralizing here ensures any future caller of
		// pruneStack inherits the same defense.
		yield* ensureNoLiveHolder(fs, options.app, options.stack, stateDir);

		let killedContainers: ReadonlyArray<string> = [];
		let removedNetworks: ReadonlyArray<string> = [];
		let removedVolumes: ReadonlyArray<string> = [];
		if (options.noStop !== true) {
			killedContainers = yield* removeDockerByLabel(
				spawner,
				'container',
				options.app,
				options.stack,
			);
			// Network + volume removal must wait for the kill pass: docker
			// rejects `network rm` / `volume rm` against live endpoints /
			// mounts.
			removedNetworks = yield* removeDockerByLabel(spawner, 'network', options.app, options.stack);
			removedVolumes = yield* removeDockerByLabel(spawner, 'volume', options.app, options.stack);
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

		// Drop the matching registry entry on the way out so the doctor
		// inventory + interactive prune no longer surface this row.
		// Best-effort: a stale entry in the registry never blocks the
		// docker / state teardown above.
		const network: RegistryNetwork = options.network ?? 'localnet';
		yield* registry.remove(options.app, options.stack, network).pipe(Effect.ignore);

		return {
			killedContainers,
			removedNetworks,
			removedVolumes,
			removedStatePaths,
			removedImages,
		};
	}).pipe(
		Effect.withSpan('PruneStack', { attributes: { app: options.app, stack: options.stack } }),
	);
