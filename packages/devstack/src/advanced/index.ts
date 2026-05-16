// `@mysten-incubation/devstack/advanced` — escape hatch surface for
// plugin authors and Effect-native consumers who need to drop below
// the high-level Ref factories.
//
// Roughly seven groups, in increasing distance from the common path:
//
// 1. **Tag substrate** — `tag`, `provide`, `composeTag`, `composeLayers`,
//    `setPhase`, `Ref`, `TagIdentity`. The primitive every factory uses.
// 2. **Plugin-author helpers** — `dockerImage`, `gitFetch`, `hostScript`,
//    `dockerOneShot`. Common shapes a custom factory will reach for.
//    Long-running services (the `Sui()`, `Walrus()`, `Dev()` shape)
//    aren't covered by a generic helper today; reach for the in-tree
//    factories or read their source for the bare `tag()` pattern.
// 3. **Codegen plugin-author surface** — `defineEmitter`, `BindingsEmitter`,
//    `DappKitEmitter`, `CodegenError`, the `CodegenContext` /
//    `CodegenPackage` shapes. Use when you need to compose emitters
//    explicitly (multi-emitter, custom emitter, swapped options).
// 4. **Faucet plugin-author surface** — `FaucetStrategy`, `defineStrategy`,
//    `suiHttpStrategy`, `FaucetRequestError`. Use when writing a custom
//    faucet strategy (e.g. a CI-specific RPC fund spigot).
// 5. **Low-level interface tags** — `SuiTag`. Yield from inside a plugin
//    or test body when you need the resolved sui shape directly.
// 6. **Internal manifest accessor** — `gatherManifest`. Composes the
//    live `Manifest` snapshot from the running registries; the
//    `Devstack` Service uses this internally.
// 7. **Admin-side interface tags** — `WalrusAdminTag`, `SealKeyManagerTag`,
//    `DeepbookAdminTag`. Privileged ops (rotate seal key, post admin
//    liquidity, …) the high-level factories don't surface.

// ── 1. Tag substrate ──
export {
	type Ref,
	type TagIdentity,
	type TagKind,
	type TuiDisplay,
	type ProvideOptions,
	type TagOptions,
	type ComposeLayersOptions,
	type TagRequires,
	type TagErrors,
	type TagProvides,
	provide,
	tag,
	composeTag,
	composeLayers,
	setPhase,
	shortId,
	CurrentTagKey,
} from './tag.js';

// ── 2. Plugin-author helpers ──
export * from './plugin-author/index.js';

// ── 3. Codegen plugin-author surface ──
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

// ── 4. Faucet plugin-author surface ──
export { type FaucetStrategy } from '../faucet/service.js';
export { suiHttpStrategy } from '../faucet/strategies/sui-http.js';
export {
	walExchangeStrategy,
	type WalExchangeHandle,
	type WalExchangeStrategyOptions,
} from '../faucet/strategies/wal-exchange.js';
export {
	treasuryCapMintStrategy,
	type TreasuryCapMintStrategyOptions,
} from '../faucet/strategies/treasury-cap-mint.js';
export { defineStrategy } from '../faucet/strategies/internal.js';
export { FaucetRequestError } from '../faucet/errors.js';

// ── 5. Low-level interface tag escape hatches ──
// `SuiTag` is the narrow contract every `Sui()` implementation targets.
// Yield it from inside a plugin or a test body when you need the
// resolved sui shape (`rpc`, `client`, `chainId`, `waitForTransactionsReady`)
// without re-deriving the layer. The high-level `Sui()` factory in the
// main barrel is what app configs reach for; `SuiTag` is for code that
// runs inside the supervisor and wants the resolved value.
export { SuiTag, type Sui } from '../services/sui.js';

// ── 6. Internal manifest accessor ──
export { gatherManifest } from '../runtime/service.js';

// ── 7. Admin-side interface tag classes (rarely yielded by app code) ──
// Local-only admin caps. Reach for these when you need to perform
// privileged operations (rotate seal key, post liquidity from the
// admin cap, etc.) that the high-level factories don't surface.
export {
	WalrusAdminTag,
	type WalrusAdmin,
	SealKeyManagerTag,
	type SealKeyManager,
	DeepbookAdminTag,
	type DeepbookAdmin,
} from '../services/index.js';
