// Public library API for `@mysten-incubation/devstack` — the authoring
// surface only. Apps + plugin authors import `definePlugin`, action
// factories, built-in plugins, signer factories, and the public types
// from here. Runtime internals (Reconciler, Supervisor, manifest I/O)
// live on `./runtime`; CLI handlers on `./cli`; helpers (publish, import,
// upstream-source images, sui-client constructor) on `./helpers`; the
// React adapter on `./react`. Vite + Vitest + Playwright integrations
// stay on their own subpaths as before.

// ─── Public types ─────────────────────────────────────────────────────────

export type {
	Account,
	AccountFactory,
	AccountFactoryContext,
	AccountSpec,
	AccountsConfig,
	AccountsContext,
	Action,
	ActionBase,
	ActionFilter,
	ActionRunContext,
	ActionStatus,
	ActionType,
	BuildAction,
	DevstackConfig,
	EmitAction,
	HostProcessAction,
	LiveNetActionRunContext,
	LocalnetActionRunContext,
	Network,
	NetworkConfig,
	Package,
	Plugin,
	Provides,
	ProvidesObject,
	PublishAction,
	RegisterAction,
	Registry,
	RegistryQuery,
	ResolvedTarget,
	SeedAction,
	Service,
	ServiceAction,
	SetupActionScope,
	ShutdownHook,
	SnapshotMeta,
	TestConfig,
	Token,
	VerifyAction,
} from './core/types.js';
export {
	getProvidedCapabilities,
	getProvidesRegistryHook,
	requireLocalnetCtx,
} from './core/types.js';
export type {
	Manifest,
	SerializedActionState,
	SerializedRegistry,
} from './runtime/manifest-types.js';

// ─── Authoring helpers ────────────────────────────────────────────────────

export { defineDevstackConfig, definePlugin, expandPluginActions } from './plugin.js';
export { defineRegistryKind } from './registry/index.js';
export { coinTokens } from './coin.js';

// ─── Action factories ─────────────────────────────────────────────────────

export { buildImage } from './actions/build.js';
export { service } from './actions/service.js';
export { containerService } from './actions/container-service.js';
export { hostProcess } from './actions/host-process.js';
export { verify } from './actions/verify.js';
export {
	publish,
	type PublishOptions,
	type PublishInputs,
} from './actions/publish.js';
export { publishMove, type PublishMoveOptions } from './actions/publish-move.js';
export { register } from './actions/register.js';
export { seed, seedRunsOn } from './actions/seed.js';
export { runTransaction, type RunTransactionOptions } from './actions/transaction.js';
export { emit } from './actions/emit.js';
export {
	mintCoinDistribution,
	type CoinDistributionEntry,
	type CoinDistributionSpec,
	type MintCoinDistributionOptions,
} from './actions/mint-coin-distribution.js';

// ─── Signer factories ─────────────────────────────────────────────────────

export {
	cliSigner,
	envSigner,
	generatedKeypair,
	type CliSignerOptions,
	type EnvSignerOptions,
} from './helpers/signers.js';

// ─── Built-in plugins ─────────────────────────────────────────────────────

export { accounts, type AccountsPluginOptions } from './plugins/accounts/index.js';
export { sui, SUI_DEFAULT_VERSION, type SuiPluginOptions } from './plugins/sui/index.js';
export {
	walrus,
	type WalrusNamespace,
	type WalrusNode,
	type WalrusPluginOptions,
} from './plugins/walrus/index.js';
export { WALRUS_REV } from './plugins/walrus/build.js';
export {
	seal,
	type SealKeyServer,
	type SealNamespace,
	type SealPluginOptions,
} from './plugins/seal/index.js';
export { SEAL_REV } from './plugins/seal/build.js';
export { codegen, defaultMvrName, type CodegenPluginOptions } from './plugins/codegen/index.js';
export {
	deepbook,
	deepbookNs,
	buildDeepbookSwapTx,
	resolveCoinType,
	SUI_COIN_TYPE,
	type BuildSwapTxOptions,
	type DeepbookMarketMakerSpec,
	type DeepbookNamespace,
	type DeepbookPluginOptions,
	type DeepbookPool,
	type DeepbookPoolSpec,
} from './plugins/deepbook/index.js';
export {
	imports,
	withRecursiveDeps,
	type ImportSpec,
	type ImportsPluginOptions,
} from './plugins/imports/index.js';
export { frontend, type FrontendPluginOptions } from './plugins/frontend/index.js';
export {
	walletServer,
	WALLET_SERVER_DEFAULT_PORT,
	type WalletServerPluginOptions,
} from './plugins/wallet-server/index.js';
