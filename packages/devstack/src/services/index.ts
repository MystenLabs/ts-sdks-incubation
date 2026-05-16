// `@mysten-incubation/devstack/services` barrel. The canonical factory
// surface for the new Ref-based API.
//
// Every export here returns a `Ref` (a typed value that's simultaneously
// a Layer and an Effect tag). Pass the result into other factories
// (`signer: alice`) for type-checked cross-references, then into
// `devstack(...)` to compose the running stack.
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
export { DappKit, type DappKitRefOptions } from './dapp-kit.js';
export { KnownPackage, type KnownPackageOptions } from './known-package.js';
export { Faucet, type FaucetOptions } from '../faucet/factory.js';
export { FaucetTag, type FaucetStrategy } from '../faucet/service.js';
export { suiHttpStrategy } from '../faucet/strategies/sui-http.js';
export { defineStrategy } from '../faucet/strategies/internal.js';
export { FaucetRequestError } from '../faucet/errors.js';
export {
	defineEmitter,
	type Emitter,
	type CodegenContext,
	type CodegenPackage,
} from '../codegen/define-emitter.js';
export { CodegenError } from '../codegen/errors.js';
export { BindingsEmitter, type BindingsEmitterOptions } from '../codegen/emitters/bindings.js';
export {
	DappKitEmitter,
	type DappKitEmitterOptions,
	type DappKitFlavor,
} from '../codegen/emitters/dapp-kit.js';
export { type AccountRef, type PackageRef } from './ref.js';
export { type Ref } from '../advanced/tag.js';
