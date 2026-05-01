// Type plumbing for the React adapter. Kept in its own module so the
// `<DevstackProvider>` and hook implementations can import without
// pulling each other.

import type { Manifest } from '../runtime/manifest-types.js';

/**
 * A single codegen module's exports — `import * as game from
 * './generated/sui/connect_four/game'` produces this shape. Every export
 * is either a typed call builder (function returning a `(tx) => ...`) or
 * a `MoveStruct`/`MoveEnum` definition that doesn't need package binding.
 *
 * `bindPackage` walks the module's exports and wraps the call builders
 * (those with a `package?: string` parameter on their `options`) so the
 * package address is auto-injected. Other exports pass through.
 */
export type CodegenModule = Record<string, unknown>;

export interface DevstackProviderState {
	manifest: Manifest | null;
	/**
	 * Map from logical package name (the registry key — `'connect_four'`,
	 * `'mock_usdc'`, `'deepbook'`, …) to the codegen module imported by
	 * the app. Order matters only for debugging.
	 */
	packages: Record<string, CodegenModule>;
}

/**
 * Apps augment this to make `useDevstackPackage('name')` return the
 * fully-typed codegen module instead of the unconstrained
 * `CodegenModule`. Pattern mirrors the dapp-kit `Register` interface.
 *
 * ```ts
 * import * as connectFour from './generated/sui/connect_four/game.js';
 * import * as managedCoin from './generated/sui/managed_coin/managed_coin.js';
 *
 * declare module '@mysten-incubation/devstack/react' {
 *   interface DevstackPackageRegistry {
 *     connect_four: typeof connectFour;
 *     managed_coin: typeof managedCoin;
 *   }
 * }
 * ```
 *
 * Without augmentation, `useDevstackPackage('connect_four')` returns
 * `CodegenModule` and call sites cast inline. With augmentation, the
 * hook returns the actual module shape — call sites read like
 * `pkg.createLobby({ arguments: [] })(tx)` with full type checking.
 */
export interface DevstackPackageRegistry {
	// Apps augment this. Empty by default.
}
