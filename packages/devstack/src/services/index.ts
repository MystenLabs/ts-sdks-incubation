// `@mysten-incubation/devstack/services` — INTERNAL barrel. Consumed by
// the root `src/index.ts` and by `src/advanced/index.ts`; not a public
// subpath itself. Holds the factory surface (LayeredTag-producing functions),
// the canonical interface tag classes, and the shape/Schema types each
// factory ships.
//
// Codegen emitters (BindingsEmitter, …) and faucet strategies
// (suiHttpStrategy, FaucetRequestError, …) deliberately
// live ONLY on `/advanced` — they're plugin-author surface, not part of
// the high-level LayeredTag-factory pillar this barrel curates. The advanced
// barrel imports them directly from `../codegen/...` / `../faucet/...`,
// so re-exporting them here would duplicate without adding reach.
//
// Naming rule:
//   - Factories take the plain noun (`Sui`, `Account`, `Package`, …).
//   - `<Name>Tag` (PascalCase class) — a bare `Context.Service` class.
//     Singleton services declare these (e.g., `SuiTag`, `FaucetTag`,
//     `PackageTag`, `CoinTag`). The underlying Context key
//     (`'@devstack/<Tag>'`) is the runtime identity. Effect-native pattern.
//   - `LayeredTag<Name, A, R, E>` (from `'../advanced/tag.js'`) — the
//     user-facing yieldable bundle every factory returns. Composition of
//     Tag + bundled Layer + UI metadata (`__kind`, `__displayTitle`,
//     `__watchPaths`, brand symbol). Yield it inside an Effect to get the
//     resolved shape; pass it as `signer`/`needs`/etc. to compose stacks.
//   - Shape types take the plain noun (`Sui`, `Account`, `Coin`,
//     `WalrusNetwork`, …). Where a factory shares the same noun, the
//     type and value coexist via TS's separate type/value namespaces.
//   - No alias for a factory's return type — reach for
//     `ReturnType<typeof Factory>` if you need to spell it.

// ── Factories ──
export { Sui, type SuiOptions, SuiTag } from './sui.js';
export {
	Seal,
	type SealOptions,
	type SealKeyServerEntry,
	type SealKeyServer,
	SealKeyServerTag,
	type SealKeyManager,
	SealKeyManagerTag,
} from './seal.js';
export {
	Walrus,
	type WalrusOptions,
	type WalrusNetwork,
	WalrusNetworkTag,
	type WalrusNodeInfo,
	type WalrusNodes,
	WalrusNodesTag,
	type WalrusProxy,
	WalrusProxyTag,
	type WalrusAdmin,
	WalrusAdminTag,
} from './walrus.js';
export {
	Deepbook,
	DeepbookMarketMaker,
	type DeepbookOptions,
	type DeepbookPoolRef,
	type DeepbookCore,
	DeepbookCoreTag,
	type DeepbookAdmin,
	DeepbookAdminTag,
	DeepbookMarketMakerTag,
} from './deepbook.js';
export { Account } from './account.js';
export {
	Package,
	type PackageOptions,
	PackageTag,
	type LocalPackage,
	LocalPackageTag,
	type Coin,
	CoinTag,
	toSdkCoin,
} from './package.js';
export {
	Pyth,
	PythTag,
	PythPusher,
	pythMid,
	SUI_PRICE_FEED_ID,
	DEEP_PRICE_FEED_ID,
	USDC_PRICE_FEED_ID,
} from './pyth.js';
export {
	Postgres,
	PostgresTag,
	type PostgresOptions,
	type Postgres as PostgresShape,
} from './postgres.js';
export type {
	PythOptions,
	PythShape,
	PythPriceInfo,
	PythMid,
	PythMidOptions,
	PythMidScale,
	PythPusherHandle,
	PythPusherOptions,
	PythPusherSource,
	PythPriceFeedId,
	PythPriceInfoSpec,
	PythPriceUpdate,
	PythLocalDeployOptions,
	PythLocalDeployFeedSpec,
	PythKnownPackageOptions,
} from './pyth.js';
export { Action, type ActionOptions } from './action.js';
export { Dev, type DevOptions } from './dev.js';
export { Wallet, type WalletOptions } from './wallet.js';
export { Codegen, type CodegenOptions, DEFAULT_CODEGEN_OUTPUT } from './codegen.js';
export { KnownPackage, type KnownPackageOptions } from './known-package.js';
export { Faucet, type FaucetOptions, FaucetTag } from './faucet/index.js';
export { type LayeredTag } from '../advanced/tag.js';
