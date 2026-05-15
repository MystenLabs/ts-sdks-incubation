// `@mysten-incubation/devstack` — public barrel.
//
// Three pillars surface here:
//
// 1. **`devstack(...refs)`** — the canonical entry. Variadic over Refs;
//    auto-fills default providers (`Sui()` when missing); writes the
//    manifest sidecar. Returns a runnable handle with `run()`, `runMain()`,
//    and `layer` for Effect-native consumers.
// 2. **Ref factories** — `Sui`, `Seal`, `Walrus`, `Deepbook`,
//    `DeepbookMarketMaker`, `Account`, `Package`, `Action`, `Dev`,
//    `Wallet`, `Bindings`. Each returns a typed Ref usable as a
//    cross-reference in other factories and yieldable inside Effects.
// 3. **Runtime accessors** — `Devstack` Effect Service for in-Effect
//    reads, `fromManifest` for browser / non-Effect consumers, plus the
//    full v4 `Manifest` schema types.
//
// Escape hatches for plugin authors live under `@mysten-incubation/devstack/advanced`.

// ── Compose entry ──
export {
	devstack,
	type DevstackComposeOptions,
	type DevstackRefInput,
} from './compose/devstack.js';

// ── Ref factories ──
export {
	Sui,
	type SuiOptions,
	Seal,
	type SealOptions,
	Walrus,
	type WalrusOptions,
	Deepbook,
	DeepbookMarketMaker,
	type DeepbookOptions,
	Account,
	Package,
	type PackageOptions,
	type CaptureSpec,
	Action,
	type ActionOptions,
	Dev,
	type DevOptions,
	Wallet,
	type WalletOptions,
	Bindings,
	type BindingsRefOptions,
	Codegen,
	type CodegenOptions,
	KnownPackage,
	type KnownPackageOptions,
	Faucet,
	type FaucetOptions,
	FaucetTag,
	type FaucetStrategy,
	type FaucetShape,
	suiHttpStrategy,
	defineStrategy,
	FaucetRequestError,
	defineEmitter,
	type Emitter,
	type CodegenContext,
	type CodegenPackage,
	BindingsEmitter,
	type BindingsEmitterOptions,
	CodegenError,
	type Ref,
	type AccountRef,
	type PackageRef,
} from './services/index.js';

// ── Runtime accessor ──
export { Devstack, DevstackLive, gatherManifest } from './runtime/service.js';
export { fromManifest } from './runtime/manifest-loader.js';
export type {
	Manifest,
	ManifestEncoded,
	AccountEntry,
	AppManifest,
	CoinEntry,
	DeepbookManifest,
	DeepbookPoolEntry,
	EndpointEntry,
	PackageEntry,
	SealManifest,
	SdkCoinEntry,
	ServicesManifest,
	StackIdentity,
	SuiManifest,
	WalrusManifest,
} from './runtime/manifest-schema.js';

// ── Helpers users routinely reach for ──
// Coin registration: passes a published `Package` ref + module/type
// into the CoinRegistry so deepbook pools (and other consumers that
// need a runtime-resolved coin type) can reference it by ref. The new
// `Package({ coins })` field auto-registers in the common case; reach
// for `registerCoin` when you need to register a coin from an already-
// published package or want a separate Ref to compose against.
export {
	registerCoin,
	type RegisterCoinOptions,
	type RegisterCoinResult,
} from './services/coin.js';
// Object-id pickers for `Action.build` callbacks that project from
// `result.objectChanges`. Most uses are subsumed by `Package`'s
// declarative `capture:` field; these stay for advanced callbacks that
// need the full programmatic form.
export {
	pickCreatedByTypeIncludes,
	pickCreatedByTypeSuffix,
} from './engine/sui-helpers.js';
// Known-network deployment registry (testnet seal/walrus/deepbook
// packages). Useful for hand-rolled `Seal({ mode: 'known' })` configs.
export {
	knownDeployments,
	type DeepbookDeployment,
	type KnownDeployments,
	type KnownNetwork,
	type SealDeployment,
	type WalrusDeployment,
} from './engine/known-deployments.js';

// ── Tagged error types ──
// Surfaced for `catchTag`-style handling in custom Action build
// callbacks and Effect-native consumers.
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
} from './engine/errors.js';

// ── Shared utility types ──
// `Transaction` is `@mysten/sui/transactions`'s builder — re-exported
// for convenience so `Action.build` callbacks don't need a separate
// dep import. `SuiObjectChange` is the shape `Action`'s
// `expose:`/`capture:` callbacks consume. The others are the per-call
// shapes returned by yielding the corresponding Ref inside an Effect.
export type {
	Account as AccountShape,
	SignAndExecuteError,
	SignAndExecuteOptions,
	SuiObjectChange,
	SuiTransactionBlockResponse,
	Transaction,
	TxResult,
} from './engine/shared.js';

// ── Interface tag classes ──
// Canonical Context.Service tags every factory's underlying Layer
// targets. Used inside `Action.build`/`extras` callbacks when the user
// wants the narrow contract shape rather than the composite Ref shape
// (e.g. `yield* SealKeyServer` for just the key-server URL + object id,
// vs `yield* seal` for the full composite). Rare in user configs; most
// of the time you yield the local Ref instead.
export {
	type SuiShape,
	type PackageShape,
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
	type DeepbookMarketMakerShape,
} from './services/index.js';

// `TagIdentity<Name>` is the per-name structural Service type Refs
// carry on their `R` channel. Re-exported so consumers of yielded Refs
// get nameable inferred types — without it, `tsc --declaration`
// (composite projects, the example apps' typecheck mode) trips TS2742.
export type { TagIdentity } from './advanced/tag.js';
