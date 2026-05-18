// Runtime subpath — everything an app needs to consume a devstack at
// runtime, without pulling in the supervisor / docker / codegen graph.
// Safe to import from app code, tests, and Playwright configs.
//
// Three concern groups:
//   1. The `Devstack` Effect Service — `yield* Devstack` inside an
//      Effect program to get the live manifest snapshot (used by apps
//      that compose with the devstack Layer directly).
//   2. Manifest schema + types — the v4 `Manifest` shape every
//      consumer reads, plus the per-service sub-shapes (Sui, Seal,
//      Walrus, Deepbook, App, …).
//   3. Loaders/discovery — `fromManifest` to parse the on-disk JSON
//      back to a typed `Manifest`, and `discoverManifestPath` to
//      locate it from cwd / env / explicit override.
//
// The producer side (manifest-emit) and the internal Extras plumbing
// stay off this barrel — they're supervisor-internal and live behind
// `/advanced` for plugin authors who genuinely need them.

// 1. Runtime accessor
export { Devstack, DevstackLive, type DevstackShape, gatherManifest } from './service.js';

// 1b. Endpoint name constants — single source of truth for the strings
// factories publish into the registry and consumers read back.
export { EndpointName, type EndpointNameValue } from './endpoint-names.js';

// 1c. Extras service — re-exported from engine/ so plugin authors keep
// importing it from the runtime barrel even though it lives in engine/.
export {
	Extras,
	ExtrasResolved,
	ExtrasLive,
	ExtrasEmpty,
	resolveExtras,
	type ExtrasInput,
} from '../engine/extras.js';

// 2. Manifest schema + types
export {
	type AccountEntry,
	type AppManifest,
	type CoinEntry,
	type DeepbookManifest,
	type DeepbookPoolEntry,
	type EndpointEntry,
	type Manifest,
	type ManifestEncoded,
	ManifestV4,
	type PackageEntry,
	type SdkCoinEntry,
	type SealManifest,
	type ServicesManifest,
	type StackIdentity,
	type SuiManifest,
	type WalrusManifest,
} from './manifest-schema.js';

// 3. Loaders + discovery
export { type FromManifestOptions, fromManifest } from './manifest-loader.js';
export { type DiscoverManifestPathOptions, discoverManifestPath } from './discover-manifest.js';
