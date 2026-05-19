// Walrus storage-node primitives. Two factories that produce the same
// narrow interface vocabulary:
//
//   - `walrusLocalCluster(opts)`   — full local boot. Builds the
//     wrapper image, deploys contracts on local sui, registers nodes,
//     fronts them via nginx, funds seed accounts. Provides ALL FOUR
//     interfaces (`WalrusNetworkTag`, `WalrusNodesTag`, `WalrusProxyTag`,
//     `WalrusAdminTag`).
//   - `walrusKnownDeployment(opts)` — pure-config handle pointing at a
//     known testnet/mainnet deployment. Provides only `WalrusNetworkTag`,
//     `WalrusNodesTag`, and (when URLs are available) `WalrusProxyTag`. No
//     `WalrusAdminTag` — we never have admin power over a network we
//     didn't boot.
//
// Consumers yield the narrow tags directly. The on-disk
// `manifest.packages.walrus` aggregate is still derived from the same
// acquired state.

export { walrusLocalCluster, type WalrusLocalClusterOptions } from './local-cluster.js';
export { walrusKnownDeployment, type WalrusKnownDeploymentOptions } from './known-deployment.js';
// `localnetWalrusOptions(args)` — pure-function helper that builds the
// `packageConfig` + `storageNodeUrlScheme: 'http'` fields for
// `new WalrusClient(...)` against a devstack-booted walrus. Browser
// code in example apps sources the ids from generated `captured.ts`
// and passes them in directly.
export {
	localnetWalrusOptions,
	type LocalnetWalrusOptions,
	type LocalnetWalrusInputs,
} from './options.js';
