// Internal Postgres sidecar for built-in plugins.
//
// This is not a public `postgres()` factory. It exists so the Sui local
// validator can own its GraphQL indexer database as a sidecar while snapshotting
// the database under Sui's own `(plugin, role)` label tuple.

import { Effect, type Scope } from 'effect';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { ContainerHandle, ContainerRuntime } from '../../../contracts/container-runtime.ts';
import type { Identity } from '../../../substrate/identity.ts';
import {
	ensureManagedContainer,
	sanitizeAlias,
} from '../../../substrate/runtime/managed-container.ts';

import {
	credentialedUrl,
	plainUrl,
	withDatabase,
	type PostgresConnectionParts,
} from './connection.ts';
import { awaitReady, ensureDatabases, type ContainerExec } from './db-ensure.ts';
import {
	postgresPluginError,
	postgresConfigError,
	type DatabaseCreateFailed,
	type PostgresConfigError,
	type PostgresConnectionTimeout,
	type PostgresPluginError,
} from './errors.ts';

export interface PostgresSidecar {
	readonly name: string;
	readonly user: string;
	readonly password: string;
	readonly host: string;
	readonly port: number;
	readonly databases: ReadonlyArray<string>;
	readonly endpoint: string;
	readonly plainEndpoint: string;
	readonly url: (db: string) => string;
	readonly containerNetwork: string;
	readonly networkAlias: string;
}

interface ResolvedPostgresSidecarOptions {
	readonly name: string;
	readonly version: string;
	readonly user: string;
	readonly password: string;
	readonly databases: ReadonlyArray<string>;
	readonly readyTimeoutMs: number;
	readonly stopGraceSeconds: number;
}

const DEFAULT_VERSION = '17-alpine';
const DEFAULT_USER = 'devstack';
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_SECONDS = 20;
const POSTGRES_PORT = 5432;

/** Sidecar password — derived from `(app, stack, role)`, deliberately without
 *  `stackRoot`. The sidecar's PGDATA rides the owning plugin's snapshots and
 *  restored image layers, so the password must remain stable across runtime
 *  roots for the same stack. */
export const deriveSidecarPassword = (app: string, stack: string, role: string): string => {
	const body = (app + stack + role).replace(/[^a-zA-Z0-9]/g, '');
	const fingerprint = createHash('sha256')
		.update(`${app}\x1f${stack}\x1f${role}`)
		.digest('hex')
		.slice(0, 8);
	return `pg-${body}-${fingerprint}`;
};

const resolveSidecarOptions = (
	identity: Identity,
	opts: {
		readonly role: string;
		readonly database: string;
		readonly version?: string;
		readonly readyTimeoutMs?: number;
		readonly stopGraceSeconds?: number;
	},
): ResolvedPostgresSidecarOptions => {
	if (opts.database.length === 0) {
		throw postgresConfigError({
			field: 'database',
			message: 'postgres sidecar: `database` must be non-empty',
		});
	}

	return {
		name: opts.role,
		version: opts.version ?? DEFAULT_VERSION,
		user: DEFAULT_USER,
		password: deriveSidecarPassword(identity.app, identity.stack, opts.role),
		databases: [opts.database],
		readyTimeoutMs: opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
		stopGraceSeconds: opts.stopGraceSeconds ?? DEFAULT_STOP_GRACE_SECONDS,
	};
};

const resolveImageContextPath = (): string => {
	const here = new URL(import.meta.url);
	const ctxUrl = new URL('../../../../images/postgres/', here);
	return fileURLToPath(ctxUrl);
};

const containerExec = (runtime: ContainerRuntime, handle: ContainerHandle): ContainerExec => ({
	run: (argv) =>
		runtime
			.exec(handle, argv)
			.pipe(
				Effect.catch((err) =>
					Effect.fail(
						postgresPluginError(
							'container-start',
							`runtime.exec failed: ${err.reason} — ${err.detail}`,
							err,
						),
					),
				),
			),
});

/** Boot a Postgres container owned by a sibling plugin. The container labels
 *  are stamped as `{ plugin: 'sui', role }` so Sui snapshot capture owns the
 *  database state; callers still share the internal Postgres image build. */
export const bootPostgresSidecar = (
	runtime: ContainerRuntime,
	identity: Identity,
	opts: {
		readonly network: string;
		readonly alias: string;
		readonly role: string;
		readonly database: string;
		readonly version?: string;
		readonly readyTimeoutMs?: number;
		readonly stopGraceSeconds?: number;
		/** Opaque caller-owned fingerprint stamped as `devstack.config-hash`.
		 *  With `recreate: 'on-config-change'`, a mismatch recreates the
		 *  mount-less sidecar with an empty DB while a match resumes rows. */
		readonly configHash?: string;
	},
): Effect.Effect<
	{ readonly handle: PostgresSidecar; readonly containerHandle: ContainerHandle },
	PostgresPluginError | PostgresConfigError | PostgresConnectionTimeout | DatabaseCreateFailed,
	Scope.Scope
> =>
	Effect.gen(function* () {
		const resolved = yield* Effect.try({
			try: () => resolveSidecarOptions(identity, opts),
			catch: (cause) => cause as PostgresConfigError,
		});

		yield* runtime
			.ensureNetwork({ name: opts.network, app: identity.app, stack: identity.stack })
			.pipe(
				Effect.catch((cause) =>
					Effect.fail(
						postgresPluginError(
							'network-create',
							`failed to ensure postgres sidecar network '${opts.network}'`,
							cause,
						),
					),
				),
			);

		const imageRef = yield* runtime
			.ensureImage({
				contextPath: resolveImageContextPath(),
				dockerfile: 'Dockerfile',
				buildArgs: { POSTGRES_VERSION: resolved.version },
				owner: { app: identity.app, stack: identity.stack, plugin: 'postgres', role: 'db' },
			})
			.pipe(
				Effect.catch((cause) =>
					Effect.fail(
						postgresPluginError(
							'image-build',
							`failed to build postgres sidecar image (${resolved.version})`,
							cause,
						),
					),
				),
			);

		const containerName = sanitizeAlias(`${identity.app}-${identity.stack}-${opts.role}`);
		const containerHandle = yield* ensureManagedContainer({
			runtime,
			labels: { app: identity.app, stack: identity.stack, plugin: 'sui', role: opts.role },
			spec: {
				name: containerName,
				image: imageRef,
				recreate: 'on-config-change',
				...(opts.configHash !== undefined ? { configHash: opts.configHash } : {}),
				env: {
					POSTGRES_USER: resolved.user,
					POSTGRES_PASSWORD: resolved.password,
					POSTGRES_DB: opts.database,
				},
				stopGraceSeconds: resolved.stopGraceSeconds,
				networkAttach: [{ name: opts.network, aliases: [opts.alias] }],
			},
			mapError: (cause) =>
				postgresPluginError(
					'container-start',
					`failed to start postgres sidecar container '${opts.role}'`,
					cause,
				),
		});

		const exec = containerExec(runtime, containerHandle);
		yield* awaitReady(exec, resolved.user, opts.database, resolved.readyTimeoutMs);
		yield* ensureDatabases(exec, resolved.user, resolved.databases);

		const parts: PostgresConnectionParts = {
			user: resolved.user,
			password: resolved.password,
			host: containerName,
			port: POSTGRES_PORT,
		};
		const endpoint = credentialedUrl(parts);
		const handle: PostgresSidecar = {
			name: resolved.name,
			user: resolved.user,
			password: resolved.password,
			host: containerName,
			port: POSTGRES_PORT,
			databases: resolved.databases,
			endpoint,
			plainEndpoint: plainUrl(containerName, POSTGRES_PORT),
			url: (db) => withDatabase(endpoint, db),
			containerNetwork: opts.network,
			networkAlias: opts.alias,
		};

		return { handle, containerHandle };
	});
