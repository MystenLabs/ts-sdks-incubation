// Canonical endpoint names — single source of truth for the string
// keys factories publish into `EndpointRegistry` and consumers (the
// manifest grouper, codegen emitters, playwright helpers) read back.
//
// Each constant is a `defineEndpoint(...)` declaration that ALSO carries
// the conventional-route + manifest-field metadata. The derived
// `CONVENTIONAL_ROUTES` table in `runtime/conventional-routes.ts` reads
// from the same declarations, so a new endpoint is one entry here
// instead of three coordinated edits across this file, conventional
// routes, and the manifest grouper.
//
// Adding a new well-known endpoint:
//   1. Append a `defineEndpoint(...)` constant below, supplying the
//      conventional-route pair (when traefik routes it) and the
//      manifest-field path (when it surfaces under `services.*` or
//      `app.*`).
//   2. Wire the projection into `runtime/service.ts`'s grouper if it
//      lands inside a structured services/app block (the grouper still
//      needs explicit code because the manifest shape is
//      heterogeneous — some endpoints are siblings of state records,
//      others are app-top-level).
//   3. Wire it into `playwright/web-server.ts` so e2e configs can name
//      it via `webServer({ endpoint })` / `baseURL`.

import { defineEndpoint } from '../engine/define-endpoint.js';

const sui_rpc = defineEndpoint({
	name: 'sui-rpc',
	conventional: { service: 'sui', port: 9000 },
	manifestField: { path: 'services.sui.rpc' },
	publishedBy: 'Sui()',
});

const sui_faucet = defineEndpoint({
	name: 'sui-faucet',
	conventional: { service: 'faucet', port: 9123 },
	manifestField: { path: 'services.sui.faucet' },
	publishedBy: 'Sui() (when faucet enabled)',
});

const sui_graphql = defineEndpoint({
	name: 'sui-graphql',
	conventional: { service: 'graphql', port: 9125 },
	manifestField: { path: 'services.sui.graphql' },
	publishedBy: 'Sui() (when graphql enabled)',
});

const sui_indexer_db = defineEndpoint({
	name: 'sui-indexer-db',
	manifestField: { path: 'services.sui.indexerDb' },
	publishedBy: 'Sui() (when indexer enabled)',
});

const wallet_app = defineEndpoint({
	name: 'wallet-app',
	conventional: { service: 'wallet', port: 5180 },
	manifestField: { path: 'app.wallet' },
	publishedBy: 'Wallet()',
});

const dev_server_primary = defineEndpoint({
	name: 'frontend.dev-server',
	conventional: { service: 'dev', port: 5175 },
	manifestField: { path: 'app.dev' },
	publishedBy: 'Dev()',
});

// Both names route to the same dev service. `DEV_SERVER_PRIMARY` is the
// canonical lookup key in the manifest (see `runtime/service.ts`'s
// `groupApp`); `DEV_SERVER_FALLBACK` is what the built-in `Dev()`
// factory publishes today.
const dev_server_fallback = defineEndpoint({
	name: 'dev-server',
	conventional: { service: 'dev', port: 5175 },
	manifestField: { path: 'app.dev' },
	publishedBy: 'Dev()',
});

const seal_key_server = defineEndpoint({
	name: 'seal-key-server',
	conventional: { service: 'seal', port: 2024 },
	manifestField: { path: 'services.seal.keyServer' },
	publishedBy: 'Seal()',
});

const walrus_aggregator = defineEndpoint({
	name: 'walrus-aggregator',
	conventional: { service: 'walrus-agg', port: 9185 },
	manifestField: { path: 'services.walrus.aggregator' },
	publishedBy: 'Walrus()',
});

const walrus_publisher = defineEndpoint({
	name: 'walrus-publisher',
	conventional: { service: 'walrus-pub', port: 9185 },
	manifestField: { path: 'services.walrus.publisher' },
	publishedBy: 'Walrus()',
});

// Phase 2 — Postgres + DeepBook indexer
const postgres = defineEndpoint({
	name: 'postgres',
	manifestField: { path: 'services.postgres.endpoint' },
	publishedBy: 'Postgres()',
});

const deepbook_indexer_metrics = defineEndpoint({
	name: 'deepbook-indexer-metrics',
	manifestField: { path: 'services.deepbook.indexer.metrics' },
	publishedBy: 'Deepbook() (when indexer enabled)',
});

const sui_checkpoint_volume = defineEndpoint({
	name: 'sui-checkpoint-volume',
	publishedBy: 'Sui() (when indexer enabled)',
});

// Phase 3 — DeepBook server (REST API + Prometheus metrics)
const deepbook_server_rest = defineEndpoint({
	name: 'deepbook-server',
	manifestField: { path: 'services.deepbook.server.rest' },
	publishedBy: 'Deepbook() (when server enabled)',
});

const deepbook_server_metrics = defineEndpoint({
	name: 'deepbook-server-metrics',
	manifestField: { path: 'services.deepbook.server.metrics' },
	publishedBy: 'Deepbook() (when server enabled)',
});

/** Canonical endpoint name constants. Each value is the `.name` of a
 *  `defineEndpoint(...)` declaration above. The object keeps a flat
 *  shape so existing consumers (`EndpointName.SUI_RPC`) keep working
 *  without churn. */
export const EndpointName = {
	SUI_RPC: sui_rpc.name,
	SUI_FAUCET: sui_faucet.name,
	SUI_GRAPHQL: sui_graphql.name,
	SUI_INDEXER_DB: sui_indexer_db.name,
	WALLET_APP: wallet_app.name,
	DEV_SERVER_PRIMARY: dev_server_primary.name,
	DEV_SERVER_FALLBACK: dev_server_fallback.name,
	SEAL_KEY_SERVER: seal_key_server.name,
	WALRUS_AGGREGATOR: walrus_aggregator.name,
	WALRUS_PUBLISHER: walrus_publisher.name,
	POSTGRES: postgres.name,
	DEEPBOOK_INDEXER_METRICS: deepbook_indexer_metrics.name,
	SUI_CHECKPOINT_VOLUME: sui_checkpoint_volume.name,
	DEEPBOOK_SERVER_REST: deepbook_server_rest.name,
	DEEPBOOK_SERVER_METRICS: deepbook_server_metrics.name,
} as const;

export type EndpointNameValue = (typeof EndpointName)[keyof typeof EndpointName];
