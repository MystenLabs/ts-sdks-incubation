# Plugin authoring

How to write a new devstack primitive — a yieldable interface tag plus
one or more factories that produce a `Layer` for that tag. The package
already ships eight primitive families (`sui`, `accounts`, `publishMove`,
`deepbook`, `walrus`, `seal`, `manifest`, `walletApp`); follow the same
shape to add your own.

Imports below come from
`@mysten-incubation/devstack-effect/plugin-author` unless noted.

## What you'll build

For a hypothetical Kafka primitive:

1. A `Kafka` interface tag (`Context.Service` class) + `KafkaShape` —
   the contract consumers depend on.
2. `kafkaLocalContainer(opts)` — a primary implementation factory that
   acquires a local broker (docker container) and provides the tag.
3. Optionally `kafkaKnownBroker(opts)` — a config-only factory that
   takes a bootstrap URL and `Layer.succeed`s the tag.
4. Tests using `@effect/vitest`'s `it.effect` against
   `provideDevstack([kafkaLocalContainer(...)])` (or
   `Layer.build(layer)` if you only need the tag).

## Step 1: Define the interface contract

Put the tag in `src/interfaces/kafka.ts` if you're contributing back, or
in your own package otherwise. The shape lives next to the tag — both
file consumers can import either independently.

```ts
import { Context, Schema } from 'effect';

export interface KafkaShape {
	readonly bootstrapUrl: string;
	readonly version: string;
}

export class Kafka extends Context.Service<Kafka, KafkaShape>()('@your-pkg/Kafka') {}

export const KafkaShapeSchema = Schema.Struct({
	bootstrapUrl: Schema.String,
	version: Schema.String,
});
```

The `Context.Service` constructor's string argument is the runtime
identity. Pick a stable name — it's the key Effect's DI uses, and
changing it breaks every consumer.

## Step 2: Write the primary implementation

The primary implementation actually spawns a broker. `provideTag(Kafka,
build)` binds your build Effect to the existing tag class — no new
Context.Service is created, so multiple factories can target the same
tag.

```ts
import { Effect } from 'effect';
import { addFinalizer } from 'effect/Scope';
import { provideTag } from '@mysten-incubation/devstack-effect/plugin-author';
import { dockerImage } from '@mysten-incubation/devstack-effect/plugin-author';
import { Kafka, type KafkaShape } from './interfaces/kafka.js';

export interface KafkaLocalContainerOptions {
	readonly name?: string;
	readonly version?: string;
}

export const kafkaLocalContainer = (opts: KafkaLocalContainerOptions = {}) => {
	const name = opts.name ?? 'kafka';
	const version = opts.version ?? '3.7.0';

	const image = dockerImage({
		name: `${name}.image`,
		dockerfilePath: 'kafka-image/Dockerfile',
		buildArgs: { KAFKA_VERSION: version },
	});

	const build = Effect.gen(function* () {
		const img = yield* image;
		const port = yield* allocatePort(9092);
		const container = yield* startContainer({ image: img.tag, port });
		yield* addFinalizer(() => stopContainer(container.id));
		const shape: KafkaShape = { bootstrapUrl: `localhost:${port}`, version };
		return shape;
	}).pipe(Effect.withSpan(`kafkaLocalContainer(${name})`));

	const { __layer } = provideTag(Kafka, build);
	return { __layer, __layers: [__layer, ...image.__layers], key: name };
};
```

Three things to notice:

- **`addFinalizer`** registers teardown against the ambient `Scope`.
  `defineDevstack` and `provideDevstack` both build the layer inside a
  scope, so finalizers fire in reverse acquire order on `Ctrl-C`.
- **`Effect.withSpan`** names the acquire phase. The TUI reads spans
  to render `acquiring → ready` transitions per primitive.
- **`__layers`** flattens upstream layers (here `image.__layers`). The
  outer composition (`defineDevstack` / `provideDevstack`) reads
  `__layers` and `Layer.mergeAll`s them — without this, the `dockerImage`
  layer wouldn't reach the runtime graph.

## Step 3: Refined interfaces (when needed)

If your primary impl exposes capabilities that the known-broker variant
can't (because we don't own the cluster), declare a refined tag:

```ts
export interface KafkaAdminShape extends KafkaShape {
	readonly createTopic: (name: string) => Effect.Effect<void, KafkaError>;
	readonly deleteTopic: (name: string) => Effect.Effect<void, KafkaError>;
}

export class KafkaAdmin extends Context.Service<KafkaAdmin, KafkaAdminShape>()(
	'@your-pkg/KafkaAdmin',
) {}
```

The canonical example in this package is `LocalPackage extends Package`
in `src/interfaces/package.ts`. Local-published packages carry a
`sourcePath`, captured object ids, and an `mvrPlaceholder` that
known-package factories can't surface — `bindings` rebinds to
`LocalPackage` so the type system catches a stack composed against a
remote package id.

Rule of thumb: if a field would be `undefined` for one of your variants,
that's a smell — split into a refined interface instead.

## Step 4: Known-broker factory (config-only)

For multi-impl services, ship a second factory that takes a URL and
`Layer.succeed`s the base tag. No docker, no acquire phase.

```ts
import { Layer } from 'effect';
import { makeTag } from '@mysten-incubation/devstack-effect/plugin-author';

export interface KafkaKnownBrokerOptions {
	readonly bootstrapUrl: string;
	readonly version?: string;
}

export const kafkaKnownBroker = (opts: KafkaKnownBrokerOptions) => {
	const shape: KafkaShape = {
		bootstrapUrl: opts.bootstrapUrl,
		version: opts.version ?? 'unknown',
	};
	const layer = Layer.succeed(Kafka, shape);
	return { __layer: layer, __layers: [layer], key: `kafka.known(${opts.bootstrapUrl})` };
};
```

The known variant produces only `Kafka` — the refined `KafkaAdmin` tag
is intentionally absent. Consumers that need admin power will fail to
typecheck under a known-broker stack, which is exactly what we want.

## Step 5: Re-export

If contributing back, re-export from `src/index.ts` next to the
existing primitives:

```ts
export { kafkaLocalContainer, kafkaKnownBroker } from './primitives/kafka.js';
export { Kafka, KafkaAdmin, type KafkaShape, type KafkaAdminShape } from './interfaces/kafka.js';
```

If shipping in your own package, export from your package root and
have consumers import from there. The interface tag's string identity
(`'@your-pkg/Kafka'`) is global across the runtime, so a third-party
primitive can satisfy a contract defined in this package as long as
both sides reach for the same `Context.Service` class.

## Worked example: a 40-line `kafka()` plugin

```ts
import { Context, Effect, Layer } from 'effect';
import { addFinalizer } from 'effect/Scope';
import { provideTag } from '@mysten-incubation/devstack-effect/plugin-author';

export interface KafkaShape {
	readonly bootstrapUrl: string;
}
export class Kafka extends Context.Service<Kafka, KafkaShape>()('@example/Kafka') {}

export const kafkaLocalContainer = (opts: { name?: string } = {}) => {
	const name = opts.name ?? 'kafka';
	const build = Effect.gen(function* () {
		const container = yield* startKafkaContainer();
		yield* addFinalizer(() => stopContainer(container.id));
		return { bootstrapUrl: `localhost:${container.port}` } as const;
	}).pipe(Effect.withSpan(`kafkaLocalContainer(${name})`));
	const { __layer } = provideTag(Kafka, build);
	return { __layer, __layers: [__layer], key: name };
};

export const kafkaKnownBroker = (opts: { bootstrapUrl: string }) => {
	const layer = Layer.succeed(Kafka, { bootstrapUrl: opts.bootstrapUrl });
	return { __layer: layer, __layers: [layer], key: `kafka.known` };
};

// Test (using `provideDevstack` against the known variant — no docker).
import { describe, expect, it } from '@effect/vitest';
import { provideDevstack } from '@mysten-incubation/devstack-effect';

describe('kafkaKnownBroker', () => {
	it.effect('yields the configured URL', () =>
		Effect.gen(function* () {
			const k = yield* Kafka;
			expect(k.bootstrapUrl).toBe('broker.example.com:9092');
		}).pipe(Effect.provide(provideDevstack([kafkaKnownBroker({ bootstrapUrl: 'broker.example.com:9092' })]))),
	);
});
```

## Common pitfalls

- **Don't access internal services in your acquire body unless you really
  need to.** `StateStore`, `EngineHandle`, and the registries
  (`PackageRegistry`, `CoinRegistry`, `EndpointRegistry`,
  `AccountRegistry`) are surfaced via `./plugin-author` for plugins that
  need to participate in caching or publish chain artifacts. Prefer
  yielding upstream tags (`yield* Sui`, `yield* MyDependency`) — those
  edges are visible to the engine and show up in the TUI.
- **Don't put nullable fields on the base interface.** If a field is
  meaningful only for one variant, split into a refined interface that
  the variant-specific factory provides. `Package` vs `LocalPackage` is
  the canonical example.
- **Don't forget `Effect.addFinalizer` (or `Layer.scoped` wrappers)** for
  resources you spawn. The supervisor runs every layer inside a `Scope`
  — finalizers fire on `Ctrl-C`, on hot-restart, and on acquire failure
  partway through the stack. Skipping them leaks containers across
  iterations.
- **Don't forget `__layers`.** Returning `{ __layer, key }` without
  `__layers` works for tags that have no transitive deps, but if your
  factory builds inner tags (`dockerImage`, `gitFetch`, ...) and yields
  them, the inner layers need to reach `Layer.mergeAll` via your
  outer tag's `__layers`. The pattern is
  `__layers: [__layer, ...inner.__layers, ...other.__layers]`.
- **Don't reach for `composeTag`.** Existing primitives that built inner
  tags inline used `composeTag` to surface the inner layers; the
  preferred shape now is multiple `provideTag` calls returning multiple
  `__layers`. `composeTag` is still on `./plugin-author` for advanced
  cases but new code should avoid it.
- **Don't pin host ports.** Use `PortAllocator` from
  `./plugin-author` so two stacks can coexist on one machine. Pin a
  preferred port; let the allocator scan forward when busy.

## Reference primitives in this package

Read these in order — they're sorted simplest to richest:

1. `src/primitives/sui.ts` — single tag, multi-factory split
   (`suiLocalnet` / `suiTestnet` / `suiMainnet` / `suiCustom`). Showcases
   the `Layer.succeed` pattern for `suiTestnet` (no acquire phase) vs the
   `Effect.gen` pattern for `suiLocalnet` (full container boot).
2. `src/primitives/publish-move.ts` — per-name tag plus `Package` /
   `LocalPackage` interface satisfaction. Showcases registries (writing
   to `PackageRegistry` + `CoinRegistry`).
3. `src/primitives/walrus.ts` — multi-tag single body. One `Effect.gen`
   acquires the full state and `Context.add`s four interface tags
   (`WalrusNetwork` + `WalrusNodes` + `WalrusProxy` + `WalrusAdmin`) into
   a single returned `Context`. Showcases `Layer.effectContext` for
   multi-tag layers.
4. `src/primitives/seal.ts` — internal aggregate tag + two thin
   projection layers (`SealKeyServer`, `SealKeyManager`). Showcases
   keeping the engine's lifecycle keyed on one acquire while producing
   two narrow interfaces for consumers.
