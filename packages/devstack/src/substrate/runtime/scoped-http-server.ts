// Scoped host HTTP server primitive.
//
// Generic ownership for in-process host HTTP listeners: bind, surface
// listen failures through a caller-owned error mapper, and install a
// scope finalizer that drops idle keepalive sockets before awaiting
// close. Domain routing stays with the plugin that supplies the
// Node request listener.

import { Effect } from 'effect';
import type { Scope } from 'effect';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type HttpRequestListener = (req: IncomingMessage, res: ServerResponse) => void;

export interface ScopedHttpServerOptions<E> {
	readonly bindAddress: string;
	readonly port: number;
	readonly listener: HttpRequestListener;
	readonly onListenError: (cause: unknown) => E;
}

export interface ScopedHttpServerHandle {
	readonly url: string;
	readonly server: Server;
	readonly close: () => Effect.Effect<void>;
}

/** Best-effort graceful close. `closeAllConnections()` drops idle
 *  keepalive sockets so `close()` resolves; older Node versions
 *  without `closeAllConnections` rely on `close()` alone. */
export const gracefulCloseHttpServer = (server: Server): Effect.Effect<void> =>
	Effect.callback<void>((resume) => {
		try {
			server.closeAllConnections();
		} catch {
			// Older Node versions don't expose closeAllConnections;
			// `close()` alone will still terminate.
		}
		server.close(() => resume(Effect.void));
	});

export const listenScopedHttpServer = <E>(
	options: ScopedHttpServerOptions<E>,
): Effect.Effect<ScopedHttpServerHandle, E, Scope.Scope> =>
	Effect.gen(function* () {
		// `acquireRelease` pairs the bound server with its close finalizer
		// atomically: the moment `listen` resolves, the graceful-close
		// finalizer is registered, so an interruption between bind and
		// finalizer registration cannot leak a listener holding the port.
		const server = yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: () =>
					new Promise<Server>((resolve, reject) => {
						const srv = createServer(options.listener);
						const onError = (err: Error) => reject(err);
						srv.once('error', onError);
						srv.listen(options.port, options.bindAddress, () => {
							srv.removeListener('error', onError);
							resolve(srv);
						});
					}),
				catch: options.onListenError,
			}),
			(srv) => gracefulCloseHttpServer(srv).pipe(Effect.uninterruptible),
		);

		return {
			url: `http://${options.bindAddress}:${options.port}`,
			server,
			close: () => gracefulCloseHttpServer(server),
		};
	});
