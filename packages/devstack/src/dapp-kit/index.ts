// dapp-kit subpath public barrel. Apps import from
// `@mysten-incubation/devstack/dapp-kit`. Peer deps
// (`@mysten/dapp-kit-react`, `@mysten/dapp-kit-core`) are optional —
// the rest of devstack stays usable without them.

export {
	createDevstackDappKit,
	createDappKitConfig,
	mvrOverridesFromManifest,
	type CreateDevstackDappKitOptions,
	type DevstackDappKit,
	type DevstackDappKitConfig,
	type DevstackDappKitConfigOptions,
	type DevstackMvrOverrides,
} from './create-devstack-dapp-kit.js';
export { localnetWalrusOptions, type LocalnetWalrusOptions } from './walrus.js';

// Browser-safe manifest accessor + types. Re-exported here so apps can
// reach the typed manifest from a subpath that doesn't drag the Node-
// only factory graph (`Sui`, `Walrus`, `Seal`, the docker engine, …)
// into their bundle. Importing these from the package root works on
// the server but trips Vite's `node:path` externalization warning in
// the browser; this subpath is the supported browser surface.
export { fromManifest } from '../runtime/manifest-loader.js';
export type {
	Manifest,
	ManifestEncoded,
	AppManifest,
	DeepbookManifest,
	SealManifest,
	ServicesManifest,
	SuiManifest,
	WalrusManifest,
} from '../runtime/manifest-schema.js';
