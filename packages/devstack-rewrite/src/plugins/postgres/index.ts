// Postgres plugin — barrel + `postgres(opts?)` factory.
//
// Architecture: Postgres is a topological leaf (no upstream service
// tag references) and a single-mode service (local container only;
// "live" modes — Cloud SQL / Neon / RDS — are a deferred decision in
// the distilled doc, anticipated by the plain-endpoint shape but not
// implemented). One factory; no mode-narrowed namespace.
//
// Capabilities emitted:
//   1. Snapshotable — container's writable layer (PGDATA-relocated),
//      identity guard contributes server name + ordered db list.
//   2. Codegenable — typed connection bindings for user-app code.
//   3. Routable (TCP, optional) — gated by `opts.route`. When true,
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

import { capabilities } from '../../api/define-capabilities.ts';
import { defineNodePlugin } from '../../api/define-plugin.ts';
import { defineTag } from '../../api/tag.ts';
import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { RoutableDecl } from '../../contracts/routable.ts';
import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import { IdentityContext } from '../../substrate/runtime/paths.ts';

import { makeCodegenable } from './codegen.ts';
import type { PostgresConnectionBindings } from './connection.ts';
import { POSTGRES_ERROR_TAGS, postgresPluginError } from './errors.ts';
import { makePostgresRoutable } from './routable.ts';
import { bootPostgresService, type Postgres, type PostgresServiceOptions } from './service.ts';
import { makeSnapshotable } from './snapshot.ts';

// ---------------------------------------------------------------------------
// Tag — the resolved value all consumers read
// ---------------------------------------------------------------------------

/** The Postgres plugin's identity tag. Built once at this barrel and
 *  imported by every consumer (substrate constraint: tags are not
 *  passed as runtime values).
 *
 *  Tag id matches the plugin key: `'postgres'`. */
export const PostgresTag = defineTag<'postgres', Postgres>('postgres', 'postgres');

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
	const databases = opts.databases ?? ['devstack'];

	return defineNodePlugin({
		provides: PostgresTag,
		consumes: [] as const,
		kind: 'leaf-long-running',
		rebootCost: 'heavy',
		acquire: () =>
			Effect.gen(function* () {
				// Substrate-context plumbing supplies real
				// `ContainerRuntime` + `Identity` instances; the
				// supervisor's plugin acquisition path provides these
				// before this body runs.
				const runtime = yield* ContainerRuntimeService;
				const identity = yield* IdentityContext;
				const { handle } = yield* bootPostgresService(runtime, identity, opts);
				return handle;
			}).pipe(
				// Distilled-doc § Invariants: already-typed errors must
				// NOT be re-wrapped by the catch-all unknown handler.
				// `catchTag` runs first; anything unknown falls into the
				// catch-all and surfaces as `phase: 'unknown'`.
				Effect.catchTags({
					PostgresPluginError: Effect.fail,
					PostgresConnectionTimeout: Effect.fail,
					DatabaseCreateFailed: Effect.fail,
				}),
				Effect.catch((cause) =>
					Effect.fail(postgresPluginError('unknown', `postgres(${name}): unknown failure`, cause)),
				),
			),
		errorContributions: [{ _tag: 'PluginErrorContribution', errorTags: POSTGRES_ERROR_TAGS }],
		// Dynamic capability factory: receives the resolved
		// `Postgres` handle + acquire context. Stamps the REAL
		// app/stack into the snapshot decl and the REAL
		// networkAlias + derived password into the codegen
		// bindings — the static-form placeholders (`<app>`,
		// `<stack>`, `<network-alias>`, `<derived-at-acquire>`)
		// are gone.
		capabilities: (resolved, acquireCtx) => {
			const snap: SnapshotableDecl = makeSnapshotable({
				app: acquireCtx.identity.app,
				stack: acquireCtx.identity.stack,
				name,
				databases,
			});
			const codegen: CodegenableDecl<PostgresConnectionBindings, 'postgres-connection'> =
				makeCodegenable({
					name,
					user: resolved.user,
					password: resolved.password,
					host: resolved.networkAlias,
					port: resolved.port,
					databases: resolved.databases,
				});
			const routable: RoutableDecl | null = opts.route
				? makePostgresRoutable({
						app: acquireCtx.identity.app,
						stack: acquireCtx.identity.stack,
						name,
						containerName: `${acquireCtx.identity.app}-${acquireCtx.identity.stack}-${name}`,
					})
				: null;
			return routable === null
				? capabilities(snap, codegen)
				: capabilities(snap, codegen, routable);
		},
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
export type { PostgresConnectionBindings, PostgresConnectionParts } from './connection.ts';
export type {
	PostgresError,
	PostgresPluginError,
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
