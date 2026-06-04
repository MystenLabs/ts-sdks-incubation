// Postgres plugin — barrel + `postgres(opts?)` factory.
//
// Architecture: Postgres is a topological leaf (no upstream service
// dependencies) and a single-mode service (local container only;
// "live" modes — Cloud SQL / Neon / RDS — are a deferred decision in
// the distilled doc, anticipated by the plain-endpoint shape but not
// implemented). One factory; no mode-narrowed namespace.
//
// During `start`, the plugin emits (via the typed `ctx.*` verbs):
//   1. `ctx.snapshotExtra` — container's writable layer (PGDATA-relocated),
//      identity guard contributes server name + ordered db list.
//   2. `ctx.codegen` — typed connection bindings for user-app code.
//   3. `ctx.endpoint` (TCP, optional) — gated by `opts.route`. When true,
//      the postgres container fronts the `postgres-tcp` Traefik
//      entrypoint (host port 5432 by default). Disabled by default to
//      preserve the existing parallel-stack story (TCP has no Host
//      header, so an entrypoint serves one backend at a time).
//      Stacks that want host-side reachability can set `route: true`
//      OR set `hostPort` directly (the two are mutually exclusive
//      escape hatches — `route: true` is recommended for in-network
//      composition with traefik, `hostPort` for direct host-port
//      publication).
//
// Substrate wiring:
//   - `ContainerRuntimeService` yielded in the acquire body for the
//     container + image + exec contract.
//   - `IdentityContext` yielded for the app/stack identity strings.
//   - `errorContributions` declares POSTGRES_ERROR_TAGS so the
//     supervisor's harvest loop registers them with the
//     FormatterRegistry.

import { Effect } from 'effect';

import { definePlugin, resource } from '../../api/define-plugin.ts';
import { pluginErrorContributions } from '../../api/plugin-errors.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import { PluginContext } from '../../substrate/plugin-ctx.ts';
import { passthroughOrWrap } from '../../substrate/runtime/passthrough-or-wrap.ts';
import { IdentityContext, StackPathsService } from '../../substrate/runtime/paths.ts';

import { makeCodegenable } from './codegen.ts';
import { POSTGRES_ERROR_TAGS, postgresPluginError, type PostgresError } from './errors.ts';
import { makePostgresRoutable } from './routable.ts';
import { bootPostgresService, type Postgres, type PostgresServiceOptions } from './service.ts';
import { makeSnapshotable } from './snapshot.ts';

// ---------------------------------------------------------------------------
// Resource identity
// ---------------------------------------------------------------------------

/** The Postgres plugin's resource identity. Used internally by the
 *  factory below; postgres is a topological leaf with no cross-plugin
 *  dependents (sui owns its indexer DB as a sidecar, not a `dependsOn`). */
const postgresResource = resource<'postgres', Postgres>('postgres');

const postgresErrorContributions = pluginErrorContributions(POSTGRES_ERROR_TAGS);

// ---------------------------------------------------------------------------
// Plugin construction
// ---------------------------------------------------------------------------

/** User-facing options on top of the service options — currently just
 *  the routable opt-in. We split this out so the service body's
 *  `PostgresServiceOptions` stays focused on container/boot knobs and
 *  the plugin-level surface owns capability gating. */
export interface PostgresPluginOptions extends PostgresServiceOptions {
	/** When `true`, the plugin contributes a `wireProtocol: 'tcp'`
	 *  Routable decl that fronts the postgres container on the
	 *  `postgres-tcp` entrypoint (host port 5432 by default). Default
	 *  `false` — parallel stacks coexist via the in-network DNS alias
	 *  and the optional `hostPort` mapping, neither of which involves
	 *  the router.
	 *
	 *  Architecture parallel-stack note: TCP entrypoints serve ONE
	 *  backend at a time (no Host-header fan-out), so only one stack
	 *  on the host may set `route: true` at a given moment. The router
	 *  orchestrator's collision detector fails fast on the second
	 *  contribution. */
	readonly route?: boolean;
}

const buildPlugin = (opts: PostgresPluginOptions) => {
	const name = opts.name ?? 'postgres';
	// Validation (databases non-empty) runs inside `bootPostgresService` via
	// `resolveOptions`; the resolved bundle's `databases` flows through to
	// the snapshot + codegen decls.

	return definePlugin({
		id: postgresResource.id,
		role: 'service',
		section: 'service',
		start: () =>
			Effect.gen(function* () {
				const ctx = yield* PluginContext;
				// Substrate-context plumbing supplies real
				// `ContainerRuntime` + `Identity` instances; the
				// supervisor's plugin acquisition path provides these
				// before this body runs.
				const runtime = yield* ContainerRuntimeService;
				const identity = yield* IdentityContext;
				const paths = yield* StackPathsService;
				const { handle } = yield* bootPostgresService(runtime, identity, paths.stackRoot, opts);

				// Emit the contributions INLINE via the typed `ctx` verbs,
				// in order (`[snap, codegen]` or `[snap, codegen, routable]`).
				// The resolved `handle` is the contribution `value`; `identity`
				// (which `start` already yields from `IdentityContext`) is the
				// `runtime.identity`.
				//
				// Codegen `host` is `handle.networkAlias` — the per-stack
				// alias Docker registers via `--network-alias` on the
				// container's primary network. Dialing the alias resolves
				// in-container regardless of which parallel stack the caller
				// belongs to; the per-stack container name still resolves
				// too, but is not parallel-stack-portable when emitted into
				// committed codegen output.
				//
				ctx.snapshotExtra(
					makeSnapshotable({
						app: identity.app,
						stack: identity.stack,
						name,
						databases: handle.databases,
					}),
				);
				ctx.codegen(
					makeCodegenable({
						name,
						user: handle.user,
						password: handle.password,
						host: handle.networkAlias,
						port: handle.port,
						databases: handle.databases,
					}),
				);
				if (opts.route) {
					ctx.endpoint(
						makePostgresRoutable({
							app: identity.app,
							stack: identity.stack,
							name,
							containerName: `${identity.app}-${identity.stack}-${name}`,
						}),
					);
				}

				return handle;
			}).pipe(
				// Distilled-doc § Invariants: already-typed errors must
				// NOT be re-wrapped by the catch-all unknown handler.
				// `passthroughOrWrap` lets the POSTGRES_ERROR_TAGS union
				// through unchanged; anything else surfaces as
				// `phase: 'unknown'`.
				passthroughOrWrap.for<PostgresError>()(POSTGRES_ERROR_TAGS, (cause) =>
					postgresPluginError('unknown', `postgres(${name}): unknown failure`, cause),
				),
			),
		errorContributions: postgresErrorContributions,
	});
};

// ---------------------------------------------------------------------------
// User-facing factory
// ---------------------------------------------------------------------------

/** Postgres-as-a-container plugin. One per `(stack, name)` pair.
 *
 *  Single-mode: only local container exists today. The plain-endpoint
 *  shape anticipates a future "live" mode (Cloud SQL / Neon / RDS)
 *  that emits the same endpoint shape without spawning. */
export const postgres = (opts: PostgresPluginOptions = {}) => buildPlugin(opts);

// Re-export the canonical TCP endpoint name for downstream consumers
// (codegen lookups, doctor / inventory rendering, etc.).
export { POSTGRES_TCP_ENDPOINT_NAME } from './routable.ts';

// ---------------------------------------------------------------------------
// Re-exports for consumers + sibling plugins
// ---------------------------------------------------------------------------

export type { Postgres, PostgresServiceOptions } from './service.ts';
// Sidecar boot seam — consumed by the sui plugin, which OWNS its
// GraphQL-indexer postgres container as a sidecar rather than depending
// on a user-declared `postgres(...)`.
export { bootPostgresSidecar } from './service.ts';
export type { PostgresConnectionBindings, PostgresConnectionParts } from './connection.ts';
export type {
	PostgresError,
	PostgresPluginError,
	PostgresConfigError,
	PostgresConnectionTimeout,
	DatabaseCreateFailed,
	PostgresPhase,
} from './errors.ts';
export { POSTGRES_ERROR_TAGS } from './errors.ts';
export type { PostgresIdentityPayload } from './snapshot.ts';

// Connection-string builders — exposed for downstream consumers that
// need to compose URLs without the resolved handle (e.g. user-app
// code that reads the codegen output and builds a per-database URL
// at runtime).
export { credentialedUrl, plainUrl, withDatabase } from './connection.ts';

export { PostgresSpans } from './spans.ts';
