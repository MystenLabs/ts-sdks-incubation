// Internal registries — collected into the manifest at finalization.
// Each user-facing primitive (sui, publishMove, accounts, ...) registers
// itself into these as part of its scoped acquisition.
//
// Exposed (read-only-ish) to plugin-author code through the free-standing
// `publishEndpoint` / `requireEndpoint` (etc.) functions; users never poke
// the bare `Context.Service` shape themselves.
//
// The dependency-edge problem
// ---------------------------
// Layers are acquired in parallel. If primitive B reads from a registry
// without yielding the upstream tag that publishes into it, Layer.build
// sees no dependency edge between A and B — B can race ahead of A and
// observe a partial registry. The `require*(tag)` helpers exist purely
// to thread the upstream tag through the R channel: the call yields
// `tag` first (forcing the ordering at the type level and at runtime),
// then returns the underlying registry service.

import { Context, Effect, Layer, Ref as EffectRef } from 'effect';
import type { Ref, TagIdentity } from '../advanced/tag.js';

export interface PackageRecord {
	readonly name: string;
	readonly packageId: string;
	readonly upgradeCapId?: string;
	readonly mvrPlaceholder?: string;
	readonly captured?: Record<string, unknown>;
}

export interface EndpointRecord {
	readonly name: string;
	readonly url: string;
	readonly kind?: string;
	readonly pairUrl?: string;
}

export interface AccountRecord {
	readonly name: string;
	readonly address: string;
}

// Per-service state registries — singletons in practice (one Sui, one
// Seal, one Walrus, one Deepbook per stack), but kept array-shaped with
// a `name` field for symmetry with the rest of the registries. Last-
// write-wins per name; `gatherManifest` reads the snapshot to populate
// the corresponding `services.*` fields in the manifest.

export interface SuiStateRecord {
	readonly name: string;
	readonly chainId: string;
}

export interface SealStateRecord {
	readonly name: string;
	/** On-chain `KeyServer` object id (BLS public key + URL). Surfaced
	 *  in `services.seal.objectId` so consumers can pass it to
	 *  `SealClient`'s `serverConfigs`. */
	readonly objectId: string;
}

export interface WalrusStateRecord {
	readonly name: string;
	/** Walrus system object id — the on-chain registry the storage
	 *  protocol reads committee + epoch state from. Surfaced in
	 *  `services.walrus.systemObjectId`. */
	readonly systemObjectId: string;
}

export interface DeepbookPoolStateEntry {
	readonly poolId: string;
	readonly baseType: string;
	readonly quoteType: string;
}

export interface DeepbookStateRecord {
	readonly name: string;
	readonly packageId: string;
	readonly registryId?: string;
	readonly pools: Record<string, DeepbookPoolStateEntry>;
}

export interface CoinRecord {
	readonly name: string;
	readonly type: string;
	readonly decimals: number;
	/**
	 * SDK-aligned projection. Optional in the registry so plugin authors
	 * publishing into `CoinRegistry` from a custom primitive don't have
	 * to derive the field manually — `manifest({})` backfills it from
	 * `(type, decimals)` when missing.
	 */
	readonly sdkCoin?: {
		readonly address: string;
		readonly type: string;
		readonly scalar: number;
	};
}

export interface RegistryShape<T> {
	readonly register: (entry: T) => Effect.Effect<void>;
	readonly snapshot: Effect.Effect<ReadonlyArray<T>>;
}

export class PackageRegistry extends Context.Service<
	PackageRegistry,
	RegistryShape<PackageRecord>
>()('@devstack/PackageRegistry') {}

export class EndpointRegistry extends Context.Service<
	EndpointRegistry,
	RegistryShape<EndpointRecord>
>()('@devstack/EndpointRegistry') {}

export class AccountRegistry extends Context.Service<
	AccountRegistry,
	RegistryShape<AccountRecord>
>()('@devstack/AccountRegistry') {}

export class CoinRegistry extends Context.Service<CoinRegistry, RegistryShape<CoinRecord>>()(
	'@devstack/CoinRegistry',
) {}

export class SuiStateRegistry extends Context.Service<
	SuiStateRegistry,
	RegistryShape<SuiStateRecord>
>()('@devstack/SuiStateRegistry') {}

export class SealStateRegistry extends Context.Service<
	SealStateRegistry,
	RegistryShape<SealStateRecord>
>()('@devstack/SealStateRegistry') {}

export class WalrusStateRegistry extends Context.Service<
	WalrusStateRegistry,
	RegistryShape<WalrusStateRecord>
>()('@devstack/WalrusStateRegistry') {}

export class DeepbookStateRegistry extends Context.Service<
	DeepbookStateRegistry,
	RegistryShape<DeepbookStateRecord>
>()('@devstack/DeepbookStateRegistry') {}

// Write-side helpers — sugar for `(yield* X).register(entry)` with a
// clearer call site. Free functions instead of static class members so
// the call sites tree-shake and the types stay honest (no
// `Object.assign(service as any, …)`).
export const publishPackage = (entry: PackageRecord): Effect.Effect<void, never, PackageRegistry> =>
	Effect.gen(function* () {
		const reg = yield* PackageRegistry;
		yield* reg.register(entry);
	});

export const publishEndpoint = (
	entry: EndpointRecord,
): Effect.Effect<void, never, EndpointRegistry> =>
	Effect.gen(function* () {
		const reg = yield* EndpointRegistry;
		yield* reg.register(entry);
	});

export const publishAccount = (entry: AccountRecord): Effect.Effect<void, never, AccountRegistry> =>
	Effect.gen(function* () {
		const reg = yield* AccountRegistry;
		yield* reg.register(entry);
	});

export const publishCoin = (entry: CoinRecord): Effect.Effect<void, never, CoinRegistry> =>
	Effect.gen(function* () {
		const reg = yield* CoinRegistry;
		yield* reg.register(entry);
	});

export const publishSuiState = (
	entry: SuiStateRecord,
): Effect.Effect<void, never, SuiStateRegistry> =>
	Effect.gen(function* () {
		const reg = yield* SuiStateRegistry;
		yield* reg.register(entry);
	});

export const publishSealState = (
	entry: SealStateRecord,
): Effect.Effect<void, never, SealStateRegistry> =>
	Effect.gen(function* () {
		const reg = yield* SealStateRegistry;
		yield* reg.register(entry);
	});

export const publishWalrusState = (
	entry: WalrusStateRecord,
): Effect.Effect<void, never, WalrusStateRegistry> =>
	Effect.gen(function* () {
		const reg = yield* WalrusStateRegistry;
		yield* reg.register(entry);
	});

export const publishDeepbookState = (
	entry: DeepbookStateRecord,
): Effect.Effect<void, never, DeepbookStateRegistry> =>
	Effect.gen(function* () {
		const reg = yield* DeepbookStateRegistry;
		yield* reg.register(entry);
	});

// Read-side helpers — yield the upstream publisher `tag` first so the
// runtime forces a dependency edge on it before resolving the registry.
// Reading a registry without yielding the publisher is a race under
// `Layer.build`, and the `require*` helpers lift that constraint into
// the R channel so misuse fails to type-check.
const makeRequire =
	<I, T>(service: Context.Service<I, RegistryShape<T>>) =>
	<Name extends string, A, R, E>(
		tag: Ref<Name, A, R, E>,
	): Effect.Effect<RegistryShape<T>, E, R | TagIdentity<Name> | I> =>
		Effect.gen(function* () {
			yield* tag;
			return yield* service;
		}) as Effect.Effect<RegistryShape<T>, E, R | TagIdentity<Name> | I>;

export const requirePackageRegistry = makeRequire<PackageRegistry, PackageRecord>(PackageRegistry);
export const requireEndpointRegistry = makeRequire<EndpointRegistry, EndpointRecord>(
	EndpointRegistry,
);
export const requireAccountRegistry = makeRequire<AccountRegistry, AccountRecord>(AccountRegistry);
export const requireCoinRegistry = makeRequire<CoinRegistry, CoinRecord>(CoinRegistry);

const makeRegistryLive = <T>() =>
	Effect.gen(function* () {
		const ref = yield* EffectRef.make<ReadonlyArray<T>>([]);
		return {
			register: (entry: T) => EffectRef.update(ref, (xs) => [...xs, entry]),
			snapshot: EffectRef.get(ref),
		};
	});

export const PackageRegistryLive: Layer.Layer<PackageRegistry> = Layer.effect(
	PackageRegistry,
	makeRegistryLive<PackageRecord>(),
);
export const EndpointRegistryLive: Layer.Layer<EndpointRegistry> = Layer.effect(
	EndpointRegistry,
	makeRegistryLive<EndpointRecord>(),
);
export const AccountRegistryLive: Layer.Layer<AccountRegistry> = Layer.effect(
	AccountRegistry,
	makeRegistryLive<AccountRecord>(),
);
export const CoinRegistryLive: Layer.Layer<CoinRegistry> = Layer.effect(
	CoinRegistry,
	makeRegistryLive<CoinRecord>(),
);
export const SuiStateRegistryLive: Layer.Layer<SuiStateRegistry> = Layer.effect(
	SuiStateRegistry,
	makeRegistryLive<SuiStateRecord>(),
);
export const SealStateRegistryLive: Layer.Layer<SealStateRegistry> = Layer.effect(
	SealStateRegistry,
	makeRegistryLive<SealStateRecord>(),
);
export const WalrusStateRegistryLive: Layer.Layer<WalrusStateRegistry> = Layer.effect(
	WalrusStateRegistry,
	makeRegistryLive<WalrusStateRecord>(),
);
export const DeepbookStateRegistryLive: Layer.Layer<DeepbookStateRegistry> = Layer.effect(
	DeepbookStateRegistry,
	makeRegistryLive<DeepbookStateRecord>(),
);

export const RegistriesLive = Layer.mergeAll(
	PackageRegistryLive,
	EndpointRegistryLive,
	AccountRegistryLive,
	CoinRegistryLive,
	SuiStateRegistryLive,
	SealStateRegistryLive,
	WalrusStateRegistryLive,
	DeepbookStateRegistryLive,
);
