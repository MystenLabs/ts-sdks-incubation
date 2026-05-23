import { createServer } from 'node:net';

import { Effect } from 'effect';
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
});
