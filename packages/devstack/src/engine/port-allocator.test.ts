// The allocator's correctness rests on its bind probe rejecting any
// port the kernel won't actually let our HTTP/docker servers claim.
// Two interfaces matter:
//
//   - 0.0.0.0     (what `docker -p host:container` binds on by default)
//   - 127.0.0.1   (what wallet-app and `docker -p 127.0.0.1:host:container`
//                  bind on)
//
// On macOS, a 0.0.0.0 bind can coexist with a 127.0.0.1 listener on the
// same port — so a probe that only checked 0.0.0.0 would falsely report
// a 127.0.0.1-bound port "free", and the wallet-app's subsequent
// `server.listen(port, '127.0.0.1')` would throw EADDRINUSE. These
// tests bind a real net.Server in the test process, then ask the
// allocator to allocate the same port and assert it scanned forward.

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, describe, expect, it } from '@effect/vitest';
import {
	claimPortLock,
	PortAllocator,
	PortAllocatorLive,
	releasePortLock,
} from './port-allocator.js';
import { processStartTime } from './process-liveness.js';

// Note: vitest's `setupFiles` (see vitest.config.ts) routes
// `defaultPortLockDir()` at a tmpdir for the whole run, so neither this
// file nor any sibling test stomps the host-wide `~/.devstack/ports/`
// rendezvous dir.

// Pick a port that's almost certainly free on developer machines. We
// don't probe with `isPortFree` here because the whole point is to
// drive the allocator's own probe — so we just pick something
// far above ephemeral defaults and tolerate the rare collision via
// `await listenOrSkip`.
const BASE_PORT = 49_321;

// Track test-side servers so `afterEach` can guarantee close even if
// an assertion throws midway through.
const liveServers: Array<net.Server> = [];

const listenOn = (port: number, host: string): Promise<net.Server> =>
	new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.once('listening', () => resolve(server));
		server.listen(port, host);
	});

const close = (server: net.Server): Promise<void> =>
	new Promise((resolve) => {
		// Force-close any keep-alive sockets so the OS releases the
		// port before the next test runs.
		(server as { closeAllConnections?: () => void }).closeAllConnections?.();
		server.close(() => resolve());
	});

// Each test computes a unique preferred port from the test name so two
// failing tests can't bleed kernel state into each other (TIME_WAIT
// sockets, etc.). Bumped per-test to keep collisions from a long-lived
// dev process out of the picture.
let testPortOffset = 0;
const nextPort = () => BASE_PORT + (testPortOffset += 10);

afterEach(async () => {
	while (liveServers.length > 0) {
		const s = liveServers.pop();
		if (s !== undefined) await close(s);
	}
});

describe('PortAllocator.allocate — dual-host probe', () => {
	it.effect('scans forward when a 127.0.0.1 listener already holds the preferred port', () =>
		Effect.gen(function* () {
			const preferred = nextPort();
			// Bind a real listener on 127.0.0.1 BEFORE asking the allocator.
			// The allocator's `bindProbe` on 127.0.0.1 must fail; it should
			// then advance to preferred + 1 and succeed there.
			const blocker = yield* Effect.tryPromise({
				try: () => listenOn(preferred, '127.0.0.1'),
				catch: (cause) => new Error(`test setup: ${String(cause)}`),
			});
			liveServers.push(blocker);

			const allocator = yield* PortAllocator;
			const port = yield* allocator.allocate(preferred);
			// Allocator must have scanned past the blocked port.
			expect(port).toBeGreaterThan(preferred);
		}).pipe(Effect.provide(PortAllocatorLive)),
	);

	it.effect('scans forward when a 0.0.0.0 listener holds the preferred port', () =>
		Effect.gen(function* () {
			const preferred = nextPort();
			const blocker = yield* Effect.tryPromise({
				try: () => listenOn(preferred, '0.0.0.0'),
				catch: (cause) => new Error(`test setup: ${String(cause)}`),
			});
			liveServers.push(blocker);

			const allocator = yield* PortAllocator;
			const port = yield* allocator.allocate(preferred);
			expect(port).toBeGreaterThan(preferred);
		}).pipe(Effect.provide(PortAllocatorLive)),
	);

	it.effect('returns the preferred port when no external listener holds it', () =>
		Effect.gen(function* () {
			const preferred = nextPort();
			const allocator = yield* PortAllocator;
			const port = yield* allocator.allocate(preferred);
			expect(port).toBe(preferred);
		}).pipe(Effect.provide(PortAllocatorLive)),
	);
});

describe('PortAllocator.release', () => {
	it.effect(
		'release removes the port from the held set so a subsequent allocate returns it again',
		() =>
			// Use a single allocator instance — the held set lives in its
			// Ref, so two `Effect.provide(PortAllocatorLive)` chains would
			// each get their own (empty) set and the second allocate would
			// trivially succeed. We exercise the same instance to prove
			// release flips the bit.
			Effect.gen(function* () {
				const allocator = yield* PortAllocator;
				const preferred = nextPort();

				const first = yield* allocator.allocate(preferred);
				expect(first).toBe(preferred);

				// While `preferred` is held: requesting it again must scan
				// forward. (Same allocator, same held set.)
				const concurrent = yield* allocator.allocate(preferred);
				expect(concurrent).toBeGreaterThan(preferred);

				// Release the original — now the held set is empty for
				// `preferred`. The third allocate should claim it again.
				yield* allocator.release(first);
				const reclaimed = yield* allocator.allocate(preferred);
				expect(reclaimed).toBe(preferred);
			}).pipe(
				// Build the layer once and share its Ref across yields.
				Effect.provide(Layer.fresh(PortAllocatorLive)),
			),
	);
});

// -----------------------------------------------------------------------------
// claimPortLock / releasePortLock — cross-process file lock
// -----------------------------------------------------------------------------
//
// The file lock is the only thing that prevents two parallel devstack
// supervisors (e.g. `DEVSTACK_STACK=test pnpm dev` alongside
// `DEVSTACK_STACK=alpha pnpm dev`) from both probing the same port as
// OS-free, both passing their in-process held-set check, and both
// spawning vite on the same number — the second binds silently fails.
//
// Two paths matter:
//   1. The atomic O_EXCL create (lock claim).
//   2. The stale-pid recovery (a previous supervisor crashed without
//      releasing; the next one detects the dead pid via `kill(0)` and
//      reclaims).
//
// We use a tmpdir as the lock directory so tests don't pollute the
// host's `~/.devstack/ports/`. Each test gets its own directory so a
// failure in one can't strand a lock for another.

describe('claimPortLock / releasePortLock — file lock', () => {
	let lockDir: string;

	const setupTmpDir = () => {
		lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'port-lock-test-'));
	};

	afterEach(() => {
		// Clean up the tmpdir even if a test threw mid-way.
		try {
			fs.rmSync(lockDir, { recursive: true, force: true });
		} catch {
			// directory may not exist if setupTmpDir wasn't called
		}
	});

	it('claims a fresh port and writes our holder JSON to the lock file', () => {
		setupTmpDir();
		const port = 50_001;
		expect(claimPortLock(port, lockDir)).toBe(true);
		const written = fs.readFileSync(path.join(lockDir, `${port}.lock`), 'utf8').trim();
		const parsed = JSON.parse(written) as { pid: number; startedAt: string; host: string };
		expect(parsed.pid).toBe(process.pid);
		expect(typeof parsed.startedAt).toBe('string');
		expect(typeof parsed.host).toBe('string');
	});

	it('rejects re-claiming our own port (idempotence is NOT a goal — caller already holds it)', () => {
		// Defensive: if a primitive accidentally tries to claim a port
		// it already locked, the second call must fail so the caller
		// notices the bug rather than silently succeeding. Production
		// callers (PortAllocator) gate on the in-memory Ref before
		// calling claimPortLock, so the second call should never
		// happen — this pins the contract anyway.
		setupTmpDir();
		const port = 50_002;
		expect(claimPortLock(port, lockDir)).toBe(true);
		// Same pid, same dir — the lock file already exists with our
		// pid, the kill(0) probe succeeds (we ARE alive), so the
		// second call returns false.
		expect(claimPortLock(port, lockDir)).toBe(false);
	});

	it('reclaims a stale lock written by a dead pid', () => {
		// Simulate a previous supervisor crash: write a lock file with
		// a pid that's guaranteed to be dead, then claim. `isHolderLive`
		// reports dead; the function deletes the stale file and writes
		// our own.
		setupTmpDir();
		const port = 50_003;
		// Dead pid: we use a max-int pid that no real process can hold.
		// Linux MAX_PID is typically 2^22; macOS goes a bit higher;
		// either way 2^31 - 1 is comfortably out of range.
		const deadPid = 2_147_483_646;
		const staleHolder = { pid: deadPid, startedAt: '', host: os.hostname() };
		fs.writeFileSync(path.join(lockDir, `${port}.lock`), JSON.stringify(staleHolder));

		expect(claimPortLock(port, lockDir)).toBe(true);

		// The lock file should now contain OUR holder, not the dead one.
		const reclaimed = JSON.parse(
			fs.readFileSync(path.join(lockDir, `${port}.lock`), 'utf8').trim(),
		) as { pid: number };
		expect(reclaimed.pid).toBe(process.pid);
	});

	it('reclaims a stale-format lock (pre-Theme-6c bare pid body)', () => {
		// Pre-Theme-6c locks stored just `String(pid)`. The new
		// parseHolder rejects that as malformed → reclaim. We are
		// unreleased; no migration concern.
		setupTmpDir();
		const port = 50_010;
		fs.writeFileSync(path.join(lockDir, `${port}.lock`), String(process.pid));

		expect(claimPortLock(port, lockDir)).toBe(true);

		const reclaimed = JSON.parse(
			fs.readFileSync(path.join(lockDir, `${port}.lock`), 'utf8').trim(),
		) as { pid: number };
		expect(reclaimed.pid).toBe(process.pid);
	});

	it('refuses to reclaim a lock when the referenced pid is alive', () => {
		// Use the test runner's own pid as the "live" holder, with the
		// matching startedAt so isHolderLive returns true. Real-world
		// equivalent: another supervisor is actually running and holding
		// the port.
		setupTmpDir();
		const port = 50_004;
		// Build a holder for THIS process; processStartTime call must
		// match what the allocator's selfHolder cached. We re-read it
		// here to keep startedAt synchronized.
		const liveHolder = {
			pid: process.pid,
			startedAt: processStartTime(process.pid) ?? '',
			host: os.hostname(),
		};
		const written = JSON.stringify(liveHolder);
		fs.writeFileSync(path.join(lockDir, `${port}.lock`), written);

		// Note: process.pid IS alive. The claim should reject.
		expect(claimPortLock(port, lockDir)).toBe(false);

		// Lock file is untouched.
		const stillThere = fs.readFileSync(path.join(lockDir, `${port}.lock`), 'utf8').trim();
		expect(stillThere).toBe(written);
	});

	it('reclaims an unreadable / corrupt lock file by overwriting it', () => {
		// Lock file exists but contains garbage (not JSON) — parseHolder
		// fails and we treat it as stale.
		setupTmpDir();
		const port = 50_005;
		fs.writeFileSync(path.join(lockDir, `${port}.lock`), 'not-a-holder-at-all');

		expect(claimPortLock(port, lockDir)).toBe(true);

		// Overwritten with our holder JSON.
		const reclaimed = JSON.parse(
			fs.readFileSync(path.join(lockDir, `${port}.lock`), 'utf8').trim(),
		) as { pid: number };
		expect(reclaimed.pid).toBe(process.pid);
	});

	// C1: a lock file we CAN'T READ (EACCES on a multi-user box, EIO on
	// a flaky disk, etc.) must NOT be treated as stale. The holder might
	// still be alive — we simply can't see them. Mirrors state-store +
	// process-liveness which both default to "alive" on read failure.
	it('refuses to reclaim a lock file when readFileSync throws EACCES', () => {
		setupTmpDir();
		const port = 50_009;
		const otherPid = 2_147_483_644;
		const lockPath = path.join(lockDir, `${port}.lock`);
		fs.writeFileSync(lockPath, String(otherPid));
		// Root sees through chmod 000; skip the assertion path then.
		if (typeof process.getuid === 'function' && process.getuid() === 0) return;
		fs.chmodSync(lockPath, 0o000);
		try {
			expect(claimPortLock(port, lockDir)).toBe(false);
			// File must NOT have been unlinked or rewritten.
			fs.chmodSync(lockPath, 0o644);
			const stillThere = fs.readFileSync(lockPath, 'utf8').trim();
			expect(stillThere).toBe(String(otherPid));
		} finally {
			fs.chmodSync(lockPath, 0o644);
		}
	});

	it('release deletes a lock we wrote', () => {
		setupTmpDir();
		const port = 50_006;
		expect(claimPortLock(port, lockDir)).toBe(true);
		expect(fs.existsSync(path.join(lockDir, `${port}.lock`))).toBe(true);

		releasePortLock(port, lockDir);
		expect(fs.existsSync(path.join(lockDir, `${port}.lock`))).toBe(false);
	});

	it('release leaves a lock written by a different pid untouched', () => {
		// Defensive: if a stale-pid recovery raced with us and the lock
		// now belongs to another supervisor's pid, we must NOT delete
		// it. The "only delete if we wrote it" check is the only thing
		// preventing release-loops where two supervisors stomp on each
		// other's locks.
		setupTmpDir();
		const port = 50_007;
		const otherPid = 2_147_483_645;
		fs.writeFileSync(path.join(lockDir, `${port}.lock`), String(otherPid));

		releasePortLock(port, lockDir);

		// Still there.
		expect(fs.existsSync(path.join(lockDir, `${port}.lock`))).toBe(true);
		const untouched = fs.readFileSync(path.join(lockDir, `${port}.lock`), 'utf8').trim();
		expect(untouched).toBe(String(otherPid));
	});

	it('release on a missing lock is a noop (no throw)', () => {
		setupTmpDir();
		const port = 50_008;
		// File doesn't exist; release should swallow the ENOENT silently.
		expect(() => releasePortLock(port, lockDir)).not.toThrow();
	});
});

// -----------------------------------------------------------------------------
// Two concurrent allocate() calls in the same process
// -----------------------------------------------------------------------------
//
// `Ref.modify` inside `allocate` is the in-process race guard: when two
// fibers call `allocate(preferred)` concurrently, both pass the kernel
// bind probe and the cross-process file lock claim, but only one of
// them wins the `Ref.modify` CAS. The loser releases the file lock and
// scans forward to the next port. Without this, two primitives in the
// same supervisor could end up sharing a port number — fatal because
// one of them will silently lose the bind on actual `server.listen`.

describe('PortAllocator.allocate — in-process race guard', () => {
	it.effect('two concurrent allocates against the same preferred return distinct ports', () =>
		Effect.gen(function* () {
			const allocator = yield* PortAllocator;
			const preferred = nextPort();
			// Fork both allocates so they race the Ref.modify CAS.
			const [a, b] = yield* Effect.all(
				[allocator.allocate(preferred), allocator.allocate(preferred)],
				{ concurrency: 'unbounded' },
			);
			expect(a).not.toBe(b);
			// One of them should be the preferred value (whichever won
			// the CAS first); the other scanned forward to preferred+1
			// (or higher if external state intervened).
			expect([a, b]).toContain(preferred);
		}).pipe(Effect.provide(Layer.fresh(PortAllocatorLive))),
	);

	// S1: file lock must be claimed AFTER the in-process CAS succeeds.
	// Reasoning: if a fiber writes the file lock BEFORE running the
	// in-memory CAS, the CAS loser then calls `releasePortLock` to undo
	// its own file-lock write — but if the new lock-acquisition ordering
	// is wrong, that release path can stomp on a peer's lock. We assert
	// the post-state invariant: every port returned by a concurrent
	// allocate has a file lock on disk containing OUR pid, AND a
	// pre-existing sibling-supervisor lock at `preferred` is untouched.
	it.effect("S1: concurrent allocate must not touch a sibling supervisor's file lock", () =>
		Effect.gen(function* () {
			const allocator = yield* PortAllocator;
			const preferred = nextPort();

			// Simulate a sibling supervisor process: pre-write a file
			// lock at `preferred` containing a different-but-alive pid
			// (our parent's pid — guaranteed alive). Both fibers below
			// must refuse the claim AND must not unlink this file.
			const dir = process.env.DEVSTACK_PORT_LOCK_DIR;
			expect(dir).toBeTruthy();
			const siblingPid = process.ppid;
			const siblingHolder = {
				pid: siblingPid,
				startedAt: processStartTime(siblingPid) ?? '',
				host: os.hostname(),
			};
			const siblingBody = JSON.stringify(siblingHolder);
			const siblingLockPath = path.join(dir as string, `${preferred}.lock`);
			fs.writeFileSync(siblingLockPath, siblingBody);

			const [a, b] = yield* Effect.all(
				[allocator.allocate(preferred), allocator.allocate(preferred)],
				{ concurrency: 'unbounded' },
			);
			expect(a).not.toBe(b);
			// Sibling's lock at `preferred` survives untouched.
			expect(fs.existsSync(siblingLockPath)).toBe(true);
			expect(fs.readFileSync(siblingLockPath, 'utf8').trim()).toBe(siblingBody);

			// Neither fiber returned `preferred` (the sibling holds it).
			expect(a).not.toBe(preferred);
			expect(b).not.toBe(preferred);

			// Each fiber's reported port has a live file lock owned by
			// our pid. If the loser had grabbed the file lock pre-CAS
			// (old ordering) and then released it on rollback, this read
			// would race with that release and could ENOENT.
			const readLockPid = (port: number) =>
				(
					JSON.parse(fs.readFileSync(path.join(dir as string, `${port}.lock`), 'utf8').trim()) as {
						pid: number;
					}
				).pid;
			expect(readLockPid(a)).toBe(process.pid);
			expect(readLockPid(b)).toBe(process.pid);
		}).pipe(Effect.provide(Layer.fresh(PortAllocatorLive))),
	);
});
