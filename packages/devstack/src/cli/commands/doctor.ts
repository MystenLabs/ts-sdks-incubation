// `devstack doctor` — preflight checks + inventory.
//
// V3 parity port. Two-section report, none of which mutate state:
//
//   - Pre-flight checks: docker daemon, sui CLI, common host ports.
//   - Inventory: every (app, stack) bucket of devstack-labelled docker
//     resources on the machine, plus on-disk state dirs. The inventory
//     reads labels from `docker ps -a` / `docker network ls` /
//     `docker volume ls` filtered on `label=devstack.app`, and walks
//     `<cwd>/.devstack/` for state.
//
// We use a fixed port set (9000, 9123, 9125, 5180) per the v4 port plan —
// the v3 version walked the prior snapshot for allocated ports, but v4's
// state-store doesn't yet record per-snapshot port leases in a shape the
// CLI can read without booting the engine.
//
// Doesn't construct an engine. Safe to run any time. Exits 0 unless docker
// is unreachable.

import { Console, Effect, FileSystem } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { Command, Flag } from 'effect/unstable/cli';
import { createServer, Socket } from 'node:net';
import { promises as nodeFs } from 'node:fs';
import {
	collectInventory,
	formatBytes,
	renderInventoryRow,
	renderTotals,
	totalsFor,
} from '../../engine/docker/inventory.js';
import { isHolderLive } from '../../engine/process-liveness.js';
import { join as joinPath } from 'node:path';
import { computeConfigHash, readForkMeta } from '../../engine/sui-fork/meta.js';
import { resolveStateDir } from '../stack-resolution.js';

type Spawner = ReturnType<typeof ChildProcessSpawner.make>;

interface Check {
	readonly name: string;
	readonly ok: boolean;
	readonly required: boolean;
	readonly detail?: string;
}

const COMMON_PORTS: ReadonlyArray<number> = [9000, 9123, 9125, 5180];

const checkDocker = (spawner: Spawner): Effect.Effect<Check> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('docker', ['version', '--format', '{{.Server.Version}}']);
		const out = yield* spawner.string(cmd).pipe(
			Effect.map((s) => ({ ok: true, text: s.trim() })),
			Effect.catch((err) => Effect.succeed({ ok: false, text: String(err) })),
		);
		if (!out.ok) {
			return {
				name: 'Docker daemon',
				ok: false,
				required: true,
				detail: out.text.includes('ENOENT')
					? 'docker not found on PATH'
					: `\`docker version\` failed: ${out.text}`,
			};
		}
		if (out.text.length === 0) {
			return { name: 'Docker daemon', ok: false, required: true, detail: 'no server version' };
		}
		return { name: 'Docker daemon', ok: true, required: true, detail: `server ${out.text}` };
	});

// Match the pinned `DEFAULT_SUI_VERSION` from `services/sui.ts` so
// doctor's drift hint stays in sync without importing the engine
// (the CLI is a thin entrypoint; pulling in the engine here would
// drag in the whole supervisor surface).
const PINNED_SUI_VERSION_TAG = 'devnet-v1.71.0';

// Parse the major.minor.patch out of either form of `sui --version`
// output (`sui 1.71.0-abcdef` or `sui 1.71.0`). Returns undefined when
// the string doesn't match — drift detection silently skips in that
// case rather than printing a misleading warning.
const parseSuiSemver = (text: string): string | undefined => {
	const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
	if (match === null) return undefined;
	return `${match[1]}.${match[2]}.${match[3]}`;
};

const compareMinor = (a: string, b: string): number => {
	const [aM, am] = a.split('.').map(Number) as [number, number, number];
	const [bM, bm] = b.split('.').map(Number) as [number, number, number];
	if (aM !== bM) return aM - bM;
	return am - bm;
};

const checkSui = (spawner: Spawner): Effect.Effect<Check> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('sui', ['--version']);
		const out = yield* spawner.string(cmd).pipe(
			Effect.map((s) => ({ ok: true, text: s.trim() })),
			Effect.catch((err) => Effect.succeed({ ok: false, text: String(err) })),
		);
		if (!out.ok) {
			return {
				name: 'Sui CLI',
				ok: false,
				required: false,
				detail: out.text.includes('ENOENT')
					? 'sui not found on PATH — see https://docs.sui.io/guides/developer/getting-started/sui-install'
					: `\`sui --version\` failed: ${out.text}`,
			};
		}
		// Drift check: parse the host sui's semver and compare against the
		// pinned build-container tag. A patch difference is fine; a minor
		// or major difference is a warning so users see the mismatch
		// before they hit a "schema diverged" failure in `sui move build`
		// or `sui move summary` against vendored Move sources.
		const hostSemver = parseSuiSemver(out.text);
		const pinnedSemver = parseSuiSemver(PINNED_SUI_VERSION_TAG);
		if (hostSemver !== undefined && pinnedSemver !== undefined) {
			const drift = Math.abs(compareMinor(hostSemver, pinnedSemver));
			if (drift > 0) {
				return {
					name: 'Sui CLI',
					ok: true,
					required: false,
					detail: `${out.text} (drift: build container pinned at ${PINNED_SUI_VERSION_TAG}; bindings codegen routes through it, but ad-hoc \`sui\` calls may diverge)`,
				};
			}
		}
		return { name: 'Sui CLI', ok: true, required: false, detail: out.text };
	});

// Try to bind {addr}:port. EADDRINUSE → bound; clean close → free.
const tryBind = (port: number, addr: string): Effect.Effect<boolean> =>
	Effect.callback<boolean>((resume) => {
		const server = createServer();
		server.unref();
		server.once('error', (err) => {
			const code = (err as { code?: string }).code;
			resume(Effect.succeed(code === 'EADDRINUSE'));
		});
		server.listen(port, addr, () => {
			server.close(() => resume(Effect.succeed(false)));
		});
	});

// Probe BOTH `0.0.0.0` and `127.0.0.1`. Either bind failing means the
// port is unavailable to a freshly-launched docker `--publish`. A bare
// `0.0.0.0` probe alone misses processes that bound `127.0.0.1`
// explicitly (some local dev servers do); a bare `127.0.0.1` probe
// misses `::1`-only listeners and races past dual-stack binds. Mirror
// the engine's port-allocator probe so doctor's accounting matches
// what the supervisor will actually see at acquire time.
const isPortBound = (port: number): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const wildcardBound = yield* tryBind(port, '0.0.0.0');
		if (wildcardBound) return true;
		return yield* tryBind(port, '127.0.0.1');
	});

const checkPort = (port: number): Effect.Effect<Check> =>
	Effect.gen(function* () {
		const bound = yield* isPortBound(port);
		return {
			name: `port ${port}`,
			ok: true,
			required: false,
			detail: bound ? 'bound (in use)' : 'free',
		};
	});

// ---------------------------------------------------------------------------
// Phase 4 fork-specific doctor checks
// ---------------------------------------------------------------------------

/** Best-effort discovery of every fork-mode stack on disk. Walks
 *  `.devstack/stacks/* /sui-fork/meta.json` and returns the per-stack
 *  meta + path tuples. Used by the four P4.11-P4.14 checks; an empty
 *  array means "no fork stacks", and the doctor section quietly omits
 *  those rows. */
interface ForkStackEntry {
	readonly stack: string;
	readonly metaPath: string;
	readonly dataDir: string;
	readonly upstream: string;
	readonly checkpoint?: number;
	readonly seedAddresses: ReadonlyArray<string>;
	readonly seedObjects: ReadonlyArray<string>;
	readonly configHash: string;
}

const discoverForkStacks = (fs: FileSystem.FileSystem, stateDirPath: string) =>
	Effect.gen(function* () {
		const stacksDir = joinPath(stateDirPath, 'stacks');
		const entries = yield* fs
			.readDirectory(stacksDir)
			.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
		const out: Array<ForkStackEntry> = [];
		for (const stack of entries) {
			const metaPath = joinPath(stacksDir, stack, 'sui-fork', 'meta.json');
			const dataDir = joinPath(stacksDir, stack, 'sui-fork', 'data');
			const meta = yield* readForkMeta(metaPath);
			if (meta === undefined) continue;
			out.push({
				stack,
				metaPath,
				dataDir,
				upstream: meta.upstream,
				...(meta.checkpoint !== undefined ? { checkpoint: meta.checkpoint } : {}),
				seedAddresses: meta.seedAddresses,
				seedObjects: meta.seedObjects,
				configHash: meta.configHash,
			});
		}
		return out as ReadonlyArray<ForkStackEntry>;
	});

// P4.11 — `sui-fork --version` shell-out. Required when at least one
// fork stack exists, informational otherwise. The binary is the
// devstack-vendored `sui-fork` (lives inside the per-stack docker
// image), so a missing host binary is expected — the check is more
// useful for users who built sui-fork locally and put it on PATH.
const checkSuiForkBinary = (spawner: Spawner, required: boolean): Effect.Effect<Check> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('sui-fork', ['--version']);
		const out = yield* spawner.string(cmd).pipe(
			Effect.map((s) => ({ ok: true, text: s.trim() })),
			Effect.catch((err) => Effect.succeed({ ok: false, text: String(err) })),
		);
		if (!out.ok) {
			return {
				name: 'sui-fork binary',
				ok: false,
				required,
				detail: out.text.includes('ENOENT')
					? 'sui-fork not found on PATH (devstack uses the vendored container binary, so this is informational unless you build sui-fork locally)'
					: `\`sui-fork --version\` failed: ${out.text}`,
			};
		}
		return { name: 'sui-fork binary', ok: true, required, detail: out.text };
	});

// P4.12 — upstream GraphQL reachability. Informational: a fork stack
// boot needs reachable upstream GraphQL (R2), but a transient blip
// doesn't warrant failing doctor. TCP probe of the documented endpoint
// hostnames per upstream.
const TCP_PROBE_TIMEOUT_MS = 2000;
const tcpProbe = (host: string, port: number): Effect.Effect<boolean> =>
	Effect.callback<boolean>((resume) => {
		const socket = new Socket();
		socket.setTimeout(TCP_PROBE_TIMEOUT_MS);
		let done = false;
		const finalize = (ok: boolean) => {
			if (done) return;
			done = true;
			socket.destroy();
			resume(Effect.succeed(ok));
		};
		socket.once('connect', () => finalize(true));
		socket.once('timeout', () => finalize(false));
		socket.once('error', () => finalize(false));
		socket.connect(port, host);
	});

const upstreamGraphqlHost = (upstream: string): string => {
	if (upstream === 'mainnet') return 'fullnode.mainnet.sui.io';
	if (upstream === 'testnet') return 'fullnode.testnet.sui.io';
	if (upstream === 'devnet') return 'fullnode.devnet.sui.io';
	return `fullnode.${upstream}.sui.io`;
};

const checkUpstreamGraphql = (upstreams: ReadonlyArray<string>): Effect.Effect<Check> =>
	Effect.gen(function* () {
		if (upstreams.length === 0) {
			return {
				name: 'upstream GraphQL',
				ok: true,
				required: false,
				detail: 'no fork stacks — skipped',
			};
		}
		const results: Array<{ upstream: string; ok: boolean }> = [];
		for (const u of upstreams) {
			const host = upstreamGraphqlHost(u);
			const ok = yield* tcpProbe(host, 443);
			results.push({ upstream: u, ok });
		}
		const failed = results.filter((r) => !r.ok);
		if (failed.length === 0) {
			return {
				name: 'upstream GraphQL',
				ok: true,
				required: false,
				detail: `reachable: ${results.map((r) => r.upstream).join(', ')}`,
			};
		}
		return {
			name: 'upstream GraphQL',
			ok: false,
			required: false,
			detail:
				`unreachable: ${failed.map((r) => r.upstream).join(', ')} ` +
				`(TCP :443 probe failed within ${TCP_PROBE_TIMEOUT_MS}ms)`,
		};
	});

// P4.13 — seed manifest matches config. Read each stack's meta.json
// and compare against itself (self-consistency check — the configHash
// must agree with the live `computeConfigHash(...)` of the persisted
// fields). Doesn't have access to the user's `devstack.config.ts`
// from inside doctor, so this surfaces corruption / tampering rather
// than runtime-vs-config drift. Drift detection runs at `apply` time
// (`ensureForkMetaConsistent`).
const checkSeedManifests = (stacks: ReadonlyArray<ForkStackEntry>): Effect.Effect<Check> => {
	if (stacks.length === 0) {
		return Effect.succeed({
			name: 'fork seed manifest',
			ok: true,
			required: false,
			detail: 'no fork stacks — skipped',
		});
	}
	const drifted: Array<{ stack: string; expected: string; got: string }> = [];
	for (const s of stacks) {
		const recomputed = computeConfigHash({
			upstream: s.upstream,
			...(s.checkpoint !== undefined ? { checkpoint: s.checkpoint } : {}),
			seedAddresses: s.seedAddresses,
			seedObjects: s.seedObjects,
		});
		if (recomputed !== s.configHash) {
			drifted.push({ stack: s.stack, expected: recomputed, got: s.configHash });
		}
	}
	if (drifted.length === 0) {
		return Effect.succeed({
			name: 'fork seed manifest',
			ok: true,
			required: false,
			detail: `${stacks.length} fork stack${stacks.length === 1 ? '' : 's'} self-consistent`,
		});
	}
	return Effect.succeed({
		name: 'fork seed manifest',
		ok: false,
		required: false,
		detail:
			`${drifted.length} stack${drifted.length === 1 ? '' : 's'} have corrupt meta.json (configHash drift): ` +
			drifted.map((d) => `${d.stack} (expected ${d.expected}, got ${d.got})`).join('; '),
	});
};

// P4.14 — fork data dir size per active fork stack. Informational. A
// large data dir is expected (the writable layer carries full chain
// state for the fork's lifetime); we surface the size so operators can
// compare against the 1GB threshold that flips `--include-fork-data`
// off in `snapshot save`.
const checkForkDataSizes = async (stacks: ReadonlyArray<ForkStackEntry>): Promise<Check> => {
	if (stacks.length === 0) {
		return {
			name: 'fork data dir size',
			ok: true,
			required: false,
			detail: 'no fork stacks — skipped',
		};
	}
	const rows: Array<string> = [];
	for (const s of stacks) {
		const bytes = await safeDataDirSize(s.dataDir);
		rows.push(`${s.stack}=${formatBytes(bytes)}`);
	}
	return {
		name: 'fork data dir size',
		ok: true,
		required: false,
		detail: rows.join(', '),
	};
};

const safeDataDirSize = async (root: string): Promise<number> => {
	try {
		const stat = await nodeFs.stat(root);
		if (stat.isDirectory()) {
			let total = 0;
			const entries = await nodeFs.readdir(root);
			for (const entry of entries) {
				total += await safeDataDirSize(joinPath(root, entry));
			}
			return total;
		}
		return stat.size;
	} catch {
		return 0;
	}
};

const renderCheck = (c: Check): string => {
	const tag = c.ok ? '✓' : c.required ? '✗' : '!';
	const reqTag = c.required ? '' : ' (informational)';
	const detail = c.detail !== undefined ? ` — ${c.detail}` : '';
	return `  ${tag} ${c.name}${reqTag}${detail}`;
};

// Find every `*.lock` file under `<root>/.devstack/` whose holder pid is
// dead and remove it. Stale locks are orphans: the supervisor that
// wrote them is gone, but its `state.json.lock` was never deleted
// (e.g. SIGKILL skipped the scope finalizer, the machine power-cycled,
// or a Docker Desktop hang killed the host process). Without cleanup,
// the next `pnpm dev` for that stack fails with a misleading
// "stack 'main' is already running (pid <dead>)" message.
//
// We only consider `<root>/.devstack/` — explicitly NOT
// `~/.devstack/` — because:
//   1. Per-repo locks live here; the global registry doesn't carry
//      O_EXCL lock files.
//   2. Walking the user's home for `*.lock` overreaches doctor's
//      scope ("preflight for THIS app").
//
// `DEVSTACK_APP_DIR` env override is honored to mirror the rest of
// the toolchain.
interface StaleLock {
	readonly path: string;
	readonly pid: number | undefined;
	readonly startedAt: string;
	readonly host: string;
	/** Parsed `acquiredAt` ISO string, when available. Surfaces in the
	 *  detail line so the user can correlate against e.g. their last
	 *  laptop restart. */
	readonly acquiredAt: string | undefined;
}

const isLockFile = (name: string): boolean => name === 'state.json.lock' || name.endsWith('.lock');

// Walk one directory looking for `*.lock` files. Returns them as
// absolute paths. Non-recursive — locks live one directory deep
// (`.devstack/stacks/<stack>/state.json.lock`,
//  `.devstack/networks/<network>.lock`).
const listLockFiles = (
	fs: FileSystem.FileSystem,
	dir: string,
): Effect.Effect<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
		if (!exists) return [];
		const entries = yield* fs
			.readDirectory(dir)
			.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
		const out: Array<string> = [];
		for (const entry of entries) {
			const full = joinPath(dir, entry);
			const stat = yield* fs.stat(full).pipe(
				Effect.map((s) => s.type),
				Effect.orElseSucceed(() => 'Unknown' as const),
			);
			if (stat === 'File' && isLockFile(entry)) out.push(full);
		}
		return out as ReadonlyArray<string>;
	});

const readLockBody = (
	fs: FileSystem.FileSystem,
	path: string,
): Effect.Effect<{
	pid: number | undefined;
	startedAt: string;
	host: string;
	acquiredAt: string | undefined;
}> =>
	Effect.gen(function* () {
		const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ''));
		if (text.trim().length === 0) {
			return { pid: undefined, startedAt: '', host: '', acquiredAt: undefined };
		}
		try {
			const parsed = JSON.parse(text) as {
				pid?: unknown;
				startedAt?: unknown;
				host?: unknown;
				acquiredAt?: unknown;
			};
			const pid =
				typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) && parsed.pid > 0
					? parsed.pid
					: undefined;
			const startedAt = typeof parsed.startedAt === 'string' ? parsed.startedAt : '';
			const host = typeof parsed.host === 'string' ? parsed.host : '';
			const acquiredAt = typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : undefined;
			return { pid, startedAt, host, acquiredAt };
		} catch {
			return { pid: undefined, startedAt: '', host: '', acquiredAt: undefined };
		}
	});

const findStaleLocks = (
	fs: FileSystem.FileSystem,
	devstackDir: string,
): Effect.Effect<ReadonlyArray<StaleLock>> =>
	Effect.gen(function* () {
		const candidates: Array<string> = [];
		// Per-stack localnet locks: `.devstack/stacks/<stack>/state.json.lock`.
		const stacksDir = joinPath(devstackDir, 'stacks');
		const stacksEntries = yield* fs
			.readDirectory(stacksDir)
			.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
		for (const stack of stacksEntries) {
			const stackDir = joinPath(stacksDir, stack);
			const inner = yield* listLockFiles(fs, stackDir);
			for (const p of inner) candidates.push(p);
		}
		// Live-net locks: `.devstack/networks/<network>.lock`.
		const netsDir = joinPath(devstackDir, 'networks');
		const netLocks = yield* listLockFiles(fs, netsDir);
		for (const p of netLocks) candidates.push(p);
		// Legacy flat lock: `.devstack/state.json.lock`.
		const flatLock = joinPath(devstackDir, 'state.json.lock');
		const flatExists = yield* fs.exists(flatLock).pipe(Effect.orElseSucceed(() => false));
		if (flatExists) candidates.push(flatLock);

		const out: Array<StaleLock> = [];
		for (const path of candidates) {
			const body = yield* readLockBody(fs, path);
			// A lock is "stale" if the pid is missing/unreadable (the body
			// is corrupt — no holder to defer to) OR the pid+startedAt
			// pair fails the start-time-aware liveness check (defends
			// against PID-reuse — a reused pid that happens to be alive
			// but with a different start time should NOT be treated as
			// the original holder). Cross-host holders are conservatively
			// classified as live so we don't blow away a peer's lock on
			// a shared filesystem.
			const stale =
				body.pid === undefined ||
				!isHolderLive({ pid: body.pid, startedAt: body.startedAt, host: body.host });
			if (stale) {
				out.push({
					path,
					pid: body.pid,
					startedAt: body.startedAt,
					host: body.host,
					acquiredAt: body.acquiredAt,
				});
			}
		}
		return out as ReadonlyArray<StaleLock>;
	});

const removeStaleLocks = (
	fs: FileSystem.FileSystem,
	locks: ReadonlyArray<StaleLock>,
): Effect.Effect<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		const removed: Array<string> = [];
		for (const lock of locks) {
			// Re-verify the holder is dead immediately before unlink. The
			// findStaleLocks pass and the unlink can race a supervisor
			// that just woke up and rewrote the lock body; checking again
			// here keeps the window between observation and mutation as
			// narrow as a single read.
			const body = yield* readLockBody(fs, lock.path);
			if (
				body.pid !== undefined &&
				isHolderLive({ pid: body.pid, startedAt: body.startedAt, host: body.host })
			) {
				continue;
			}
			const ok = yield* fs.remove(lock.path).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false),
			);
			if (ok) removed.push(lock.path);
		}
		return removed as ReadonlyArray<string>;
	});

const cleanLocksFlag = Flag.boolean('clean-locks').pipe(
	Flag.withDescription(
		'Remove dead state-store lock files (default: report only). Required ' +
			'before doctor will mutate disk state under .devstack/.',
	),
	Flag.withDefault(false),
);

const stateDirOverrideFlag = Flag.string('state-dir').pipe(
	Flag.withDescription(
		'Override DEVSTACK_STATE_DIR for the stale-lock walk. Defaults to ' +
			'<DEVSTACK_APP_DIR>/.devstack/.',
	),
	Flag.optional,
);

export const doctorCommand = Command.make(
	'doctor',
	{ cleanLocks: cleanLocksFlag, stateDirOverride: stateDirOverrideFlag },
	({ cleanLocks, stateDirOverride }) =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const fs = yield* FileSystem.FileSystem;
			const docker = yield* checkDocker(spawner);
			const sui = yield* checkSui(spawner);
			const ports: Array<Check> = [];
			for (const p of COMMON_PORTS) {
				ports.push(yield* checkPort(p));
			}

			// Stale state-store locks: each `.devstack/**/state.json.lock`
			// whose holder pid is dead blocks the next `pnpm dev` for that
			// stack with a misleading "already running (pid <dead>)" error.
			// We REPORT them by default and only mutate disk under
			// `--clean-locks` — the prior auto-clean was safe in theory
			// (an orphan can't race itself) but a doctor + mid-write
			// supervisor on the same machine could still misclassify a
			// holder mid-rewrite, and we'd rather a `--clean-locks` opt-in
			// than a defensible-but-surprising default.
			//
			// Honor --state-dir override AND DEVSTACK_STATE_DIR — the latter
			// is read at action-time so a fixture exporting it after CLI
			// import sees the override.
			const stateDir = resolveStateDir({ override: stateDirOverride });
			const staleLocks = yield* findStaleLocks(fs, stateDir);
			const removedLocks = cleanLocks
				? yield* removeStaleLocks(fs, staleLocks)
				: ([] as ReadonlyArray<string>);
			const lockCheck: Check =
				staleLocks.length === 0
					? { name: 'State-store locks', ok: true, required: false, detail: 'no stale locks' }
					: !cleanLocks
						? {
								name: 'State-store locks',
								ok: false,
								required: false,
								detail: `${staleLocks.length} stale lock${staleLocks.length === 1 ? '' : 's'} found — re-run with --clean-locks to remove`,
							}
						: {
								name: 'State-store locks',
								ok: removedLocks.length === staleLocks.length,
								required: false,
								detail:
									removedLocks.length === staleLocks.length
										? `removed ${removedLocks.length} stale lock${removedLocks.length === 1 ? '' : 's'}`
										: `removed ${removedLocks.length}/${staleLocks.length} stale lock${staleLocks.length === 1 ? '' : 's'} (rest still held or filesystem error)`,
							};

			// Phase 4 fork-specific checks. Each is a no-op when no fork
			// stacks are present on disk; otherwise:
			//   - P4.11 — `sui-fork --version` shell-out (informational
			//     unless the host has a local build).
			//   - P4.12 — TCP probe of upstream GraphQL endpoints.
			//   - P4.13 — meta.json configHash self-consistency.
			//   - P4.14 — per-stack fork data dir size.
			const forkStacks = yield* discoverForkStacks(fs, stateDir);
			const suiForkCheck = yield* checkSuiForkBinary(spawner, false);
			const upstreams = Array.from(new Set(forkStacks.map((s) => s.upstream)));
			const graphqlCheck = yield* checkUpstreamGraphql(upstreams);
			const seedCheck = yield* checkSeedManifests(forkStacks);
			const dataSizeCheck = yield* Effect.promise(() => checkForkDataSizes(forkStacks));

			const all: Array<Check> = [
				docker,
				sui,
				lockCheck,
				...ports,
				suiForkCheck,
				graphqlCheck,
				seedCheck,
				dataSizeCheck,
			];
			yield* Console.log('Checks');
			for (const c of all) {
				yield* Console.log(renderCheck(c));
			}
			// One detail line per cleaned lock so the user can audit what
			// got removed without re-running with a verbose flag.
			if (removedLocks.length > 0) {
				for (const lock of staleLocks) {
					if (!removedLocks.includes(lock.path)) continue;
					const pidLabel = lock.pid !== undefined ? `pid ${lock.pid}` : 'unreadable holder';
					const ageLabel = lock.acquiredAt !== undefined ? `, acquired ${lock.acquiredAt}` : '';
					yield* Console.log(`      └─ ${lock.path} (${pidLabel}${ageLabel})`);
				}
			}

			// Inventory only runs when the docker daemon is reachable —
			// otherwise `collectInventory` would emit empty rows and the
			// section would be noise. Doctor's exit-code semantics are
			// unchanged: docker-down still fails the command.
			if (docker.ok) {
				yield* Console.log('');
				yield* Console.log('Inventory');
				const rows = yield* collectInventory();
				if (rows.length === 0) {
					yield* Console.log('  (no devstack-labelled resources)');
				} else {
					for (const row of rows) {
						yield* Console.log(renderInventoryRow(row));
					}
					yield* Console.log('');
					yield* Console.log(renderTotals(totalsFor(rows)));
					// Compact running / repo-gone summary line. Only mentions
					// repo-gone when there's at least one — otherwise the
					// hint below is the only call to action and the line
					// stays quiet.
					const runningCount = rows.filter((r) => r.runningPid !== undefined).length;
					const repoGoneCount = rows.filter((r) => r.classification === 'repo-gone').length;
					yield* Console.log(
						`Total: ${rows.length} stack${rows.length === 1 ? '' : 's'}. ${runningCount} running. ${repoGoneCount} with missing repo directory.`,
					);
					if (repoGoneCount > 0) {
						yield* Console.log('');
						yield* Console.log(
							`Run \`devstack prune --repo-gone --yes\` to clean ${repoGoneCount} stack${repoGoneCount === 1 ? '' : 's'} whose project is gone.`,
						);
					}
				}
			}

			const failedRequired = all.filter((c) => c.required && !c.ok);
			if (failedRequired.length > 0) {
				yield* Console.log('');
				yield* Console.log(`${failedRequired.length} required check(s) failed.`);
				return yield* Effect.fail(new Error('doctor: required checks failed'));
			}
		}),
).pipe(
	Command.withDescription('Preflight checks + inventory of devstack-labelled docker resources'),
);
