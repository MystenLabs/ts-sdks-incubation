// `@mysten-incubation/devstack/services` barrel. The canonical factory
// surface for the new Ref-based API.
//
// Every export here returns a `Ref` (a typed value that's simultaneously
// a Layer and an Effect tag). Pass the result into other factories
// (`signer: alice`) for type-checked cross-references, then into
// `devstack(...)` to compose the running stack.
//
// Phase-4 cleanup: the per-service Context.Service tag classes and their
// Schema mirrors moved here from `src/interfaces/`. Tags that collide
// with a factory name (`Sui`, `Package`, `LocalPackage`,
// `DeepbookMarketMaker`) carry a `Tag` suffix; the underlying Context
// key (`'@devstack/<name>'`) is unchanged.

// ── Factories ──
export { Sui, type SuiOptions, type SuiShape, SuiTag, EndpointSchema, SuiShapeSchema } from './sui.js';
export {
	Seal,
	type SealOptions,
	type SealKeyServerEntry,
	type SealKeyServerShape,
	SealKeyServer,
	type SealKeyManagerShape,
	SealKeyManager,
	SealKeyServerEntrySchema,
	SealKeyServerShapeSchema,
} from './seal.js';
export {
	Walrus,
	type WalrusOptions,
	type WalrusNetworkShape,
	WalrusNetwork,
	type WalrusNodeInfo,
	type WalrusNodesShape,
	WalrusNodes,
	type WalrusProxyShape,
	WalrusProxy,
	type WalrusAdminShape,
	WalrusAdmin,
	WalrusNetworkShapeSchema,
	WalrusNodeInfoSchema,
	WalrusNodesShapeSchema,
	WalrusProxyShapeSchema,
} from './walrus.js';
export {
	Deepbook,
	DeepbookMarketMaker,
	type DeepbookOptions,
	type DeepbookPoolRef,
	type DeepbookCoreShape,
	DeepbookCore,
	type DeepbookAdminShape,
	DeepbookAdmin,
	type DeepbookMarketMakerShape,
	DeepbookMarketMakerTag,
	DeepbookPoolRefSchema,
} from './deepbook.js';
export {
	Account,
	type AccountShape,
	type AccountTag,
	AccountShapeSchema,
} from './account.js';
export {
	Package,
	type PackageOptions,
	type CaptureSpec,
	type PackageShape,
	PackageTag,
	type LocalPackageShape,
	LocalPackageTag,
	PackageShapeSchema,
	LocalPackageShapeSchema,
	type CoinShape,
	Coin,
	toSdkCoin,
	CoinShapeSchema,
} from './package.js';
export { Action, type ActionOptions } from './action.js';
export { Dev, type DevOptions } from './dev.js';
export { Wallet, type WalletOptions } from './wallet.js';
export { Bindings, type BindingsRefOptions } from './bindings.js';
export { Codegen, type CodegenOptions } from './codegen.js';
export { KnownPackage, type KnownPackageOptions } from './known-package.js';
export { Faucet, type FaucetOptions } from '../faucet/factory.js';
export { FaucetTag, type FaucetStrategy, type FaucetShape } from '../faucet/service.js';
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
export { type AccountRef, type PackageRef } from './ref.js';
export { type Ref } from '../advanced/tag.js';
