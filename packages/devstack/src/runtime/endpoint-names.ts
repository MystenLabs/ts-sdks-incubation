// Canonical endpoint names — single source of truth for the string
// keys factories publish into `EndpointRegistry` and consumers (the
// manifest grouper, codegen emitters, playwright helpers) read back.
//
// Adding a new well-known endpoint:
//   1. Append a constant below.
//   2. Wire it into `runtime/service.ts` so `gatherManifest` projects
//      it under `services.*` or `app.*`.
//   3. Wire it into `playwright/web-server.ts` so e2e configs can name
//      it via `webServer({ endpoint })` / `baseURL`.

export const EndpointName = {
	SUI_RPC: 'sui-rpc',
	SUI_FAUCET: 'sui-faucet',
	SUI_GRAPHQL: 'sui-graphql',
	SUI_INDEXER_DB: 'sui-indexer-db',
	WALLET_APP: 'wallet-app',
	DEV_SERVER_PRIMARY: 'frontend.dev-server',
	DEV_SERVER_FALLBACK: 'dev-server',
	SEAL_KEY_SERVER: 'seal-key-server',
	WALRUS_AGGREGATOR: 'walrus-aggregator',
	WALRUS_PUBLISHER: 'walrus-publisher',
} as const;

export type EndpointNameValue = (typeof EndpointName)[keyof typeof EndpointName];
