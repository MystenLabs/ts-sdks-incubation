// PortBrokerService — kernel probe behavior.
//
// These tests exercise the allocation seam directly rather than
// spawning Docker. Sui's local mode uses `probeHost: '0.0.0.0'` because
// Docker host publishing binds all interfaces.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';

import { Deferred, Effect, Exit, Fiber, Layer } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	DEFAULT_PORT_WINDOW,
	PortBrokerService,
	layerPortBroker,
} from '../../../../src/substrate/runtime/port-broker/index.ts';
import { ownHolder } from '../../../../src/substrate/runtime/cross-process/liveness.ts';
import { layerRuntimeRoot } from '../../../../src/substrate/runtime/paths.ts';
import { withTempRoot } from '../../../helpers/with-temp-root.ts';

const listenOnRandomPort = (host: '127.0.0.1' | '0.0.0.0'): Effect.Effect<Server, Error> =>
	Effect.tryPromise({
		try: () =>
			new Promise<Server>((resolve, reject) => {
				const server = createServer();
				server.once('error', reject);
				server.listen(0, host, () => {
					server.off('error', reject);
					resolve(server);
				});
			}),
		catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
	});

const closeServer = (server: Server): Effect.Effect<void> =>
	Effect.tryPromise({
		try: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
		catch: () => undefined,
	}).pipe(Effect.catch(() => Effect.void));

const serverPort = (server: Server): number => {
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('expected TCP server address');
	}
	return address.port;
};

const portLockPath = (root: string, port: number): string =>
	join(root, 'port-locks', `${port}.json`);

const portBrokerLayer = (root: string) =>
	layerPortBroker.pipe(Layer.provide(layerRuntimeRoot(root)));

describe('PortBrokerService', () => {
	it.effect('reassigns when an all-interface preferred port is already occupied', () =>
		withTempRoot('port-broker-test', (root) =>
			Effect.acquireUseRelease(
				listenOnRandomPort('0.0.0.0'),
				(server) =>
					Effect.gen(function* () {
						const broker = yield* PortBrokerService;
						const preferred = serverPort(server);
						const allocated = yield* Effect.scoped(
							broker.allocate({
								owner: 'test-rpc',
								preferredPort: preferred,
								probeHost: '0.0.0.0',
							}),
						);

						expect(allocated.port).not.toBe(preferred);
					}).pipe(Effect.provide(portBrokerLayer(root))),
				closeServer,
			),
		),
	);

	it.effect('reassigns when a loopback listener occupies a Docker wildcard preferred port', () =>
		withTempRoot('port-broker-test', (root) =>
			Effect.acquireUseRelease(
				listenOnRandomPort('127.0.0.1'),
				(server) =>
					Effect.gen(function* () {
						const broker = yield* PortBrokerService;
						const preferred = serverPort(server);
						const allocated = yield* Effect.scoped(
							broker.allocate({
								owner: 'test-rpc',
								preferredPort: preferred,
								probeHost: '0.0.0.0',
							}),
						);

						expect(allocated.port).not.toBe(preferred);
					}).pipe(Effect.provide(portBrokerLayer(root))),
				closeServer,
			),
		),
	);

	it.effect('frees the in-process slot when the allocate fiber is interrupted mid-chain', () =>
		// Regression: between `tryReserve(port)` and `finishAllocation`
		// arming its scope finalizer there was a gap where an
		// `Effect.interrupt` would leave the in-process Map slot held
		// until the Layer scope closed. `Effect.acquireUseRelease`
		// around that critical region must release the slot on
		// interrupt. We verify the slot is freed by issuing a second
		// allocate against the same `preferredPort` after the first
		// fiber is interrupted; if the slot were still held, the
		// second allocate would surface `preferred-busy`.
		withTempRoot('port-broker-test', (root) =>
			Effect.gen(function* () {
				const broker = yield* PortBrokerService;
				// Pick a free port the OS hands out, then close the seed
				// server so the broker's kernel probe will pass.
				const seed = yield* listenOnRandomPort('127.0.0.1');
				const preferred = serverPort(seed);
				yield* closeServer(seed);

				const fiberStarted = yield* Deferred.make<void>();
				const fiber = yield* Effect.forkChild(
					Effect.scoped(
						Effect.gen(function* () {
							yield* Deferred.succeed(fiberStarted, undefined);
							// Block in this scope forever after a successful
							// allocate — but the interrupt below races with
							// the allocate itself, so the fiber may also
							// die during reserve/probe. Either way, the
							// in-process slot must be released.
							yield* broker.allocate({
								owner: 'interrupt-target',
								preferredPort: preferred,
							});
							yield* Effect.never;
						}),
					),
				);
				yield* Deferred.await(fiberStarted);
				// Give the allocate a chance to enter its critical region
				// (the `tryReserve` modify) before we interrupt.
				yield* Effect.yieldNow;
				yield* Effect.yieldNow;
				yield* Fiber.interrupt(fiber);
				const exit = yield* Fiber.await(fiber);
				expect(Exit.isFailure(exit)).toBe(true);

				// On-disk reservation must NOT leak. If the interrupt landed
				// after acquirePortReservation wrote port-locks/<preferred>.json
				// but before finishAllocation armed its finalizer, the
				// uninterruptible release step of attemptSlot must have unlinked
				// it. A leaked file (holder = this still-alive process) would
				// otherwise mark the port busy forever.
				expect(existsSync(portLockPath(root, preferred))).toBe(false);

				// Slot must be freed. A second allocate for the same
				// `preferredPort` should NOT surface `preferred-busy`.
				const allocated = yield* Effect.scoped(
					broker.allocate({
						owner: 'after-interrupt',
						preferredPort: preferred,
					}),
				);
				expect(allocated.port).toBe(preferred);
			}).pipe(Effect.provide(portBrokerLayer(root))),
		),
	);

	it.effect('releases the on-disk reservation when the bind probe misses', () =>
		// Regression (interrupt-leak fix): attemptSlot writes
		// port-locks/<port>.json BEFORE the kernel probe, then only
		// keeps it on the `kept` path. On any non-`kept` exit the
		// uninterruptible release step must unlink the file. We force a
		// deterministic probe-miss: a live loopback listener occupies
		// `preferred`, and we allocate with probeHost '0.0.0.0' (which
		// probes loopback first). The broker reassigns; the reservation
		// file for `preferred` must NOT be left behind. If the release
		// path stopped unlinking the reservation, the stale file (holder
		// = this process) would persist and the next allocate of
		// `preferred` would see it busy.
		withTempRoot('port-broker-test', (root) =>
			Effect.acquireUseRelease(
				listenOnRandomPort('127.0.0.1'),
				(server) =>
					Effect.gen(function* () {
						const broker = yield* PortBrokerService;
						const preferred = serverPort(server);
						const allocated = yield* Effect.scoped(
							broker.allocate({
								owner: 'probe-miss',
								preferredPort: preferred,
								probeHost: '0.0.0.0',
							}),
						);

						// Reassigned away from the occupied preferred port ...
						expect(allocated.port).not.toBe(preferred);
						// ... and crucially, no orphaned reservation file remains for
						// the preferred port we briefly reserved before the probe.
						expect(existsSync(portLockPath(root, preferred))).toBe(false);
					}).pipe(Effect.provide(portBrokerLayer(root))),
				closeServer,
			),
		),
	);

	it.effect('self-heals an undecodable leftover reservation and keeps the preferred port', () =>
		// Regression (incompatible-shape leftover): a reservation file
		// written by an incompatible-version supervisor (here the old
		// `{ version: 1, kind, ... }` shape that lacks the now-required
		// `owner`) fails decode. Its ownerId/holder are unreadable, so
		// the owner-id and liveness reclaim paths can NEVER clear it.
		// acquirePortReservation must treat an undecodable EEXIST body as
		// a stale artifact, unlink it, and retry the exclusive create so
		// the allocate STILL wins `preferred`. Without the self-heal the
		// broker maps the undecodable file to `busy` and reassigns,
		// skipping that port for the supervisor's whole lifetime.
		withTempRoot('port-broker-test', (root) =>
			Effect.gen(function* () {
				const seed = yield* listenOnRandomPort('127.0.0.1');
				const preferred = serverPort(seed);
				yield* closeServer(seed);

				// Plant an OLD-SHAPE (undecodable under the current schema)
				// reservation file at the preferred port.
				mkdirSync(join(root, 'port-locks'), { recursive: true });
				writeFileSync(
					portLockPath(root, preferred),
					`${JSON.stringify({
						version: 1,
						port: preferred,
						kind: 'wallet',
						ownerId: 'legacy-process',
						holder: ownHolder(),
					})}\n`,
					{ mode: 0o600 },
				);

				const broker = yield* PortBrokerService;
				const allocated = yield* Effect.scoped(
					broker.allocate({
						owner: 'after-self-heal',
						preferredPort: preferred,
					}),
				);

				// The undecodable leftover was reclaimed, so the preferred
				// port is recovered rather than permanently skipped.
				expect(allocated.port).toBe(preferred);
			}).pipe(Effect.provide(portBrokerLayer(root))),
		),
	);

	it.effect('two concurrent brokers racing the same port: exactly one wins the reservation', () =>
		// Regression: previously `tryWriteReservationSync` used
		// `existsSync(path)` + `atomicWriteFileSync` (rename clobbers),
		// leaving a TOCTOU window where two peers could pass the
		// existence check, both rename their tempfile onto the final
		// path, and both believe they own the port. The fix replaced
		// the rename with `linkSync` (POSIX-atomic exclusive-create —
		// `EEXIST` on collision), so this race is now arbitrated by
		// the kernel.
		//
		// Two SEPARATE broker instances (two `Ref<Map>` scopes, same
		// runtime root) simulate two `devstack apply` processes sharing
		// a state dir. They synchronize on a `Deferred` so both pass
		// any pre-checks at roughly the same instant. Exactly one must
		// receive the preferred port; the other must reassign.
		withTempRoot('port-broker-test', (root) =>
			Effect.gen(function* () {
				// Seed: claim a free OS port, then release so kernel
				// probes will pass for both brokers.
				const seed = yield* listenOnRandomPort('127.0.0.1');
				const preferred = serverPort(seed);
				yield* closeServer(seed);

				const start = yield* Deferred.make<void>();

				const raceFiber = (owner: string) =>
					Effect.forkChild(
						Effect.scoped(
							Effect.gen(function* () {
								const broker = yield* PortBrokerService;
								yield* Deferred.await(start);
								const allocated = yield* Effect.scoped(
									broker.allocate({ owner, preferredPort: preferred }),
								);
								return allocated.port;
								// `Layer.fresh` forces each fiber to materialize its
								// own broker (own in-process `Ref<Map>`) instead of
								// inheriting a memoized instance from the parent
								// runtime. The two brokers share the on-disk runtime
								// root so they contend at the linkSync layer — the
								// shape this test is designed to exercise.
							}).pipe(Effect.provide(Layer.fresh(portBrokerLayer(root)))),
						),
					);

				const fiberA = yield* raceFiber('racer-a');
				const fiberB = yield* raceFiber('racer-b');

				// Release both fibers at the same instant.
				yield* Deferred.succeed(start, undefined);

				const exitA = yield* Fiber.await(fiberA);
				const exitB = yield* Fiber.await(fiberB);

				// Both fibers must succeed — the loser reassigns
				// rather than failing.
				expect(Exit.isSuccess(exitA)).toBe(true);
				expect(Exit.isSuccess(exitB)).toBe(true);
				if (!Exit.isSuccess(exitA) || !Exit.isSuccess(exitB)) return;

				const portA = exitA.value;
				const portB = exitB.value;

				// Exactly one owns the preferred port; the other got a
				// different port from the scan window.
				const ownersOfPreferred = [portA, portB].filter((p) => p === preferred);
				expect(ownersOfPreferred.length).toBe(1);
				expect(portA).not.toBe(portB);
			}),
		),
	);

	it.effect('reassigns when a live peer reservation holds the preferred port', () =>
		withTempRoot('port-broker-test', (root) =>
			Effect.gen(function* () {
				const seed = yield* listenOnRandomPort('127.0.0.1');
				const preferred = serverPort(seed);
				yield* closeServer(seed);

				mkdirSync(join(root, 'port-locks'), { recursive: true });
				writeFileSync(
					join(root, 'port-locks', `${preferred}.json`),
					`${JSON.stringify({
						version: 1,
						port: preferred,
						owner: 'peer-process-owner',
						ownerId: 'peer-process',
						holder: ownHolder(),
					})}\n`,
					{ mode: 0o600 },
				);

				const broker = yield* PortBrokerService;
				const allocated = yield* Effect.scoped(
					broker.allocate({
						owner: 'test-wallet',
						preferredPort: preferred,
					}),
				);

				expect(allocated.port).not.toBe(preferred);
				expect(allocated.port).toBeGreaterThan(0);
			}).pipe(Effect.provide(portBrokerLayer(root))),
		),
	);

	it('DEFAULT_PORT_WINDOW pins the wallet-shared scan window', () => {
		// `DEFAULT_PORT_WINDOW` is the canonical scan window, imported by
		// the wallet plugin so its UX-pinned auto-connect range stays
		// structurally tied to the broker default. These literals are the
		// wallet adapter's hardcoded range (plugins/wallet/index.ts
		// windowHint { start: 39200, size: 1000 }); retuning the broker
		// default without updating the wallet must fail HERE, not drift
		// silently.
		expect(DEFAULT_PORT_WINDOW).toEqual({ start: 39200, size: 1000 });
	});
});
