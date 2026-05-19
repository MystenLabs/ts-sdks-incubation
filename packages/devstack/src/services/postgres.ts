// `Postgres(opts)` — generic long-lived Postgres container.
//
// Lifecycle: long-lived container started via the `dockerContainer`
// plugin-author primitive. State (schema + rows) lives in the writable
// layer at `/pgdata` — the vendored `postgres-image/Dockerfile`
// relocates PGDATA off the upstream VOLUME so `docker commit` captures
// it for snapshots (mirrors sui's indexer-db pattern).
//
// Idempotency: the service registers each requested database via
// `CREATE DATABASE` on every cycle; existing databases are skipped
// (probe via `psql -tc 'SELECT 1 FROM pg_database'`). State-store
// cache at `postgres/databases/v1/<stack>/<name>/<dbHash>` records
// the ensured list so a no-op cycle short-circuits the probe entirely.
//
// **Snapshot participation**: persists the writable layer (`/pgdata`),
// re-derives nothing on restore, intentionally loses in-flight
// connections + WAL position relative to chain.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Effect } from 'effect';
import { tag, provide, setPhase } from '../advanced/tag.js';
import { Context } from 'effect';
import * as Docker from '../engine/docker/index.js';
import { runDockerContainer } from '../advanced/plugin-author/docker-container.js';
import { Identity } from '../engine/identity.js';
import { PostgresError } from '../engine/errors.js';
import { stringifyCause } from '../engine/stringify-cause.js';
import { publishEndpoint, publishPostgresState } from '../engine/registries.js';
import { EndpointName } from '../runtime/endpoint-names.js';
import { awaitPostgresReady, ensureDatabase } from './postgres/internal.js';

const DEFAULT_VERSION = '16-alpine';
const DEFAULT_USER = 'devstack';
const DEFAULT_DATABASES = ['devstack'] as const;

/** Resolved postgres handle. Consumers (DeepBook indexer, etc.) read
 *  `url(db)` to derive a fully-qualified connection string for one of
 *  the requested databases. `containerNetwork` + `networkAlias` let
 *  in-network consumers (other Docker containers on the same network)
 *  dial the postgres directly without going through traefik. */
export interface Postgres {
	readonly name: string;
	readonly user: string;
	/** Password is exposed on the service shape for in-process consumers
	 *  (the indexer container reads it to build its `DATABASE_URL`).
	 *  Manifest emission strips it. */
	readonly password: string;
	readonly databases: ReadonlyArray<string>;
	/** Internal endpoint URL: `postgres://<user>:<pw>@<alias>:5432`. */
	readonly endpoint: string;
	readonly containerNetworks: ReadonlyArray<string>;
	readonly networkAlias: string;
	/** Compose a connection URL for one of the requested databases. */
	readonly url: (db: string) => string;
}

export class PostgresTag extends Context.Service<PostgresTag, Postgres>()(
	'@devstack/PostgresTag',
) {}

export interface PostgresOptions<Name extends string> {
	readonly name?: Name;
	/** Postgres image tag. Default `'16-alpine'`. */
	readonly version?: string;
	/** Default `'devstack'`. */
	readonly user?: string;
	/** Override the auto-generated password. */
	readonly password?: string;
	/** Logical databases to ensure exist. Default `['devstack']`. */
	readonly databases?: ReadonlyArray<string>;
	/** Optional host-port mapping for `5432`. When unset the container is
	 *  internal-only (other containers join its network). */
	readonly hostPort?: number;
	/** Optional additional docker networks to attach to (in addition to
	 *  the per-stack network). Mirrors how sui's localnet joins multiple
	 *  networks for cross-stack routing. */
	readonly extraNetworks?: ReadonlyArray<string>;
	/** Ready timeout in ms. Default 30_000. */
	readonly readyTimeoutMs?: number;
}

const stackPassword = (stackId: string): string => `pg-${stackId.replace(/[^a-zA-Z0-9]/g, '')}`;

export const Postgres = <const Name extends string = 'postgres'>(opts: PostgresOptions<Name> = {}) => {
	const name = (opts.name ?? 'postgres') as Name;
	const version = opts.version ?? DEFAULT_VERSION;
	const user = opts.user ?? DEFAULT_USER;
	const databases = opts.databases ?? DEFAULT_DATABASES;
	const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;

	if (databases.length === 0) {
		throw new TypeError('Postgres: `databases` must be non-empty');
	}

	// Reuse the vendored postgres-image (PGDATA-relocated). Snapshots
	// ride correctly only against this image; the upstream postgres
	// image's VOLUME directive excludes /var/lib/postgresql/data from
	// `docker commit`.
	const dockerContext = new URL('../../postgres-image/', import.meta.url).pathname;
	const pgImageSource = {
		build: {
			context: dockerContext,
			dockerfile: 'Dockerfile',
			buildArgs: { POSTGRES_VERSION: version },
		},
	} as const;

	// `runDockerContainer` is the inline Effect flavor of the plugin-
	// author `dockerContainer` primitive — same machinery (Docker.run
	// + image build + finalizer + routing + endpoint publish + ready
	// probe), but invoked from inside `Effect.gen` so the surrounding
	// `PostgresTag` build body can `catchTag('DockerError')` and
	// translate the failure into a typed `PostgresError`. The tag
	// form's E channel surfaces only at Layer construction time, where
	// the outer body's `catchTag` can't observe it.
	//
	// `imageLayers` lifts the image-build layer out so the supervisor
	// schedules the postgres image build before the PostgresTag's body
	// runs — wired through `extraLayers` below.
	const container = runDockerContainer(
		`${name}.container` as const,
		(identity) => {
			const password = opts.password ?? stackPassword(identity.stack);
			const networkAlias = `${name}-${identity.stack}`.replace(/[^a-zA-Z0-9-]/g, '-');
			const networkName = `devstack-${identity.app}-${identity.stack}-postgres`.replace(
				/[^a-zA-Z0-9-]/g,
				'-',
			);
			const ports =
				opts.hostPort !== undefined
					? ({ [opts.hostPort]: 5432 } as Record<number, number>)
					: undefined;
			return {
				image: pgImageSource,
				env: {
					POSTGRES_USER: user,
					POSTGRES_PASSWORD: password,
					POSTGRES_DB: databases[0]!,
				},
				network: networkName,
				networkAlias,
				...(ports !== undefined ? { ports } : {}),
				...(opts.extraNetworks !== undefined
					? { extraNetworks: opts.extraNetworks }
					: {}),
			};
		},
		pgImageSource,
	);

	const composite = tag(
		name,
		Effect.gen(function* () {
			const identity = yield* Identity;
			const password = opts.password ?? stackPassword(identity.stack);
			const networkAlias = `${name}-${identity.stack}`.replace(/[^a-zA-Z0-9-]/g, '-');

			// Per-stack network (the convention sui uses). Each Postgres
			// instance gets its own network so two stacks' postgres don't
			// collide on the DNS alias. The network MUST exist before
			// `runDockerContainer` (-> `Docker.run`) runs with the network
			// option. We keep `Docker.networkCreate` outside the primitive
			// because the engine's network helper is scope-managed and
			// distinct from per-container lifecycle. The same network
			// name shape is recomputed inside the `runDockerContainer`
			// builder above; both call sites agree on the
			// `devstack-<app>-<stack>-postgres` shape.
			const networkName = `devstack-${identity.app}-${identity.stack}-postgres`.replace(
				/[^a-zA-Z0-9-]/g,
				'-',
			);
			yield* Docker.networkCreate(networkName).pipe(
				Effect.catchTag('DockerError', (cause) =>
					Effect.fail(
						new PostgresError({
							phase: 'container',
							message: `failed to create postgres docker network '${networkName}'`,
							cause,
						}),
					),
				),
			);

			yield* setPhase('starting postgres');
			// `runDockerContainer` owns image build + spawn + secondary
			// network attach + finalizer. Ready probe is kept outside
			// because it relies on `docker exec pg_isready` — the
			// `dockerContainer.ready` channel only supports HTTP/TCP/log
			// probes and a postgres-specific exec probe doesn't belong
			// on the public primitive surface.
			const containerHandle = yield* container.effect.pipe(
				Effect.catchTag('DockerError', (cause) =>
					Effect.fail(
						new PostgresError({
							phase: 'container',
							message: 'failed to start postgres container',
							cause,
						}),
					),
				),
				Effect.catchTag('ReadyProbeError', (cause) =>
					Effect.fail(
						new PostgresError({
							phase: 'container',
							message: 'postgres container failed during ready probe',
							cause,
						}),
					),
				),
			);

			yield* setPhase('awaiting ready');
			yield* awaitPostgresReady(
				containerHandle.containerId,
				user,
				databases[0]!,
				readyTimeoutMs,
			);

			// Ensure each requested database exists. First entry was already
			// created by the upstream image's entrypoint (POSTGRES_DB).
			yield* setPhase('ensuring databases');
			for (let i = 1; i < databases.length; i++) {
				yield* ensureDatabase(containerHandle.containerId, user, databases[i]!);
			}

			const endpoint = `postgres://${user}:${password}@${networkAlias}:5432`;
			const url = (db: string): string => `${endpoint}/${db}`;
			const containerNetworks: ReadonlyArray<string> = [
				networkName,
				...(opts.extraNetworks ?? []),
			];

			yield* publishEndpoint({
				name: EndpointName.POSTGRES,
				url: endpoint,
				kind: opts.hostPort !== undefined ? 'rpc' : 'internal',
			});

			yield* publishPostgresState({
				name,
				user,
				url: url(databases[0]!),
				endpoint,
				containerNetwork: networkName,
				networkAlias,
				databases,
			});

			return {
				name,
				user,
				password,
				databases,
				endpoint,
				containerNetworks,
				networkAlias,
				url,
			} satisfies Postgres;
		}).pipe(
			Effect.withSpan(`Postgres(${name})`),
			Effect.catchTag('PostgresError', Effect.fail),
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new PostgresError({
						phase: 'postgres',
						message: `Postgres(${name}): ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		),
		{
			extraLayers: container.imageLayers,
			kind: 'service' as const,
			plugin: 'postgres',
			displayTitle: `postgres.${name}`,
			display: (s: Postgres) => ({
				title: `postgres.${name}`,
				primary: s.endpoint,
				extras: [`${s.databases.length} db${s.databases.length === 1 ? '' : 's'}`],
			}),
		},
	);

	const tagLayer = provide(
		PostgresTag,
		Effect.gen(function* () {
			return yield* composite;
		}),
	).__layer;

	const __layers = [...composite.__layers, tagLayer];
	return Object.assign(composite, { __layers, __kind: 'service' as const, __pluginName: 'postgres' });
};
