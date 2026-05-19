// Cross-stack inventory of devstack-labelled docker resources + on-disk
// state. Consumed by `cli/commands/doctor.ts` (the new "Inventory"
// section) and `cli/commands/prune.ts` (`--list`, `--interactive`,
// `--all-orphans`).
//
// The functions here intentionally stay pure-reporters: they never call
// `docker rm` / `docker network rm` / `docker volume rm`. Mutation lives
// in `cli/commands/_prune-stack.ts` so a misuse of the inventory tools
// (e.g. piping `docker volume ls` output through `xargs rm`) can't
// silently delete anything.
//
// Three label conventions are queried (all stamped by
// `internal/docker/core.ts` + `internal/docker/network.ts`):
//   - container labels: `devstack.app=<app>` / `devstack.stack=<stack>`
//   - network labels:   `devstack.app=<app>` / `devstack.stack=<stack>`
//   - volume labels:    `devstack.app=<app>` / `devstack.stack=<stack>`
//
// State dirs live under `<DEVSTACK_APP_DIR or cwd>/.devstack/stacks/<stack>/`
// (per-stack) or `<dir>/.devstack/state.json` (flat legacy). The flat
// layout has no stack dimension on disk — we attribute it to the
// caller's current `stack` (typically `main`) so the inventory line is
// still actionable.

import { Effect, FileSystem } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { DockerLabel } from '../identity.js';
import { isPidAlive as isPidAliveShared } from '../process-liveness.js';
import { Registry, type RegistryEntry } from '../registry.js';
import { resolveAppDir } from '../resolve-app-dir.js';
import { ROUTER_CONTAINER, ROUTER_NETWORK } from './router.js';

type Spawner = ReturnType<typeof ChildProcessSpawner.make>;
type Fs = ReturnType<typeof FileSystem.make>;

/** A single (app, stack) bucket. */
export interface InventoryRow {
	readonly app: string;
	readonly stack: string;
	readonly containers: ReadonlyArray<ContainerRef>;
	readonly networks: ReadonlyArray<NetworkRef>;
	readonly volumes: ReadonlyArray<VolumeRef>;
	readonly stateDirs: ReadonlyArray<string>;
	/** Supervisor PID if a live `state.json.lock` was found, else `undefined`. */
	readonly runningPid: number | undefined;
	/**
	 * Three-way row state used by the picker + doctor inventory. See
	 * `computeClassification` for the rules.
	 *   - `'running'`: a live supervisor pid holds this stack's lock.
	 *     Never selectable / prunable.
	 *   - `'repo-gone'`: the registry recorded a `repoPath` and that
	 *     directory no longer exists on disk. The user's most common
	 *     "I want to clean this up" trigger; pre-selected in the picker.
	 *   - `'idle'`: everything else. Selectable, no special highlight.
	 */
	readonly classification: RowClassification;
	/** Registry entry if one exists for this (app, stack). */
	readonly registryEntry: RegistryEntry | undefined;
}

export type RowClassification = 'running' | 'repo-gone' | 'idle';

export interface ContainerRef {
	readonly id: string;
	readonly name: string;
	readonly status: string;
	readonly running: boolean;
}

export interface NetworkRef {
	readonly id: string;
	readonly name: string;
}

export interface VolumeRef {
	readonly name: string;
	/** Size in bytes; `undefined` if `docker system df -v` didn't report it. */
	readonly sizeBytes: number | undefined;
}

// `docker ps -a --filter label=devstack.app --format` with explicit
// columns. Tab-separated so newlines inside `Status` ("Up 5 minutes
// (healthy)") can't break the parse. `{{.Label "devstack.app"}}` returns
// the empty string when the label is absent; combined with `--filter
// label=devstack.app` that means every row we read DOES have an app
// label, but the explicit `{{.Label ...}}` template keeps the parser
// defensive against docker version drift in the label format.
const listContainers = (spawner: Spawner): Effect.Effect<ReadonlyArray<RawContainer>> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('docker', [
			'ps',
			'-a',
			'--filter',
			`label=${DockerLabel.APP}`,
			'--format',
			`{{.ID}}\t{{.Label "${DockerLabel.APP}"}}\t{{.Label "${DockerLabel.STACK}"}}\t{{.Names}}\t{{.State}}\t{{.Status}}`,
		]);
		const out = yield* spawner.string(cmd).pipe(Effect.orElseSucceed(() => ''));
		const rows: Array<RawContainer> = [];
		for (const line of out.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			const parts = trimmed.split('\t');
			if (parts.length < 6) continue;
			const [id, app, stack, name, state, status] = parts as [
				string,
				string,
				string,
				string,
				string,
				string,
			];
			if (app.length === 0) continue;
			rows.push({
				id,
				app,
				stack: stack.length === 0 ? '<unset>' : stack,
				name,
				status,
				running: state === 'running',
			});
		}
		return rows as ReadonlyArray<RawContainer>;
	});

interface RawContainer {
	readonly id: string;
	readonly app: string;
	readonly stack: string;
	readonly name: string;
	readonly status: string;
	readonly running: boolean;
}

const listNetworks = (spawner: Spawner): Effect.Effect<ReadonlyArray<RawNetwork>> =>
	Effect.gen(function* () {
		// `docker network ls` doesn't render individual labels via
		// `--format {{.Label "..."}}` consistently across versions (older
		// docker prints the `Labels` map verbatim), so we fan out one
		// `docker network inspect <id>` per match. Network counts in
		// practice run in the single digits per machine — the fan-out is
		// cheap compared to the alternative of parsing the comma-joined
		// `{{.Labels}}` blob with embedded `=` and `,` in values.
		const lsCmd = ChildProcess.make('docker', [
			'network',
			'ls',
			'-q',
			'--filter',
			`label=${DockerLabel.APP}`,
		]);
		const idsText = yield* spawner.string(lsCmd).pipe(Effect.orElseSucceed(() => ''));
		const ids = idsText
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (ids.length === 0) return [] as ReadonlyArray<RawNetwork>;
		const inspectCmd = ChildProcess.make('docker', [
			'network',
			'inspect',
			'--format',
			`{{.Id}}\t{{.Name}}\t{{index .Labels "${DockerLabel.APP}"}}\t{{index .Labels "${DockerLabel.STACK}"}}`,
			...ids,
		]);
		const out = yield* spawner.string(inspectCmd).pipe(Effect.orElseSucceed(() => ''));
		const rows: Array<RawNetwork> = [];
		for (const line of out.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			const parts = trimmed.split('\t');
			if (parts.length < 4) continue;
			const [id, name, app, stack] = parts as [string, string, string, string];
			if (app.length === 0 || app === '<no value>') continue;
			rows.push({
				id,
				name,
				app,
				stack: stack.length === 0 || stack === '<no value>' ? '<unset>' : stack,
			});
		}
		return rows as ReadonlyArray<RawNetwork>;
	});

interface RawNetwork {
	readonly id: string;
	readonly name: string;
	readonly app: string;
	readonly stack: string;
}

const listVolumes = (spawner: Spawner): Effect.Effect<ReadonlyArray<RawVolume>> =>
	Effect.gen(function* () {
		const lsCmd = ChildProcess.make('docker', [
			'volume',
			'ls',
			'-q',
			'--filter',
			`label=${DockerLabel.APP}`,
		]);
		const namesText = yield* spawner.string(lsCmd).pipe(Effect.orElseSucceed(() => ''));
		const names = namesText
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (names.length === 0) return [] as ReadonlyArray<RawVolume>;
		// `docker volume inspect` accepts multiple names in one invocation
		// and emits one record per name; using `--format` here keeps us
		// out of the JSON-blob parsing business.
		const inspectCmd = ChildProcess.make('docker', [
			'volume',
			'inspect',
			'--format',
			`{{.Name}}\t{{index .Labels "${DockerLabel.APP}"}}\t{{index .Labels "${DockerLabel.STACK}"}}`,
			...names,
		]);
		const out = yield* spawner.string(inspectCmd).pipe(Effect.orElseSucceed(() => ''));
		const rows: Array<RawVolume> = [];
		for (const line of out.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			const parts = trimmed.split('\t');
			if (parts.length < 3) continue;
			const [name, app, stack] = parts as [string, string, string];
			if (app.length === 0 || app === '<no value>') continue;
			rows.push({
				name,
				app,
				stack: stack.length === 0 || stack === '<no value>' ? '<unset>' : stack,
			});
		}
		return rows as ReadonlyArray<RawVolume>;
	});

interface RawVolume {
	readonly name: string;
	readonly app: string;
	readonly stack: string;
}

// `docker system df -v --format '{{json .}}'` emits a single JSON object
// with a `Volumes` array; each entry has a `Size` field that's a
// human-readable string (`"1.234GB"`, `"12.4MB"`). We parse the suffix
// to bytes so the inventory can sum + render.
//
// Falling back to "size unknown" on parse failure is preferable to a
// stat-walk: `docker volume inspect` doesn't expose disk usage, and
// `du`-ing the mountpoint requires root on a Docker-for-Mac VM.
const fetchVolumeSizes = (spawner: Spawner): Effect.Effect<ReadonlyMap<string, number>> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('docker', ['system', 'df', '-v', '--format', '{{json .}}']);
		const out = yield* spawner.string(cmd).pipe(Effect.orElseSucceed(() => ''));
		const sizes = new Map<string, number>();
		if (out.trim().length === 0) return sizes;
		// `docker system df --format` emits one JSON object per line on
		// some versions and a single object on others. Try the simple
		// case first; if that fails, try line-delimited.
		const tryParse = (text: string): unknown | undefined => {
			try {
				return JSON.parse(text) as unknown;
			} catch {
				return undefined;
			}
		};
		let parsed = tryParse(out);
		if (parsed === undefined) {
			// Line-delimited fallback. Take the first record that has a
			// `Volumes` field.
			for (const line of out.split('\n')) {
				const cand = tryParse(line);
				if (cand !== undefined) {
					parsed = cand;
					break;
				}
			}
		}
		if (parsed === undefined || typeof parsed !== 'object') return sizes;
		const volumes = (parsed as { Volumes?: unknown }).Volumes;
		if (!Array.isArray(volumes)) return sizes;
		for (const v of volumes) {
			if (typeof v !== 'object' || v === null) continue;
			const name = (v as { Name?: unknown }).Name;
			const size = (v as { Size?: unknown }).Size;
			if (typeof name !== 'string' || typeof size !== 'string') continue;
			const bytes = parseSize(size);
			if (bytes !== undefined) sizes.set(name, bytes);
		}
		return sizes;
	});

// -----------------------------------------------------------------------------
// Image inventory — global rollup (NOT per-(app, stack)). Devstack-built
// images get a `devstack.image=true` label from `internal/docker/image.ts`
// at build time. The label is global because:
//   - The same base image is reused across stacks (e.g. `walrus-rs:dev`
//     built once, mounted into every walrus.aggregator container).
//   - The build cache lives in the docker daemon, not the per-stack
//     compose project.
//
// Removal candidacy: an image with the label AND no running container
// using it. `docker rmi` against an in-use image errors and we'd waste
// a round-trip; instead we cross-reference `docker ps --format
// {{.Image}}` against the label-filtered list and only surface
// candidates that are not in active use.
// -----------------------------------------------------------------------------

export interface ImageRef {
	readonly id: string;
	readonly tag: string;
	readonly sizeBytes: number | undefined;
	/**
	 * True if at least one running container references this image. Such
	 * images are excluded from `prune --include-images` removal.
	 */
	readonly inUse: boolean;
}

export interface ImageInventory {
	readonly labelled: ReadonlyArray<ImageRef>;
	/**
	 * Count of `devstack-*`-named images WITHOUT the
	 * `devstack.image=true` label — pre-registry orphans. Doctor
	 * surfaces this count with a hint to clean manually since we can't
	 * safely auto-remove an unlabelled image (no proof it was devstack
	 * that built it).
	 */
	readonly unlabelledOrphans: number;
}

// `docker images --filter label=devstack.image=true` lists every image
// `internal/docker/image.ts:build` stamped. The `--format` template
// asks for ID + Repository:Tag + Size; Size is human-readable so we
// re-use `parseSize` to bytesify it. Tag may be `<none>:<none>` for
// dangling layers — skip those.
const listLabelledImages = (
	spawner: Spawner,
): Effect.Effect<ReadonlyArray<{ id: string; tag: string; sizeBytes: number | undefined }>> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('docker', [
			'images',
			'--filter',
			'label=devstack.image=true',
			'--format',
			'{{.ID}}\t{{.Repository}}:{{.Tag}}\t{{.Size}}',
		]);
		const out = yield* spawner.string(cmd).pipe(Effect.orElseSucceed(() => ''));
		const rows: Array<{ id: string; tag: string; sizeBytes: number | undefined }> = [];
		const seen = new Set<string>();
		for (const line of out.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			const parts = trimmed.split('\t');
			if (parts.length < 3) continue;
			const [id, tag, size] = parts as [string, string, string];
			if (seen.has(id)) continue;
			seen.add(id);
			rows.push({ id, tag, sizeBytes: parseSize(size) });
		}
		return rows as ReadonlyArray<{ id: string; tag: string; sizeBytes: number | undefined }>;
	});

// Returns the set of image references (repo:tag OR id) currently in use
// by any container (running OR stopped — stopped containers still
// reference their image and `docker rmi` would fail).
const inUseImageRefs = (spawner: Spawner): Effect.Effect<ReadonlySet<string>> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('docker', ['ps', '-a', '--format', '{{.Image}}\t{{.ImageID}}']);
		const out = yield* spawner.string(cmd).pipe(Effect.orElseSucceed(() => ''));
		const refs = new Set<string>();
		for (const line of out.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			const parts = trimmed.split('\t');
			if (parts.length < 1) continue;
			const [image, id] = parts as [string, string | undefined];
			if (image.length > 0) refs.add(image);
			if (id !== undefined && id.length > 0) refs.add(id);
		}
		return refs as ReadonlySet<string>;
	});

// Count `devstack-*`-named images that do NOT carry the new
// `devstack.image=true` label. These were built before the labelling
// landed — we surface the count so doctor can hint at manual cleanup
// (we can't safely auto-remove an unlabelled image, no proof we built it).
const countUnlabelledOrphans = (spawner: Spawner): Effect.Effect<number> =>
	Effect.gen(function* () {
		const allCmd = ChildProcess.make('docker', ['images', '--format', '{{.ID}}', 'devstack-*']);
		const labelledCmd = ChildProcess.make('docker', [
			'images',
			'--filter',
			'label=devstack.image=true',
			'--format',
			'{{.ID}}',
			'devstack-*',
		]);
		const all = yield* spawner.string(allCmd).pipe(Effect.orElseSucceed(() => ''));
		const labelled = yield* spawner.string(labelledCmd).pipe(Effect.orElseSucceed(() => ''));
		const allIds = new Set(
			all
				.split('\n')
				.map((s) => s.trim())
				.filter((s) => s.length > 0),
		);
		const labelledIds = new Set(
			labelled
				.split('\n')
				.map((s) => s.trim())
				.filter((s) => s.length > 0),
		);
		let count = 0;
		for (const id of allIds) if (!labelledIds.has(id)) count += 1;
		return count;
	});

export const collectImageInventory = (): Effect.Effect<
	ImageInventory,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const [labelled, inUse, unlabelledOrphans] = yield* Effect.all(
			[listLabelledImages(spawner), inUseImageRefs(spawner), countUnlabelledOrphans(spawner)],
			{ concurrency: 'unbounded' },
		);
		const images: Array<ImageRef> = labelled.map((img) => ({
			id: img.id,
			tag: img.tag,
			sizeBytes: img.sizeBytes,
			inUse: inUse.has(img.id) || inUse.has(img.tag),
		}));
		return { labelled: images as ReadonlyArray<ImageRef>, unlabelledOrphans };
	}).pipe(Effect.withSpan('InventoryCollectImages'));

// Parse docker's human-readable size strings ("1.234GB", "12.4MB",
// "0B"). Returns bytes. Decimal SI units (1KB = 1000B) match docker's
// own reporting convention.
export const parseSize = (s: string): number | undefined => {
	const m = /^(\d+(?:\.\d+)?)\s*([kKmMgGtTpP]?)([iI]?)([bB])$/.exec(s.trim());
	if (m === null) return undefined;
	const value = Number.parseFloat(m[1] ?? '0');
	if (!Number.isFinite(value)) return undefined;
	const unit = (m[2] ?? '').toLowerCase();
	const binary = (m[3] ?? '').length > 0;
	const base = binary ? 1024 : 1000;
	switch (unit) {
		case '':
			return value;
		case 'k':
			return value * base;
		case 'm':
			return value * base ** 2;
		case 'g':
			return value * base ** 3;
		case 't':
			return value * base ** 4;
		case 'p':
			return value * base ** 5;
		default:
			return undefined;
	}
};

export const formatBytes = (n: number): string => {
	if (!Number.isFinite(n) || n < 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	let v = n;
	while (v >= 1000 && i < units.length - 1) {
		v /= 1000;
		i += 1;
	}
	const formatted = v >= 100 || i === 0 ? Math.round(v).toString() : v.toFixed(1);
	return `${formatted} ${units[i]}`;
};

// Walk every plausible `<root>/.devstack/stacks/<name>` directory and
// every flat `<root>/.devstack/state.json`. Callers pass the roots to
// probe (typically `<DEVSTACK_APP_DIR or cwd>`).
//
// State-dir attribution is best-effort: we can't tell from disk alone
// which `<app>` a flat `state.json` belongs to — the file holds the
// data but not the identity. `collectInventory` matches by stack name
// against the docker-label-derived (app, stack) buckets and only
// surfaces state-dir entries for buckets that already have at least
// one container/volume/network on this host.
export interface StateLocation {
	readonly stack: string;
	readonly dir: string;
	/** Optional lock holder. */
	readonly pid: number | undefined;
}

export const enumerateStateLocations = (
	fs: Fs,
	roots: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<StateLocation>> =>
	Effect.gen(function* () {
		const out: Array<StateLocation> = [];
		for (const root of roots) {
			const devstackDir = joinPath(root, '.devstack');
			const exists = yield* fs.exists(devstackDir).pipe(Effect.orElseSucceed(() => false));
			if (!exists) continue;
			// Per-stack layout.
			const stacksRoot = joinPath(devstackDir, 'stacks');
			const stacksExists = yield* fs.exists(stacksRoot).pipe(Effect.orElseSucceed(() => false));
			if (stacksExists) {
				const entries = yield* fs
					.readDirectory(stacksRoot)
					.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
				for (const entry of entries) {
					const stackDir = joinPath(stacksRoot, entry);
					const isDir = yield* fs.stat(stackDir).pipe(
						Effect.map((s) => s.type === 'Directory'),
						Effect.orElseSucceed(() => false),
					);
					if (!isDir) continue;
					const lockPath = joinPath(stackDir, 'state.json.lock');
					const pid = yield* readLockPid(fs, lockPath);
					out.push({ stack: entry, dir: stackDir, pid });
				}
			}
			// Flat fallback. The pre-stacks-layout state.json has no
			// per-stack dimension on disk — attribute it to `main`,
			// matching how the rest of the toolchain treats unspecified
			// stack names.
			const flat = joinPath(devstackDir, 'state.json');
			const flatExists = yield* fs.exists(flat).pipe(Effect.orElseSucceed(() => false));
			if (flatExists) {
				const lockPath = joinPath(devstackDir, 'state.json.lock');
				const pid = yield* readLockPid(fs, lockPath);
				// Avoid double-emitting if a per-stack `main` already
				// covered this directory.
				if (!out.some((s) => s.stack === 'main' && s.dir === joinPath(stacksRoot, 'main'))) {
					out.push({ stack: 'main', dir: devstackDir, pid });
				}
			}
		}
		return out as ReadonlyArray<StateLocation>;
	});

const readLockPid = (fs: Fs, lockPath: string): Effect.Effect<number | undefined> =>
	Effect.gen(function* () {
		const exists = yield* fs.exists(lockPath).pipe(Effect.orElseSucceed(() => false));
		if (!exists) return undefined;
		const text = yield* fs.readFileString(lockPath).pipe(Effect.orElseSucceed(() => ''));
		if (text.trim().length === 0) return undefined;
		try {
			const parsed = JSON.parse(text) as { pid?: unknown };
			if (typeof parsed.pid === 'number' && Number.isFinite(parsed.pid)) return parsed.pid;
		} catch {
			return undefined;
		}
		return undefined;
	});

// Re-export from the shared helper so callers can keep importing
// `isPidAlive` from this module. See `process-liveness.ts` for the full
// rationale (POSIX kill(0) + EPERM=alive trick, PID reuse trade-off).
export const isPidAlive = isPidAliveShared;

/** Build the per-(app,stack) inventory from raw docker output + state. */
export interface CollectInventoryOptions {
	/** Defaults to `[DEVSTACK_APP_DIR ?? cwd, ~]`. */
	readonly roots?: ReadonlyArray<string>;
}

export const collectInventory = (
	options: CollectInventoryOptions = {},
): Effect.Effect<
	ReadonlyArray<InventoryRow>,
	never,
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Registry
> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const fs = yield* FileSystem.FileSystem;
		const registry = yield* Registry;

		const [containers, networks, volumes, sizes] = yield* Effect.all(
			[
				listContainers(spawner),
				listNetworks(spawner),
				listVolumes(spawner),
				fetchVolumeSizes(spawner),
			],
			{ concurrency: 'unbounded' },
		);

		// Bucket by (app, stack). Use `<app>/<stack>` as the map key
		// — `/` can't appear in either field (docker rejects it in
		// labels), so collisions are impossible.
		type Bucket = {
			containers: Array<ContainerRef>;
			networks: Array<NetworkRef>;
			volumes: Array<VolumeRef>;
		};
		const buckets = new Map<string, Bucket>();
		const ensure = (app: string, stack: string): Bucket => {
			const k = `${app}/${stack}`;
			let b = buckets.get(k);
			if (b === undefined) {
				b = { containers: [], networks: [], volumes: [] };
				buckets.set(k, b);
			}
			return b;
		};
		for (const c of containers) {
			ensure(c.app, c.stack).containers.push({
				id: c.id,
				name: c.name,
				status: c.status,
				running: c.running,
			});
		}
		for (const n of networks) {
			ensure(n.app, n.stack).networks.push({ id: n.id, name: n.name });
		}
		for (const v of volumes) {
			ensure(v.app, v.stack).volumes.push({
				name: v.name,
				sizeBytes: sizes.get(v.name),
			});
		}

		// Map (app, stack) buckets to inventory rows + look up state dirs
		// and running pids per row.
		const cwd = resolveAppDir();
		const roots = options.roots !== undefined ? options.roots : ([cwd] as ReadonlyArray<string>);

		// Enumerate state dirs ONCE across all roots — the result is
		// independent of (app, stack), so we filter by stack name
		// per-bucket below.
		const states = yield* enumerateStateLocations(fs, roots);

		// Read the global registry. Cross-join on (app, stack) so each
		// docker-present row picks up the matching entry's
		// `repoPath` / `lastSeen` / `pid`. Registry-only entries (no
		// surviving docker resources) only surface when their
		// `repoPath` is gone — those are the "repo-gone" rows the user
		// wants to GC. Registry-only entries whose repo still exists
		// are stale bookkeeping and silently elided here; `prune`
		// strips them from the registry in its own GC pass.
		const registrySnapshot = yield* registry.read;
		const registryByKey = new Map<string, RegistryEntry>();
		for (const entry of registrySnapshot.stacks) {
			registryByKey.set(`${entry.app}/${entry.stack}`, entry);
		}

		const rows: Array<InventoryRow> = [];
		const seenKeys = new Set<string>();
		for (const [key, bucket] of buckets) {
			const [app, stack] = key.split('/') as [string, string];
			seenKeys.add(key);
			const matchingStates = states.filter((s) => s.stack === stack);
			const runningPid = matchingStates.find((s) => s.pid !== undefined && isPidAlive(s.pid))?.pid;
			const entry = registryByKey.get(key);
			const classification = computeClassification({ entry, runningPid });
			rows.push({
				app,
				stack,
				containers: bucket.containers,
				networks: bucket.networks,
				volumes: bucket.volumes,
				stateDirs: matchingStates.map((s) => s.dir),
				runningPid,
				classification,
				registryEntry: entry,
			});
		}

		// Registry-only entries (no docker resources on this host).
		// Only surface the ones whose `repoPath` is gone — those carry
		// the signal the user cares about ("I `rm -rf`'d this example
		// and the registry still says it existed"). Entries whose repo
		// is still on disk but have no docker presence are silently
		// elided; `prune` strips them from the registry in its silent
		// GC pass.
		for (const entry of registrySnapshot.stacks) {
			const key = `${entry.app}/${entry.stack}`;
			if (seenKeys.has(key)) continue;
			const matchingStates = states.filter((s) => s.stack === entry.stack);
			const runningPid = matchingStates.find((s) => s.pid !== undefined && isPidAlive(s.pid))?.pid;
			if (runningPid === undefined && existsSync(entry.repoPath)) continue;
			const classification = computeClassification({ entry, runningPid });
			rows.push({
				app: entry.app,
				stack: entry.stack,
				containers: [],
				networks: [],
				volumes: [],
				stateDirs: matchingStates.map((s) => s.dir),
				runningPid,
				classification,
				registryEntry: entry,
			});
		}

		// Stable order: by app then stack.
		rows.sort((a, b) => {
			if (a.app !== b.app) return a.app < b.app ? -1 : 1;
			return a.stack < b.stack ? -1 : a.stack > b.stack ? 1 : 0;
		});
		return rows as ReadonlyArray<InventoryRow>;
	}).pipe(Effect.withSpan('InventoryCollect'));

// -----------------------------------------------------------------------------
// Classification glue
// -----------------------------------------------------------------------------

interface ClassificationInput {
	readonly entry: RegistryEntry | undefined;
	readonly runningPid: number | undefined;
}

// Three-way row state for the picker + doctor inventory. We deliberately
// drop the older active/dormant/stale/abandoned/untracked/wiped vocab —
// the user wants to "manage and clean things up without visiting each
// repo", not a lifecycle report card. The rules in priority order:
//   1. `runningPid` is alive  → `'running'` (never selectable).
//   2. registry entry exists AND its `repoPath` is no longer on disk
//      → `'repo-gone'` (the "I `rm -rf`'d the example, please clean it
//      up" trigger; pre-selected in the picker).
//   3. everything else → `'idle'`.
export const computeClassification = (input: ClassificationInput): RowClassification => {
	const { entry, runningPid } = input;
	if (runningPid !== undefined && isPidAliveShared(runningPid)) return 'running';
	if (entry !== undefined && !existsSync(entry.repoPath)) return 'repo-gone';
	return 'idle';
};

// Render helpers used by both `doctor` and `prune --list`.

export const summarizeContainers = (row: InventoryRow): string => {
	const running = row.containers.filter((c) => c.running).length;
	const stopped = row.containers.length - running;
	if (row.containers.length === 0) return '0 containers';
	if (running === 0) return `0 containers (${stopped} stopped)`;
	if (stopped === 0) return `${running} container${running === 1 ? '' : 's'} running`;
	return `${running} running, ${stopped} stopped`;
};

export const volumeBytes = (row: InventoryRow): number => {
	let total = 0;
	for (const v of row.volumes) {
		if (v.sizeBytes !== undefined) total += v.sizeBytes;
	}
	return total;
};

// `${app}/.../${parent}` shortener — keeps `/long/path/to/repos/wallet`
// from blowing the row width. Used by both the doctor inventory line
// and the Ink picker's row renderer.
export const shortRepoPath = (full: string | undefined): string => {
	if (full === undefined || full.length === 0) return '—';
	const norm = full.replace(/\/+$/, '');
	const parts = norm.split('/');
	if (parts.length <= 2) return norm;
	const tail = parts.slice(-2).join('/');
	return `…/${tail}`;
};

export const renderInventoryRow = (row: InventoryRow): string => {
	const containers = summarizeContainers(row);
	const networks = `${row.networks.length} network${row.networks.length === 1 ? '' : 's'}`;
	const bytes = volumeBytes(row);
	const sized = bytes > 0 ? ` (~${formatBytes(bytes)})` : '';
	const volumes = `${row.volumes.length} volume${row.volumes.length === 1 ? '' : 's'}${sized}`;
	const state = row.stateDirs.length > 0 ? 'state present' : 'no state';
	const running = row.runningPid !== undefined ? '  ← running' : '';
	const repo =
		row.registryEntry !== undefined ? `  ${shortRepoPath(row.registryEntry.repoPath)}` : '';
	const repoGone = row.classification === 'repo-gone' ? '  [repo gone]' : '';
	return `  ${row.app} / ${row.stack}  —  ${containers}, ${networks}, ${volumes}, ${state}${repo}${repoGone}${running}`;
};

export interface InventoryTotals {
	readonly apps: number;
	readonly stacks: number;
	readonly containers: number;
	readonly networks: number;
	readonly volumes: number;
	readonly bytes: number;
	readonly stateDirs: number;
}

export const totalsFor = (rows: ReadonlyArray<InventoryRow>): InventoryTotals => {
	const apps = new Set<string>();
	let containers = 0;
	let networks = 0;
	let volumes = 0;
	let bytes = 0;
	let stateDirs = 0;
	for (const r of rows) {
		apps.add(r.app);
		containers += r.containers.length;
		networks += r.networks.length;
		volumes += r.volumes.length;
		bytes += volumeBytes(r);
		stateDirs += r.stateDirs.length;
	}
	return {
		apps: apps.size,
		stacks: rows.length,
		containers,
		networks,
		volumes,
		bytes,
		stateDirs,
	};
};

export const renderTotals = (t: InventoryTotals): string =>
	`Total: ${t.apps} app${t.apps === 1 ? '' : 's'}, ${t.stacks} stack${t.stacks === 1 ? '' : 's'}, ${t.containers} container${t.containers === 1 ? '' : 's'}, ${t.networks} network${t.networks === 1 ? '' : 's'}, ${t.volumes} volume${t.volumes === 1 ? '' : 's'}${t.bytes > 0 ? ` (~${formatBytes(t.bytes)})` : ''}, ${t.stateDirs} state ${t.stateDirs === 1 ? 'dir' : 'dirs'}`;

// -----------------------------------------------------------------------------
// Shared Traefik router inventory — singleton across all (app, stack)
// buckets. Surfaced as a top-level row in `doctor` / `prune` so users
// can see whether the cross-stack proxy infrastructure is live and how
// many active stacks would notice if `--include-router` torched it.
// -----------------------------------------------------------------------------

export interface RouterInfo {
	/** Whether the `devstack-traefik` container exists at all (running or not). */
	readonly present: boolean;
	/** Whether the container is currently running. */
	readonly running: boolean;
	/** Number of currently-running containers (across every (app, stack))
	 *  that carry `traefik.enable=true` — these would lose external
	 *  reachability if the router was removed. */
	readonly activeBackends: number;
	/** Distinct `devstack.app` values among those active backends. */
	readonly apps: ReadonlyArray<string>;
}

export const collectRouterInfo = (): Effect.Effect<
	RouterInfo,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		// Probe the singleton router container directly. `docker inspect`
		// exit-0 means it exists; `.State.Running` distinguishes running
		// from stopped. Errors collapse to "not present".
		const inspectCmd = ChildProcess.make('docker', [
			'inspect',
			'--format',
			'{{.State.Running}}',
			ROUTER_CONTAINER,
		]);
		const inspectOut = yield* spawner.string(inspectCmd).pipe(Effect.orElseSucceed(() => ''));
		const trimmed = inspectOut.trim();
		const present = trimmed.length > 0;
		const running = trimmed === 'true';
		// Enumerate every running container with a `traefik.enable=true`
		// label — those are the backends the router currently points at.
		// We don't care about stopped containers (they're not currently
		// using router routing) and we don't care about the router itself
		// (which carries `devstack.router=true`, not `traefik.enable`).
		const backendsCmd = ChildProcess.make('docker', [
			'ps',
			'--filter',
			'label=traefik.enable=true',
			'--format',
			`{{.Label "${DockerLabel.APP}"}}`,
		]);
		const backendsOut = yield* spawner.string(backendsCmd).pipe(Effect.orElseSucceed(() => ''));
		const lines = backendsOut
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const apps = new Set<string>();
		for (const app of lines) {
			if (app.length > 0) apps.add(app);
		}
		return {
			present,
			running,
			activeBackends: lines.length,
			apps: [...apps].sort() as ReadonlyArray<string>,
		};
	}).pipe(Effect.withSpan('InventoryCollectRouter'));

export const renderRouterRow = (info: RouterInfo): string => {
	if (!info.present) {
		return `  devstack-router  —  not running (network: ${ROUTER_NETWORK})`;
	}
	const stateWord = info.running ? 'running' : 'stopped';
	const usedBy =
		info.activeBackends === 0
			? 'no active backends'
			: `${info.activeBackends} backend${info.activeBackends === 1 ? '' : 's'} across ${info.apps.length} app${info.apps.length === 1 ? '' : 's'}`;
	return `  ${ROUTER_CONTAINER}  —  ${stateWord}, ${usedBy}`;
};
