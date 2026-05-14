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

import * as net from 'node:net';
import { Effect, Layer } from 'effect';
import { afterEach, describe, expect, it } from '@effect/vitest';
import {
	PortAllocator,
	PortAllocatorLive,
} from './port-allocator.js';
import { reallocatePortsOnConflict } from './docker/port-conflict.js';

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
	it.effect('release removes the port from the held set so a subsequent allocate returns it again', () =>
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

// `reallocatePortsOnConflict` is the shared helper that primitives
// (sui, seal, walrus/nodes, walrus/proxy) hand to `Docker.run` as the
// `onPortConflict` callback. It releases each conflicting host port
// back to the allocator and re-allocates with the same value as
// `preferred` — so the allocator either returns the original port (if
// it has come free) or scans forward to the next free preferred-style
// slot. This is the load-bearing behavior for the "pause stack A →
// boot stack B → resume A on the next preferred port" UX.
describe('reallocatePortsOnConflict — shared helper', () => {
	it.effect(
		'releases each conflicting port and re-allocates against the same preferred value (no external listeners → returns the same ports)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const allocator = yield* PortAllocator;
					const preferredA = nextPort();
					const preferredB = nextPort();
					// Simulate the primitive's initial allocate path: both
					// ports are now in the allocator's held set.
					const firstA = yield* allocator.allocate(preferredA);
					const firstB = yield* allocator.allocate(preferredB);
					expect(firstA).toBe(preferredA);
					expect(firstB).toBe(preferredB);

					// Build the callback (operates inside its own scope so
					// the new-port release finalizers don't leak across
					// tests). The conflicting map mirrors what `Docker.run`
					// would pass on a port-conflict resume: the caller's
					// stale host→container map.
					const scope = yield* Effect.scope;
					const cb = reallocatePortsOnConflict(allocator, scope, 'test.primitive');
					const fresh = yield* cb({
						[firstA]: 9000,
						[firstB]: 9123,
					});

					// Nothing external holds either preferred port, so
					// after release+allocate we should land back on the
					// same numbers — proving `release(p)` actually frees
					// the slot for `allocate(p)`.
					const freshKeys = Object.keys(fresh)
						.map(Number)
						.sort((a, b) => a - b);
					expect(freshKeys).toEqual([preferredA, preferredB].sort((a, b) => a - b));
					// Container ports preserved 1:1.
					expect(fresh[preferredA]).toBe(9000);
					expect(fresh[preferredB]).toBe(9123);
				}).pipe(Effect.provide(Layer.fresh(PortAllocatorLive))),
			),
	);

	it.effect(
		'scans forward when the preferred port is held by an external listener (UX: pause A → B takes 9000 → resume A shifts to 9001)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const allocator = yield* PortAllocator;
					const preferred = nextPort();
					// Primitive's initial allocate — succeeds.
					const first = yield* allocator.allocate(preferred);
					expect(first).toBe(preferred);

					// Release inside the allocator's held set (mirrors the
					// scope-teardown finalizer firing when the primitive
					// stops). Now an external process snaps up the port
					// before resume fires.
					yield* allocator.release(first);
					const externalListener = yield* Effect.tryPromise({
						try: () => listenOn(preferred, '127.0.0.1'),
						catch: (cause) => new Error(`test setup: ${String(cause)}`),
					});
					liveServers.push(externalListener);

					// Re-allocate to simulate the primitive entering its
					// build path again. The allocator's held set is empty
					// for `preferred` but the bind probe fails — scans
					// forward.
					const second = yield* allocator.allocate(preferred);
					expect(second).toBeGreaterThan(preferred);

					// Now imagine `docker start` failed with port-conflict
					// (the external listener triggered the same conflict
					// docker would see). The helper releases `second` and
					// re-allocates against `preferred` — still blocked by
					// the external listener, scans forward.
					const scope = yield* Effect.scope;
					const cb = reallocatePortsOnConflict(allocator, scope, 'test.primitive');
					const fresh = yield* cb({ [second]: 9000 });
					const freshKeys = Object.keys(fresh).map(Number);
					expect(freshKeys.length).toBe(1);
					// The new port is somewhere AFTER `preferred` (the
					// external listener holds it), proving the helper
					// asks the allocator to walk forward from the
					// preferred value.
					expect(freshKeys[0]).toBeGreaterThan(preferred);
				}).pipe(Effect.provide(Layer.fresh(PortAllocatorLive))),
			),
	);
});
