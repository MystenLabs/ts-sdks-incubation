export {
	composeStackLayer,
	defineDevstack,
	type Devstack,
	type DevstackConfig,
	type StackComposeOptions,
	type StackMember,
} from './define-devstack.js';
export { provideDevstack, type ProvideDevstackOptions } from './provide-devstack.js';
export {
	knownDeployments,
	type DeepbookDeployment,
	type KnownDeployments,
	type KnownNetwork,
	type SealDeployment,
	type WalrusDeployment,
} from './internal/known-deployments.js';

// Primitive factories + their per-call shapes. Re-exported by name
// rather than `export *` because the interface barrel below introduces
// canonical singleton tags (`Sui`, `Package`, …) that collide with the
// per-factory shape names the primitives barrel surfaces. The
// conflicting `Sui`/`SuiShape` come from interfaces; everything else
// still comes from primitives. Once every primitive consumes the
// interface tag directly the two namespaces collapse again.
export { accounts, type AccountSpec, type AccountsHandle } from './primitives/accounts.js';
export { action, type ActionOptions } from './primitives/action.js';
export { bindings, type BindingsOptions, type BindingsResult } from './primitives/bindings.js';
export {
	dockerContainer,
	type DockerContainerHandle,
	type DockerContainerOptions,
} from './primitives/docker-container.js';
export {
	AccountError,
	BindingsError,
	DeepbookError,
	DockerError,
	HostProcessError,
	ManifestError,
	PublishError,
	SealError,
	SuiError,
	WalletAppError,
	WalrusError,
} from './primitives/errors.js';
export {
	hostProcess,
	type HostProcessHandle,
	type HostProcessOptions,
	type HttpReadyProbe,
	type LogReadyProbe,
	type ReadyProbe,
	type TcpReadyProbe,
} from './primitives/host-process.js';
export { manifest, type ManifestData, type ManifestOptions } from './primitives/manifest.js';
export {
	publishMove,
	type CoinSpec,
	// `Package` from publishMove is the per-call shape (carries captured
	// + coins records); the canonical singleton-tag `Package` comes from
	// the interfaces barrel below. Aliased here so both stay reachable.
	type Package as PublishedPackage,
	type PublishedCoin,
	type PublishMoveOptions,
} from './primitives/publish-move.js';
export {
	pickCreatedByTypeIncludes,
	pickCreatedByTypeSuffix,
} from './primitives/sui-helpers.js';
export {
	registerCoin,
	type RegisterCoinOptions,
	type RegisterCoinResult,
} from './primitives/register-coin.js';
export type {
	Account,
	SignAndExecuteError,
	SignAndExecuteOptions,
	SuiObjectChange,
	SuiTransactionBlockResponse,
	Transaction,
	TxResult,
} from './primitives/shared.js';
export {
	deepbookKnownPackage,
	deepbookLocalDeploy,
	deepbookMarketMaker,
	type DeepbookKnownPackageOptions,
	type DeepbookLocalDeployOptions,
	type DeepbookLocalDeployShape,
	type DeepbookMarketMakerHandle,
	type DeepbookMarketMakerOptions,
	type DeepbookMarketMakerPoolSpec,
	type DeepbookPool,
	type DeepbookPoolSpec,
} from './primitives/deepbook/index.js';
export {
	sealKnownKeyServer,
	sealLocalKeygen,
	type SealKnownKeyServerOptions,
	type SealLocalKeygenOptions,
	type SealLocalKeygenShape,
} from './primitives/seal.js';
// `Sui`/`SuiShape` come from interfaces; the `sui*` factories + their
// per-call options come from primitives. The `Sui` class in
// `primitives/sui.ts` is just a re-export of the interface tag, so they
// share the same Context key (`'@devstack/Sui'`) and are interchangeable
// at runtime.
export {
	suiCustom,
	suiLocalnet,
	suiMainnet,
	suiTestnet,
	type SuiCustomOptions,
	type SuiLocalnetOptions,
	type SuiMainnetOptions,
	type SuiNetwork,
	type SuiTestnetOptions,
} from './primitives/sui.js';
export { tx, type TxOptions } from './primitives/tx.js';
export { walletApp, type WalletApp, type WalletAppOptions } from './primitives/wallet-app.js';
export {
	walrusKnownDeployment,
	walrusLocalCluster,
	type WalrusKnownDeploymentOptions,
	type WalrusLocalClusterOptions,
} from './primitives/walrus/index.js';

// Canonical interface contracts. Every multi-impl factory produces a
// `Layer` for one of these tags; consumers depend on the tag, not on a
// specific factory.
export {
	Sui,
	type SuiShape,
	Package,
	type PackageShape,
	LocalPackage,
	type LocalPackageShape,
	Coin,
	type CoinShape,
	WalrusNetwork,
	type WalrusNetworkShape,
	WalrusNodes,
	type WalrusNodesShape,
	WalrusProxy,
	type WalrusProxyShape,
	WalrusAdmin,
	type WalrusAdminShape,
	SealKeyServer,
	type SealKeyServerShape,
	SealKeyManager,
	type SealKeyManagerShape,
	DeepbookCore,
	type DeepbookCoreShape,
	DeepbookAdmin,
	type DeepbookAdminShape,
	DeepbookMarketMaker,
	type DeepbookMarketMakerShape,
	type AccountShape,
	type AccountTag,
} from './interfaces/index.js';
