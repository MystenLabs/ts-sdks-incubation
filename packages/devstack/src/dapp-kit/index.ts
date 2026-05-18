// dapp-kit subpath public barrel. Apps import from
// `@mysten-incubation/devstack/dapp-kit`. Peer deps
// (`@mysten/dapp-kit-react`, `@mysten/dapp-kit-core`) are optional —
// the rest of devstack stays usable without them.
//
// What lives here:
//   - `localnetWalrusOptions({ systemObjectId, stakingPoolId })` —
//     builds the `packageConfig` (systemObjectId + stakingPoolId) for
//     `new WalrusClient(...)` and sets `storageNodeUrlScheme: 'http'`
//     since devstack storage nodes serve plain HTTP. The object ids
//     are sourced from the generated `captured.ts` in user code and
//     passed in directly.
//
// The dapp-kit instance itself is constructed in user code (each
// example's `src/dapp-kit.ts`) by spreading the generated
// `devstackDappKitConfig` from `./generated/dapp-kit-config.js` into
// `createDAppKit(...)`. There's no runtime `createDevstackDappKit`
// helper any more — the generated config replaces it.
//
// Manifest accessors (`fromManifest`) and the typed `Manifest` shape
// are NOT re-exported here. Generated browser code (`./generated/`) is
// fully self-contained: the dapp-kit-config and stack-handle emitters
// bake every value as a static literal at codegen time, so browser
// code never reads `.devstack/manifest.json` at runtime. Server-side
// callers that need `fromManifest` import it from the package root
// (`@mysten-incubation/devstack`) directly.

export { localnetWalrusOptions, type LocalnetWalrusOptions } from './walrus.js';
