import { createServer } from 'node:net';
import type { Server } from 'node:http';

import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { listenScopedHttpServer } from '../../../src/substrate/runtime/scoped-http-server.ts';

const freePort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (address === null || typeof address === 'string') {
				server.close(() => reject(new Error('expected tcp address')));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});

describe('listenScopedHttpServer', () => {
	it.effect('serves requests and exposes the loopback URL', () =>
		Effect.gen(function* () {
			const port = yield* Effect.promise(freePort);
			const handle = yield* listenScopedHttpServer({
				bindAddress: '127.0.0.1',
				port,
				listener: (_req, res) => {
					res.statusCode = 200;
					res.end('ok');
				},
				onListenError: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
			});

			const body = yield* Effect.promise(async () => {
				const response = await fetch(handle.url);
				return response.text();
			});

			expect(body).toBe('ok');
		}).pipe(Effect.scoped),
	);

	it.effect(
		'registers the close finalizer atomically with bind (interrupt after acquire still closes)',
		() =>
			// Regression for the bind/finalizer atomicity bug: the server is
			// bound with `acquireRelease`, so the graceful-close finalizer is
			// bound the instant `listen` resolves. An interrupt arriving right
			// after acquisition must still close the listener — otherwise a
			// listener leaks, holding its port. Pre-fix the finalizer was a
			// separate `addFinalizer` on the following line, leaving a (narrow)
			// window where an interrupt would leak the bound server.
			Effect.gen(function* () {
				const port = yield* Effect.promise(freePort);
				const bound = yield* Deferred.make<Server>();
				const fiber = yield* Effect.forkScoped(
					Effect.gen(function* () {
						const handle = yield* listenScopedHttpServer({
							bindAddress: '127.0.0.1',
							port,
							listener: (_req, res) => {
								res.statusCode = 200;
								res.end('ok');
							},
							onListenError: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
						});
						// Acquisition succeeded: hand the bound server out, then
						// keep the scope open so only the interrupt tears it down.
						yield* Deferred.succeed(bound, handle.server);
						return yield* Effect.never;
					}).pipe(Effect.scoped),
				);

				const server = yield* Deferred.await(bound);
				expect(server.listening).toBe(true);

				// Interrupt awaits finalizer completion; the atomic release must
				// have run, closing the listener.
				yield* Fiber.interrupt(fiber);
				expect(server.listening).toBe(false);
			}),
	);
});
