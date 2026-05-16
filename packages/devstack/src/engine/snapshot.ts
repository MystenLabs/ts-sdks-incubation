// Snapshot / restore for the devstack state-store. A snapshot is a point-in-
// time copy of `.devstack/state.json` (the published-package-IDs / port-leases
// cache that lets `devstack up` resume without re-publishing or re-genesis)
// plus optional docker-image tarballs for the containers the stack manages.
//
// Layout on disk:
//
//   <dir>/<id>/state.json         — copy of the state-store file
//   <dir>/<id>/meta.json          — { createdAt: <ms since epoch> }
//   <dir>/<id>/containers/*.tar   — `docker save` output, one per container
//
// snapshot() takes an optional `containers: {id, name}[]`. For each entry it
// `docker commit`s the live container into `devstack-snap:<id>-<name>` and
// `docker save`s the resulting image into `containers/<name>.tar`. The
// returned `containerTars` lists the tarball paths.
//
// restore() walks `containers/` and `docker load`s each tarball back into the
// local daemon, returning the loaded image tags. Re-running the snapshot
// images is the caller's responsibility — we don't track the run-time config
// (ports, env, network) inside this primitive yet.

import { Effect, FileSystem, Path, Schema } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process';
import * as Docker from './docker.js';

// Mirror state-store.ts: env var overrides, default to `.devstack`.
const STATE_DIR = process.env.DEVSTACK_STATE_DIR ?? '.devstack';
const STATE_FILE_NAME = 'state.json';
const META_FILE_NAME = 'meta.json';
const CONTAINERS_DIR_NAME = 'containers';
const DEFAULT_SNAPSHOTS_DIR = `${STATE_DIR}/snapshots`;

export class SnapshotError extends Schema.TaggedErrorClass<SnapshotError>()('SnapshotError', {
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

const SnapshotMeta = Schema.Struct({
	createdAt: Schema.Number,
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

/**
 * Capture current state to a snapshot dir.
 *
 * Copies `${STATE_DIR}/state.json` into `${dir}/${id}/state.json` and writes
 * a `meta.json` sibling with `{ createdAt: Date.now() }`. If `containers` is
 * provided, also `docker commit`s each container into a `devstack-snap:` tag
 * and `docker save`s the image into `${dir}/${id}/containers/${name}.tar`.
 *
 * Returns the absolute snapshot directory and the list of saved tar paths so
 * the caller can log / display what was captured.
 */
export const snapshot = (opts: {
	id: string;
	dir?: string;
	containers?: ReadonlyArray<{ id: string; name: string }>;
}): Effect.Effect<
	{ path: string; containerTars: ReadonlyArray<string> },
	SnapshotError,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		const snapshotsDir = opts.dir ?? DEFAULT_SNAPSHOTS_DIR;
		const target = path.join(snapshotsDir, opts.id);
		const stateSrc = path.join(STATE_DIR, STATE_FILE_NAME);
		const stateDst = path.join(target, STATE_FILE_NAME);
		const metaDst = path.join(target, META_FILE_NAME);
		const containersDir = path.join(target, CONTAINERS_DIR_NAME);

		yield* fs
			.makeDirectory(target, { recursive: true })
			.pipe(Effect.mapError(wrapError(`failed to create snapshot dir ${target}`)));

		// If there's no state.json yet, the snapshot is still meaningful (an
		// empty stack at this point) — write only the meta file and return.
		const hasState = yield* fs
			.exists(stateSrc)
			.pipe(Effect.mapError(wrapError(`failed to stat ${stateSrc}`)));

		if (hasState) {
			yield* fs
				.copyFile(stateSrc, stateDst)
				.pipe(Effect.mapError(wrapError(`failed to copy ${stateSrc} -> ${stateDst}`)));
		}

		const meta: SnapshotMeta = { createdAt: Date.now() };
		yield* fs
			.writeFileString(metaDst, JSON.stringify(meta, null, 2))
			.pipe(Effect.mapError(wrapError(`failed to write ${metaDst}`)));

		// Container snapshot path: commit each container into a snapshot-
		// scoped tag, then save to a tar inside `containers/`. We only
		// create the containers dir when the caller actually has containers
		// to snapshot — keeps the on-disk layout tidy for the common
		// state-only case.
		const containers = opts.containers ?? [];
		const containerTars: Array<string> = [];
		if (containers.length > 0) {
			yield* fs
				.makeDirectory(containersDir, { recursive: true })
				.pipe(Effect.mapError(wrapError(`failed to create ${containersDir}`)));

			for (const container of containers) {
				const imageName = `devstack-snap:${opts.id}-${container.name}`;
				const tarPath = path.join(containersDir, `${container.name}.tar`);

				yield* Docker.commitContainer(container.id, imageName).pipe(
					Effect.mapError(wrapDockerError(`failed to commit container ${container.name}`)),
				);
				yield* Docker.saveImage(imageName, tarPath).pipe(
					Effect.mapError(wrapDockerError(`failed to save image ${imageName}`)),
				);
				containerTars.push(tarPath);
			}
		}

		return { path: target, containerTars };
	}).pipe(Effect.withSpan('snapshot.create', { attributes: { 'snapshot.id': opts.id } }));

/**
 * Restore from a snapshot.
 *
 * Copies `${dir}/${id}/state.json` back over `${STATE_DIR}/state.json` and
 * `docker load`s every tar in `${dir}/${id}/containers/`. Returns the loaded
 * image tags. Errors loudly if the snapshot directory does not exist —
 * silent fall-through would hide a typo in the id.
 *
 * Re-starting containers from the loaded images is the caller's job; we
 * don't store run-time config (ports, env, network) inside the snapshot yet.
 */
export const restore = (opts: {
	id: string;
	dir?: string;
}): Effect.Effect<
	{ loadedImages: ReadonlyArray<string> },
	SnapshotError,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		const snapshotsDir = opts.dir ?? DEFAULT_SNAPSHOTS_DIR;
		const source = path.join(snapshotsDir, opts.id);
		const stateSrc = path.join(source, STATE_FILE_NAME);
		const stateDst = path.join(STATE_DIR, STATE_FILE_NAME);
		const containersDir = path.join(source, CONTAINERS_DIR_NAME);

		const exists = yield* fs
			.exists(source)
			.pipe(Effect.mapError(wrapError(`failed to stat ${source}`)));

		if (!exists) {
			return yield* new SnapshotError({ message: `snapshot ${opts.id} not found at ${source}` });
		}

		const hasState = yield* fs
			.exists(stateSrc)
			.pipe(Effect.mapError(wrapError(`failed to stat ${stateSrc}`)));

		if (hasState) {
			yield* fs
				.makeDirectory(STATE_DIR, { recursive: true })
				.pipe(Effect.mapError(wrapError(`failed to create ${STATE_DIR}`)));
			yield* fs
				.copyFile(stateSrc, stateDst)
				.pipe(Effect.mapError(wrapError(`failed to copy ${stateSrc} -> ${stateDst}`)));
		}

		// Container restore path: walk `containers/*.tar` and `docker load`
		// each one. We accept any file in the dir; the daemon will reject a
		// malformed tar with a clear error that we surface as SnapshotError.
		const loadedImages: Array<string> = [];
		const hasContainersDir = yield* fs
			.exists(containersDir)
			.pipe(Effect.mapError(wrapError(`failed to stat ${containersDir}`)));

		if (hasContainersDir) {
			const entries = yield* fs
				.readDirectory(containersDir)
				.pipe(Effect.mapError(wrapError(`failed to read ${containersDir}`)));

			for (const entry of entries) {
				if (!entry.endsWith('.tar')) continue;
				const tarPath = path.join(containersDir, entry);
				const { tag } = yield* Docker.loadImage(tarPath).pipe(
					Effect.mapError(wrapDockerError(`failed to load image from ${tarPath}`)),
				);
				loadedImages.push(tag);
			}
		}

		return { loadedImages };
	}).pipe(Effect.withSpan('snapshot.restore', { attributes: { 'snapshot.id': opts.id } }));

/**
 * List available snapshots, ordered by `createdAt` ascending.
 *
 * A directory entry without a parseable `meta.json` is skipped — a partial
 * snapshot from a crashed `snapshot()` shouldn't crash `list()`.
 */
export const list = (opts?: {
	dir?: string;
}): Effect.Effect<
	ReadonlyArray<{ id: string; createdAt: number }>,
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

		const results: Array<{ id: string; createdAt: number }> = [];
		for (const id of entries) {
			const metaPath = path.join(snapshotsDir, id, META_FILE_NAME);
			const metaExists = yield* fs.exists(metaPath).pipe(Effect.orElseSucceed(() => false));
			if (!metaExists) continue;
			const parsed = yield* fs.readFileString(metaPath).pipe(
				Effect.flatMap((txt) =>
					Effect.try({
						try: () => JSON.parse(txt) as { createdAt?: unknown },
						catch: (cause) => cause,
					}),
				),
				Effect.orElseSucceed(() => undefined),
			);
			if (!parsed || typeof parsed.createdAt !== 'number') continue;
			results.push({ id, createdAt: parsed.createdAt });
		}

		results.sort((a, b) => a.createdAt - b.createdAt);
		return results;
	}).pipe(Effect.withSpan('snapshot.list'));
