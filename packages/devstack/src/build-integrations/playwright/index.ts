// Playwright build-integration — public barrel.
//
// Architecture (distilled/23-build-integrations.md § Playwright):
// apps compose the provided config fragments inside Playwright's
// normal `defineConfig(...)`; in-spec helpers (`connectAs`,
// `selectAccount`, `loadStackManifest`, the wallet adapter) import
// from the same subpath.
//
// Layer position: L4 (surface). Reads the manifest + env; never
// writes; never subscribes to engine events; never imports a plugin
// by service name. `hostService(...)` owns the dev-server port
// allocation; this surface only READS the URL it emits.
//
// Optional peer: `@playwright/test`. We do not import the peer at
// module init — the structural types in this barrel and its children
// keep the preset loadable without it (matching the vitest preset).

// -----------------------------------------------------------------------------
// Re-exports — the helpers in-spec tests import from this subpath
// -----------------------------------------------------------------------------

export type {
	DevstackPlaywrightBaseConfigOptions,
	DevstackPlaywrightEndpointOptions,
	DevstackPlaywrightProjectsOptions,
	DevstackPlaywrightUseOptions,
	DevstackPlaywrightWebServerOptions,
	PlaywrightBaseConfigShape,
	PlaywrightProjectShape,
	PlaywrightUseConfigShape,
	PlaywrightWebServerConfigShape,
} from './config.ts';
export {
	devstackPlaywrightBaseConfig,
	devstackPlaywrightProjects,
	devstackPlaywrightUse,
	devstackPlaywrightWebServer,
	resolveDevstackPlaywrightBaseURL,
} from './config.ts';

export type {
	ResolveStackContextOptions,
	ResolvedEndpoint,
	StackContext,
} from './stack-context.ts';
export {
	PLAYWRIGHT_ENV,
	conventionalUrlFor,
	discoverManifestPath,
	makeStackContext,
	readManifestSync,
	readStackContext,
	resolveEndpointUrl,
} from './stack-context.ts';

export type {
	DefineGlobalSetupOptions,
	PlaywrightGlobalSetup,
	PlaywrightStackFixture,
} from './global-setup.ts';
export { STACK_CONTEXT_SLOT, buildGlobalSetup, readStashedFixture } from './global-setup.ts';
// Re-export the substrate-owned slot key so callers can import the
// typed slot contract directly from the playwright barrel.
export { PLAYWRIGHT_STACK_CONTEXT_SLOT_KEY } from '../runtime/playwright-stack-context-slot.ts';

export type {
	DevAccount,
	PlaywrightPageLike,
	SignTxRequest,
	SignTxResponse,
	WalletAdapter,
	WalletAdapterOptions,
} from './wallet-context.ts';
export {
	DAPP_KIT_SLOT,
	WALLET_ENDPOINT_KEY,
	connectAs,
	createWalletAdapter,
	loadStackManifest,
	selectAccount,
} from './wallet-context.ts';

export type { PlaywrightIntegrationError } from './errors.ts';
export {
	PlaywrightEndpointNotFoundError,
	PlaywrightManifestDiscoveryError,
	PlaywrightManifestShapeError,
	PlaywrightWalletAdapterError,
} from './errors.ts';
