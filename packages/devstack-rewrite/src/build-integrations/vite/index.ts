// Vite build integration — public barrel.
//
// Architecture § L4 build integrations: pure consumer of devstack
// artifacts. The vite integration reads the L0 manifest envelope and
// the codegen-emitted files; it does NOT subscribe to engine events.
//
// Apps consume this subpath via one call:
//
//   import { defineDevstackViteConfig } from
//     '@mysten-incubation/devstack/vite';
//
//   export default defineDevstackViteConfig({ port: 5174 });
//
// Standalone plugin consumers (apps that already own a complex
// vite.config.ts) import `devstackVitePlugin` directly.

export { defineDevstackViteConfig } from './config.ts';
export type { DefineDevstackViteConfigOptions } from './config.ts';

export { devstackVitePlugin } from './plugin.ts';
export type { DevstackVitePluginOptions, DevstackVitePluginInternals } from './plugin.ts';

export { discoverIdentity, type ResolvedIdentity, type DiscoverOptions } from './discover.ts';

export {
	coldStartHost,
	coldStartUrl,
	DEFAULT_ROUTER_PUBLIC_PORT,
	DEV_HOST_INFIX,
	type ColdStartUrlInput,
} from './cold-start-url.ts';

// Re-exports from the canonical `runtime/` substrate. The slot
// contract + manifest read API live there; vite's barrel surfaces
// them for callers that import only this subpath.
export {
	DAPP_KIT_SLOT_KEY,
	readDAppKitSlot,
	writeDAppKitSlot,
	clearDAppKitSlot,
	type DAppKitSlot,
	readStackContext,
	type StackContext,
	type ResolvedEndpoint,
	ManifestDiscoveryError,
	ManifestShapeError,
} from '../runtime/index.ts';

export { wireGracefulShutdown, type GracefulShutdownOptions } from './graceful-shutdown.ts';

export { buildDispatchTable, type DispatchTable, type DispatchEntry } from './dispatch-table.ts';

export {
	ViteIdentityResolutionError,
	ViteConfigOptionsError,
	type ViteIntegrationError,
} from './errors.ts';
