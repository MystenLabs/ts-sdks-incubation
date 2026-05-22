// Public API surface for `@mysten-incubation/devstack`.
//
// One root barrel for the whole user-facing + plugin-author vocabulary
// (api-surface-design.md P5). Every plugin factory, every option type,
// every plugin-author primitive flows through this file. Subpaths
// (`/contracts`, `/substrate`, plus the L5 build-integration subpaths)
// exist for tree-shaking + isolation, not as part of the user vocabulary.

// --- Composer surfaces --------------------------------------------------

export { defineDevstack, type Stack } from './api/define-devstack.ts';
export {
	defineDevstackWith,
	type BuildCtx,
	type DevstackOptionsWith,
} from './api/define-devstack-with.ts';
export {
	runStack,
	type BootError,
	type RunHandle,
	type RunStackIdentityOptions,
	type RunStackOptions,
} from './api/run-stack.ts';

// --- Plugin authoring helpers -------------------------------------------

export {
	capability,
	capabilitySink,
	codegenable,
	defineCapability,
	projection,
	routable,
	snapshotable,
	strategyContributor,
} from './api/define-capabilities.ts';
export {
	defineId,
	definePlugin,
	resource,
	type AnyPlugin,
	type AnyResourceRef,
	type DependencyInput,
	type DependencyList,
	type Plugin,
	type PluginSpec,
	type ResourceRef,
	type ResolvedDependencies,
	type ResourceIdOf,
	type ResourceValueOf,
} from './api/define-plugin.ts';
export {
	defineModeNamespace,
	type FactoriesByMode,
	type FactoriesFor,
	type ModeNamespace,
} from './api/mode-narrowed-factory.ts';
export * as ConfigValidation from './substrate/runtime/config-validation.ts';
export * as HttpProbes from './substrate/runtime/http-probe.ts';
export * as ManagedContainers from './substrate/runtime/managed-container.ts';
export * as ProcessLines from './substrate/runtime/observability/process-lines.ts';
export * as ProcessSupervisor from './substrate/runtime/process-supervisor.ts';
export * as Probes from './substrate/runtime/probes.ts';
export * as Redaction from './substrate/runtime/observability/redaction.ts';
export * as RetryPolicy from './substrate/runtime/retry-policy.ts';
export * as RuntimeDecode from './substrate/runtime/runtime-decode.ts';
export {
	Logger,
	Redactor,
	type LoggerShape,
	type LogLevel,
	type LogLine,
	type LogPayload,
	type RedactionRule,
	type TagBuffer,
} from './substrate/runtime/observability/index.ts';

// --- Contract types plugin authors emit decls of ------------------------

export type {
	CapabilityDecl,
	CapabilityKind,
	CapabilityPayloadFor,
	DevstackCapabilityRegistry,
	ExactCapabilityPayload,
} from './contracts/capability-decl.ts';
export type {
	CodegenableDecl,
	CodegenEmitContext,
	CodegenEmitDone,
} from './contracts/codegenable.ts';
export type { ProjectionDecl, ProjectionEvent } from './contracts/projection.ts';
export type {
	ContainerHandle,
	ContainerRuntime,
	ContainerRuntimeError,
	ImageRef,
	LoadedImageBundle,
	TaggedImageRef,
} from './contracts/container-runtime.ts';
export { ContainerRuntimeService } from './runtime/docker/service.ts';
export type {
	LivenessClassifierDecl,
	LivenessClassification,
	LivenessHints,
} from './contracts/liveness-classifier.ts';
export type {
	DispatchId,
	DevstackRoutableUpstreamRegistry,
	RoutableDecl,
	RoutableHttpDecl,
	RoutableTcpDecl,
	RoutableUpstream,
	RoutableUpstreamKind,
} from './contracts/routable.ts';
export type { ContainerLabelTuple, SnapshotableDecl } from './contracts/snapshotable.ts';
export type { StrategyContributorDecl, StrategyFor } from './contracts/strategy-contributor.ts';

// --- Lifecycle primitives plugin authors touch --------------------------

export type { LifecycleStatus, PhaseNarration, PluginRole } from './substrate/lifecycle.ts';

// --- Network + options --------------------------------------------------

export type {
	NetworkConfig,
	NetworkMode,
	DefaultNetwork,
	DevstackNetworkModeRegistry,
} from './substrate/network.ts';
export type { DevstackOptions } from './substrate/options.ts';
export type {
	ManifestExtras,
	ManifestExtrasContext,
	ManifestExtrasInput,
} from './substrate/manifest.ts';
export { IdentityContext } from './substrate/runtime/paths.ts';

// --- Branded primitives (constructor functions for plugin authors) ------

export {
	appName,
	chainId,
	contentHash,
	endpointKey,
	stackName,
	type AppName,
	type Brand,
	type ChainId,
	type ContentHash,
	type EndpointKey,
	type StackName,
} from './substrate/brand.ts';

// ===========================================================================
// Built-in plugin factories
// ===========================================================================
//
// Every L2 plugin's public surface re-exported here. Subpaths under
// `/plugins/<name>` are deleted at this PR — tree-shaking handles unused
// plugins via the package's `sideEffects: false`. See api-surface-design.md
// §5 (subpath strategy) and `api-comparison.md` cross-cut friction point #1.

// --- Sui ----------------------------------------------------------------

export {
	sui,
	suiFor,
	type SuiClient,
	type ForkAdminSurface,
	type WaitForTransactionsReady,
	type ResolvedSuiNetwork,
	type SuiOptions,
	type SuiLocalOptions,
	type SuiExternalOptions,
	type SuiLiveOptions,
	type SuiForkOptions,
	type SuiPluginMode,
	type SuiNetworkBindings,
	type SuiError,
	type SuiPluginError,
	type SuiCliError,
	type SuiConfigError,
	type ForkUnsupportedError,
	type SeedManifestMismatchError,
	type SuiFundsReadyError,
	type ChainProbe,
	type ChainProbeError,
	type ChainProbeMode,
	type FundsReadyStrategy,
	type FundsReadyError,
	type SeedObjectsAccumulator,
	type ForkMeta,
	type SuiProbeKey,
} from './plugins/sui/index.ts';

// --- Account ------------------------------------------------------------

export {
	account,
	DEFAULT_EPHEMERAL_FUND_MIST,
	SUI_FULL_COIN_TYPE,
	type AccountOptions,
	type AccountValue,
	type TxResult,
	type AccountError,
	type AccountAcquireError,
	type AccountAcquirePhase,
	type AccountSignError,
	type AccountSignPhase,
	type AccountVariantKind,
	type CoinMember,
	type CrossCuttingFundingEntry,
	type AccountBindings,
	type SyntheticImpersonationSigner,
	type SignatureScheme,
	type ResolvedKeypair,
} from './plugins/account/index.ts';

// --- Package ------------------------------------------------------------

export {
	localPackage,
	knownPackage,
	pkg,
	pickCreatedByType,
	type LocalPackageOptions,
	type KnownPackageOptions,
	type LocalPackageResolved,
	type KnownPackageResolved,
	type PackageResolved,
	type PackageCapture,
	type PackageCaptureCallback,
	type PackageCaptureMap,
	type PickCreatedByTypeOptions,
	type PublisherAccountMember,
	type LocalPackagePublishOutput,
	type PackagePublishObjectChange,
	type PublishError,
	type PackageBindings,
	type ResolvedLocalPackage,
	type ResolvedKnownPackage,
} from './plugins/package/index.ts';

// --- Coin ---------------------------------------------------------------

export {
	coin,
	BUILTIN_COINS,
	isBareCoinType,
	validateBareCoinType,
	type CoinValue,
	type CoinAddressForm,
	type ResolvedCoin,
	type BuiltinCoinName,
	type CoinBindings,
	type DiscoveredCoin,
	type PackageMember,
	type CoinError,
	type CoinPhase,
} from './plugins/coin/index.ts';

// --- Wallet -------------------------------------------------------------

export {
	wallet,
	WALLET_ACCOUNTS_ALL,
	type WalletOptions,
	type WalletValue,
	type WalletAccountMember,
	type WalletAccountsAll,
	type DappKitConfigBindings,
	type WalletError,
	type WalletBootError,
	type WalletBootPhase,
	type WalletRequestError,
	type WalletRequestPhase,
	type OriginPolicy,
	type OriginPolicyInputs,
	type OriginCheckResult,
	type PairingToken,
} from './plugins/wallet/index.ts';

// --- Host Service -------------------------------------------------------

export {
	hostService,
	HOST_SERVICE_PORT_TOKEN,
	type HostServiceError,
	type HostServiceOptions,
	type HostServiceReadyProbe,
	type HostServiceValue,
} from './plugins/host-service/index.ts';

// --- Postgres -----------------------------------------------------------

export {
	postgres,
	POSTGRES_TCP_ENDPOINT_NAME,
	credentialedUrl,
	plainUrl,
	withDatabase,
	type PostgresPluginOptions,
	type Postgres,
	type PostgresServiceOptions,
	type PostgresConnectionBindings,
	type PostgresConnectionParts,
	type PostgresError,
	type PostgresPluginError,
	type PostgresConfigError,
	type PostgresConnectionTimeout,
	type DatabaseCreateFailed,
	type PostgresPhase,
} from './plugins/postgres/index.ts';

// --- Faucet -------------------------------------------------------------

export {
	faucet,
	faucetCapabilityKey,
	defineFaucetStrategy,
	suiLocalStrategy,
	suiLiveStrategy,
	LIVE_FAUCET_URLS,
	requestFundsOnce,
	requestFundsWithRetry,
	DEFAULT_FETCH_DEADLINE_MS,
	DEFAULT_INITIAL_DELAY_MS,
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_TIMEOUT_MS,
	BACKOFF_FACTOR,
	type FaucetService,
	type FaucetServiceOptions,
	type FaucetStrategyContribution,
	type FaucetRequest,
	type FaucetDispatcher,
	type FaucetError,
	type FaucetUnreachable,
	type FaucetExhausted,
	type FaucetBodyError,
	type FaucetStrategyMissing,
	type FaucetConfigError,
	type FaucetStrategy,
	type SuiLocalStrategyOptions,
	type SuiLiveStrategyOptions,
	type SuiLiveNetwork,
	type FaucetPostOptions,
	type RetryOptions,
} from './plugins/faucet/index.ts';

// --- Action -------------------------------------------------------------

export {
	action,
	type ActionOptions,
	type ActionUpstreamRef,
	type ActionBuildContext,
	type ActionError,
	type ActionPhase,
	type ActionReceipt,
} from './plugins/action/index.ts';

// --- Walrus -------------------------------------------------------------

export {
	walrus,
	walrusFor,
	type WalrusAdmin,
	type WalrusResolved,
	type WalrusLocalClusterOptions,
	type WalrusKnownDeploymentOptions,
	type WalrusKnownNetwork,
	type WalrusStorageNode,
	type WalrusBindings,
	type WalrusNodeBinding,
	type WalrusError,
	type WalrusPluginError,
	type WalrusConfigError,
	type WalrusPhase,
	type WalFaucetStrategy,
	type WalFaucetRequest,
} from './plugins/walrus/index.ts';

// --- Seal ---------------------------------------------------------------

export {
	seal,
	sealFor,
	sealLocalKeygenStrict,
	type SealOptions,
	type SealCommonOptions,
	type SealLocalKeygenOptions,
	type SealLiveOptions,
	type SealForkKnownOptions,
	type SealKeyServer,
	type SealKeyServerEntry,
	type SealLocalKeygenResolved,
	type SealKnownResolved,
	type SealResolved,
	type SealKeyManager,
	type SealError,
	type SealAnyError,
	type SealConfigError,
	type SealAcquireError,
	type SealBindings,
} from './plugins/seal/index.ts';

// --- Deepbook -----------------------------------------------------------

export {
	deepbook,
	deepbookFor,
	type DeepbookResolved,
	type DeepbookCommonOptions,
	type DeepbookLocalOptions,
	type DeepbookKnownOptions,
	type DeepbookKnownNetwork,
	type DeepbookOptions,
	type DeepbookBindings,
	type DeepbookPoolBinding,
	type DeepbookError,
	type DeepbookPluginError,
	type DeepbookConfigError,
	type DeepbookPhase,
	type AccountMemberAlias,
	type DeepbookPool,
	type PythHandle,
	type PythPriceFeedId,
} from './plugins/deepbook/index.ts';
