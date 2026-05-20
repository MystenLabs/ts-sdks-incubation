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
//      …). The snapshot tars this as a single tarball.
//
//      **Load-bearing invariant**: the walrus deploy outputs at
//      `runtime/walrus/<name>/deploy/` MUST ride this tar. The directory
//      holds the storage-node private keys + per-node config that
//      `walrus-deploy` wrote; without them, a state-store entry that
//      says "walrus is already deployed" can't be honored on resume
//      (the storage-node mount step reads from this dir).
//      `acquireLocalCluster`'s verify probe detects the absence and
//      invalidates the cache entry, but the cleaner outcome is for
//      both pieces to travel together — which is what this single
//      `runtime/` tar capture achieves by construction.
//
//   3. Container images — for every container in `opts.containers` we
//      `docker commit devstack-snap:<id>-<name>` + `docker save` the
//      resulting image into `containers/<name>.tar`. Chain state lives
//      in the writable layer (RocksDB at `/root/.sui`, postgres at
//      `/pgdata`), so the committed image contains everything the
//      localnet + indexer need to resume.
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
import { captureCommand } from './capture-command.js';
import * as Docker from './docker.js';
import { DockerLabel } from './identity.js';
import { SnapshotPhases } from './phases.js';
import { resolveAppDir } from './resolve-app-dir.js';
import { RUNTIME_DIR_NAME } from './service-paths.js';

// Mirror state-store.ts: env var overrides, default to `.devstack`.
const STATE_DIR = process.env.DEVSTACK_STATE_DIR ?? '.devstack';
const STATE_FILE_NAME = 'state.json';
const META_FILE_NAME = 'meta.json';
const RUNTIME_TAR_NAME = 'runtime.tar';
const CONTAINERS_DIR_NAME = 'containers';
const EXTRAS_DIR_NAME = 'extras';
const DEFAULT_SNAPSHOTS_DIR = `${STATE_DIR}/snapshots`;

// `app` at top-level and `originalImage` per container are both
// load-bearing: without `originalImage`, restore can't retag the
// loaded snapshot image back to the supervisor's content-addressed
// base tag, so the supervisor's `Docker.run` reuse probe sees a name
// match but image mismatch and recreates from a fresh base image,
// running a brand-new genesis (chain state lost).
//
// Per-service fields (`chainId`, fork upstream / checkpoint) live in a
// typed `services` bucket extended via TypeScript declaration merging
// — see `SnapshotMetaServices` below.

export class SnapshotError extends Schema.TaggedErrorClass<SnapshotError>()('SnapshotError', {
	// `phase` discriminates which step of the save/restore pipeline
	// failed. Closed set in `engine/phases.ts::SnapshotPhases`. AGENTS.md
	// makes phase the canonical "which step" field so pretty-error's
	// `summarizeCause` can bucket failures without parsing message text
	// (E7 / E14).
	phase: Schema.Literals(SnapshotPhases),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

// One funnel for all snapshot failures. Replaces the three pre-E7
// `wrap*Error` helpers (`wrapError`, `wrapDockerError`,
// `captureToSnapshotError`) with a single phase-stamped envelope. The
// helper accepts any cause shape — unknown filesystem errors,
// DockerError, or CaptureError — and rolls the source error's own
// message into the SnapshotError message so log-grepping by the inner
// `phase` (docker / tar) still works.
const snapshotError =
	(phase: SnapshotError['phase'], context?: string) =>
	(cause: unknown): SnapshotError => {
		const ctxPart = context !== undefined ? `${context}: ` : '';
		// DockerError carries its own inner phase + message; surface both
		// so the snapshot message reads e.g.
		//   "snapshot[container-commit] failed to commit container sui:
		//    docker commit failed — image already exists".
		if (cause instanceof Docker.DockerError) {
			return new SnapshotError({
				phase,
				message: `${ctxPart}${cause.phase} failed — ${cause.message}`,
				cause,
			});
		}
		// CaptureError (engine/capture-command.ts) wraps its own cause —
		// unwrap so the SnapshotError's cause is the underlying defect,
		// not the capture-helper envelope.
		const captureLike = cause as { _tag?: string; cause?: unknown };
		if (captureLike?._tag === 'CaptureError') {
			return new SnapshotError({
				phase,
				message: `${ctxPart}failed`,
				cause: captureLike.cause ?? cause,
			});
		}
		// Unknown errors — filesystem failures (ENOENT, EACCES) and the
		// like. Carry the raw cause so prettyError walks it.
		return new SnapshotError({
			phase,
			message: ctxPart.length > 0 ? ctxPart.replace(/: $/, '') : 'failed',
			cause,
		});
	};

const ContainerEntry = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	/** The base image tag the container was created with (i.e. the
	 *  supervisor's content-addressed `devstack-*.image:<hash>` tag).
	 *  Restore retags the loaded snapshot image to this string so the
	 *  next `Docker.run`'s name+image match probe finds the snapshot's
	 *  content. */
	originalImage: Schema.String,
});

const ExtraEntry = Schema.Struct({
	key: Schema.String,
	path: Schema.String,
});

// -----------------------------------------------------------------------------
// SnapshotMetaServices — typed, declaration-mergeable per-service bucket
// -----------------------------------------------------------------------------
//
// In-tree services declare their slice directly on the interface
// below; out-of-tree plugins extend it via TypeScript's module
// declaration merging from their own source.
//
// Example (out-of-tree plugin, in its own .ts file):
//
//   declare module '@mysten-incubation/devstack/advanced' {
//     interface SnapshotMetaServices {
//       myPlugin: { foo: string };
//     }
//   }
//
// Then `services: {myPlugin: {foo: 'bar'}}` at the `snapshot()` call
// site and `readServiceMeta(meta, 'myPlugin')` at restore — both
// fully typed.
//
// Runtime side: the JSON writer is permissive (accepts anything the
// merged interface ends up with); the JSON reader returns the raw
// shape and casts via the TS slice. There's no `Effect.Schema`
// validation at the bucket boundary — TS typing at producer +
// consumer sites is the only discipline (single direction; no
// migration). When the on-disk record disagrees with the current TS
// shape, callers should treat the slice as missing and re-derive.
export interface SnapshotMetaServices {
	/**
	 * Sui chain meta. `chainId` is the checkpoint-0 digest captured at
	 * snapshot time. `restore` matches it against the running stack's
	 * `Sui.chainId` and refuses a cross-chain restore (would corrupt
	 * downstream lookup tables — publishMove cache, KnownPackage,
	 * dapp-kit MVR — that key on chain id).
	 */
	readonly sui?: { readonly chainId: string };
}

const ServicesBucketSchema = Schema.Record(Schema.String, Schema.Unknown);

const SnapshotMeta = Schema.Struct({
	createdAt: Schema.Number,
	stack: Schema.String,
	/** Devstack app identity at save time. Needed at restore time to
	 *  scope the pre-restore `docker rm -f` to THIS app's stale
	 *  containers (so a sibling app's stack=main containers aren't
	 *  nuked). */
	app: Schema.String,
	network: Schema.String,
	containers: Schema.optional(Schema.Array(ContainerEntry)),
	extras: Schema.optional(Schema.Array(ExtraEntry)),
	runtimeIncluded: Schema.Boolean,
	/** Per-service meta slices. Each service that participates in the
	 *  snapshot's restore-time validation contributes via TypeScript
	 *  declaration merging on `SnapshotMetaServices` — see the
	 *  in-tree example in `services/sui.ts`. The runtime shape is a
	 *  permissive `Record<string, unknown>` so an out-of-tree plugin
	 *  whose slice declaration isn't in this build still round-trips
	 *  cleanly; type narrowing happens at the consumer call site
	 *  (`readServiceMeta('foo')`). */
	services: Schema.optional(ServicesBucketSchema),
});
type SnapshotMeta = typeof SnapshotMeta.Type;

/**
 * Type-narrowed view of `SnapshotMeta.services`. Plugin authors get
 * autocomplete + return-type checking when they call into
 * `readServiceMeta('sui')` etc., because the TS interface above is
 * the source of narrowing.
 */
export type SnapshotMetaServicesShape = Partial<SnapshotMetaServices>;

/**
 * Construct a typed entry for the `services` bucket. The caller
 * supplies the slice name + payload and TS enforces the payload
 * matches the declaration-merged shape.
 *
 * Used at `snapshot()` save sites to assemble the bucket without a
 * `as` cast.
 */
export const buildServicesBucket = (
	entries: Partial<SnapshotMetaServices>,
): Record<string, unknown> => ({ ...entries }) as Record<string, unknown>;

/**
 * Read a typed slice off a parsed `SnapshotMeta.services` bucket. Returns
 * `undefined` when the slice is absent (snapshot was taken before the
 * service participated, plugin not loaded at save time, etc.). The
 * caller is responsible for treating undefined as "no record" and
 * re-deriving from on-chain state.
 */
export const readServiceMeta = <K extends keyof SnapshotMetaServices>(
	meta: SnapshotMeta | undefined,
	name: K,
): SnapshotMetaServices[K] | undefined => {
	if (meta === undefined || meta.services === undefined) return undefined;
	const slice = (meta.services as Record<string, unknown>)[name as string];
	return slice as SnapshotMetaServices[K] | undefined;
};


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
	const appDir = resolveAppDir();
	// Mirror `state-store.ts:resolvePaths` — local-like networks
	// (localnet + `*-fork` variants) own per-stack state, live nets
	// share one file per network. Inline the check so this module stays
	// pure-string and doesn't depend on `SuiNetwork`'s literal type.
	if (network === 'localnet' || network.endsWith('-fork')) {
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
//
// Both `tarCreate` and `tarExtract` capture stderr alongside the exit
// code so a non-zero exit surfaces tar's own diagnostic into the
// SnapshotError message. Without this, a CI failure like "tar exited 2"
// is undebuggable post-mortem — the actual reason (EACCES on a
// container-written file, source file vanished mid-archive, output
// path unwritable, …) lives on stderr and is the only signal tar
// gives. Truncated to keep error messages readable; the full stderr
// is still attached as the SnapshotError `cause` for log-grepping.
// Subprocess capture is delegated to `engine/capture-command.ts`
// (audit finding E2).
// -----------------------------------------------------------------------------

const TAR_STDERR_TRUNC = 500;

const truncateStderr = (text: string): string => {
	const trimmed = text.replace(/\r/g, '').trim();
	if (trimmed.length === 0) return '(no stderr)';
	if (trimmed.length <= TAR_STDERR_TRUNC) return trimmed;
	return `${trimmed.slice(0, TAR_STDERR_TRUNC - 1)}…`;
};

const runTar = (
	spawner: ReturnType<typeof ChildProcessSpawner.make>,
	cmd: ChildProcess.Command,
	phase: SnapshotError['phase'],
	op: string,
): Effect.Effect<void, SnapshotError> =>
	Effect.gen(function* () {
		// `stderrTruncate: Infinity` so `truncateStderr` below applies the
		// snapshot-specific elision policy (`'(no stderr)'` placeholder
		// when empty, single-char `…` ellipsis, no `[truncated]` suffix)
		// instead of `captureCommand`'s generic policy. Stdout from tar
		// is uninteresting (the archive bytes ride into the `-f <file>`
		// arg, not pipe) so default `Infinity` stays.
		const captured = yield* captureCommand(spawner, cmd, {
			op,
			stderrTruncate: Infinity,
		}).pipe(Effect.mapError(snapshotError(phase, op)));
		if (captured.exitCode !== 0) {
			return yield* Effect.fail(
				new SnapshotError({
					phase,
					message: `${op} exited ${captured.exitCode}: ${truncateStderr(captured.stderr)}`,
					cause: captured.stderr.length > 0 ? captured.stderr : undefined,
				}),
			);
		}
	});

const tarCreate = (
	spawner: ReturnType<typeof ChildProcessSpawner.make>,
	srcDir: string,
	tarPath: string,
	phase: SnapshotError['phase'],
): Effect.Effect<void, SnapshotError> => {
	// `-C srcDir .` makes the archive entries relative to `srcDir`'s
	// children, so untarring at a different absolute path on restore
	// puts files at the right offsets without leading-slash stripping.
	const cmd = ChildProcess.make('tar', ['-cf', tarPath, '-C', srcDir, '.']);
	return runTar(spawner, cmd, phase, `tar -cf ${tarPath}`);
};

const tarExtract = (
	spawner: ReturnType<typeof ChildProcessSpawner.make>,
	tarPath: string,
	dstDir: string,
	phase: SnapshotError['phase'],
): Effect.Effect<void, SnapshotError> => {
	// `--no-same-owner` so a restore running as a different UID
	// than the save (e.g. CI runner ≠ developer's local user)
	// doesn't fail with EPERM on chown. The files end up owned by
	// whoever ran restore — fine for devstack's use case where the
	// runtime/ contents are scoped to the current shell session.
	// Supported by both GNU tar and BSD tar.
	const cmd = ChildProcess.make('tar', ['-xf', tarPath, '-C', dstDir, '--no-same-owner']);
	return runTar(spawner, cmd, phase, `tar -xf ${tarPath}`);
};

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
			`label=${DockerLabel.APP}=${app}`,
			'--filter',
			`label=${DockerLabel.STACK}=${stack}`,
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
		Effect.withSpan('SnapshotPreCleanupApp', {
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
	app: string;
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
	 *  should still ride the snapshot. Callers pass the list here at
	 *  `saveSnapshot` time — there is no in-Effect mutator registry. */
	extras?: ReadonlyArray<{ key: string; path: string }>;
	/** Skip the runtime/ tarball. False by default. Set true for a
	 *  pure container-only snapshot — rare, but useful when the runtime
	 *  dir is large and the caller intends to manage its capture
	 *  separately. */
	skipRuntime?: boolean;
	/** Per-service meta slices captured at save time. Each entry must
	 *  match the corresponding `SnapshotMetaServices[K]` shape — see
	 *  the declaration-merging convention at the top of this file. The
	 *  CLI snapshot command populates `services.sui = {chainId}` from
	 *  the running stack's `Sui.chainId`; out-of-tree plugins add their
	 *  own slices here.
	 *
	 *  Restore consults the bucket via `readServiceMeta(meta, name)`. */
	services?: Partial<SnapshotMetaServices>;
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
			.pipe(Effect.mapError(snapshotError('create-dir', `failed to create snapshot dir ${target}`)));

		// 1. state.json — preserves the cached state-store entries
		// (package IDs, port leases, seal BLS keypair cache, walrus
		// deploy fingerprint). Optional: an empty stack at snapshot
		// time has no state.json yet, and that's fine.
		const hasState = yield* fs
			.exists(stackPaths.stateFile)
			.pipe(Effect.mapError(snapshotError('state-copy', `failed to stat ${stackPaths.stateFile}`)));
		if (hasState) {
			yield* fs
				.copyFile(stackPaths.stateFile, stateDst)
				.pipe(
					Effect.mapError(
						snapshotError('state-copy', `failed to copy ${stackPaths.stateFile} -> ${stateDst}`),
					),
				);
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
				.pipe(
					Effect.mapError(snapshotError('runtime-tar', `failed to stat ${stackPaths.runtimeDir}`)),
				);
			if (hasRuntime) {
				yield* tarCreate(spawner, stackPaths.runtimeDir, runtimeTarDst, 'runtime-tar');
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
		const containerEntries: Array<{ id: string; name: string; originalImage: string }> = [];
		if (containers.length > 0) {
			yield* fs
				.makeDirectory(containersDir, { recursive: true })
				.pipe(Effect.mapError(snapshotError('container-commit', `failed to create ${containersDir}`)));
			for (const container of containers) {
				const imageName = `devstack-snap:${opts.id}-${container.name}`;
				const tarPath = path.join(containersDir, `${container.name}.tar`);
				const originalImage = yield* Docker.inspectContainerImage(container.id);
				if (originalImage === undefined) {
					return yield* Effect.fail(
						new SnapshotError({
							phase: 'container-inspect',
							message: `failed to inspect container ${container.name} (${container.id}): docker reported no image tag`,
						}),
					);
				}
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
					Effect.mapError(
						snapshotError('container-commit', `failed to commit container ${container.name}`),
					),
				);
				if (isRunning === true) {
					yield* Docker.pauseContainer(container.id).pipe(
						Effect.mapError(
							snapshotError('container-pause', `failed to pause container ${container.name}`),
						),
					);
					yield* commit.pipe(
						Effect.ensuring(Docker.unpauseContainer(container.id).pipe(Effect.ignore)),
					);
				} else {
					yield* commit;
				}
				yield* Docker.saveImage(imageName, tarPath).pipe(
					Effect.mapError(snapshotError('container-save', `failed to save image ${imageName}`)),
				);
				containerTars.push(tarPath);
				containerEntries.push({
					id: container.id,
					name: container.name,
					originalImage,
				});
			}
		}

		// 4. Extras — opt-in absolute paths passed by the caller in
		// `opts.extras`. Each becomes a single tar in
		// `<snapshot>/extras/<key>.tar` whose archive is rooted at
		// the parent of the path so extract restores the full
		// absolute path verbatim. (Captured this way rather than
		// `tar -C / -P <path>` to avoid pulling the entire root.)
		const extras = opts.extras ?? [];
		const extrasTars: Array<string> = [];
		if (extras.length > 0) {
			yield* fs
				.makeDirectory(extrasDir, { recursive: true })
				.pipe(Effect.mapError(snapshotError('extras-dir', `failed to create ${extrasDir}`)));
			for (const extra of extras) {
				const tarPath = path.join(extrasDir, `${extra.key}.tar`);
				const exists = yield* fs
					.exists(extra.path)
					.pipe(Effect.mapError(snapshotError('extras-stat', `failed to stat ${extra.path}`)));
				if (!exists) {
					// Skip missing extras rather than failing — a plugin
					// might register an extra whose path is only populated
					// after a specific code path runs.
					continue;
				}
				yield* tarCreate(spawner, extra.path, tarPath, 'extras-tar');
				extrasTars.push(tarPath);
			}
		}

		// 5. meta.json — schema-versioned record of what's in this
		// snapshot. `restore` reads it back to know which subset of
		// the four passes to run AND which app+stack labels to scope
		// its pre-load cleanup to.
		const servicesBucket =
			opts.services !== undefined && Object.keys(opts.services).length > 0
				? buildServicesBucket(opts.services)
				: undefined;
		const meta: SnapshotMeta = {
			createdAt: Date.now(),
			stack,
			app: opts.app,
			network,
			runtimeIncluded: runtimeTar !== undefined,
			...(containerEntries.length > 0 ? { containers: containerEntries } : {}),
			...(extras.length > 0 ? { extras: extras.map((e) => ({ key: e.key, path: e.path })) } : {}),
			...(servicesBucket !== undefined ? { services: servicesBucket } : {}),
		};
		yield* fs
			.writeFileString(metaDst, JSON.stringify(meta, null, 2))
			.pipe(Effect.mapError(snapshotError('meta-write', `failed to write ${metaDst}`)));

		return { path: target, containerTars, runtimeTar, extrasTars };
	}).pipe(Effect.withSpan('SnapshotCreate', { attributes: { 'snapshot.id': opts.id } }));

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
	/** Current stack's chain identifier. When set AND
	 *  `meta.services.sui.chainId` is set AND they don't match,
	 *  `restore` fails with a typed error. Caller passes the running
	 *  stack's `Sui.chainId`. */
	expectedChainId?: string;
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
			.pipe(Effect.mapError(snapshotError('source-stat', `failed to stat ${source}`)));
		if (!exists) {
			return yield* new SnapshotError({
				phase: 'not-found',
				message: `snapshot ${opts.id} not found at ${source}`,
			});
		}

		// Read meta once — used by the pre-cleanup pass (app+stack
		// label filter), the container restore pass (originalImage
		// retag), and the extras pass (recorded paths).
		const meta = yield* readMeta(fs, path.join(source, META_FILE_NAME));

		// Chain guard. When the caller passes the running stack's
		// chainId AND the snapshot recorded `services.sui.chainId`,
		// refuse a cross-chain restore. Silent retag of images under
		// a divergent chain id would leave downstream lookups
		// (publishMove cache, KnownPackage, dapp-kit MVR) pointing at
		// addresses that don't exist on the running chain — a class
		// of bug that's near-impossible to debug from the surfaced
		// symptom. Skipped when either side is unset (meta from a
		// snapshot whose Sui factory hadn't yet declared its slice or
		// callers that don't care).
		if (meta !== undefined) {
			const sui = readServiceMeta(meta, 'sui');
			if (
				opts.expectedChainId !== undefined &&
				sui?.chainId !== undefined &&
				sui.chainId !== opts.expectedChainId
			) {
				return yield* new SnapshotError({
					phase: 'chainId-mismatch',
					message:
						`snapshot ${opts.id} chainId mismatch: meta=${sui.chainId} ` +
						`current=${opts.expectedChainId}. Refusing restore — the snapshot was ` +
						`captured from a different chain and would corrupt the running stack.`,
				});
			}
		}

		// PRE-CLEANUP — before loading any tars, `docker rm -f` any
		// containers belonging to (meta.app, meta.stack). Reason: the
		// reuse-if-image-matches probe in `Docker.run` compares
		// container Config.Image string-equal. If a pre-existing
		// container shares the supervisor's tag string, the probe
		// adopts it and never recreates from the (newly-retagged)
		// snapshot image. Nuking first guarantees the next `apply`
		// goes through `fresh` and uses the snapshot's content. Best-
		// effort: docker daemon down, no matching containers, or
		// permission errors don't fail the restore. Skipped when meta
		// is unreadable.
		if (meta !== undefined) {
			yield* preCleanupApp(spawner, meta.app, meta.stack).pipe(Effect.ignore);
		}

		// 1. state.json — copy back over the live state-store file.
		const hasState = yield* fs
			.exists(stateSrc)
			.pipe(Effect.mapError(snapshotError('state-restore', `failed to stat ${stateSrc}`)));
		if (hasState) {
			const stateDir = path.dirname(stackPaths.stateFile);
			yield* fs
				.makeDirectory(stateDir, { recursive: true })
				.pipe(Effect.mapError(snapshotError('state-restore', `failed to create ${stateDir}`)));
			yield* fs
				.copyFile(stateSrc, stackPaths.stateFile)
				.pipe(
					Effect.mapError(
						snapshotError(
							'state-restore',
							`failed to copy ${stateSrc} -> ${stackPaths.stateFile}`,
						),
					),
				);
		}

		// 2. runtime/ — untar back into place. Wipe the destination first
		// (then mkdir-p) so files written AFTER the snapshot was taken
		// don't persist as orphans overlaid on the restored tree. Without
		// this, a file created between snap-A and snap-B would survive a
		// restore of snap-A — `tar -xf` only writes the entries inside
		// the archive, it does not delete extras already present in the
		// destination. mkdir-p after the wipe handles a clean stack with
		// no prior runtime dir.
		let runtimeRestored = false;
		const hasRuntimeTar = yield* fs
			.exists(runtimeTarSrc)
			.pipe(
				Effect.mapError(snapshotError('runtime-extract', `failed to stat ${runtimeTarSrc}`)),
			);
		if (hasRuntimeTar) {
			yield* fs
				.remove(stackPaths.runtimeDir, { recursive: true, force: true })
				.pipe(
					Effect.mapError(
						snapshotError('runtime-extract', `failed to clear ${stackPaths.runtimeDir}`),
					),
				);
			yield* fs
				.makeDirectory(stackPaths.runtimeDir, { recursive: true })
				.pipe(
					Effect.mapError(
						snapshotError('runtime-extract', `failed to create ${stackPaths.runtimeDir}`),
					),
				);
			yield* tarExtract(spawner, runtimeTarSrc, stackPaths.runtimeDir, 'runtime-extract');
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
			.pipe(Effect.mapError(snapshotError('container-load', `failed to stat ${containersDir}`)));
		if (hasContainersDir) {
			const entries = yield* fs
				.readDirectory(containersDir)
				.pipe(Effect.mapError(snapshotError('container-load', `failed to read ${containersDir}`)));
			// Index meta.containers by `name` so we can look up
			// `originalImage` per tarball without a quadratic search.
			const byName = new Map<string, string>();
			for (const c of meta?.containers ?? []) {
				byName.set(c.name, c.originalImage);
			}
			for (const entry of entries) {
				if (!entry.endsWith('.tar')) continue;
				const tarPath = path.join(containersDir, entry);
				const { tag } = yield* Docker.loadImage(tarPath).pipe(
					Effect.mapError(
						snapshotError('container-load', `failed to load image from ${tarPath}`),
					),
				);
				loadedImages.push(tag);
				// Retag to originalImage so the supervisor's next
				// `dockerImage({build})` finds the snapshot's content
				// under the expected content-addressed tag.
				const containerName = entry.replace(/\.tar$/, '');
				const originalImage = byName.get(containerName);
				if (originalImage !== undefined) {
					yield* Docker.tagImage(tag, originalImage).pipe(
						Effect.mapError(
							snapshotError('container-retag', `failed to retag ${tag} -> ${originalImage}`),
						),
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
			.pipe(Effect.mapError(snapshotError('extras-extract', `failed to stat ${extrasDir}`)));
		if (hasExtrasDir) {
			const extrasMeta = meta?.extras ?? [];
			for (const extra of extrasMeta) {
				const tarPath = path.join(extrasDir, `${extra.key}.tar`);
				const tarExists = yield* fs
					.exists(tarPath)
					.pipe(Effect.mapError(snapshotError('extras-extract', `failed to stat ${tarPath}`)));
				if (!tarExists) continue;
				yield* fs
					.makeDirectory(extra.path, { recursive: true })
					.pipe(
						Effect.mapError(snapshotError('extras-extract', `failed to create ${extra.path}`)),
					);
				yield* tarExtract(spawner, tarPath, extra.path, 'extras-extract');
				extrasRestored.push(extra.key);
			}
		}

		return { loadedImages, runtimeRestored, extrasRestored };
	}).pipe(Effect.withSpan('SnapshotRestore', { attributes: { 'snapshot.id': opts.id } }));

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
	ReadonlyArray<{
		id: string;
		createdAt: number;
		stack?: string;
		network?: string;
		/** Raw per-service meta bucket, as read off `meta.json`. Use
		 *  `readServiceMeta`-style accessors on the consumer side to
		 *  narrow to a specific service's slice. */
		services?: Record<string, unknown>;
	}>,
	SnapshotError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		const snapshotsDir = opts?.dir ?? DEFAULT_SNAPSHOTS_DIR;

		const exists = yield* fs
			.exists(snapshotsDir)
			.pipe(Effect.mapError(snapshotError('list-stat', `failed to stat ${snapshotsDir}`)));
		if (!exists) return [] as const;

		const entries = yield* fs
			.readDirectory(snapshotsDir)
			.pipe(Effect.mapError(snapshotError('list-read', `failed to read ${snapshotsDir}`)));

		const results: Array<{
			id: string;
			createdAt: number;
			stack: string;
			network: string;
			services?: Record<string, unknown>;
		}> = [];
		for (const id of entries) {
			const meta = yield* readMeta(fs, path.join(snapshotsDir, id, META_FILE_NAME));
			if (meta === undefined) continue;
			results.push({
				id,
				createdAt: meta.createdAt,
				stack: meta.stack,
				network: meta.network,
				...(meta.services !== undefined
					? { services: meta.services as Record<string, unknown> }
					: {}),
			});
		}

		results.sort((a, b) => a.createdAt - b.createdAt);
		return results;
	}).pipe(Effect.withSpan('SnapshotList'));
