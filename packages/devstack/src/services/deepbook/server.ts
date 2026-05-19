// `DeepbookServer(opts)` — long-running Rust container that serves the
// DeepBook REST API on port 9008, reading from the Postgres started in
// Phase 2 (which the Phase-2 indexer writes events into). Mirrors the
// deepbook-sandbox docker-compose server service
// (`~/code/deepbook-sandbox/sandbox/docker-compose.yml:195-228`).
//
// Joins two networks: the Postgres `containerNetwork` (for `DATABASE_URL`)
// + the router network (for the `/ticker` REST + `/metrics` Prometheus
// endpoints surfaced via traefik).
//
// Stateless against the writable layer: every response is rendered on
// demand from Postgres + chain RPC. Snapshot semantics: persists
// nothing, re-derives nothing on restore — the post-restore Postgres
// carries the indexed data the server reads.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Context, Effect } from 'effect';
import { tag, provide, setPhase, type LayeredTag } from '../../advanced/tag.js';
import { runDockerContainer } from '../../advanced/plugin-author/docker-container.js';
import { Identity } from '../../engine/identity.js';
import { DeepbookServerError } from '../../engine/errors.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { publishDeepbookServerState, publishEndpoint } from '../../engine/registries.js';
import { EndpointName } from '../../runtime/endpoint-names.js';
import { DEFAULT_DEEPBOOK_MOVE_VERSION, getDeepbookImages } from './images.js';
import type { DeepbookCore } from '../deepbook.js';
import type { Postgres } from '../postgres.js';
import type { Sui } from '../sui.js';
import { routerEntrypoint } from '../../engine/docker/router.js';
import { routerHostname } from '../../engine/router-hostname.js';

// Internal container ports — sandbox parity. The Rust server binary
// binds 9008 for REST and 9184 for Prometheus on its own loopback;
// traefik routes external hostnames through to those ports on the
// container's network alias.
//
// 9008 is the canonical DeepBook REST port (matches @mysten/deepbook-v3
// `testnetServer` / `mainnetServer` URLs). 9184 mirrors the indexer's
// Prometheus binding — the Rust binary uses the same metrics convention
// across both services. The router-side entrypoint that binds the host
// port is `deepbook-server-metrics` (host port 9186; see
// `engine/docker/router.ts` for why 9185 isn't free).
const INTERNAL_REST_PORT = 9008;
const INTERNAL_METRICS_PORT = 9184;

// Hardcoded db-statement timeout — matches sandbox's docker-compose
// `command:` arg. Surfaces here as an option override for callers that
// want to relax it.
const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 60_000;

/** Resolved server handle. `rest` is the traefik-routed URL for the REST
 *  API; `metrics` is the Prometheus-style scrape URL. `databaseUrl` is
 *  the fully-qualified Postgres URL the server was started with —
 *  exposed here for diagnostics + future consumers. */
export interface DeepbookServer {
	readonly name: string;
	readonly rest: string;
	readonly metrics: string;
	readonly databaseUrl: string;
	readonly containerNetwork: string;
	readonly networkAlias: string;
}

export class DeepbookServerTag extends Context.Service<DeepbookServerTag, DeepbookServer>()(
	'@devstack/DeepbookServerTag',
) {}

// Minimal margin-shape requirement — keeps the server's option types
// independent of the margin factory's own export so wiring stays
// add-only. The margin factory's `DeepbookMargin` interface (Phase 4)
// is a superset of this.
interface MarginRefShape {
	readonly packageId: string;
	readonly liquidationPackageId: string;
}

export interface DeepbookServerOptions<Name extends string> {
	readonly name?: Name;
	readonly postgres: LayeredTag<any, Postgres, any, any>;
	readonly sui: LayeredTag<any, Sui, any, any>;
	readonly deepbook: LayeredTag<any, DeepbookCore, any, any>;
	/** Optional margin ref — when set, the server env carries
	 *  `MARGIN_PACKAGE_ID` so the REST API can decode margin-aware
	 *  events. Wired alongside the Phase-4 margin factory. */
	readonly margin?: LayeredTag<any, MarginRefShape, any, any>;
	/** Pinned Move source version. Resolves to a (indexer, server) image
	 *  pair via `DEEPBOOK_IMAGES`. Default `'v7.0.0'`. */
	readonly moveVersion?: string;
	/** Pin the server image explicitly (overrides `moveVersion`). */
	readonly image?: string;
	/** Override db-statement timeout in ms. Default 60_000. */
	readonly dbStatementTimeoutMs?: number;
	/** Logical database name within the Postgres instance. Default
	 *  `'deepbook'` (must match the indexer's setting; the server reads
	 *  from the same db the indexer writes to). */
	readonly databaseName?: string;
	/** Optional Rust log level for the binary. Default `'info'`. */
	readonly rustLog?: string;
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
}

const slug = (s: string): string => s.replace(/[^a-zA-Z0-9-]/g, '-');

export const DeepbookServer = <const Name extends string = 'deepbook-server'>(
	opts: DeepbookServerOptions<Name>,
) => {
	const name = (opts.name ?? 'deepbook-server') as Name;
	const moveVersion = opts.moveVersion ?? DEFAULT_DEEPBOOK_MOVE_VERSION;
	const databaseName = opts.databaseName ?? 'deepbook';
	const dbStatementTimeoutMs = opts.dbStatementTimeoutMs ?? DEFAULT_DB_STATEMENT_TIMEOUT_MS;

	const image = opts.image ?? getDeepbookImages(moveVersion).server;

	const composite = tag(
		name,
		Effect.gen(function* () {
			for (const dep of opts.dependsOn ?? []) {
				yield* dep;
			}
			const identity = yield* Identity;
			const postgres = yield* opts.postgres;
			const sui = yield* opts.sui;
			const deepbook = yield* opts.deepbook;
			const margin = opts.margin !== undefined ? yield* opts.margin : undefined;

			yield* setPhase('starting server');

			const networkAlias = slug(`${name}-${identity.stack}`);
			const databaseUrl = postgres.url(databaseName);

			// Server container joins Postgres's network so it can dial the
			// db via `networkAlias` (no host port mapping required).
			const postgresNetwork = postgres.containerNetworks[0]!;

			// Sandbox env-var contract (docker-compose.yml:195-228). The
			// server reads checkpoint + chain state via the sui RPC URL
			// (`host.docker.internal:9000` from inside the container — the
			// localhost RPC is reachable through docker's bridge), and
			// the rest from Postgres. `DEEPBOOK_PACKAGE_ID` /
			// `DEEP_TREASURY_ID` come from the deepbook ref. The optional
			// margin Ref (when present) supplies `MARGIN_PACKAGE_ID`.
			const env: Record<string, string> = {
				DATABASE_URL: databaseUrl,
				RPC_URL: 'http://host.docker.internal:9000',
				DEEPBOOK_PACKAGE_ID: deepbook.packageId,
				DEEP_TOKEN_PACKAGE_ID: deepbook.packageId,
				DEEP_TREASURY_ID: deepbook.packageIds.DEEP_TREASURY_ID,
				RUST_LOG: opts.rustLog ?? 'info',
			};

			// `host.docker.internal` resolution requires the docker engine to
			// expose it (default on Docker Desktop, requires explicit
			// `extra_hosts` on linux). The sandbox sets it via compose; we
			// pass it via `--add-host` at run-time below for parity.
			// `sui` ref is held only so the layer-build edge stays explicit;
			// the server doesn't read sui fields directly.
			void sui;

			if (margin !== undefined) {
				env.MARGIN_PACKAGE_ID = margin.packageId;
			}

			yield* setPhase('starting container');
			const restRouterInfo = routerEntrypoint('deepbook-server');
			if (restRouterInfo === undefined) {
				return yield* Effect.fail(
					new DeepbookServerError({
						phase: 'port-alloc',
						message: `routerEntrypoint('deepbook-server') is undefined — router table out of sync`,
					}),
				);
			}
			const metricsRouterInfo = routerEntrypoint('deepbook-server-metrics');
			if (metricsRouterInfo === undefined) {
				return yield* Effect.fail(
					new DeepbookServerError({
						phase: 'port-alloc',
						message: `routerEntrypoint('deepbook-server-metrics') is undefined — router table out of sync`,
					}),
				);
			}
			const restHostname = routerHostname(identity, 'deepbook-server');
			const metricsHostname = routerHostname(identity, 'deepbook-server-metrics');
			// Two router entries on a single container — REST API +
			// Prometheus scrape — each on its own entrypoint port +
			// stack-scoped hostname. `runDockerContainer` derives the
			// router id + hostname from each `routing[].name` (no
			// `hostnameName` override needed here — the previous
			// callsite minted matching `routerId` / `routerHostname`
			// for both names verbatim).
			const container = yield* runDockerContainer(`${name}.container` as const, {
				image: { pull: image },
				env,
				// Mirror the sandbox command line: `--db-statement-timeout-ms`
				// is the only argument; the binary infers the rest from env.
				// `args` lands AFTER the image as the container's command
				// override. Matches docker-compose `command:` semantics
				// (`~/code/deepbook-sandbox/sandbox/docker-compose.yml:228`).
				args: ['--db-statement-timeout-ms', dbStatementTimeoutMs.toString()],
				network: postgresNetwork,
				networkAlias,
				// `host.docker.internal` is automatic on Desktop; explicit
				// here for parity across Linux daemons (CI runners).
				addHosts: ['host.docker.internal:host-gateway'],
				routing: [
					{
						name: 'deepbook-server',
						entrypoint: 'deepbook-server',
						servicePort: INTERNAL_REST_PORT,
					},
					{
						name: 'deepbook-server-metrics',
						entrypoint: 'deepbook-server-metrics',
						servicePort: INTERNAL_METRICS_PORT,
					},
				],
			}).effect.pipe(
				Effect.catchTag('DockerError', (cause) =>
					Effect.fail(
						new DeepbookServerError({
							phase: 'container',
							message: `failed to start deepbook-server container`,
							cause,
						}),
					),
				),
				Effect.catchTag('ReadyProbeError', (cause) =>
					Effect.fail(
						new DeepbookServerError({
							phase: 'container',
							message: `deepbook-server container failed ready probe`,
							cause,
						}),
					),
				),
			);
			void container;

			const restUrl = `http://${restHostname}:${restRouterInfo.port}/`;
			const metricsUrl = `http://${metricsHostname}:${metricsRouterInfo.port}/metrics`;

			yield* publishEndpoint({
				name: EndpointName.DEEPBOOK_SERVER_REST,
				url: restUrl,
				kind: 'rpc',
			});
			yield* publishEndpoint({
				name: EndpointName.DEEPBOOK_SERVER_METRICS,
				url: metricsUrl,
				kind: 'rpc',
			});

			yield* publishDeepbookServerState({
				name,
				restUrl,
				metricsUrl,
				databaseUrl,
				containerNetwork: postgresNetwork,
				networkAlias,
			});

			return {
				name,
				rest: restUrl,
				metrics: metricsUrl,
				databaseUrl,
				containerNetwork: postgresNetwork,
				networkAlias,
			} satisfies DeepbookServer;
		}).pipe(
			Effect.withSpan(`DeepbookServer(${name})`),
			Effect.catchTag('DeepbookServerError', Effect.fail),
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new DeepbookServerError({
						phase: 'server',
						message: `DeepbookServer(${name}): ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		),
		{
			kind: 'service' as const,
			plugin: 'deepbook',
			displayTitle: `deepbook.server.${name}`,
			display: (s: DeepbookServer) => ({
				title: `deepbook.server.${name}`,
				primary: s.rest,
				extras: [s.metrics],
			}),
		},
	);

	const tagLayer = provide(
		DeepbookServerTag,
		Effect.gen(function* () {
			return yield* composite;
		}),
	).__layer;

	const __layers = [...composite.__layers, tagLayer];
	return Object.assign(composite, {
		__layers,
		__kind: 'service' as const,
		__pluginName: 'deepbook',
	});
};
