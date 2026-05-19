// `@mysten-incubation/devstack` — public barrel.
//
// Two pillars surface here:
//
// 1. **`devstack(...refs)`** — the canonical entry. Variadic over LayeredTags;
//    auto-fills default providers (`Sui()` when missing); writes the
//    manifest sidecar. Returns a runnable handle with `run()`, `runMain()`,
//    and `layer` for Effect-native consumers.
// 2. **LayeredTag factories** — `Sui`, `Seal`, `Walrus`, `Deepbook`,
//    `DeepbookMarketMaker`, `Account`, `Package`, `Action`, `Dev`,
//    `Wallet`, `Codegen`. Each returns a typed LayeredTag usable as a
//    cross-reference in other factories and yieldable inside Effects.
//
// Plus the `Manifest` schema types — the on-disk
// `.devstack/manifest.json` shape every consumer reads. Browser-side
// readers parse the JSON directly; codegen bakes values as literals.
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
// `Sui`, `Account`, `Package`, `DeepbookMarketMaker` re-export
// both the factory function (value) and the shape (type) under the same
// name; TS's separate type/value namespaces lets them coexist.
//
// `Faucet` is auto-mounted by `devstack(...)`; users no longer call it
// explicitly. Plugin authors writing custom faucet strategies reach for
// it (along with the strategy primitives) via `/advanced`.
export {
	Sui,
	type SuiOptions,
	Seal,
	type SealOptions,
	Walrus,
	type WalrusOptions,
	localnetWalrusOptions,
	type LocalnetWalrusOptions,
	type LocalnetWalrusInputs,
	Deepbook,
	DeepbookMarketMaker,
	type DeepbookOptions,
	Account,
	Package,
	type PackageOptions,
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
	type LayeredTag,
	Postgres,
	type PostgresOptions,
	PostgresTag,
	Pyth,
	type PythOptions,
	PythTag,
	PythPusher,
	SUI_PRICE_FEED_ID,
	DEEP_PRICE_FEED_ID,
	USDC_PRICE_FEED_ID,
} from './services/index.js';
// Deepbook surface — exposed from the root barrel so the reference
// example app (`examples/deepbook-full`) can `import
// { DeepbookMargin, DeepbookIndexer, DeepbookServer, VendorDeepbook, ... }`
// without dipping into `/services`.
export {
	DeepbookMargin,
	DeepbookIndexer,
	DeepbookServer,
	DeepbookMintDEEP,
	DeepbookMintUSDC,
	VendorDeepbook,
} from './services/deepbook.js';
export {
	USDC_MARGIN_DEFAULTS,
	SUI_MARGIN_DEFAULTS,
	DEFAULT_POOL_RISK_CONFIG,
} from './services/deepbook.js';

// ── Manifest schema types ──
// The on-disk `.devstack/manifest.json` shape every consumer reads.
// Browser-side readers parse the JSON directly; codegen bakes values as
// literals at build time, so non-Effect runtime callers don't need a
// loader helper. Effect-native producers (the supervisor, codegen
// emitters) use `gatherManifest()` on `/advanced` for the in-Effect
// snapshot.
//
// Wire-level HTTP path contract for the wallet-app server. Re-exported
// for sibling packages (notably `@mysten-incubation/dev-wallet`) that
// need to read these paths back to construct fetch URLs against a
// running devstack.
export { WalletHttpPath, type WalletHttpPathValue } from './services/wallet/protocol.js';
export type {
	Manifest,
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
// Coin handles: `Coin('SYMBOL')` (registry lookup), `Coin.fromPackage(pkg,
// 'WITNESS')` (per-package), `Coin('0x...::T')` (bare on-chain coin type,
// for live-net), `Coin.builtin('sui')` (canonical builtin). Coin
// auto-discovery in `Package(...)` populates the registry directly, so
// the user only needs a yieldable handle to address the discovered coin.
export {
	Coin,
	type CoinFactory,
	type CoinValue,
	type BuiltinCoinName,
	CoinNotFoundError,
	CoinAmbiguousError,
} from './services/coin.js';
// Object-id pickers (`pickCreatedByType(changes, {suffix|includes|prefix})`)
// live on `/advanced` — plugin-author surface for `Action.build`
// callbacks that project from `result.objectChanges`. User configs reach
// for `Package(...)`'s coin auto-discovery and `PackageWithCapture` on
// `/advanced` for declarative captures; the picker is the escape hatch
// for the programmatic form.

// ── Tagged error types ──
// Surfaced for `catchTag`-style handling in custom Action build
// callbacks and Effect-native consumers.
export {
	AccountError,
	ConfigLoadError,
	DeepbookError,
	DockerError,
	HostProcessError,
	ManifestDiscoveryError,
	ManifestError,
	ManifestShapeError,
	PublishError,
	SealError,
	SuiError,
	WalletAppError,
	WalrusError,
} from './engine/errors.js';
export { CodegenError } from './codegen/errors.js';
export { FaucetRequestError } from './services/faucet/index.js';

// ── Interface tag classes ──
// Canonical Context.Service tag for the seal key server — the only
// interface tag with an example consumer (`examples/private-content`).
// Other interface tags (`CoinTag`, `WalrusNetworkTag`, `WalrusNodesTag`,
// `WalrusProxyTag`, `DeepbookCoreTag`) live under `/advanced` — they're
// plugin-author surface rather than typical app-config reach.
//
// Admin-side tags (`WalrusAdminTag`, `SealKeyManagerTag`,
// `DeepbookAdminTag`) likewise live under `/advanced` — those are
// privileged operations the high-level factories don't surface.
export { SealKeyServerTag, type SealKeyServer } from './services/index.js';

// `TagIdentity<Name>` is the per-name structural Service type LayeredTags
// carry on their `R` channel. Re-exported so consumers of yielded LayeredTags
// get nameable inferred types — without it, `tsc --declaration`
// (composite projects, the example apps' typecheck mode) trips TS2742.
export type { TagIdentity } from './advanced/tag.js';
