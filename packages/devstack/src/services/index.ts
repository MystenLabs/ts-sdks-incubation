// `@mysten-incubation/devstack/services` barrel. The canonical factory
// surface for the new Ref-based API.
//
// Every export here returns a `Ref` (a typed value that's simultaneously
// a Layer and an Effect tag). Pass the result into other factories
// (`signer: alice`) for type-checked cross-references, then into
// `devstack(...)` to compose the running stack.

export { Sui, type SuiOptions } from './sui.js';
export { Seal, type SealOptions } from './seal.js';
export { Walrus, type WalrusOptions } from './walrus.js';
export { Deepbook, DeepbookMarketMaker, type DeepbookOptions } from './deepbook.js';
export { Account } from './account.js';
export { Package, type PackageOptions, type CaptureSpec } from './package.js';
export { Action, type ActionOptions } from './action.js';
export { Dev, type DevOptions } from './dev.js';
export { Wallet, type WalletOptions } from './wallet.js';
export { Bindings, type BindingsRefOptions } from './bindings.js';
export {
	type Ref,
	type RefSection,
	type AccountRef,
	type PackageRef,
	withSection,
} from './ref.js';
