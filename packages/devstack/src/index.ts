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
	AccountNetworkSpec,
	AccountSpec,
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
	ShutdownHook,
	TestConfig,
	Token,
	VerifyAction,
} from './core/types.js';
export {
	getProvidedCapabilities,
	getProvidesRegistryHook,
	requireLocalnetCtx,
} from './core/types.js';

// ─── Authoring helpers ────────────────────────────────────────────────────

export { defineDevstackConfig, definePlugin, expandPluginActions } from './plugin.js';

// ─── Action factories ─────────────────────────────────────────────────────

export { buildImage } from './actions/build.js';
export { service } from './actions/service.js';
export { containerService } from './actions/container-service.js';
export { hostProcess } from './actions/host-process.js';
export { job } from './actions/job.js';
export { verify } from './actions/verify.js';
export {
	publish,
	definePublishAction,
	type DefinePublishActionOptions,
} from './actions/publish.js';
export { register } from './actions/register.js';
export { seed, seedRunsOn } from './actions/seed.js';
export { emit } from './actions/emit.js';

// ─── Signer factories ─────────────────────────────────────────────────────

export {
	cliSigner,
	envSigner,
	generatedKeypair,
	type CliSignerOptions,
	type EnvSignerOptions,
} from './helpers/signers.js';

// ─── Built-in plugins ─────────────────────────────────────────────────────

export {
	sui,
	suiContainerName,
	appNetworkName,
	SUI_DEFAULT_VERSION,
	type SuiPluginOptions,
} from './plugins/sui/index.js';
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
export { codegen, type CodegenPluginOptions } from './plugins/codegen/index.js';
export {
	imports,
	withRecursiveDeps,
	type ImportSpec,
	type ImportsPluginOptions,
} from './plugins/imports/index.js';
export { frontend, type FrontendPluginOptions } from './plugins/vite/index.js';
export {
	walletServer,
	WALLET_SERVER_DEFAULT_PORT,
	type WalletServerPluginOptions,
} from './plugins/wallet-server/index.js';
