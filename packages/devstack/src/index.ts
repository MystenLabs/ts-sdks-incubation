// `@mysten-incubation/devstack` — public barrel.
//
// Three pillars surface here:
//
// 1. **`devstack(...refs)`** — the canonical entry. Variadic over LayeredTags;
//    auto-fills default providers (`Sui()` when missing); writes the
//    manifest sidecar. Returns a runnable handle with `run()`, `runMain()`,
//    and `layer` for Effect-native consumers.
// 2. **LayeredTag factories** — `Sui`, `Seal`, `Walrus`, `Deepbook`,
//    `DeepbookMarketMaker`, `Account`, `Package`, `Action`, `Dev`,
//    `Wallet`, `Codegen`. Each returns a typed LayeredTag usable as a
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
// `DevstackHandle` is the run-handle `devstack(...)` returns. Re-exported
// so the inferred type of `export default devstack(...)` is nameable
// without dipping into the engine subpath.
export type { DevstackHandle } from './engine/supervisor.js';

// ── LayeredTag factories ──
// `Sui`, `Account`, `Package`, `DeepbookMarketMaker`, `Faucet` re-export
// both the factory function (value) and the shape (type) under the same
// name; TS's separate type/value namespaces lets them coexist.
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
	Codegen,
	type CodegenOptions,
	DEFAULT_CODEGEN_OUTPUT,
	KnownPackage,
	type KnownPackageOptions,
	Faucet,
	type FaucetOptions,
	FaucetTag,
	type LayeredTag,
} from './services/index.js';

// ── Runtime accessor ──
export { Devstack, DevstackLive } from './runtime/service.js';
// Wire-level HTTP path contract for the wallet-app server. Re-exported
// for sibling packages (notably `@mysten-incubation/dev-wallet`) that
// need to read these paths back to construct fetch URLs against a
// running devstack.
export { WalletHttpPath, type WalletHttpPathValue } from './services/wallet/protocol.js';
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
// published package or want a separate LayeredTag to compose against.
export {
	registerCoin,
	type RegisterCoinOptions,
	type RegisterCoinResult,
} from './services/coin.js';
// Object-id pickers for `Action.build` callbacks that project from
// `result.objectChanges`. Most uses are subsumed by `Package`'s
// declarative `capture:` field; these stay for advanced callbacks that
// need the full programmatic form.
export { pickCreatedByTypeIncludes, pickCreatedByTypeSuffix } from './engine/sui-helpers.js';
// Canonical deployment registry per-network sub-shapes. The
// `knownDeployments` value + `KnownDeployments` / `KnownNetwork` types
// it's indexed by live under `/advanced` — that's plugin-author surface
// for custom factories that need to default the `network:` shape. The
// per-service deployment record types stay here so app code can spell
// out `override:` literals against them without reaching into `/advanced`.
export type {
	DeepbookDeployment,
	SealDeployment,
	WalrusDeployment,
} from './engine/known-deployments.js';

// ── Tagged error types ──
// Surfaced for `catchTag`-style handling in custom Action build
// callbacks and Effect-native consumers.
export {
	AccountError,
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
export { CodegenError } from './codegen/errors.js';
export { FaucetRequestError } from './services/faucet/index.js';

// ── Shared utility types ──
// `Transaction` is `@mysten/sui/transactions`'s builder — re-exported
// for convenience so `Action.build` callbacks don't need a separate
// dep import. `SuiObjectChange` is the shape `Action`'s
// `expose:`/`capture:` callbacks consume.
export type {
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
// wants the narrow contract shape rather than the composite LayeredTag shape
// (e.g. `yield* SealKeyServerTag` for just the key-server URL + object id,
// vs `yield* seal` for the full composite). Rare in user configs; most
// of the time you yield the local LayeredTag instead.
//
// Admin-side tags (`WalrusAdminTag`, `SealKeyManagerTag`,
// `DeepbookAdminTag`) live under `/advanced` — those are privileged
// operations the high-level factories don't surface.
export {
	CoinTag,
	type Coin,
	WalrusNetworkTag,
	type WalrusNetwork,
	WalrusNodesTag,
	type WalrusNodes,
	WalrusProxyTag,
	type WalrusProxy,
	SealKeyServerTag,
	type SealKeyServer,
	DeepbookCoreTag,
	type DeepbookCore,
} from './services/index.js';

// `TagIdentity<Name>` is the per-name structural Service type LayeredTags
// carry on their `R` channel. Re-exported so consumers of yielded LayeredTags
// get nameable inferred types — without it, `tsc --declaration`
// (composite projects, the example apps' typecheck mode) trips TS2742.
export type { TagIdentity } from './advanced/tag.js';
