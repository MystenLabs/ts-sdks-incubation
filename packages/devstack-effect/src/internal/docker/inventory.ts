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
import { join as joinPath } from 'node:path';

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
}

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
const listContainers = (
	spawner: Spawner,
): Effect.Effect<ReadonlyArray<RawContainer>> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('docker', [
			'ps',
			'-a',
			'--filter',
			'label=devstack.app',
			'--format',
			'{{.ID}}\t{{.Label "devstack.app"}}\t{{.Label "devstack.stack"}}\t{{.Names}}\t{{.State}}\t{{.Status}}',
		]);
		const out = yield* spawner.string(cmd).pipe(Effect.catch(() => Effect.succeed('')));
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

const listNetworks = (
	spawner: Spawner,
): Effect.Effect<ReadonlyArray<RawNetwork>> =>
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
			'label=devstack.app',
		]);
		const idsText = yield* spawner.string(lsCmd).pipe(Effect.catch(() => Effect.succeed('')));
		const ids = idsText
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (ids.length === 0) return [] as ReadonlyArray<RawNetwork>;
		const inspectCmd = ChildProcess.make('docker', [
			'network',
			'inspect',
			'--format',
			'{{.Id}}\t{{.Name}}\t{{index .Labels "devstack.app"}}\t{{index .Labels "devstack.stack"}}',
			...ids,
		]);
		const out = yield* spawner.string(inspectCmd).pipe(Effect.catch(() => Effect.succeed('')));
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

const listVolumes = (
	spawner: Spawner,
): Effect.Effect<ReadonlyArray<RawVolume>> =>
	Effect.gen(function* () {
		const lsCmd = ChildProcess.make('docker', [
			'volume',
			'ls',
			'-q',
			'--filter',
			'label=devstack.app',
		]);
		const namesText = yield* spawner.string(lsCmd).pipe(Effect.catch(() => Effect.succeed('')));
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
			'{{.Name}}\t{{index .Labels "devstack.app"}}\t{{index .Labels "devstack.stack"}}',
			...names,
		]);
		const out = yield* spawner.string(inspectCmd).pipe(Effect.catch(() => Effect.succeed('')));
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
const fetchVolumeSizes = (
	spawner: Spawner,
): Effect.Effect<ReadonlyMap<string, number>> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('docker', ['system', 'df', '-v', '--format', '{{json .}}']);
		const out = yield* spawner.string(cmd).pipe(Effect.catch(() => Effect.succeed('')));
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
			const exists = yield* fs
				.exists(devstackDir)
				.pipe(Effect.catch(() => Effect.succeed(false)));
			if (!exists) continue;
			// Per-stack layout.
			const stacksRoot = joinPath(devstackDir, 'stacks');
			const stacksExists = yield* fs
				.exists(stacksRoot)
				.pipe(Effect.catch(() => Effect.succeed(false)));
			if (stacksExists) {
				const entries = yield* fs
					.readDirectory(stacksRoot)
					.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
				for (const entry of entries) {
					const stackDir = joinPath(stacksRoot, entry);
					const isDir = yield* fs.stat(stackDir).pipe(
						Effect.map((s) => s.type === 'Directory'),
						Effect.catch(() => Effect.succeed(false)),
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
			const flatExists = yield* fs
				.exists(flat)
				.pipe(Effect.catch(() => Effect.succeed(false)));
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
		const exists = yield* fs.exists(lockPath).pipe(Effect.catch(() => Effect.succeed(false)));
		if (!exists) return undefined;
		const text = yield* fs.readFileString(lockPath).pipe(Effect.catch(() => Effect.succeed('')));
		if (text.trim().length === 0) return undefined;
		try {
			const parsed = JSON.parse(text) as { pid?: unknown };
			if (typeof parsed.pid === 'number' && Number.isFinite(parsed.pid)) return parsed.pid;
		} catch {
			return undefined;
		}
		return undefined;
	});

// Mirror of `state-store.ts:isHolderLive` minus the start-time match
// (we don't have access to the original `startedAt` here; for the
// inventory a bare `kill(0)` is good enough — if the PID happens to
// have been reused we'll surface a false positive "running" instead of
// silently pruning an active supervisor's state, which is the safer
// failure mode).
export const isPidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// EPERM proves the PID is in use even though we can't signal it.
		return code === 'EPERM';
	}
};

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
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const fs = yield* FileSystem.FileSystem;

		const [containers, networks, volumes, sizes] = yield* Effect.all(
			[
				listContainers(spawner),
				listNetworks(spawner),
				listVolumes(spawner),
				fetchVolumeSizes(spawner),
			],
			{ concurrency: 'unbounded' },
		);

		// Bucket by (app, stack). Use `<app> <stack>` as the map key
		// — ` ` can't appear in either field (docker rejects it in
		// labels), so collisions are impossible.
		type Bucket = {
			containers: Array<ContainerRef>;
			networks: Array<NetworkRef>;
			volumes: Array<VolumeRef>;
		};
		const buckets = new Map<string, Bucket>();
		const ensure = (app: string, stack: string): Bucket => {
			const k = `${app} ${stack}`;
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
		const cwd = process.env.DEVSTACK_APP_DIR ?? process.cwd();
		const roots =
			options.roots !== undefined
				? options.roots
				: ([cwd] as ReadonlyArray<string>);

		// Enumerate state dirs ONCE across all roots — the result is
		// independent of (app, stack), so we filter by stack name
		// per-bucket below.
		const states = yield* enumerateStateLocations(fs, roots);

		const rows: Array<InventoryRow> = [];
		for (const [key, bucket] of buckets) {
			const [app, stack] = key.split(' ') as [string, string];
			const matchingStates = states.filter((s) => s.stack === stack);
			const runningPid = matchingStates.find((s) => s.pid !== undefined && isPidAlive(s.pid))
				?.pid;
			rows.push({
				app,
				stack,
				containers: bucket.containers,
				networks: bucket.networks,
				volumes: bucket.volumes,
				stateDirs: matchingStates.map((s) => s.dir),
				runningPid,
			});
		}

		// Orphan-state-only rows (state on disk but no docker resources)
		// are deliberately omitted here: the state file holds the
		// per-primitive data but not the originating `app` label, so we
		// can't attribute them. Operators in that situation can clear
		// from inside the repo with a regular `wipe --yes`.

		// Stable order: by app then stack.
		rows.sort((a, b) => {
			if (a.app !== b.app) return a.app < b.app ? -1 : 1;
			return a.stack < b.stack ? -1 : a.stack > b.stack ? 1 : 0;
		});
		return rows as ReadonlyArray<InventoryRow>;
	}).pipe(Effect.withSpan('inventory.collect'));

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

export const renderInventoryRow = (row: InventoryRow): string => {
	const containers = summarizeContainers(row);
	const networks = `${row.networks.length} network${row.networks.length === 1 ? '' : 's'}`;
	const bytes = volumeBytes(row);
	const sized = bytes > 0 ? ` (~${formatBytes(bytes)})` : '';
	const volumes = `${row.volumes.length} volume${row.volumes.length === 1 ? '' : 's'}${sized}`;
	const state = row.stateDirs.length > 0 ? 'state present' : 'no state';
	const running = row.runningPid !== undefined ? '  ← running' : '';
	return `  ${row.app} / ${row.stack}  —  ${containers}, ${networks}, ${volumes}, ${state}${running}`;
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
