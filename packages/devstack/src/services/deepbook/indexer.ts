// `DeepbookIndexer(opts)` — long-running Rust container that reads Sui
// checkpoints and writes DeepBook events to Postgres. Mirrors the
// deepbook-sandbox docker-compose indexer service
// (`~/code/deepbook-sandbox/sandbox/docker-compose.yml:151-188`).
//
// Joins three networks: Postgres `containerNetwork` (for `DATABASE_URL`)
// + the sui per-stack network (for `--local-ingestion-path /checkpoints`,
// when a checkpoint volume is mounted) + optionally the router network
// (for `/metrics` endpoint via traefik).
//
// **Snapshot participation**: writable layer carries no useful state
// beyond runtime files; cursor is preserved in Postgres bookkeeping
// tables. Re-derives cursor from Postgres on restart; intentionally
// loses in-memory event buffers.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Context, Effect } from 'effect';
import { tag, provide, setPhase, type LayeredTag } from '../../advanced/tag.js';
import { runDockerContainer } from '../../advanced/plugin-author/docker-container.js';
import { Identity } from '../../engine/identity.js';
import { DeepbookIndexerError } from '../../engine/errors.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { publishDeepbookIndexerState } from '../../engine/registries.js';
import { DEFAULT_DEEPBOOK_MOVE_VERSION, getDeepbookImages } from './images.js';
import type { DeepbookCore } from '../deepbook.js';
import type { DeepbookMargin } from './margin.js';
import type { Postgres } from '../postgres.js';
import type { Sui } from '../sui.js';
import { routerEntrypoint } from '../../engine/docker/router.js';
import { routerHostname } from '../../engine/router-hostname.js';

const INTERNAL_METRICS_PORT = 9184;

/** Resolved indexer handle. `metrics` is the traefik-routed URL for
 *  `/metrics` (Prometheus-style scrape). `databaseUrl` is the
 *  fully-qualified Postgres URL the indexer was started with. */
export interface DeepbookIndexer {
	readonly name: string;
	readonly metrics: string;
	readonly databaseUrl: string;
	readonly containerNetwork: string;
	readonly networkAlias: string;
}

export class DeepbookIndexerTag extends Context.Service<DeepbookIndexerTag, DeepbookIndexer>()(
	'@devstack/DeepbookIndexerTag',
) {}

export interface DeepbookIndexerOptions<Name extends string> {
	readonly name?: Name;
	readonly postgres: LayeredTag<any, Postgres, any, any>;
	readonly sui: LayeredTag<any, Sui, any, any>;
	readonly deepbook: LayeredTag<any, DeepbookCore, any, any>;
	/** Optional margin Ref. When set, the indexer's `MARGIN_PACKAGES`
	 *  env carries the deployed `<marginPackageId>,<liquidationPackageId>`
	 *  pair (comma-separated) so the indexer's Move-event decoders can
	 *  read margin-side events from the same Postgres. Sandbox parity
	 *  (`~/code/deepbook-sandbox/sandbox/docker-compose.yml:151-188`). */
	readonly margin?: LayeredTag<any, DeepbookMargin, any, any>;
	/** Pinned Move source version. Resolves to a (indexer, server) image
	 *  pair via `DEEPBOOK_IMAGES`. Default `'v7.0.0'`. */
	readonly moveVersion?: string;
	/** Pin the indexer image explicitly (overrides `moveVersion`). */
	readonly image?: string;
	/** First Sui checkpoint to ingest from. Default `0`. */
	readonly firstCheckpoint?: number;
	/** Database name within the Postgres instance. Default `'deepbook'`. */
	readonly databaseName?: string;
	/** Optional db connection pool size. Default `10`. */
	readonly dbConnectionPoolSize?: number;
	/** Optional Rust log level for the binary. Default `'info'`. */
	readonly rustLog?: string;
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
}

const slug = (s: string): string => s.replace(/[^a-zA-Z0-9-]/g, '-');

export const DeepbookIndexer = <const Name extends string = 'deepbook-indexer'>(
	opts: DeepbookIndexerOptions<Name>,
) => {
	const name = (opts.name ?? 'deepbook-indexer') as Name;
	const moveVersion = opts.moveVersion ?? DEFAULT_DEEPBOOK_MOVE_VERSION;
	const databaseName = opts.databaseName ?? 'deepbook';

	const image = opts.image ?? getDeepbookImages(moveVersion).indexer;

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

			yield* setPhase('starting indexer');

			const networkAlias = slug(`${name}-${identity.stack}`);
			const databaseUrl = postgres.url(databaseName);

			// Indexer container joins Postgres's network so it can dial the
			// db via `networkAlias` (no host port mapping required).
			const postgresNetwork = postgres.containerNetworks[0]!;

			const env: Record<string, string> = {
				DATABASE_URL: databaseUrl,
				NETWORK: 'localnet',
				DEEPBOOK_PACKAGE_ID: deepbook.packageId,
				FIRST_CHECKPOINT: (opts.firstCheckpoint ?? 0).toString(),
				RUST_LOG: opts.rustLog ?? 'info',
				DB_CONNECTION_POOL_SIZE: (opts.dbConnectionPoolSize ?? 10).toString(),
				// `LOCAL_CHECKPOINTS_DIR` is set when the indexer mounts the
				// sui checkpoint volume. Sui-fork hasn't yet surfaced a
				// volume name (`EndpointName.SUI_CHECKPOINT_VOLUME` is added
				// to endpoint-names.ts but the sui factory hasn't published
				// it yet). For now indexer boots without checkpoint ingestion
				// — the Move events still flow through Postgres once the
				// volume is wired in a later phase.
			};

			// Phase-4: when a margin Ref is wired in, surface the deployed
			// package ids to the indexer via `MARGIN_PACKAGES` (comma-
			// separated). Mirrors sandbox parity
			// (`~/code/deepbook-sandbox/sandbox/docker-compose.yml:151-188`).
			// The indexer's Move-event decoders use this list to subscribe
			// to the margin-side events written to the same Postgres.
			if (margin !== undefined) {
				env.MARGIN_PACKAGES = `${margin.packageId},${margin.liquidationPackageId}`;
			}

			// `sui` Ref held only for the layer-build edge.
			void sui;

			yield* setPhase('starting container');
			const routerEntrypointInfo = routerEntrypoint('deepbook-indexer-metrics');
			if (routerEntrypointInfo === undefined) {
				return yield* Effect.fail(
					new DeepbookIndexerError({
						phase: 'port-alloc',
						message: `routerEntrypoint('deepbook-indexer-metrics') is undefined — router table out of sync`,
					}),
				);
			}
			const metricsHostname = routerHostname(identity, 'deepbook-indexer');
			// `routing[].name = 'deepbook-indexer-metrics'` (router id)
			// + `hostnameName = 'deepbook-indexer'` (URL host) preserves
			// the previous file-provider id ↔ hostname split: the URL is
			// `deepbook-indexer.<app>.localhost:9186/metrics` but the
			// file-provider key is `deepbook-indexer-metrics` (so a
			// sibling deepbook route sharing the hostname doesn't
			// collide on the router id). The deepbook image is a
			// registry tag from `getDeepbookImages`; `{pull}` is the
			// right branch.
			const container = yield* runDockerContainer(`${name}.container` as const, {
				image: { pull: image },
				env,
				network: postgresNetwork,
				networkAlias,
				routing: [
					{
						name: 'deepbook-indexer-metrics',
						hostnameName: 'deepbook-indexer',
						entrypoint: 'deepbook-indexer-metrics',
						servicePort: INTERNAL_METRICS_PORT,
					},
				],
			}).effect.pipe(
				Effect.catchTag('DockerError', (cause) =>
					Effect.fail(
						new DeepbookIndexerError({
							phase: 'container',
							message: `failed to start deepbook-indexer container`,
							cause,
						}),
					),
				),
				Effect.catchTag('ReadyProbeError', (cause) =>
					Effect.fail(
						new DeepbookIndexerError({
							phase: 'container',
							message: `deepbook-indexer container failed ready probe`,
							cause,
						}),
					),
				),
			);
			void container;

			const metricsUrl = `http://${metricsHostname}:${routerEntrypointInfo.port}/metrics`;

			// URL ownership: the indexer's metrics URL is published only
			// into the per-service state registry below.
			// `runtime/service.ts::groupDeepbook` reads it from there to
			// surface `services.deepbook.indexer.metrics` in the manifest;
			// no flat-endpoint declaration exists (Wave-2 dual-write fix).

			yield* publishDeepbookIndexerState({
				name,
				metricsUrl,
				databaseUrl,
				containerNetwork: postgresNetwork,
				networkAlias,
			});

			return {
				name,
				metrics: metricsUrl,
				databaseUrl,
				containerNetwork: postgresNetwork,
				networkAlias,
			} satisfies DeepbookIndexer;
		}).pipe(
			Effect.withSpan(`DeepbookIndexer(${name})`),
			Effect.catchTag('DeepbookIndexerError', Effect.fail),
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new DeepbookIndexerError({
						phase: 'indexer',
						message: `DeepbookIndexer(${name}): ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		),
		{
			kind: 'service' as const,
			plugin: 'deepbook',
			displayTitle: `deepbook.indexer.${name}`,
			display: (s: DeepbookIndexer) => ({
				title: `deepbook.indexer.${name}`,
				primary: s.metrics,
			}),
			// Phase B (notes/parallel-graph-resolution.md §3.2): yields
			// postgres, sui, deepbook, optional margin, and iterates
			// `dependsOn`. Lift them all into upstreams so the topo
			// scheduler places the indexer strictly after its providers.
			upstreamKeys: [
				opts.postgres,
				opts.sui,
				opts.deepbook,
				...(opts.margin !== undefined ? [opts.margin] : []),
				...(opts.dependsOn ?? []),
			],
		},
	);

	const tagLayer = provide(
		DeepbookIndexerTag,
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
