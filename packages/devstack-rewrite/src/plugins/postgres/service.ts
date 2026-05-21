// Postgres plugin — service body (real boot).
//
// Lifecycle (distilled doc § Lifecycle states):
//   1. Pre-start: identity (app + stack) resolved, deterministic
//      strings (network name, alias, default password) computed.
//   2. Per-stack docker network ensured (idempotent; survives the
//      cycle that creates it).
//   3. Vendored image ensured. The Dockerfile at
//      `<package>/images/postgres/Dockerfile` does ONE thing:
//      `ENV PGDATA=/var/lib/postgresql/data-devstack` so writes land in
//      the container's writable layer rather than the upstream
//      `VOLUME /var/lib/postgresql/data` path (which `docker commit`
//      excludes). This is the single load-bearing invariant for
//      snapshot integrity.
//   4. Container started with `POSTGRES_USER` / `POSTGRES_PASSWORD` /
//      `POSTGRES_DB` env. Joined to the per-stack network under a
//      deterministic alias. Optional host-port publication.
//   5. `pg_isready` retry loop runs against the bootstrap database
//      via `runtime.exec`, bounded by `readyTimeoutMs`.
//   6. Subsequent databases ensured idempotently via `psql -tAc`
//      existence-check + `createdb`.
//   7. Resolved `Postgres` handle returned. The substrate's outer
//      machinery publishes the manifest projection (plain URL only).
//
// What this file does NOT do:
//   - Pause/unpause around `docker commit` — engine-level (snapshot
//     orchestrator walks `managedContainers` labels emitted by
//     `snapshot.ts` and pauses them).
//   - Manage schema migrations or run init SQL — schema is plugin-
//     owned by consumers (distilled doc § Generic database-service
//     requirements: "no migrations, no init SQL, no schema
//     management").
//   - Register the stop finalizer — `ContainerRuntime.ensureContainer`
//     owns the container's scope finalizer (10s grace today). The
//     20s WAL-flush grace exposed via `stopGrace` is the duration the
//     substrate's scope finalizer plumbing should apply once the
//     runtime exposes a typed `stopGraceSeconds` knob; until then the
//     runtime's default applies.

import { Duration, Effect, type Scope } from 'effect';

import type { ContainerHandle, ContainerRuntime } from '../../contracts/container-runtime.ts';
import type { Identity } from '../../substrate/identity.ts';
import {
	credentialedUrl,
	plainUrl,
	withDatabase,
	type PostgresConnectionParts,
} from './connection.ts';
import { awaitReady, ensureDatabases, type ContainerExec } from './db-ensure.ts';
import {
	postgresPluginError,
	type DatabaseCreateFailed,
	type PostgresConnectionTimeout,
	type PostgresPluginError,
} from './errors.ts';

/** Resolved Postgres handle — the tag's resolved value.
 *
 *  Distilled doc § Outputs: consumers read this to compose
 *  `DATABASE_URL` strings. `url(db)` is the per-database composer;
 *  `endpoint` is the cluster-level credentialed URL; `plainEndpoint`
 *  is the manifest-safe URL (no password). */
export interface Postgres {
	readonly name: string;
	readonly user: string;
	/** Credential. Held in-memory on the resolved value; manifest
	 *  projection strips it. Logging convention: never `console.log`
	 *  the entire handle — log `plainEndpoint` instead. */
	readonly password: string;
	readonly host: string;
	readonly port: number;
	readonly databases: ReadonlyArray<string>;
	/** Cluster-level credentialed URL. */
	readonly endpoint: string;
	/** Cluster-level no-credentials URL. Manifest-safe. */
	readonly plainEndpoint: string;
	/** Per-database credentialed URL composer. */
	readonly url: (db: string) => string;
	/** Per-stack docker network the container is joined to. */
	readonly containerNetwork: string;
	/** In-network DNS alias siblings dial. */
	readonly networkAlias: string;
}

/** Service options. Defaults track distilled-doc recommendations:
 *  postgres 17-alpine is the latest LTS-stable at the time of writing
 *  (one major up from the v3 service's 16-alpine pin). */
export interface PostgresServiceOptions {
	readonly name?: string;
	readonly version?: string;
	readonly user?: string;
	readonly password?: string;
	readonly databases?: ReadonlyArray<string>;
	readonly hostPort?: number;
	readonly extraNetworks?: ReadonlyArray<string>;
	readonly readyTimeoutMs?: number;
	/** WAL-flush budget on `docker stop`. Default 20s (matches the
	 *  sui-indexer-db sidecar in v3). 10s (docker default) risks
	 *  SIGKILL on busy DBs → recovery mode on next boot. */
	readonly stopGraceSeconds?: number;
}

/** Internal canonicalised options after defaults applied. */
export interface ResolvedPostgresOptions {
	readonly name: string;
	readonly version: string;
	readonly user: string;
	readonly password: string;
	readonly databases: ReadonlyArray<string>;
	readonly hostPort: number | undefined;
	readonly extraNetworks: ReadonlyArray<string>;
	readonly readyTimeoutMs: number;
	readonly stopGraceSeconds: number;
}

const DEFAULT_VERSION = '17-alpine';
const DEFAULT_USER = 'devstack';
const DEFAULT_DATABASES = ['devstack'] as const;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_SECONDS = 20;
const POSTGRES_PORT = 5432;

/** Deterministic dev password from `(app, stack)`. Tradeoff
 *  documented in the distilled doc § Postgres-specific concerns:
 *  fine for a single-user dev tool, foot-gun if `hostPort` is set in
 *  a multi-user environment. The user-supplied `password` override on
 *  `PostgresServiceOptions` is the escape hatch. */
const derivePassword = (app: string, stack: string): string =>
	`pg-${(app + stack).replace(/[^a-zA-Z0-9]/g, '')}`;

const sanitizeAlias = (s: string): string => s.replace(/[^a-zA-Z0-9-]/g, '-');

/** Resolve user-supplied options against defaults + identity-derived
 *  values. Pure; safe to call before the Effect body runs. */
export const resolveOptions = (
	identity: Identity,
	opts: PostgresServiceOptions,
): ResolvedPostgresOptions => {
	const name = opts.name ?? 'postgres';
	const databases = opts.databases ?? DEFAULT_DATABASES;
	if (databases.length === 0) {
		throw new TypeError('postgres(): `databases` must be non-empty');
	}
	return {
		name,
		version: opts.version ?? DEFAULT_VERSION,
		user: opts.user ?? DEFAULT_USER,
		password: opts.password ?? derivePassword(identity.app, identity.stack),
		databases,
		hostPort: opts.hostPort,
		extraNetworks: opts.extraNetworks ?? [],
		readyTimeoutMs: opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
		stopGraceSeconds: opts.stopGraceSeconds ?? DEFAULT_STOP_GRACE_SECONDS,
	};
};

/** Bundled boot result for the barrel. The dynamic-capability factory
 *  projects resolved options + identity-derived strings onto the
 *  snapshot + codegen decls. */
export interface PostgresBootResult {
	readonly resolved: ResolvedPostgresOptions;
	readonly handle: Postgres;
	readonly containerHandle: ContainerHandle;
}

/** Resolve the vendored Dockerfile context path for THIS package.
 *
 *  The build context is the directory containing the Dockerfile
 *  (`<package>/images/postgres/`). We resolve it relative to this
 *  source file via `import.meta.url`, which works in both source
 *  (tsx) and built (.js) form because the layout is preserved.
 *
 *  Distilled doc § Open questions: long-term, this should move to
 *  the substrate's L1 image-build helper so all plugins resolve
 *  their build contexts the same way. For now, the resolution is
 *  local to the plugin. */
const resolveImageContextPath = (): string => {
	// `import.meta.url` is the URL of this module file. From
	// `<pkg>/src/plugins/postgres/service.ts` we walk up three
	// directories (`plugins/`, `src/`, `<pkg>/`) and then down into
	// `images/postgres/`.
	const here = new URL(import.meta.url);
	const ctxUrl = new URL('../../../images/postgres/', here);
	// File: URLs need decoding back to a host path for the docker CLI.
	return decodeURIComponent(ctxUrl.pathname);
};

/** Build a `ContainerExec` view bound to a specific container handle.
 *  Thin adapter from the runtime's contract surface to the plugin's
 *  local exec seam. The runtime never promotes non-zero exit to
 *  failure here — the caller (pg_isready retry loop, createdb
 *  existence-check) decides. */
const containerExec = (runtime: ContainerRuntime, handle: ContainerHandle): ContainerExec => ({
	run: (argv) =>
		runtime.exec(handle, argv).pipe(
			// Daemon-level failures (no such container, daemon
			// unreachable) collapse to a synthetic non-zero ExecResult
			// so the retry loop sees them and the typed timeout error
			// carries the daemon stderr as `lastStderr` for the cause
			// walker. We do NOT surface ContainerRuntimeError here —
			// the plugin's typed errors are the only failure shapes
			// `awaitReady` / `ensureDatabases` produce, and they
			// already carry the captured streams.
			Effect.catch((err) =>
				Effect.succeed({
					exitCode: 255,
					stdout: '',
					stderr: `runtime.exec failed: ${err.reason} — ${err.detail}`,
				}),
			),
		),
});

/** Boot the postgres service. The barrel composes this with the
 *  capability decls. */
export const bootPostgresService = (
	runtime: ContainerRuntime,
	identity: Identity,
	opts: PostgresServiceOptions,
): Effect.Effect<
	PostgresBootResult,
	PostgresPluginError | PostgresConnectionTimeout | DatabaseCreateFailed,
	Scope.Scope
> =>
	Effect.gen(function* () {
		const resolved = resolveOptions(identity, opts);

		// Identity-derived strings. The naming pattern must match what
		// snapshot label-discovery uses — both call sites converge on
		// `(app, stack, plugin='postgres', role=<name>)`.
		const networkAlias = sanitizeAlias(`${resolved.name}-${identity.stack}`);
		const containerNetwork = sanitizeAlias(`devstack-${identity.app}-${identity.stack}-postgres`);

		// 1. Ensure the per-stack docker network. Idempotent — no-op
		//    if the network already exists (warm resume).
		yield* runtime
			.ensureNetwork({
				name: containerNetwork,
				app: identity.app,
				stack: identity.stack,
			})
			.pipe(
				Effect.catch((cause) =>
					Effect.fail(
						postgresPluginError(
							'network-create',
							`failed to ensure postgres network '${containerNetwork}'`,
							cause,
						),
					),
				),
			);

		// 2. Ensure the vendored image. The Dockerfile sets PGDATA off
		//    the upstream VOLUME path so the writable layer captures
		//    PGDATA — the single load-bearing snapshot invariant
		//    (distilled doc § Postgres-specific concerns).
		const imageRef = yield* runtime
			.ensureImage({
				contextPath: resolveImageContextPath(),
				dockerfile: 'Dockerfile',
				buildArgs: { POSTGRES_VERSION: resolved.version },
			})
			.pipe(
				Effect.catch((cause) =>
					Effect.fail(
						postgresPluginError(
							'image-build',
							`failed to build postgres image (${resolved.version})`,
							cause,
						),
					),
				),
			);

		// 3. Start container. `networkAttach`'s first entry becomes the
		//    `--network` flag on `docker run -d`; subsequent entries
		//    are attached post-start with IP-readback (runtime owns
		//    that detail).
		//
		//    The runtime adapter does NOT yet thread the in-network
		//    alias through `--network-alias`; the network alias the
		//    handle exposes is the architecture-mandated value, but
		//    siblings should dial by `name` (the container name)
		//    which docker also publishes under the network. The
		//    architecture revision to add `networkAlias` to
		//    EnsureContainerSpec is flagged in `index.ts`.
		const containerHandle = yield* runtime
			.ensureContainer({
				name: `${identity.app}-${identity.stack}-${resolved.name}`,
				image: imageRef,
				labels: {
					app: identity.app,
					stack: identity.stack,
					plugin: 'postgres',
					role: resolved.name,
				},
				recreate: 'on-config-change',
				env: {
					POSTGRES_USER: resolved.user,
					POSTGRES_PASSWORD: resolved.password,
					POSTGRES_DB: resolved.databases[0]!,
				},
				ports:
					resolved.hostPort !== undefined
						? [{ containerPort: POSTGRES_PORT, hostPort: resolved.hostPort }]
						: undefined,
				networkAttach: [containerNetwork, ...resolved.extraNetworks],
			})
			.pipe(
				Effect.catch((cause) =>
					Effect.fail(
						postgresPluginError(
							'container-start',
							`failed to start postgres container '${resolved.name}'`,
							cause,
						),
					),
				),
			);

		// 4. Probe readiness via `pg_isready` against the bootstrap
		//    database. Server-aware probe — distilled doc § Postgres-
		//    specific concerns: TCP-listener readiness alone is
		//    insufficient (postgres opens the port before accepting
		//    queries).
		const exec = containerExec(runtime, containerHandle);
		yield* awaitReady(exec, resolved.user, resolved.databases[0]!, resolved.readyTimeoutMs);

		// 5. Ensure subsequent databases idempotently. The bootstrap
		//    database (index 0) is image-entrypoint-created via
		//    POSTGRES_DB and skipped by `ensureDatabases`.
		yield* ensureDatabases(exec, resolved.user, resolved.databases);

		// 6. Resolve the handle. Host for in-stack siblings is the
		//    container name (which docker registers as a DNS entry on
		//    the attached network). When the substrate's
		//    `networkAlias` plumbing lands we'll swap to that; until
		//    then the container name is the stable in-network handle.
		const dnsName = `${identity.app}-${identity.stack}-${resolved.name}`;
		const parts: PostgresConnectionParts = {
			user: resolved.user,
			password: resolved.password,
			host: dnsName,
			port: POSTGRES_PORT,
		};
		const endpoint = credentialedUrl(parts);
		const plainEndpoint = plainUrl(dnsName, POSTGRES_PORT);

		const handle: Postgres = {
			name: resolved.name,
			user: resolved.user,
			password: resolved.password,
			host: dnsName,
			port: POSTGRES_PORT,
			databases: resolved.databases,
			endpoint,
			plainEndpoint,
			url: (db) => withDatabase(endpoint, db),
			containerNetwork,
			networkAlias,
		};

		return { resolved, handle, containerHandle };
	}).pipe(
		Effect.withSpan('postgres.boot', {
			attributes: {
				'postgres.name': opts.name ?? 'postgres',
				'postgres.version': opts.version ?? DEFAULT_VERSION,
			},
		}),
	);

/** Stop-grace duration. The substrate's finalizer plumbing reads this
 *  to set the docker-stop SIGTERM→SIGKILL window. 20s default avoids
 *  busy-DB SIGKILL → recovery-mode on next boot. */
export const stopGrace = (resolved: ResolvedPostgresOptions): Duration.Duration =>
	Duration.seconds(resolved.stopGraceSeconds);
