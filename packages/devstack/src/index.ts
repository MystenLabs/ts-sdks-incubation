// Public API surface for `@mysten-incubation/devstack`.
//
// One root barrel for the whole user-facing + plugin-author vocabulary
// (api-surface-design.md P5). Every plugin factory, every option type,
// every plugin-author primitive flows through this file. Subpaths
// (`/contracts`, `/substrate`, plus the L5 build-integration subpaths)
// exist for tree-shaking + isolation, not as part of the user vocabulary.

// --- Composer surfaces --------------------------------------------------

export {
	defineDevstack,
	type Stack,
	type WithAutoSui,
	type __UnsatisfiedWitnessesError,
} from './api/define-devstack.ts';
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

export { defineNodePlugin } from './api/define-plugin.ts';
export {
	capabilities,
	capabilityBuilder,
	type CapabilityBuilder,
} from './api/define-capabilities.ts';
export {
	consumeMembers,
	consumeMember,
	type ConsumedMembers,
	type ConsumedMember,
	type ConsumesTagsOf,
	type ResolvedValuesOf,
} from './api/consume-members.ts';
export { defineTag, type AnyTag, type ResolvedOf, type Tag, type TagIdOf } from './api/tag.ts';
export {
	defineWitness,
	providesWitness,
	requiresWitness,
	type ProvidesWitness,
	type RequiresWitness,
	type Witness,
} from './api/witness.ts';
export {
	defineModeNamespace,
	forNetwork,
	type FactoriesByMode,
	type FactoriesFor,
	type ModeNamespace,
} from './api/mode-narrowed-factory.ts';

// --- Contract types plugin authors emit decls of ------------------------

export type { CapabilityDecl } from './contracts/capability-decl.ts';
export type { CodegenableDecl, CodegenEntries, EmittedFor } from './contracts/codegenable.ts';
export type {
	ContainerHandle,
	ContainerRuntime,
	ContainerRuntimeError,
	ImageRef,
} from './contracts/container-runtime.ts';
export { ContainerRuntimeService } from './runtime/docker/service.ts';
export type { CompositePrimitiveDecl } from './contracts/composite-primitive.ts';
export type {
	LifenessClassifierDecl,
	LifenessClassification,
	LifenessHints,
} from './contracts/liveness-classifier.ts';
export type {
	DispatchId,
	RoutableDecl,
	RoutableHttpDecl,
	RoutableTcpDecl,
	RoutableUpstream,
} from './contracts/routable.ts';
export type { ContainerLabelTuple, SnapshotableDecl } from './contracts/snapshotable.ts';
export type { StrategyContributorDecl, StrategyFor } from './contracts/strategy-contributor.ts';

// --- Plugin-instance shape (the universal NodePlugin contract) ----------

export type { AnyNodePlugin, NodePlugin } from './contracts/node-plugin.ts';
export {
	MEMBER_BRAND,
	type AcquireContext,
	type AnyMember,
	type BuildContext,
	type CapabilitiesFactory,
	type MemberBranded,
	type MissingProviders,
	type StackMember,
	type WatchDecl,
	type __MemberNotConsumedError,
} from './substrate/plugin.ts';

// --- Lifecycle + lifted-sibling primitives plugin authors touch ---------

export type {
	LifecycleStatus,
	PhaseNarration,
	PluginKind,
	RebootCost,
} from './substrate/lifecycle.ts';
export {
	litHash,
	litSiblingKey,
	type LitHash,
	type LitSiblingKey,
	type LiftedSiblingKey,
	type SiblingScope,
} from './substrate/lifted-sibling.ts';

// --- Network + options --------------------------------------------------

export type { NetworkConfig, NetworkMode, DefaultNetwork } from './substrate/network.ts';
export type { DevstackOptions, OptionsLike } from './substrate/options.ts';
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
	pluginKey,
	stackName,
	type AppName,
	type Brand,
	type ChainId,
	type ContentHash,
	type EndpointKey,
	type PluginKey,
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
	SuiTag,
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
	type AccountTagId,
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
	packageTagId,
	pickCreatedByType,
	type LocalPackageOptions,
	type KnownPackageOptions,
	type LocalPackageResolved,
	type KnownPackageResolved,
	type PackageResolved,
	type PackageTagId,
	type PackageCapture,
	type PackageCaptureCallback,
	type PackageCaptureMap,
	type PackageCoins,
	type PickCreatedByTypeOptions,
	type PublisherAccountMember,
	type PublishReceipt,
	type PublishObjectChange,
	type PublishError,
	type PackageBindings,
	type ResolvedLocalPackage,
	type ResolvedKnownPackage,
} from './plugins/package/index.ts';

// --- Coin ---------------------------------------------------------------

export {
	coin,
	coinTagId,
	BUILTIN_COINS,
	isBareCoinType,
	validateBareCoinType,
	type CoinTagId,
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
	WalletTag,
	WALLET_ACCOUNTS_ALL,
	type WalletOptions,
	type WalletValue,
	type WalletAccountMember,
	type WalletAccountTags,
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

// --- Postgres -----------------------------------------------------------

export {
	postgres,
	PostgresTag,
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
	type PostgresConnectionTimeout,
	type DatabaseCreateFailed,
	type PostgresPhase,
} from './plugins/postgres/index.ts';

// --- Faucet -------------------------------------------------------------

export {
	faucet,
	FaucetTag,
	FAUCET_DISPATCH_KEY,
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
	actionTagId,
	ActionReceiptSchema,
	signAndExecute,
	type ActionTagId,
	type ActionOptions,
	type ActionUpstreamMember,
	type ActionBuildContext,
	type ActionError,
	type ActionPhase,
	type ActionLifecyclePhase,
	type DynamicDiscriminator,
	type StaticDiscriminator,
	type ActionReceipt,
	type ActionObjectChange,
} from './plugins/action/index.ts';

// --- Walrus -------------------------------------------------------------

export {
	walrus,
	walrusFor,
	WalrusTag,
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
	makeSealTag,
	sealTagId,
	type SealOptions,
	type SealCommonOptions,
	type SealLocalKeygenOptions,
	type SealLiveOptions,
	type SealForkKnownOptions,
	type SealKeyServer,
	type SealKeyServerEntry,
	type SealLocalKeygenResolved,
	type SealKnownResolved,
	type SealTagId,
	type SealResolved,
	type SealKeyManager,
	type SealError,
	type SealAnyError,
	type SealAcquireError,
	type SealBindings,
} from './plugins/seal/index.ts';

// --- Deepbook -----------------------------------------------------------

export {
	deepbook,
	deepbookFor,
	type DeepbookTagId,
	type DeepbookResolved,
	type DeepbookCommonOptions,
	type DeepbookLocalOptions,
	type DeepbookKnownOptions,
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
