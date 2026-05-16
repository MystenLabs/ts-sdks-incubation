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

import { Console, Effect, FileSystem, Option } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { Command, Flag } from 'effect/unstable/cli';
import { createServer } from 'node:net';
import {
	collectInventory,
	renderInventoryRow,
	renderTotals,
	totalsFor,
} from '../../engine/docker/inventory.js';
import { isHolderLive } from '../../engine/process-liveness.js';
import { join as joinPath } from 'node:path';

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

const isLockFile = (name: string): boolean =>
	name === 'state.json.lock' || name.endsWith('.lock');

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
			.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
		const out: Array<string> = [];
		for (const entry of entries) {
			const full = joinPath(dir, entry);
			const stat = yield* fs.stat(full).pipe(
				Effect.map((s) => s.type),
				Effect.catch(() => Effect.succeed('Unknown' as const)),
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
		const text = yield* fs
			.readFileString(path)
			.pipe(Effect.orElseSucceed(() => ''));
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
			const acquiredAt =
				typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : undefined;
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
			.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
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
			const ok = yield* fs
				.remove(lock.path)
				.pipe(
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
		const appDir = process.env.DEVSTACK_APP_DIR ?? process.cwd();
		const stateDir = Option.match(stateDirOverride, {
			onSome: (s) => (s.startsWith('/') ? s : joinPath(appDir, s)),
			onNone: () => {
				const env = process.env.DEVSTACK_STATE_DIR;
				if (env !== undefined) return env.startsWith('/') ? env : joinPath(appDir, env);
				return joinPath(appDir, '.devstack');
			},
		});
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

		const all: Array<Check> = [docker, sui, lockCheck, ...ports];
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
				const ageLabel =
					lock.acquiredAt !== undefined ? `, acquired ${lock.acquiredAt}` : '';
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
