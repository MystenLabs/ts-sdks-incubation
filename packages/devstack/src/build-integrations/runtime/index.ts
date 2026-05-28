// Build-integrations / runtime — public read API.
//
// Read-side L5 bridge between the on-disk manifest the supervisor
// writes and the consumer code (apps, build tools, codegen output)
// that needs to discover endpoints, accounts, packages, etc.
//
// This module is what build integrations + generated app code import.
// Plain TS surface — no Effect, no Schema. (Internally we use Schema
// to validate the envelope on read, but the API shape is plain.)
//
// Three things this layer owns:
//   1. Manifest discovery (`discoverManifestPath`) — env + override +
//      walk-up precedence, stack-scoped only.
//   2. Manifest read + project (`readStackContext`) — sync-blocking,
//      throws structured errors on disk / shape / version failures.
//   3. Cold-start URL fallback (`coldStartUrl`) — for callers that
//      need an endpoint URL BEFORE the manifest exists (e.g.
//      Playwright config-load that spawns `pnpm dev`).
//
// The substrate (`src/substrate/manifest.ts`) owns the schema shape;
// the supervisor (in `src/substrate/runtime/manifest/`) owns the
// write path. Architecture § Runtime substrate scope: three-way split.

export {
	discoverBuildIntegrationIdentity,
	discoverManifestPath,
	discoverSingleStackManifestPath,
	readAppName,
	readAppNameWalkup,
	type DiscoverManifestPathOptions,
	type DiscoverBuildIntegrationIdentityOptions,
	type DiscoverSingleStackManifestPathOptions,
	type BuildIntegrationIdentity,
	DEFAULT_STACK,
	DEFAULT_STATE_DIR,
} from './discover.ts';
export {
	manifestEnvelopeFromStackContext,
	readStackContext,
	type ReadStackContextOptions,
	CONSUMER_MANIFEST_VERSION,
} from './read-stack-context.ts';
export type { ResolvedEndpoint, StackContext, StackIdentity } from './stack-context.ts';
export { EndpointRegistry } from './endpoint-registry.ts';
export {
	coldStartUrl,
	conventionalRouteHost,
	conventionalRouteUrl,
	conventionalRoutesFromHints,
	tryColdStartUrl,
	type ColdStartUrlOptions,
	type ConventionalRoute,
	type ConventionalRouteHint,
	type ConventionalRouteHostInput,
	type ConventionalRouteUrlInput,
} from './cold-start-url.ts';
export {
	BUILT_IN_CONVENTIONAL_HINTS,
	BUILT_IN_ENDPOINT_ALIASES,
	DEFAULT_ROUTER_ENTRYPOINT_PORT,
	builtInConventionalRoutes,
	conventionalRoutesFromManifest,
	conventionalRoutesPreferringManifest,
	resolveBuiltInEndpointAlias,
} from './conventional-routes.ts';
export {
	PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY,
	type PlaywrightStackFixture,
} from './playwright-stack-context-slot.ts';
export {
	ManifestDiscoveryError,
	ManifestShapeError,
	NoConventionalRouteError,
	type ManifestDiscoveryPhase,
	type ManifestShapePhase,
} from './errors.ts';
export {
	WalletHttpPath,
	WALLET_AUTH_HEADER,
	WALLET_BEARER_PREFIX,
	WALLET_ENDPOINT_ALIAS,
	WALLET_ENDPOINT_NAME,
	WALLET_PROTOCOL_PREFIX,
	WALLET_TOKEN_FRAGMENT_KEY,
	WALLET_TOKEN_HEX_LENGTH,
	type WalletHttpPathValue,
} from './wallet-paths.ts';
export {
	ManifestEnvelopeSchema,
	type ManifestEnvelope,
	type EndpointEntry,
} from './manifest-types.ts';
