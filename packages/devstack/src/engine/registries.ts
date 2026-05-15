// Internal registries — collected into the manifest at finalization.
// Each user-facing primitive (sui, publishMove, accounts, ...) registers
// itself into these as part of its scoped acquisition.
//
// Exposed (read-only-ish) to plugin-author code through typed `publish`
// + `requiring` helpers; users never poke the bare `Context.Service`
// shape themselves.
//
// The dependency-edge problem
// ---------------------------
// Layers are acquired in parallel. If primitive B reads from a registry
// without yielding the upstream tag that publishes into it, Layer.build
// sees no dependency edge between A and B — B can race ahead of A and
// observe a partial registry. The `requiring(tag)` helpers exist purely
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

// Helpers added to each registry class. `publish(entry)` is the
// write-side path — it's `(yield* X).register(entry)` with a clearer
// name. `requiring(tag)` is the read-side path that forces a
// dependency edge on `tag` before resolving the registry; reading the
// registry without yielding the upstream publisher tag is a race
// under Layer.build, and `requiring` lifts that constraint into the
// R channel so misuse fails to type-check.
interface RegistryHelpers<I, T> {
	readonly publish: (entry: T) => Effect.Effect<void, never, I>;
	readonly requiring: <Name extends string, A, R, E>(
		tag: Ref<Name, A, R, E>,
	) => Effect.Effect<RegistryShape<T>, E, R | TagIdentity<Name> | I>;
}

export class PackageRegistry extends Context.Service<
	PackageRegistry,
	RegistryShape<PackageRecord>
>()('@devstack/PackageRegistry') {
	static readonly publish: RegistryHelpers<PackageRegistry, PackageRecord>['publish'];
	static readonly requiring: RegistryHelpers<PackageRegistry, PackageRecord>['requiring'];
}

export class EndpointRegistry extends Context.Service<
	EndpointRegistry,
	RegistryShape<EndpointRecord>
>()('@devstack/EndpointRegistry') {
	static readonly publish: RegistryHelpers<EndpointRegistry, EndpointRecord>['publish'];
	static readonly requiring: RegistryHelpers<EndpointRegistry, EndpointRecord>['requiring'];
}

export class AccountRegistry extends Context.Service<
	AccountRegistry,
	RegistryShape<AccountRecord>
>()('@devstack/AccountRegistry') {
	static readonly publish: RegistryHelpers<AccountRegistry, AccountRecord>['publish'];
	static readonly requiring: RegistryHelpers<AccountRegistry, AccountRecord>['requiring'];
}

export class CoinRegistry extends Context.Service<CoinRegistry, RegistryShape<CoinRecord>>()(
	'@devstack/CoinRegistry',
) {
	static readonly publish: RegistryHelpers<CoinRegistry, CoinRecord>['publish'];
	static readonly requiring: RegistryHelpers<CoinRegistry, CoinRecord>['requiring'];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const attachHelpers = <I, T>(service: Context.Service<I, RegistryShape<T>>): void => {
	const helpers: RegistryHelpers<I, T> = {
		publish: (entry) => service.use((reg) => reg.register(entry)),
		requiring: <Name extends string, A, R, E>(tag: Ref<Name, A, R, E>) =>
			Effect.gen(function* () {
				yield* tag;
				return yield* service;
			}) as Effect.Effect<RegistryShape<T>, E, R | TagIdentity<Name> | I>,
	};
	Object.assign(service as any, helpers);
};
/* eslint-enable @typescript-eslint/no-explicit-any */

attachHelpers<PackageRegistry, PackageRecord>(PackageRegistry);
attachHelpers<EndpointRegistry, EndpointRecord>(EndpointRegistry);
attachHelpers<AccountRegistry, AccountRecord>(AccountRegistry);
attachHelpers<CoinRegistry, CoinRecord>(CoinRegistry);

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

export const RegistriesLive = Layer.mergeAll(
	PackageRegistryLive,
	EndpointRegistryLive,
	AccountRegistryLive,
	CoinRegistryLive,
);
