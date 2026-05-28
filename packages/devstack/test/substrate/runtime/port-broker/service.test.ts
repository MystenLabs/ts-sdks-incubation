// PortBrokerService — kernel probe behavior.
//
// These tests exercise the allocation seam directly rather than
// spawning Docker. Sui's local mode uses `probeHost: '0.0.0.0'` because
// Docker host publishing binds all interfaces.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Deferred, Effect, Exit, Fiber, Layer } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	PortBrokerService,
	layerPortBroker,
} from '../../../../src/substrate/runtime/port-broker/index.ts';
import { ownHolder } from '../../../../src/substrate/runtime/cross-process/liveness.ts';
import { layerRuntimeRoot } from '../../../../src/substrate/runtime/paths.ts';

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

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'port-broker-test-'));

const portBrokerLayer = (root: string) =>
	layerPortBroker.pipe(Layer.provide(layerRuntimeRoot(root)));

describe('PortBrokerService', () => {
	it.effect('reassigns when an all-interface preferred port is already occupied', () => {
		const root = freshRoot();
		return Effect.acquireUseRelease(
			listenOnRandomPort('0.0.0.0'),
			(server) =>
				Effect.gen(function* () {
					try {
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
					} finally {
						rmSync(root, { recursive: true, force: true });
					}
				}).pipe(Effect.provide(portBrokerLayer(root))),
			closeServer,
		);
	});

	it.effect('reassigns when a loopback listener occupies a Docker wildcard preferred port', () => {
		const root = freshRoot();
		return Effect.acquireUseRelease(
			listenOnRandomPort('127.0.0.1'),
			(server) =>
				Effect.gen(function* () {
					try {
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
					} finally {
						rmSync(root, { recursive: true, force: true });
					}
				}).pipe(Effect.provide(portBrokerLayer(root))),
			closeServer,
		);
	});

	it.effect('frees the in-process slot when the allocate fiber is interrupted mid-chain', () => {
		// Regression: between `tryReserve(port)` and `finishAllocation`
		// arming its scope finalizer there was a gap where an
		// `Effect.interrupt` would leave the in-process Map slot held
		// until the Layer scope closed. `Effect.acquireUseRelease`
		// around that critical region must release the slot on
		// interrupt. We verify the slot is freed by issuing a second
		// allocate against the same `preferredPort` after the first
		// fiber is interrupted; if the slot were still held, the
		// second allocate would surface `preferred-busy`.
		const root = freshRoot();
		return Effect.gen(function* () {
			try {
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

				// Slot must be freed. A second allocate for the same
				// `preferredPort` should NOT surface `preferred-busy`.
				const allocated = yield* Effect.scoped(
					broker.allocate({
						owner: 'after-interrupt',
						preferredPort: preferred,
					}),
				);
				expect(allocated.port).toBe(preferred);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(portBrokerLayer(root)));
	});

	it.effect('reassigns when a live peer reservation holds the preferred port', () => {
		const root = freshRoot();

		const allocatePreferred = Effect.gen(function* () {
			const seed = yield* listenOnRandomPort('127.0.0.1');
			const preferred = serverPort(seed);
			yield* closeServer(seed);
			return preferred;
		});

		return Effect.gen(function* () {
			try {
				const preferred = yield* allocatePreferred;
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
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(portBrokerLayer(root)));
	});
});
