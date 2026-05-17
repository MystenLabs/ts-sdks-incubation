// `@mysten-incubation/devstack/services` — INTERNAL barrel. Consumed by
// the root `src/index.ts` and by `src/advanced/index.ts`; not a public
// subpath itself. Holds the factory surface (Ref-producing functions),
// the canonical interface tag classes, and the shape/Schema types each
// factory ships.
//
// Codegen emitters (BindingsEmitter, …) and faucet strategies
// (suiHttpStrategy, defineStrategy, FaucetRequestError, …) deliberately
// live ONLY on `/advanced` — they're plugin-author surface, not part of
// the high-level Ref-factory pillar this barrel curates. The advanced
// barrel imports them directly from `../codegen/...` / `../faucet/...`,
// so re-exporting them here would duplicate without adding reach.
//
// Naming rule:
//   - Factories take the plain noun (`Sui`, `Account`, `Package`, …).
//   - Context.Service tag classes carry a `Tag` suffix (`SuiTag`,
//     `AccountTag`, `PackageTag`, `CoinTag`, …). The underlying Context
//     key (`'@devstack/<Tag>'`) is the runtime identity.
//   - Shape types take the plain noun (`Sui`, `Account`, `Coin`,
//     `WalrusNetwork`, …). Where a factory shares the same noun, the
//     type and value coexist via TS's separate type/value namespaces.

// ── Factories ──
export { Sui, type SuiOptions, SuiTag, EndpointSchema, SuiSchema } from './sui.js';
export {
	Seal,
	type SealOptions,
	type SealKeyServerEntry,
	type SealKeyServer,
	SealKeyServerTag,
	type SealKeyManager,
	SealKeyManagerTag,
	SealKeyServerEntrySchema,
	SealKeyServerSchema,
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
	WalrusNetworkSchema,
	WalrusNodeInfoSchema,
	WalrusNodesSchema,
	WalrusProxySchema,
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
	DeepbookPoolRefSchema,
} from './deepbook.js';
export { Account, type AccountTag, AccountSchema } from './account.js';
export {
	Package,
	type PackageOptions,
	type CaptureSpec,
	PackageTag,
	type LocalPackage,
	LocalPackageTag,
	PackageSchema,
	LocalPackageSchema,
	type Coin,
	CoinTag,
	toSdkCoin,
	CoinSchema,
} from './package.js';
export { Action, type ActionOptions } from './action.js';
export { Dev, type DevOptions } from './dev.js';
export { Wallet, type WalletOptions } from './wallet.js';
export { Codegen, type CodegenOptions, DEFAULT_CODEGEN_OUTPUT } from './codegen.js';
export { KnownPackage, type KnownPackageOptions } from './known-package.js';
export { Faucet, type FaucetOptions } from '../faucet/factory.js';
export { FaucetTag } from '../faucet/service.js';
export { type AccountRef, type PackageRef } from './ref.js';
export { type Ref } from '../advanced/tag.js';
