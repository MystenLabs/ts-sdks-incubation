// `@mysten-incubation/devstack/advanced` — escape hatch surface for
// plugin authors and Effect-native consumers who need to drop below
// the high-level LayeredTag factories.
//
// Roughly seven groups, in increasing distance from the common path:
//
// 1. **Tag substrate** — `tag`, `provide`, `composeLayers`, `setPhase`,
//    `LayeredTag`, `TagIdentity`. The primitive every factory uses.
// 2. **Plugin-author helpers** — `dockerImage`, `gitFetch`, `hostScript`,
//    `dockerOneShot`, `pickCreatedByType`. Common shapes a custom factory
//    will reach for. Long-running services (the `Sui()`, `Walrus()`,
//    `Dev()` shape) aren't covered by a generic helper today; reach for
//    the in-tree factories or read their source for the bare `tag()` pattern.
// 3. **Runtime accessor surface** — `gatherManifest`, `EndpointName`,
//    `ExtrasInput`. Plugin-author primitives that build on the manifest
//    wire format (emitters reading the live snapshot, factories that
//    publish endpoints, custom `extras` shapes).
// 4. **Codegen plugin-author surface** — `defineEmitter`,
//    `BindingsEmitter`, `DappKitConfigEmitter`, `StackHandleEmitter`,
//    `CodegenError`, the `CodegenContext` / `CodegenPackage` shapes.
//    Use when you need to compose emitters explicitly (custom emitter,
//    swapped per-emitter options).
// 5. **Faucet plugin-author surface** — `FaucetStrategy`,
//    `suiHttpStrategy`, `FaucetRequestError`. Use when writing a custom
//    faucet strategy (e.g. a CI-specific RPC fund spigot).
// 6. **Low-level interface tags** — `SuiTag`. Yield from inside a plugin
//    or test body when you need the resolved sui shape directly.
// 7. **Admin-side interface tags** — `WalrusAdminTag`, `SealKeyManagerTag`,
//    `DeepbookAdminTag`. Privileged ops (rotate seal key, post admin
//    liquidity, …) the high-level factories don't surface.

// ── 1. Tag substrate ──
export {
	type LayeredTag,
	type TagIdentity,
	type TagKind,
	type TuiDisplay,
	type ProvideOptions,
	type TagOptions,
	type ComposeLayersOptions,
	provide,
	tag,
	composeLayers,
	setPhase,
} from './tag.js';
// `makeService(pluginName, kind, impl)` — stamps `__kind` +
// `__pluginName` on a tag-shaped value. Replaces the in-tree
// `Object.assign(impl, {__kind, __pluginName})` boilerplate; surfaced
// here for out-of-tree plugins that mirror the same pattern.
export { makeService } from './make-service.js';

// Plugin-author entry. `devstack(...)` is the canonical surface; reach for
// `defineDevstack` when you want to pre-build the Layer graph (custom
// state-store keys, etc.) and skip the LayeredTag-flatten/default-fill pipeline.
// `composeStackLayer` exposes just the layer composition step for
// fixtures and integration tests that drive the engine themselves.
export {
	defineDevstack,
	composeStackLayer,
	type DevstackHandle,
	type DevstackConfig,
	type StackMember,
	type StackComposeOptions,
	type RendererKind,
	type RunOverrides,
} from '../engine/supervisor.js';

// ── 2. Plugin-author helpers ──
export * from './plugin-author/index.js';

// Object-id picker for `Action.build` callbacks that project from
// `result.objectChanges`. One parameterized helper covering the
// suffix, includes, and prefix variants — pass exactly one filter
// (default: first match; pass `all: true` with `prefix:` to enumerate).
export { pickCreatedByType } from '../engine/sui-helpers.js';
export type { PickCreatedByTypeFilter, PickCreatedByTypeResult } from '../engine/sui-helpers.js';

// `PackageWithCapture` — variant of `Package(...)` for plugin authors
// who need to extract object ids from the publish receipt beyond the
// coins covered by auto-discovery (admin caps, registries, DAO
// objects). Coin auto-discovery still runs; this factory just adds the
// `capture(changes)` lambda + the `pkg.captured` projection.
export {
	PackageWithCapture,
	type PackageWithCaptureOptions,
	type CaptureSpec,
} from '../services/package.js';

// Canonical testnet/mainnet seal/walrus/deepbook deployment registry.
// Plugin-author surface for custom factories that want to default the
// `network: 'testnet' | 'mainnet'` shape the in-tree `Seal()` / `Walrus()`
// / `Deepbook()` factories use — not user surface (app configs reach for
// the high-level factories, which consult this internally).
export {
	knownDeployments,
	type KnownDeployments,
	type KnownNetwork,
} from '../engine/known-deployments.js';

// ── 3. Runtime accessor surface ──
// `gatherManifest()` — in-Effect snapshot of the live registries +
// Identity returning the `Manifest` shape (also re-exported as types
// from the package root). Codegen emitters and any plugin-author Effect
// that wants the structured manifest view reach for this; the manifest
// emitter (`runtime/manifest-emit.ts`) uses it internally to write the
// on-disk JSON.
export { gatherManifest } from '../runtime/service.js';
// `EndpointName` — closed enum of well-known endpoint names. Factories
// publish into the `EndpointRegistry` keyed by these constants; manifest
// readers and consumers compare against them. Plugin authors who publish
// a new endpoint reach for `dockerContainer({ publishEndpoint })` (which
// expects an `EndpointName`-typed value or a free-form string).
export { EndpointName, type EndpointNameValue } from '../runtime/endpoint-names.js';
// `ExtrasInput` — the accepted shape for the user's `extras:` field on
// `DevstackComposeOptions`. Plugin authors composing devstack via
// `defineDevstack(...)` (vs the top-level `devstack(...)`) pass an
// `ExtrasInput` value through to `extras:` directly.
export type { ExtrasInput } from '../engine/extras.js';

// ── 4. Codegen plugin-author surface ──
export {
	defineEmitter,
	type Emitter,
	type CodegenContext,
	type CodegenPackage,
} from '../codegen/define-emitter.js';
export { BindingsEmitter } from '../codegen/emitters/bindings.js';
export { DappKitConfigEmitter } from '../codegen/emitters/dapp-kit-config.js';
export { DeepbookConfigEmitter } from '../codegen/emitters/deepbook-config.js';
export { StackHandleEmitter } from '../codegen/emitters/stack-handle.js';
export { CodegenError } from '../codegen/errors.js';

// ── 5. Faucet plugin-author surface ──
// `Faucet(...)` is auto-mounted by `devstack(...)` — users don't call
// it explicitly. Plugin authors writing custom faucet strategies reach
// for it (alongside the strategy primitives) here to register their
// own strategies on top of the auto-included one.
export {
	Faucet,
	type FaucetOptions,
	FaucetTag,
	type FaucetStrategy,
	FaucetRequestError,
} from '../services/faucet/index.js';
export { suiHttpStrategy } from '../services/faucet/strategies/sui-http.js';
export { walExchangeStrategy } from '../services/faucet/strategies/wal-exchange.js';
export { treasuryCapMintStrategy } from '../services/faucet/strategies/treasury-cap-mint.js';

// `pythMid` — Ref helper that polls the on-chain Pyth `PriceInfoObject`
// and exposes a Ref-shaped mid price for downstream consumers. Lives on
// `/advanced` because the typical user reaches for it via the higher-
// level `DeepbookMarketMaker` (which composes `pythMid` internally for
// its quote source). Plugin authors building custom market-maker /
// pricing surfaces wire it explicitly.
export { pythMid, type PythMid, type PythMidOptions, type PythMidScale } from '../services/pyth.js';

// `DevstackSigner` — re-exported alias for `@mysten/sui/cryptography`'s
// `Signer` abstract class. Plugin authors writing factories that accept
// a raw signer (HSM, remote signer, browser wallet under test) should
// type the parameter as `DevstackSigner` so the surface stays consistent
// with the SDK contract that `Account('alice', {kind: 'signer', signer})`
// already accepts. The devstack `Account` resolves to a Signer-compatible
// shape (same `sign{Transaction,PersonalMessage}` / `getKeyScheme` /
// `getPublicKey` / `toSuiAddress` surface) but in the Effect idiom —
// `Account.signTransaction(bytes)` returns `Effect<{signature, bytes}>`
// rather than the SDK's `Promise<SignatureWithBytes>`.
export type { Signer as DevstackSigner } from '@mysten/sui/cryptography';

// ── 6. Low-level interface tag escape hatches ──
// Yield from inside a plugin or a test body when you need the resolved
// shape directly. The high-level factories (`Sui()`, `Walrus()`,
// `Deepbook()`, `Coin()`) in the main barrel are what app configs reach
// for; these tags are for code that runs inside the supervisor and
// wants the resolved value.
export { SuiTag, type Sui } from '../services/sui.js';
export {
	CoinTag,
	type Coin,
	WalrusNetworkTag,
	type WalrusNetwork,
	WalrusNodesTag,
	type WalrusNodes,
	WalrusProxyTag,
	type WalrusProxy,
	DeepbookCoreTag,
	type DeepbookCore,
} from '../services/index.js';

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
