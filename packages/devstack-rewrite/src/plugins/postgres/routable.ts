// Postgres plugin — optional Routable TCP contribution.
//
// Postgres is a raw-TCP service (no HTTP, no virtual-host concept), so
// it participates in the router via the `wireProtocol: 'tcp'` variant
// of `RoutableDecl`. Effects:
//
//   - The router orchestrator writes a TCP file-provider entry that
//     binds the `postgres-tcp` entrypoint port (5432 by default) and
//     forwards raw TCP to the container's shared-network IP+port.
//   - The endpoint shows up in the manifest under `postgres-tcp` so
//     codegen / build-integrations can resolve `127.0.0.1:5432` as
//     the host-side dial address.
//
// PARALLEL-STACK NOTE. TCP has no virtual-host equivalent — a TCP
// entrypoint port can serve exactly ONE backend per Traefik container.
// Two parallel stacks each contributing a TCP postgres Routable on
// `postgres-tcp` will fail collision detection at `contributeRoute`
// time. Stacks that need parallel postgres backends should set
// `opts.route: false` and dial the container in-network directly
// (`networkAlias:5432`).
//
// CORS is omitted by construction — the TCP variant of `RoutableDecl`
// doesn't carry a `cors` field.

import type { RoutableDecl } from '../../contracts/routable.ts';

/** Canonical endpoint name — matches the `DEFAULT_ENTRYPOINTS` entry
 *  in `orchestrators/router/entrypoints.ts`. */
export const POSTGRES_TCP_ENDPOINT_NAME = 'postgres-tcp' as const;

/** Construct the Postgres TCP Routable decl.
 *
 *  The `containerName` is whatever name the postgres `ensureContainer`
 *  call uses for its container — the router's upstream resolver maps
 *  the key back to the container's shared-network IP at dispatch-file
 *  write time. */
export const makePostgresRoutable = (parts: {
	readonly app: string;
	readonly stack: string;
	readonly name: string;
	readonly containerName: string;
}): RoutableDecl => ({
	kind: 'routable',
	endpointName: POSTGRES_TCP_ENDPOINT_NAME,
	dispatchId: {
		// Include the instance name for readable diagnostics; the router
		// hashes the full `(app, stack, compositeKey, role)` tuple before
		// writing the global dispatch file.
		compositeKey: `postgres.${parts.app}.${parts.stack}.${parts.name}`,
		role: parts.name,
	},
	upstream: { type: 'container', containerName: parts.containerName, containerPort: 5432 },
	wireProtocol: 'tcp',
});
