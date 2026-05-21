// PortBrokerService — kernel probe behavior.
//
// These tests exercise the allocation seam directly rather than
// spawning Docker. Sui's local mode uses `probeHost: '0.0.0.0'` because
// Docker host publishing binds all interfaces.

import { createServer, type Server } from 'node:net';

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	PortBrokerService,
	layerPortBroker,
} from '../../../../src/substrate/runtime/port-broker/index.ts';

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

describe('PortBrokerService', () => {
	it.effect('reassigns when an all-interface preferred port is already occupied', () =>
		Effect.acquireUseRelease(
			listenOnRandomPort('0.0.0.0'),
			(server) =>
				Effect.scoped(
					Effect.gen(function* () {
						const broker = yield* PortBrokerService;
						const preferred = serverPort(server);
						const allocated = yield* broker.allocate({
							kind: 'rpc',
							preferredPort: preferred,
							probeHost: '0.0.0.0',
						});

						expect(allocated.port).not.toBe(preferred);
						expect(allocated.kind).toBe('rpc');
					}),
				),
			closeServer,
		).pipe(Effect.provide(layerPortBroker)),
	);
});
