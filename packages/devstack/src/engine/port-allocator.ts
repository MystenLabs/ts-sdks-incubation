// Port allocator — hands out free TCP ports. Composite primitives (sui,
// walrus, seal, the Dev host process, anything calling Docker.run) use
// it instead of pinning host:container 1:1, so two stacks can run
// side-by-side without manual port juggling.
//
// `allocate(preferred)` scans forward from `preferred` up to `maxScan`
// ports, returning the first port that is (a) not in our held set and
// (b) bindable on `0.0.0.0`. We hold the port in a Ref so subsequent
// allocations don't race for the same number. `release(port)` removes
// from the set — the OS handles the actual socket teardown.

import { Context, Effect, Layer, Ref, Schema } from 'effect';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { hostname } from 'node:os';
import { isHolderLive, processStartTime, type LockHolder } from './process-liveness.js';

export interface PortAllocatorShape {
	/** Reserve a port near the preferred. If preferred is in use, scan forward up to maxScan. */
	readonly allocate: (
		preferred: number,
		options?: { maxScan?: number },
	) => Effect.Effect<number, PortAllocatorError>;
	/** Release a port previously allocated. */
	readonly release: (port: number) => Effect.Effect<void>;
	/** Snapshot of currently-held ports. */
	readonly snapshot: Effect.Effect<ReadonlyArray<number>>;
}

export class PortAllocator extends Context.Service<PortAllocator, PortAllocatorShape>()(
	'@devstack/PortAllocator',
) {}

export class PortAllocatorError extends Schema.TaggedErrorClass<PortAllocatorError>()(
	'PortAllocatorError',
	{
		preferred: Schema.Number,
		message: Schema.String,
	},
) {}

// OS-level probe: try to bind a fresh server to the port on BOTH
// 0.0.0.0 and 127.0.0.1. Docker's `-p 127.0.0.1:host:container` and
// our wallet-app server both bind specifically to 127.0.0.1 — a probe
// that only checked 0.0.0.0 would report the port free while
// another loopback-bound process still holds it (the kernel lets
// 0.0.0.0:N coexist with another listener on 127.0.0.1:N on macOS).
// Requiring both interfaces match what docker run / Node http actually
// claim. Any error (EADDRINUSE, EACCES, etc.) collapses to false.
const bindProbe = (port: number, host: string): Promise<boolean> =>
	new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', () => {
			server.unref();
			server.close();
			resolve(false);
		});
		server.once('listening', () => {
			server.close(() => resolve(true));
		});
		server.listen(port, host);
	});
// Host-wide port reservation directory. Two devstack supervisors
// running side-by-side (e.g. `DEVSTACK_STACK=test pnpm dev` +
// `DEVSTACK_STACK=alpha pnpm dev`) each maintain their own in-memory
// `held` Ref — so without a shared filesystem rendezvous, both can
// independently probe an OS-free port, both pass the in-memory check,
// and both spawn vite against the same number. The first vite binds;
// the second silently EADDRINUSE's. We write `<port>.lock` containing
// our pid; the create is atomic (`wx`), so only one allocator can
// own a given port at a time. Lock is deleted on `release()` and on
// supervisor scope teardown.
//
// `defaultPortLockDir` is computed lazily so tests can pass an
// isolated tmpdir (no host-wide lock pollution); the allocator below
// falls through to the default.
// Lazy-evaluated so tests (and forked CI workers) can swap the
// rendezvous dir via `DEVSTACK_PORT_LOCK_DIR` without poisoning each
// other's locks. Without an override falls back to the per-user dir.
export const defaultPortLockDir = (): string =>
	process.env.DEVSTACK_PORT_LOCK_DIR ?? path.join(os.homedir(), '.devstack', 'ports');
const portLockPath = (dir: string, port: number): string => path.join(dir, `${port}.lock`);

// Lock body is JSON `{ pid, startedAt, host }` — Theme 6c upgraded from
// the bare-pid format so PID reuse on long-uptime machines can't trick
// stale-recovery. Self-holder is cached because `processStartTime`
// shells out to `ps`; we don't want O(allocations) forks.
let cachedSelfHolder: LockHolder | undefined;
const selfHolder = (): LockHolder => {
	if (cachedSelfHolder === undefined) {
		cachedSelfHolder = {
			pid: process.pid,
			startedAt: processStartTime(process.pid) ?? '',
			host: hostname(),
		};
	}
	return cachedSelfHolder;
};

const serializeHolder = (h: LockHolder): string =>
	JSON.stringify({ pid: h.pid, startedAt: h.startedAt, host: h.host });

// Parse the lock body. Returns undefined for stale-format (e.g. the
// pre-Theme-6c bare-pid format) or malformed JSON; the caller treats
// undefined as "reclaim it, the prior writer used an obsolete schema".
const parseHolder = (raw: string): LockHolder | undefined => {
	try {
		const obj = JSON.parse(raw.trim()) as unknown;
		if (
			obj !== null &&
			typeof obj === 'object' &&
			'pid' in obj &&
			'startedAt' in obj &&
			'host' in obj &&
			typeof (obj as { pid: unknown }).pid === 'number' &&
			typeof (obj as { startedAt: unknown }).startedAt === 'string' &&
			typeof (obj as { host: unknown }).host === 'string'
		) {
			return obj as LockHolder;
		}
		return undefined;
	} catch {
		return undefined;
	}
};

// `true` if successfully claimed; `false` if another LIVE process holds the lock.
// Treats stale locks (referenced pid no longer exists) as reusable: we delete
// the stale file and retry the create. Exported for unit tests; production
// callers go through PortAllocator.allocate.
export const claimPortLock = (port: number, dir: string = defaultPortLockDir()): boolean => {
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(portLockPath(dir, port), serializeHolder(selfHolder()), { flag: 'wx' });
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
	}
	// Lock exists: only reclaim if we can prove the holder is gone.
	// ENOENT here = the file vanished between EEXIST and read (a peer
	// just released); the unlink-then-rewrite below will succeed
	// (unlink ENOENT is the only failure mode and we re-try the wx
	// create). EACCES / EIO / EPERM / any other read failure = we
	// CANNOT prove the holder is dead; mirror state-store + process-
	// liveness and treat the holder as alive (refuse the claim).
	let raw: string;
	try {
		raw = fs.readFileSync(portLockPath(dir, port), 'utf8');
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'ENOENT' ? attemptReclaim(port, dir) : false;
	}
	const holder = parseHolder(raw);
	if (holder === undefined) {
		// Stale-format (pre-Theme-6c bare pid) or corrupt JSON — reclaim.
		return attemptReclaim(port, dir);
	}
	if (isHolderLive(holder)) return false;
	return attemptReclaim(port, dir);
};

const attemptReclaim = (port: number, dir: string): boolean => {
	try {
		fs.unlinkSync(portLockPath(dir, port));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
	}
	try {
		fs.writeFileSync(portLockPath(dir, port), serializeHolder(selfHolder()), { flag: 'wx' });
		return true;
	} catch {
		return false;
	}
};
export const releasePortLock = (port: number, dir: string = defaultPortLockDir()): void => {
	try {
		const raw = fs.readFileSync(portLockPath(dir, port), 'utf8');
		const holder = parseHolder(raw);
		// Only delete if WE wrote the lock — defensive against a racing
		// process that already cleaned ours and wrote its own holder.
		// Stale-format / unparsable body: someone else wrote it (we always
		// write JSON now), so leave it alone.
		if (holder === undefined) return;
		const me = selfHolder();
		if (
			holder.pid === me.pid &&
			holder.startedAt === me.startedAt &&
			holder.host === me.host
		) {
			fs.unlinkSync(portLockPath(dir, port));
		}
	} catch {
		// missing / unreadable: nothing to do
	}
};

const isPortFree = async (port: number): Promise<boolean> => {
	// MUST be sequential, not parallel: on Linux, a `0.0.0.0:port`
	// bind covers `127.0.0.1:port`, so a concurrent `127.0.0.1:port`
	// probe would always EADDRINUSE while the wildcard probe still
	// holds the port. macOS allows the two binds to coexist, which
	// masked the bug locally; CI (Ubuntu runner) failed every
	// allocate. Probe wildcard first, fully close it, then probe
	// loopback.
	const wildcardOk = await bindProbe(port, '0.0.0.0');
	if (!wildcardOk) return false;
	return bindProbe(port, '127.0.0.1');
};

export const PortAllocatorLive: Layer.Layer<PortAllocator> = Layer.effect(
	PortAllocator,
	Effect.gen(function* () {
		const ref = yield* Ref.make<Set<number>>(new Set());

		const allocate = (
			preferred: number,
			options?: { maxScan?: number },
		): Effect.Effect<number, PortAllocatorError> =>
			Effect.gen(function* () {
				const maxScan = options?.maxScan ?? 100;
				for (let port = preferred; port <= preferred + maxScan; port++) {
					const held = yield* Ref.get(ref);
					if (held.has(port)) continue;
					const free = yield* Effect.tryPromise({
						try: () => isPortFree(port),
						catch: () => new PortAllocatorError({ preferred, message: `probe failed for ${port}` }),
					}).pipe(Effect.orElseSucceed(() => false));
					if (!free) continue;
					// Phase 1 (in-process CAS): atomically reserve in the
					// held set. MUST run before the cross-process file
					// lock — otherwise two concurrent fibers in this
					// process both claim the same file lock, the loser's
					// `releasePortLock` then unlinks the WINNER's file,
					// and a third sibling supervisor can grab the port
					// from under us.
					const claimed = yield* Ref.modify(ref, (s) => {
						if (s.has(port)) return [false, s] as const;
						const next = new Set(s);
						next.add(port);
						return [true, next] as const;
					});
					if (!claimed) continue;
					// Phase 2 (cross-process file lock): only one
					// supervisor host-wide can own `<port>.lock`. If a
					// sibling process holds it, roll back the in-memory
					// reservation and scan forward.
					if (claimPortLock(port)) return port;
					yield* Ref.update(ref, (s) => {
						if (!s.has(port)) return s;
						const next = new Set(s);
						next.delete(port);
						return next;
					});
				}
				return yield* Effect.fail(
					new PortAllocatorError({
						preferred,
						message: `No free port found in [${preferred}, ${preferred + maxScan}]`,
					}),
				);
			}).pipe(Effect.withSpan('PortAllocator.allocate', { attributes: { preferred } }));

		const release = (port: number): Effect.Effect<void> =>
			Effect.gen(function* () {
				yield* Effect.sync(() => releasePortLock(port));
				yield* Ref.update(ref, (s) => {
					if (!s.has(port)) return s;
					const next = new Set(s);
					next.delete(port);
					return next;
				});
			});

		const snapshot: Effect.Effect<ReadonlyArray<number>> = Ref.get(ref).pipe(
			Effect.map((s) => Array.from(s)),
		);

		// On supervisor shutdown, drop every port lock this allocator
		// owns. Primitives rarely call `release()` explicitly; without
		// this finalizer, lock files leak across runs and the
		// stale-pid recovery path is the only thing keeping the dir
		// usable. Best-effort: errors are swallowed.
		yield* Effect.addFinalizer(() =>
			Ref.get(ref).pipe(
				Effect.map((held) => {
					for (const port of held) releasePortLock(port);
				}),
				Effect.ignore,
			),
		);

		return { allocate, release, snapshot };
	}),
);
