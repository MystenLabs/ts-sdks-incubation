// Snapshot / restore for a devstack stack. A snapshot is a point-in-time
// capture of three things:
//
//   1. `state.json` — the state-store record (port leases, package IDs,
//      seal BLS keypair cache, walrus deploy fingerprint, …). Without
//      this, restored containers come up against chain IDs / package IDs
//      they no longer recognize.
//
//   2. `runtime/` directory — the canonical service-owned state dir
//      (`runtime/accounts/<name>.key`, `runtime/wallet/token`,
//      `runtime/seal/master-key.env`, `runtime/walrus/<name>/deploy/`,
//      …). Phase 3 of the snapshot redesign collected these scattered
//      paths into one directory; the snapshot tars it as a single
//      tarball.
//
//   3. Container images — for every container in `opts.containers` we
//      `docker commit devstack-snap:<id>-<name>` + `docker save` the
//      resulting image into `containers/<name>.tar`. Phase 2 of the
//      redesign put chain state in the writable layer (RocksDB at
//      `/root/.sui`, postgres at `/pgdata`), so the committed image
//      contains everything the localnet + indexer need to resume.
//
// Optional extras (`opts.extras`): an opt-in registry of additional
// host paths that don't fit under `runtime/<service>/` (typically
// system-level paths a plugin author can't redirect). Tarred into
// `<snapshot>/extras/<key>.tar` and recorded in meta.json.
//
// Layout on disk:
//
//   <dir>/<id>/state.json         — copy of the state-store file
//   <dir>/<id>/runtime.tar        — tar of the canonical runtime/ dir
//   <dir>/<id>/containers/*.tar   — docker save output, one per container
//   <dir>/<id>/extras/<key>.tar   — opt-in extras tars
//   <dir>/<id>/meta.json          — { version, createdAt, stack, network,
//                                       containers: [...], extras: [...] }
//
// Restore is the reverse: untar runtime back into place, untar extras,
// copy state.json back, docker load each container tar. After restore,
// the next `devstack up` adopts the loaded images via the
// reuse-if-image-matches probe in `Docker.run` — no manual restart of
// individual containers is needed.

import { Effect, FileSystem, Path, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import * as Docker from './docker.js';
import { RUNTIME_DIR_NAME } from './service-paths.js';

// Mirror state-store.ts: env var overrides, default to `.devstack`.
const STATE_DIR = process.env.DEVSTACK_STATE_DIR ?? '.devstack';
const STATE_FILE_NAME = 'state.json';
const META_FILE_NAME = 'meta.json';
const RUNTIME_TAR_NAME = 'runtime.tar';
const CONTAINERS_DIR_NAME = 'containers';
const EXTRAS_DIR_NAME = 'extras';
const DEFAULT_SNAPSHOTS_DIR = `${STATE_DIR}/snapshots`;

// v3 (current): adds `app` to top-level + `originalImage` per container.
//   Without `originalImage`, restore can't retag the loaded snapshot
//   image back to the supervisor's content-addressed base tag — so the
//   supervisor's `Docker.run` reuse probe sees a name match but image
//   mismatch and recreates from a fresh base image, running a brand-new
//   genesis. Chain state is lost. v2 snapshots are still readable by
//   `list()` but won't restore container content correctly.
const META_VERSION = 3;

export class SnapshotError extends Schema.TaggedErrorClass<SnapshotError>()('SnapshotError', {
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

const ContainerEntry = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	/** The base image tag the container was created with (i.e. the
	 *  supervisor's content-addressed `devstack-*.image:<hash>` tag).
	 *  Restore retags the loaded snapshot image to this string so the
	 *  next `Docker.run`'s name+image match probe finds the snapshot's
	 *  content. Optional for backwards-compat with v2 snapshots. */
	originalImage: Schema.optional(Schema.String),
});

const ExtraEntry = Schema.Struct({
	key: Schema.String,
	path: Schema.String,
});

const SnapshotMeta = Schema.Struct({
	version: Schema.optional(Schema.Number),
	createdAt: Schema.Number,
	stack: Schema.optional(Schema.String),
	/** Devstack app identity at save time. Needed at restore time to
	 *  scope the pre-restore `docker rm -f` to THIS app's stale
	 *  containers (so a sibling app's stack=main containers aren't
	 *  nuked). Optional for backwards-compat with v2 snapshots. */
	app: Schema.optional(Schema.String),
	network: Schema.optional(Schema.String),
	containers: Schema.optional(Schema.Array(ContainerEntry)),
	extras: Schema.optional(Schema.Array(ExtraEntry)),
	runtimeIncluded: Schema.optional(Schema.Boolean),
});
type SnapshotMeta = typeof SnapshotMeta.Type;

const wrapError = (message: string) => (cause: unknown) => new SnapshotError({ message, cause });

// Funnel DockerError → SnapshotError so callers only need to handle one tag.
// The docker op name is preserved in the message so failures are still
// debuggable from logs.
const wrapDockerError =
	(context: string) =>
	(cause: Docker.DockerError): SnapshotError =>
		new SnapshotError({
			message: `${context}: ${cause.op} failed — ${cause.message}`,
			cause,
		});

const wrapSpawnError = (op: string) => (cause: unknown) =>
	new SnapshotError({ message: `${op} failed`, cause });

// -----------------------------------------------------------------------------
// Path resolution — mirrors `engine/state-store.ts:resolvePaths` +
// `engine/service-paths.ts:resolveRuntimeRoot` so the snapshot pipeline
// reads from / writes to the same paths the live services do.
// -----------------------------------------------------------------------------

interface StackPaths {
	readonly stateFile: string;
	readonly runtimeDir: string;
}

const resolveStackPaths = (stack: string, network: string, pathSvc: Path.Path): StackPaths => {
	const envOverride = process.env.DEVSTACK_STATE_DIR;
	if (envOverride !== undefined && envOverride.length > 0) {
		return {
			stateFile: pathSvc.join(envOverride, STATE_FILE_NAME),
			runtimeDir: pathSvc.join(envOverride, RUNTIME_DIR_NAME),
		};
	}
	const appDir = process.env.DEVSTACK_APP_DIR ?? process.cwd();
	if (network === 'localnet') {
		const base = pathSvc.join(appDir, '.devstack', 'stacks', stack);
		return {
			stateFile: pathSvc.join(base, STATE_FILE_NAME),
			runtimeDir: pathSvc.join(base, RUNTIME_DIR_NAME),
		};
	}
	const base = pathSvc.join(appDir, '.devstack', 'networks', network);
	return {
		stateFile: pathSvc.join(base, `${network}.json`),
		runtimeDir: pathSvc.join(base, RUNTIME_DIR_NAME),
	};
};

// -----------------------------------------------------------------------------
// tar helpers — spawn `tar` directly. We use the system tar binary so we
// preserve mode bits + symlinks without pulling in a Node tar library
// (which would add ~50KB to the bundle for a single capability we use
// in two places).
// -----------------------------------------------------------------------------

const tarCreate = (
	spawner: ReturnType<typeof ChildProcessSpawner.make>,
	srcDir: string,
	tarPath: string,
): Effect.Effect<void, SnapshotError> =>
	Effect.gen(function* () {
		// `-C srcDir .` makes the archive entries relative to `srcDir`'s
		// children, so untarring at a different absolute path on restore
		// puts files at the right offsets without leading-slash stripping.
		const cmd = ChildProcess.make('tar', ['-cf', tarPath, '-C', srcDir, '.']);
		const exitCode = yield* spawner
			.exitCode(cmd)
			.pipe(Effect.mapError(wrapSpawnError(`tar -cf ${tarPath}`)));
		if (exitCode !== 0) {
			return yield* Effect.fail(
				new SnapshotError({
					message: `tar -cf ${tarPath} exited ${exitCode}`,
				}),
			);
		}
	});

const tarExtract = (
	spawner: ReturnType<typeof ChildProcessSpawner.make>,
	tarPath: string,
	dstDir: string,
): Effect.Effect<void, SnapshotError> =>
	Effect.gen(function* () {
		// `--no-same-owner` so a restore running as a different UID
		// than the save (e.g. CI runner ≠ developer's local user)
		// doesn't fail with EPERM on chown. The files end up owned by
		// whoever ran restore — fine for devstack's use case where the
		// runtime/ contents are scoped to the current shell session.
		// Supported by both GNU tar and BSD tar.
		const cmd = ChildProcess.make('tar', ['-xf', tarPath, '-C', dstDir, '--no-same-owner']);
		const exitCode = yield* spawner
			.exitCode(cmd)
			.pipe(Effect.mapError(wrapSpawnError(`tar -xf ${tarPath}`)));
		if (exitCode !== 0) {
			return yield* Effect.fail(
				new SnapshotError({
					message: `tar -xf ${tarPath} exited ${exitCode}`,
				}),
			);
		}
	});

// -----------------------------------------------------------------------------
// preCleanupApp — `docker rm -f` containers matching (app, stack).
//
// Called from `restore` BEFORE loading container tars. Without this, a
// container that was already running before the restore (perhaps from
// a separate `apply` against unrelated state) would shadow the loaded
// snapshot image — the supervisor's reuse-if-name-and-image-match probe
// in `Docker.run` would adopt the EXISTING container and never recreate
// from the (newly retagged) snapshot image. Nuking app+stack containers
// first forces the next `apply` through the `fresh` path so the
// snapshot's content is what gets booted. Best-effort throughout —
// daemon down or no matching containers is a silent no-op.
// -----------------------------------------------------------------------------

const preCleanupApp = (
	spawner: ReturnType<typeof ChildProcessSpawner.make>,
	app: string,
	stack: string,
): Effect.Effect<void, never> =>
	Effect.gen(function* () {
		const lsCmd = ChildProcess.make('docker', [
			'ps',
			'-aq',
			'--filter',
			`label=devstack.app=${app}`,
			'--filter',
			`label=devstack.stack=${stack}`,
		]);
		const text = yield* spawner.string(lsCmd).pipe(Effect.orElseSucceed(() => ''));
		const ids = text
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		for (const id of ids) {
			yield* spawner.exitCode(ChildProcess.make('docker', ['rm', '-f', id])).pipe(Effect.ignore);
		}
	}).pipe(
		Effect.withSpan('snapshot.preCleanupApp', {
			attributes: { 'snapshot.app': app, 'snapshot.stack': stack },
		}),
	);

// -----------------------------------------------------------------------------
// snapshot()
// -----------------------------------------------------------------------------

export const snapshot = (opts: {
	id: string;
	dir?: string;
	/** Devstack app identity at save time. Stored in meta.json so
	 *  restore can scope the pre-load `docker rm -f` to THIS app's
	 *  containers (sibling apps that share `stack=main` are unaffected). */
	app?: string;
	/** Stack identity. Defaults to 'main'. */
	stack?: string;
	/** Network for path scoping. Defaults to 'localnet'. */
	network?: string;
	/** Containers to commit + save. Caller (CLI) enumerates them via
	 *  `docker ps -a --filter label=devstack.app=<app>,devstack.stack=<stack>`.
	 *  Empty array skips the container pass — useful for state-only
	 *  snapshots that don't capture the writable layer (smaller artifact
	 *  at the cost of needing the next `up` to rebuild chain state). */
	containers?: ReadonlyArray<{ id: string; name: string }>;
	/** Opt-in extras: absolute paths that live outside `runtime/` but
	 *  should still ride the snapshot. Registered via
	 *  `ServicePaths.addExtra(...)` from a plugin's boot Effect. */
	extras?: ReadonlyArray<{ key: string; path: string }>;
	/** Skip the runtime/ tarball. False by default. Set true for a
	 *  pure container-only snapshot — rare, but useful when the runtime
	 *  dir is large and the caller intends to manage its capture
	 *  separately. */
	skipRuntime?: boolean;
}): Effect.Effect<
	{
		path: string;
		containerTars: ReadonlyArray<string>;
		runtimeTar: string | undefined;
		extrasTars: ReadonlyArray<string>;
	},
	SnapshotError,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

		const stack = opts.stack ?? 'main';
		const network = opts.network ?? 'localnet';
		const stackPaths = resolveStackPaths(stack, network, path);

		const snapshotsDir = opts.dir ?? DEFAULT_SNAPSHOTS_DIR;
		const target = path.join(snapshotsDir, opts.id);
		const stateDst = path.join(target, STATE_FILE_NAME);
		const metaDst = path.join(target, META_FILE_NAME);
		const runtimeTarDst = path.join(target, RUNTIME_TAR_NAME);
		const containersDir = path.join(target, CONTAINERS_DIR_NAME);
		const extrasDir = path.join(target, EXTRAS_DIR_NAME);

		yield* fs
			.makeDirectory(target, { recursive: true })
			.pipe(Effect.mapError(wrapError(`failed to create snapshot dir ${target}`)));

		// 1. state.json — preserves the cached state-store entries
		// (package IDs, port leases, seal BLS keypair cache, walrus
		// deploy fingerprint). Optional: an empty stack at snapshot
		// time has no state.json yet, and that's fine.
		const hasState = yield* fs
			.exists(stackPaths.stateFile)
			.pipe(Effect.mapError(wrapError(`failed to stat ${stackPaths.stateFile}`)));
		if (hasState) {
			yield* fs
				.copyFile(stackPaths.stateFile, stateDst)
				.pipe(Effect.mapError(wrapError(`failed to copy ${stackPaths.stateFile} -> ${stateDst}`)));
		}

		// 2. runtime/ — tar the canonical service-owned state dir.
		// `tar` is happy to archive an empty or missing tree on Linux,
		// but the macOS BSD tar errors on a non-existent source; gate
		// on `fs.exists` so first-time snapshots of a stack that
		// hasn't booted yet don't fail loudly.
		let runtimeTar: string | undefined;
		if (opts.skipRuntime !== true) {
			const hasRuntime = yield* fs
				.exists(stackPaths.runtimeDir)
				.pipe(Effect.mapError(wrapError(`failed to stat ${stackPaths.runtimeDir}`)));
			if (hasRuntime) {
				yield* tarCreate(spawner, stackPaths.runtimeDir, runtimeTarDst);
				runtimeTar = runtimeTarDst;
			}
		}

		// 3. Containers — commit each into a snapshot-scoped tag and
		// save to a tar inside `containers/`. We ALSO record the
		// container's original base-image tag (via `docker inspect
		// --format '{{.Config.Image}}'`) so restore can retag the
		// loaded snapshot image back to that string — that's what makes
		// the supervisor's name+image reuse probe in `Docker.run`
		// actually adopt the snapshot's content instead of recreating
		// from a fresh base image (which would run a new genesis →
		// chain state lost). Only create the containers dir when we
		// actually have containers to save (keeps the on-disk layout
		// tidy for state-only snapshots).
		const containers = opts.containers ?? [];
		const containerTars: Array<string> = [];
		const containerEntries: Array<{ id: string; name: string; originalImage?: string }> = [];
		if (containers.length > 0) {
			yield* fs
				.makeDirectory(containersDir, { recursive: true })
				.pipe(Effect.mapError(wrapError(`failed to create ${containersDir}`)));
			for (const container of containers) {
				const imageName = `devstack-snap:${opts.id}-${container.name}`;
				const tarPath = path.join(containersDir, `${container.name}.tar`);
				const originalImage = yield* Docker.inspectContainerImage(container.id);
				// Pause the container around `docker commit` so the
				// resulting image captures a quiescent writable layer.
				// Without this, RocksDB / postgres mid-WAL-fsync at
				// commit time produces snapshots that need recovery on
				// next boot or fail to open entirely. `docker pause`
				// errors on a stopped container, so skip the pause when
				// the container isn't currently running (already
				// quiescent in that case). The unpause is registered via
				// `Effect.ensuring` so it fires on both success and
				// failure of the commit.
				const isRunning = yield* Docker.inspectContainerRunning(container.id);
				const commit = Docker.commitContainer(container.id, imageName).pipe(
					Effect.mapError(wrapDockerError(`failed to commit container ${container.name}`)),
				);
				if (isRunning === true) {
					yield* Docker.pauseContainer(container.id).pipe(
						Effect.mapError(wrapDockerError(`failed to pause container ${container.name}`)),
					);
					yield* commit.pipe(
						Effect.ensuring(Docker.unpauseContainer(container.id).pipe(Effect.ignore)),
					);
				} else {
					yield* commit;
				}
				yield* Docker.saveImage(imageName, tarPath).pipe(
					Effect.mapError(wrapDockerError(`failed to save image ${imageName}`)),
				);
				containerTars.push(tarPath);
				containerEntries.push({
					id: container.id,
					name: container.name,
					...(originalImage !== undefined ? { originalImage } : {}),
				});
			}
		}

		// 4. Extras — opt-in absolute paths registered via
		// `ServicePaths.addExtra`. Each becomes a single tar in
		// `<snapshot>/extras/<key>.tar` whose archive is rooted at
		// the parent of the path so extract restores the full
		// absolute path verbatim. (Captured this way rather than
		// `tar -C / -P <path>` to avoid pulling the entire root.)
		const extras = opts.extras ?? [];
		const extrasTars: Array<string> = [];
		if (extras.length > 0) {
			yield* fs
				.makeDirectory(extrasDir, { recursive: true })
				.pipe(Effect.mapError(wrapError(`failed to create ${extrasDir}`)));
			for (const extra of extras) {
				const tarPath = path.join(extrasDir, `${extra.key}.tar`);
				const exists = yield* fs
					.exists(extra.path)
					.pipe(Effect.mapError(wrapError(`failed to stat ${extra.path}`)));
				if (!exists) {
					// Skip missing extras rather than failing — a plugin
					// might register an extra whose path is only populated
					// after a specific code path runs.
					continue;
				}
				yield* tarCreate(spawner, extra.path, tarPath);
				extrasTars.push(tarPath);
			}
		}

		// 5. meta.json — schema-versioned record of what's in this
		// snapshot. `restore` reads it back to know which subset of
		// the four passes to run AND which app+stack labels to scope
		// its pre-load cleanup to.
		const meta: SnapshotMeta = {
			version: META_VERSION,
			createdAt: Date.now(),
			stack,
			...(opts.app !== undefined ? { app: opts.app } : {}),
			network,
			runtimeIncluded: runtimeTar !== undefined,
			...(containerEntries.length > 0 ? { containers: containerEntries } : {}),
			...(extras.length > 0 ? { extras: extras.map((e) => ({ key: e.key, path: e.path })) } : {}),
		};
		yield* fs
			.writeFileString(metaDst, JSON.stringify(meta, null, 2))
			.pipe(Effect.mapError(wrapError(`failed to write ${metaDst}`)));

		return { path: target, containerTars, runtimeTar, extrasTars };
	}).pipe(Effect.withSpan('snapshot.create', { attributes: { 'snapshot.id': opts.id } }));

// -----------------------------------------------------------------------------
// restore()
// -----------------------------------------------------------------------------

export const restore = (opts: {
	id: string;
	dir?: string;
	/** Stack identity. Defaults to 'main'. Should match (or be empty
	 *  for) the meta.json's recorded stack — the meta is informational
	 *  only, the caller can intentionally restore across stacks. */
	stack?: string;
	network?: string;
}): Effect.Effect<
	{
		loadedImages: ReadonlyArray<string>;
		runtimeRestored: boolean;
		extrasRestored: ReadonlyArray<string>;
	},
	SnapshotError,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

		const stack = opts.stack ?? 'main';
		const network = opts.network ?? 'localnet';
		const stackPaths = resolveStackPaths(stack, network, path);

		const snapshotsDir = opts.dir ?? DEFAULT_SNAPSHOTS_DIR;
		const source = path.join(snapshotsDir, opts.id);
		const stateSrc = path.join(source, STATE_FILE_NAME);
		const runtimeTarSrc = path.join(source, RUNTIME_TAR_NAME);
		const containersDir = path.join(source, CONTAINERS_DIR_NAME);
		const extrasDir = path.join(source, EXTRAS_DIR_NAME);

		const exists = yield* fs
			.exists(source)
			.pipe(Effect.mapError(wrapError(`failed to stat ${source}`)));
		if (!exists) {
			return yield* new SnapshotError({ message: `snapshot ${opts.id} not found at ${source}` });
		}

		// Read meta once — used by the pre-cleanup pass (app+stack
		// label filter), the container restore pass (originalImage
		// retag), and the extras pass (recorded paths).
		const meta = yield* readMeta(fs, path.join(source, META_FILE_NAME));

		// PRE-CLEANUP — before loading any tars, `docker rm -f` any
		// containers belonging to (meta.app, meta.stack). Reason: the
		// reuse-if-image-matches probe in `Docker.run` compares
		// container Config.Image string-equal. If a pre-existing
		// container shares the supervisor's tag string, the probe
		// adopts it and never recreates from the (newly-retagged)
		// snapshot image. Nuking first guarantees the next `apply`
		// goes through `fresh` and uses the snapshot's content. Best-
		// effort: docker daemon down, no matching containers, or
		// permission errors don't fail the restore.
		const metaApp = meta?.app;
		const metaStack = meta?.stack;
		if (metaApp !== undefined && metaStack !== undefined) {
			yield* preCleanupApp(spawner, metaApp, metaStack).pipe(Effect.ignore);
		}

		// 1. state.json — copy back over the live state-store file.
		const hasState = yield* fs
			.exists(stateSrc)
			.pipe(Effect.mapError(wrapError(`failed to stat ${stateSrc}`)));
		if (hasState) {
			const stateDir = path.dirname(stackPaths.stateFile);
			yield* fs
				.makeDirectory(stateDir, { recursive: true })
				.pipe(Effect.mapError(wrapError(`failed to create ${stateDir}`)));
			yield* fs
				.copyFile(stateSrc, stackPaths.stateFile)
				.pipe(Effect.mapError(wrapError(`failed to copy ${stateSrc} -> ${stackPaths.stateFile}`)));
		}

		// 2. runtime/ — untar back into place. mkdir-p the destination
		// first so a clean stack with no prior runtime dir works.
		let runtimeRestored = false;
		const hasRuntimeTar = yield* fs
			.exists(runtimeTarSrc)
			.pipe(Effect.mapError(wrapError(`failed to stat ${runtimeTarSrc}`)));
		if (hasRuntimeTar) {
			yield* fs
				.makeDirectory(stackPaths.runtimeDir, { recursive: true })
				.pipe(Effect.mapError(wrapError(`failed to create ${stackPaths.runtimeDir}`)));
			yield* tarExtract(spawner, runtimeTarSrc, stackPaths.runtimeDir);
			runtimeRestored = true;
		}

		// 3. Containers — `docker load` each tar back into the local
		// daemon, THEN retag the loaded snapshot image to its
		// originalImage tag (from meta) so the supervisor's next
		// `dockerImage({build})` finds the snapshot's content under
		// the expected content-addressed tag and the reuse-if-image-
		// matches probe finds a match on the freshly-recreated
		// container.
		const loadedImages: Array<string> = [];
		const hasContainersDir = yield* fs
			.exists(containersDir)
			.pipe(Effect.mapError(wrapError(`failed to stat ${containersDir}`)));
		if (hasContainersDir) {
			const entries = yield* fs
				.readDirectory(containersDir)
				.pipe(Effect.mapError(wrapError(`failed to read ${containersDir}`)));
			// Index meta.containers by `name` so we can look up
			// `originalImage` per tarball without a quadratic search.
			const byName = new Map<string, { originalImage?: string }>();
			for (const c of meta?.containers ?? []) {
				byName.set(c.name, c.originalImage !== undefined ? { originalImage: c.originalImage } : {});
			}
			for (const entry of entries) {
				if (!entry.endsWith('.tar')) continue;
				const tarPath = path.join(containersDir, entry);
				const { tag } = yield* Docker.loadImage(tarPath).pipe(
					Effect.mapError(wrapDockerError(`failed to load image from ${tarPath}`)),
				);
				loadedImages.push(tag);
				// Retag to originalImage if recorded. Best-effort: an
				// older v2 snapshot won't have it and falls back to
				// "loaded but unused" (recreates from a fresh base
				// image, runs new genesis — explicit upgrade path is
				// "wipe + re-snapshot under v3").
				const containerName = entry.replace(/\.tar$/, '');
				const meta_c = byName.get(containerName);
				if (meta_c?.originalImage !== undefined) {
					yield* Docker.tagImage(tag, meta_c.originalImage).pipe(
						Effect.mapError(wrapDockerError(`failed to retag ${tag} -> ${meta_c.originalImage}`)),
					);
				}
			}
		}

		// 4. Extras — untar each registered absolute-path extra back
		// to its original location. The meta records the source path
		// per extras key so we know where to extract.
		const extrasRestored: Array<string> = [];
		const hasExtrasDir = yield* fs
			.exists(extrasDir)
			.pipe(Effect.mapError(wrapError(`failed to stat ${extrasDir}`)));
		if (hasExtrasDir) {
			const extrasMeta = meta?.extras ?? [];
			for (const extra of extrasMeta) {
				const tarPath = path.join(extrasDir, `${extra.key}.tar`);
				const tarExists = yield* fs
					.exists(tarPath)
					.pipe(Effect.mapError(wrapError(`failed to stat ${tarPath}`)));
				if (!tarExists) continue;
				yield* fs
					.makeDirectory(extra.path, { recursive: true })
					.pipe(Effect.mapError(wrapError(`failed to create ${extra.path}`)));
				yield* tarExtract(spawner, tarPath, extra.path);
				extrasRestored.push(extra.key);
			}
		}

		return { loadedImages, runtimeRestored, extrasRestored };
	}).pipe(Effect.withSpan('snapshot.restore', { attributes: { 'snapshot.id': opts.id } }));

// -----------------------------------------------------------------------------
// list()
// -----------------------------------------------------------------------------

const decodeMetaSync = Schema.decodeUnknownSync(SnapshotMeta);

const readMeta = (
	fs: FileSystem.FileSystem,
	metaPath: string,
): Effect.Effect<SnapshotMeta | undefined, never> =>
	Effect.gen(function* () {
		const exists = yield* fs.exists(metaPath).pipe(Effect.orElseSucceed(() => false));
		if (!exists) return undefined;
		const parsed = yield* fs.readFileString(metaPath).pipe(
			Effect.flatMap((txt) =>
				Effect.try({
					try: () => JSON.parse(txt) as unknown,
					catch: (cause) => cause,
				}),
			),
			Effect.orElseSucceed(() => undefined),
		);
		if (parsed === undefined) return undefined;
		// Sync decode + try/catch (vs Effect-returning decode) — `readMeta`
		// is best-effort, the caller falls back to `undefined` and skips
		// extras / per-snapshot stack tagging when meta is malformed.
		try {
			return decodeMetaSync(parsed);
		} catch {
			return undefined;
		}
	});

/**
 * List available snapshots, ordered by `createdAt` ascending.
 *
 * A directory entry without a parseable `meta.json` is skipped — a partial
 * snapshot from a crashed `snapshot()` shouldn't crash `list()`.
 */
export const list = (opts?: {
	dir?: string;
}): Effect.Effect<
	ReadonlyArray<{ id: string; createdAt: number; stack?: string; network?: string }>,
	SnapshotError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		const snapshotsDir = opts?.dir ?? DEFAULT_SNAPSHOTS_DIR;

		const exists = yield* fs
			.exists(snapshotsDir)
			.pipe(Effect.mapError(wrapError(`failed to stat ${snapshotsDir}`)));
		if (!exists) return [] as const;

		const entries = yield* fs
			.readDirectory(snapshotsDir)
			.pipe(Effect.mapError(wrapError(`failed to read ${snapshotsDir}`)));

		const results: Array<{ id: string; createdAt: number; stack?: string; network?: string }> = [];
		for (const id of entries) {
			const meta = yield* readMeta(fs, path.join(snapshotsDir, id, META_FILE_NAME));
			if (meta === undefined) continue;
			results.push({
				id,
				createdAt: meta.createdAt,
				...(meta.stack !== undefined ? { stack: meta.stack } : {}),
				...(meta.network !== undefined ? { network: meta.network } : {}),
			});
		}

		results.sort((a, b) => a.createdAt - b.createdAt);
		return results;
	}).pipe(Effect.withSpan('snapshot.list'));
