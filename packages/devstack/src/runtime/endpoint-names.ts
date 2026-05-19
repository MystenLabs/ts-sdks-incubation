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

// Phase 2 — Postgres
const postgres = defineEndpoint({
	name: 'postgres',
	manifestField: { path: 'services.postgres.endpoint' },
	publishedBy: 'Postgres()',
});

// Flat-only-internal endpoint name. **No `manifestField:` and no
// `conventional:` route on purpose** — this name addresses a Docker
// volume (not an HTTP endpoint), so neither the manifest grouper nor
// the traefik conventional-route table would do anything sensible with
// it. The constant exists so the deepbook indexer can read
// `EndpointName.SUI_CHECKPOINT_VOLUME` rather than hard-coding the
// string — when the sui factory eventually publishes the volume (the
// sui-fork agent's work), the indexer's `LOCAL_CHECKPOINTS_DIR` mount
// will resolve via this name.
//
// Don't delete this even though no current factory publishes it; the
// sui-fork integration plan in `packages/devstack/notes/sui-fork-integration.md`
// reaches for it. See Wave 6.5 (`notes/review-followups.md` §8.5) for
// the explicit "keep as flat-only-internal" decision.
const sui_checkpoint_volume = defineEndpoint({
	name: 'sui-checkpoint-volume',
	publishedBy: 'Sui() (when indexer enabled)',
});

// DeepBook indexer + server URLs are intentionally NOT declared here —
// the per-service state registries (`DeepbookIndexerStateRegistry`,
// `DeepbookServerStateRegistry`) own those URLs, and `groupDeepbook`
// in `runtime/service.ts` reads them directly from state. Adding
// `defineEndpoint(...)` declarations for them would duplicate the
// source of truth between flat-endpoint records and per-service state
// records (the Wave-2 fix from `.review-findings/` Tier A.1).

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
	SEAL_KEY_SERVER: seal_key_server.name,
	WALRUS_AGGREGATOR: walrus_aggregator.name,
	WALRUS_PUBLISHER: walrus_publisher.name,
	POSTGRES: postgres.name,
	SUI_CHECKPOINT_VOLUME: sui_checkpoint_volume.name,
} as const;

export type EndpointNameValue = (typeof EndpointName)[keyof typeof EndpointName];
