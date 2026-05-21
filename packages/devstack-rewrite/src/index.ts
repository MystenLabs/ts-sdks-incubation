// Public API surface for `@mysten-incubation/devstack-rewrite`.
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
export { chainProbeFor } from './substrate/runtime/strategy-registry/index.ts';
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
export { ContainerRuntimeService } from './runtime/docker/index.ts';
export { IdentityContext } from './substrate/runtime/paths.ts';
export {
	MEMBER_BRAND,
	type AcquireContext,
	type AnyMember,
	type BuildContext,
	type CapabilitiesFactory,
	type MemberBranded,
	type MissingProviders,
	type PluginErrorContribution,
	type StackMember,
	type WatchDecl,
	type __MemberNotConsumedError,
} from './substrate/plugin.ts';

// --- Lifecycle + lifted-sibling primitives plugin authors touch ---------

export type {
	LifecycleFact,
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
	chainProbeCapabilityKey,
	FUNDS_READY_GATE_KEY,
	SEED_OBJECTS_CAPABILITY_KEY,
	FORK_UNSUPPORTED_SURFACES,
	wrapWithForkGuard,
	SUI_ERROR_TAGS,
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
	type ForkLockHolder,
	type SuiProbeKey,
} from './plugins/sui/index.ts';

// --- Account ------------------------------------------------------------

export {
	account,
	ACCOUNT_ERROR_TAGS,
	DEFAULT_EPHEMERAL_FUND_MIST,
	SUI_FULL_COIN_TYPE,
	accountRegistryKey,
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
	type FundingCoinTags,
	type ProjectedFunding,
	type ProjectedFundingEntry,
	type AccountBindings,
	type AccountRegistryEntry,
	type AccountRegistryKey,
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
	PACKAGE_ERROR_TAGS,
	type LocalPackageOptions,
	type KnownPackageOptions,
	type LocalPackageResolved,
	type KnownPackageResolved,
	type PackageResolved,
	type PackageTagId,
	type PublisherAccountMember,
	type PublishReceipt,
	type PublishObjectChange,
	type PublishError,
	type PackageBindings,
	type PublishExecutor,
	type ResolvedLocalPackage,
	type ResolvedKnownPackage,
} from './plugins/package/index.ts';

// --- Coin ---------------------------------------------------------------

export {
	coin,
	coinTagId,
	BUILTIN_COINS,
	COIN_REGISTRY_CAPABILITY_KEY,
	CoinRegistryService,
	coinRegistryLayer,
	discoverCoinsFromPublish,
	OnchainCoinMetadataShape,
	METADATA_FETCH_TIMEOUT_MS,
	METADATA_RETRY_SCHEDULE,
	fetchCoinMetadataOnce,
	fetchCoinMetadataMany,
	makeCoinMetadataCache,
	isBareCoinType,
	validateBareCoinType,
	performMint,
	MintedCoinVerifyShape,
	mintTxError,
	mintParseError,
	coinError,
	COIN_ERROR_TAGS,
	SYMBOL_FORM_NO_DEP_EDGE_WARNING,
	type CoinTagId,
	type CoinValue,
	type CoinAddressForm,
	type ResolvedCoin,
	type BuiltinCoinName,
	type CoinRecord,
	type CoinRegistry,
	type CoinKey,
	type CoinBindings,
	type DiscoveredCoin,
	type MetadataSdkShim,
	type OnchainCoinMetadata,
	type CoinMetadataCache,
	type MintInputs,
	type MintResult,
	type MintSigner,
	type MintSdkShim,
	type CachedMint,
	type PackageMember,
	type CoinError,
	type CoinPhase,
} from './plugins/coin/index.ts';

// --- Wallet -------------------------------------------------------------

export {
	wallet,
	WalletTag,
	WALLET_ACCOUNTS_ALL,
	WalletHttpPath,
	WALLET_PROTOCOL_PREFIX,
	WALLET_AUTH_HEADER,
	WALLET_BEARER_PREFIX,
	WALLET_TOKEN_FRAGMENT_KEY,
	WALLET_TOKEN_HEX_LENGTH,
	SignRequestSchema,
	SignResponseSchema,
	ExecuteRequestSchema,
	ExecuteResponseSchema,
	HealthResponseSchema,
	AccountsResponseSchema,
	AccountSummarySchema,
	ErrorResponseSchema,
	SuiAddressSchema,
	Base64Schema,
	SignatureSchemeSchema,
	AccountSourceSchema,
	WALLET_ERROR_TAGS,
	resolveOriginPolicy,
	checkOrigin,
	corsHeadersFor,
	mintToken,
	acquirePairingToken,
	tokenPath,
	composePairUrl,
	parsePairUrl,
	parseBearerHeader,
	safeBearerEquals,
	redactToken,
	WALLET_ENDPOINT_NAME,
	makeWalletRoutable,
	dispatch,
	startHttpServer,
	MAX_BODY_BYTES,
	makeWalletCodegen,
	type WalletOptions,
	type WalletValue,
	type WalletAccountMember,
	type WalletAccountTags,
	type WalletAccountsAll,
	type DappKitConfigBindings,
	type WalletHttpPathValue,
	type SignRequest,
	type SignResponse,
	type ExecuteRequest,
	type ExecuteResponse,
	type HealthResponse,
	type AccountsResponse,
	type AccountSummary,
	type ErrorResponse,
	type WalletError,
	type WalletBootError,
	type WalletBootPhase,
	type WalletRequestError,
	type WalletRequestPhase,
	type OriginPolicy,
	type OriginPolicyInputs,
	type OriginCheckResult,
	type PairingToken,
	type WalletRequest,
	type WalletResponse,
	type WalletServerConfig,
	type WalletServerHandle,
} from './plugins/wallet/index.ts';

// --- Postgres -----------------------------------------------------------

export {
	postgres,
	PostgresTag,
	POSTGRES_TCP_ENDPOINT_NAME,
	POSTGRES_ERROR_TAGS,
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
	type PostgresIdentityPayload,
} from './plugins/postgres/index.ts';

// --- Faucet -------------------------------------------------------------

export {
	faucet,
	FaucetTag,
	FAUCET_DISPATCH_KEY,
	FAUCET_CAPABILITY_KEY_PREFIX,
	faucetCapabilityKey,
	defineFaucetStrategy,
	FAUCET_ERROR_TAGS,
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
	ACTION_ERROR_TAGS,
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
	WALRUS_ERROR_TAGS,
	WAL_FAUCET_STRATEGY_KEY,
	WALRUS_STATE_REGISTRY_KEY,
	WALRUS_ROUTER_PORT,
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
	type WalSwapError,
	type WalrusStateEntry,
	type WalrusLocalStateEntry,
	type WalrusKnownStateEntry,
} from './plugins/walrus/index.ts';

// --- Seal ---------------------------------------------------------------

export {
	seal,
	sealFor,
	sealLocalKeygenStrict,
	makeSealTag,
	makeSealManagerTag,
	sealTagId,
	sealManagerTagId,
	SEAL_ERROR_TAGS,
	sealCargoImageKey,
	sealSourceFetchKey,
	DEFAULT_SEAL_REPO,
	DEFAULT_SEAL_VERSION,
	DEFAULT_SEAL_MOVE_SUBDIR,
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
	type SealManagerTagId,
	type SealKeyManager,
	type SealError,
	type SealAnyError,
	type SealAcquireError,
	type SealBindings,
	type SealCargoImageKey,
	type SealCargoImageResolved,
	type SealSourceFetchKey,
	type SealSourceFetchResolved,
} from './plugins/seal/index.ts';

// --- Deepbook -----------------------------------------------------------

export {
	deepbook,
	deepbookFor,
	deepbookPluginKey,
	DEEPBOOK_ERROR_TAGS,
	DEEP_PRICE_FEED_ID,
	DEFAULT_POOL_RISK_CONFIG,
	pythPriceFeedId,
	SUI_MARGIN_DEFAULTS,
	SUI_PRICE_FEED_ID,
	USDC_MARGIN_DEFAULTS,
	USDC_PRICE_FEED_ID,
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
	type DeepbookMarginAssetConfig,
	type DeepbookMarginOptions,
	type DeepbookMarginPoolRegistration,
	type DeepbookMarginPoolRiskConfig,
	type DeepbookMarketMakerOptions,
	type DeepbookMarketMakerStrategy,
	type DeepbookPool,
	type DeepbookPoolSpec,
	type PackageMemberAlias,
	type PythFeed,
	type PythHandle,
	type PythOptions,
	type PythPriceFeedId,
} from './plugins/deepbook/index.ts';
