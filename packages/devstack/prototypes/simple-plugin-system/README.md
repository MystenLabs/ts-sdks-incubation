# Adapter-shaped plugin system prototype

This directory contains one prototype for a simpler devstack plugin authoring API. It is isolated
from `src/`, has its own `tsconfig.json`, and does not participate in the package build.

## Goal

Keep the current engine shape, but stop making plugin authors hand-write the current engine shape.

The current implementation needs these data flows:

```ts
resource id -> dependency ids -> start Effect -> resolved value
resolved value + runtime context -> capability list
capability list -> current supervisor/orchestrator sinks
```

The prototype keeps those flows in the public model and lowers through an internal adapter when the
current engine shape is needed:

```ts
definePlugin(...)
  -> id
  -> dependsOn
  -> start(ctx, deps)
  -> capabilities array or dynamic capabilities array
  -> toCurrentEngineStack(stack).members
```

The intended migration path is public API first, internal adapter second, engine cleanup later.

## Files

- `src/core.ts` — generic authoring substrate and public stack shape.
- `src/adapter.ts` — internal lowering from the public stack shape to current-engine members.
- `src/builtins.ts` — built-in Sui, account, package, wallet, action, host-service factories.
- `src/examples.ts` — barrel for the example set.
- `src/examples/arena.config.ts` — normal app config authoring.
- `src/examples/generated-results.ts` — public app usage of generated files.
- `src/examples/health-check-capability.ts` — typed custom capability helper and inferred sink.
- `src/examples/redis-plugin.ts` — third-party plugin authoring with a typed Redis value and custom
  capability contribution.
- `src/examples/custom-plugin.config.ts` — app config that consumes the custom plugin.
- `src/examples/wallet-all.config.ts` — built-in expansion for `wallet({ accounts: 'all' })`.
- `src/examples/group.config.ts` — grouped plugin modeled with normal dependencies.
- `src/examples/adapter-behavior.config.ts` — adapter output details such as dependency dedupe.
- `src/examples/mode-narrowed.config.ts` — callback stack authoring with network-mode narrowing.
- `src/examples/capability-sink.ts` — runtime sink behavior for typed and structural custom capabilities.
- `src/examples/runtime-smoke.ts` — executable smoke check for internal adapter lowering and resolved
  deps. It is intentionally not exported from the public examples barrel because it imports Node
  built-ins.
- `src/examples/type-contracts.ts` — negative type checks and codegen declaration checks.
- `MIGRATION.md` — source-file-level cutover plan for applying the prototype to the real package.

## Authoring Shape

Stack authors should mostly keep the current public style:

```ts
const publisher = account('publisher');
const alice = account('alice');

const connectFour = localPackage('connect_four', {
	sourcePath: './move/connect_four',
	publisher,
});

const openLobby = action('arena.openLobby', {
	dependsOn: { signer: alice, pkg: connectFour },
	body: (ctx, { signer, pkg }) => {
		return ctx.signAndExecute(signer, (tx) => {
			tx.moveCall({ target: `${pkg.packageId}::game::create_lobby` });
		});
	},
});

const app = hostService({
	name: 'arena-app',
	command: 'pnpm dev',
	port: 5176,
	dependsOn: [alice, connectFour],
});

export default defineDevstack({
	members: [openLobby, app],
	stackName: 'arena',
	codegen: { outputDir: 'src/generated' },
});
```

`dependsOn` can be a single item, an array, or an object. A single dependency is passed as the
resolved value, so simple cases do not need tuple destructuring:

```ts
const fundLobby = action('arena.fundLobby', {
	dependsOn: alice,
	body: (ctx, signer) =>
		ctx.signAndExecute(signer, (tx) => {
			tx.moveCall({ target: '0x2::coin::split' });
		}),
});
```

Arrays are useful when positional destructuring is clearer:

```ts
const closeLobby = action('arena.closeLobby', {
	dependsOn: [alice, connectFour],
	body: (ctx, [signer, pkg]) =>
		ctx.signAndExecute(signer, (tx) => {
			tx.moveCall({ target: `${pkg.packageId}::game::close_lobby` });
		}),
});
```

The dependency list is still explicit because the dep graph needs it before start runs. An
Effect-style `yield* get(...)` body is not enough for planning because the engine needs dependency
ids before any plugin is started.

Callbacks keep a `ctx` argument for runtime helpers, but dependency access is standardized through
the second argument. Actions, plugin `start`, and host-service env hooks all use the same rule: the
`dependsOn` shape determines the dependency argument shape.

`defineDevstack({ members })` treats listed members as entrypoints. Plugin-valued dependencies are
expanded recursively before the adapter lowers into the current engine. That means app authors can
usually omit dependencies that are already reachable from entrypoints:

```ts
const app = hostService({
	name: 'arena-app',
	command: 'pnpm dev',
	port: 5176,
	dependsOn: [alice, connectFour, devWallet],
});

export default defineDevstack({
	members: [app],
	stackName: 'arena',
});
```

This expansion only works when the dependency value is the actual plugin returned by a factory. A
bare `accountRef('alice')` is just a resource reference, so it still needs a provider somewhere in
the reachable stack and missing-provider validation catches that.

Stacks that need network-mode-specific factories can use the callback form. The network is part of
the first config object, and the builder receives a mode-narrowed context:

```ts
const serviceFor = defineModeNamespace({
	local: { sidecar: () => hostService({ name: 'local-indexer', command: 'pnpm dev', port: 5180 }) },
	fork: { proxy: () => hostService({ name: 'fork-proxy', command: 'pnpm dev', port: 5181 }) },
});

const localNetwork = defineNetwork({ mode: 'local', name: 'localnet' });

export default defineDevstackWith({ network: localNetwork, stackName: 'local' }, ({ network }) => {
	const sidecar = serviceFor.for(network).sidecar();
	return [sidecar];
});
```

The callback form exists for type narrowing and late factory selection. It still returns ordinary
members and runs through the same dependency expansion, validation, and adapter lowering as
`defineDevstack({ members })`.

Groups use the same dependency graph. A grouped plugin depends on the members it coordinates, and
`kind: 'group'` is just metadata for the parent plugin:

```ts
const redisGroup = definePlugin({
	id: 'redis/grouped',
	kind: 'group',
	dependsOn: { sidecar: redisSidecar, metrics: redisMetrics },
	start: (_ctx, { sidecar, metrics }) =>
		Effect.succeed({
			url: sidecar.url.replace('http://', 'redis://'),
			metricsUrl: metrics.url,
		}),
});
```

There is no separate group capability. Group membership, ordering, validation, and dependency
expansion all come from `dependsOn`.

Plugin authors give a plugin one `id`. The `id` is graph identity, not an app-facing lookup name.
The plugin's resolved value type comes from the `start` return type.

Plugin-owned capability kinds are structural by default. A plugin can create a local helper without
registering the kind in a central union. If the plugin wants first-class typed sinks for that
capability, the capability module owns a registry extension by key:

```ts
declare module '../core.ts' {
	interface DevstackCapabilityRegistry {
		'health-check': {
			readonly url: string;
			readonly intervalMs: number;
		};
	}
}

const healthCheck = defineCapability('health-check');
```

Runtime sinks opt into the capability kinds they understand. Unknown kinds are reported as
`unhandled`; they do not force plugin authors to augment a central registry:

```ts
const healthCheckSink = capabilitySink('health-check', (capability) =>
	Effect.sync(() => {
		void capability.url;
	}),
);
```

The sink callback parameter is inferred from `DevstackCapabilityRegistry['health-check']`; no local
capability type annotation is needed.

The core types are readonly internally, but plugin-authored value shapes do not have to spell
`readonly`; ordinary TypeScript object types work.

The plugin factory itself returns a normal resource-producing plugin. There is no separate
`provides: resource(...)` declaration:

```ts
const redis = <const Name extends string>(name: Name) => {
	const id = defineId(`redis/${name}`);

	return definePlugin({
		id,
		dependsOn: Sui,
		kind: 'leaf-long-running',
		start: () => Effect.succeed({ name, url: `redis://127.0.0.1:6379/${name}` }),
		capabilities: ({ value }) =>
			[
				snapshotable({ subtrees: [id], missingTolerance: 'fine' }),
				routable({
					endpointName: `redis-${name}`,
					dispatchId: { groupKey: id, role: 'tcp' },
					upstream: { type: 'host-loopback', port: 6379 },
					wireProtocol: 'tcp',
				}),
				healthCheck({ url: value.url, intervalMs: 1000 }),
				codegenable({
					emitterName: id,
					outputPath: `${id}.ts`,
					emit: (writer) =>
						writer.writeTypeScript(
							`export const redis = ${JSON.stringify({ name, url: value.url })};\n`,
						),
				}),
			],
	});
};
```

Another plugin can depend on that Redis plugin by reference. The `start` return value gives
downstream plugins a typed value, not just an ordering edge.

```ts
const cache = redis('cache');

const cacheBackedApp = hostService({
	name: 'cache-backed-app',
	command: 'pnpm dev',
	port: 5177,
	dependsOn: { cache },
	env: (_ctx, { cache }) => ({
		REDIS_URL: cache.url,
	}),
});

export default defineDevstack({
	members: [cacheBackedApp],
});
```

## Codegen

Plugin types do not carry generated-output types anymore.

That type plumbing made plugin declarations harder to read and pushed app-facing generated-file
contracts into the plugin type system. The prototype now treats codegen as an opaque runtime artifact
capability: plugins say which file they emit and write source text through a `CodegenWriter`. The
generated file owns its own values and types, and app code imports those generated files directly.
See `src/examples/generated-results.ts`.

The only codegen typing left in the plugin substrate is the capability contract itself, so the
supervisor/orchestrator can route the contribution. There is no generated-output type parameter, no
`typeDeclarations` field, and no module-export shape threaded through plugin types.

## Extensible Maps

Several string-discriminated surfaces are better represented as extensible interface maps instead of
hand-rolled unions:

| Surface | Registry interface | Why |
| --- | --- | --- |
| Capability declarations | `DevstackCapabilityRegistry` | Keys are capability kinds; values are payload shapes. `CapabilityDecl<'kind'>` adds the `kind` field from the key. |
| Network modes | `DevstackNetworkModeRegistry` | Mode-specific config fields, such as `checkpoint` for `fork`, stay attached to the mode key. |
| Routable upstreams | `DevstackRoutableUpstreamRegistry` | New upstream transports can add a `type` key and payload shape without editing a union. |
| Plugin kinds | `DevstackPluginKindRegistry` | Keeps lifecycle kind vocabulary extensible while preserving literal keys for UI/scheduler metadata. |
| Lifted-sibling scopes | `DevstackLiftedSiblingScopeRegistry` | Scope vocabulary can grow without rewriting the lifted-sibling key type. |

Not every string should become a registry. Resource ids remain free-form graph identity, capability
keys such as `account:alice` remain sink-owned strings, and `RebootCost` stays closed because the
scheduler needs a small fixed cost vocabulary.

The prototype has type contracts for registry extension. Custom network modes keep their own fields,
local networks reject fork-only fields like `checkpoint`, custom routable upstreams infer their
payload from `type`, and custom plugin kinds / lifted-sibling scopes are accepted only after registry
augmentation.

## Migration Sketch

The migration should be an in-place API cleanup, not a long-lived v1/v2 split. The prototype is
designed so the current supervisor can keep consuming current-engine-shaped members while plugin
authors move to the smaller authoring API.

### 1. Introduce the adapter boundary

First, land the small public substrate types and keep current-engine lowering in an internal adapter:

```ts
definePlugin({ id, dependsOn, start, capabilities })
  -> createDevstackStack(...)
  -> toCurrentEngineStack(...)
  -> { provides, consumes, acquire, capabilities }
```

At this point the current engine still sees `provides`, `consumes`, and `acquire`. Only the authoring
surface changes. The public `defineDevstack` return value does not expose `engine`; adapter output is
used by the supervisor/tests that need the current substrate shape. This keeps orchestration, process
supervision, snapshots, routing, and codegen sinks on the existing path while the public plugin API is
simplified.

### 2. Convert built-in factories first

Convert the built-ins before third-party plugins:

- `sui()`
- `account(...)`
- `localPackage(...)`
- `wallet(...)`
- `action(...)`
- `hostService(...)`

Each factory should keep returning a plugin/ref value that can be used in another plugin's
`dependsOn`. The factory owns the runtime `id`, and the `start` return type becomes the dependency
value type.

The mechanical mapping is:

| Current author-facing concept | New author-facing concept |
| --- | --- |
| `provides: resource(id, ...)` | `id` |
| `consumes` | `dependsOn` |
| `acquire(ctx)` | `start(ctx, deps)` |
| `ctx.use(dep)` in author callbacks | resolved `deps` argument |
| one-off typed resource registries | inferred plugin/ref value type |
| generated output types in plugin types | generated files export their own types |
| `pluginGroup(...)` capability | `kind: 'group'` plus normal `dependsOn` |

### What disappears

The migration should delete these concepts from the public authoring surface:

- Public `consumes`. Authors use `dependsOn`; only the adapter emits current-engine `consumes`.
- Public `provides: resource(...)`. Authors spell one `id`; the provided value is inferred from
  `start`.
- Public `pluginKey`. The adapter derives current-engine tags from `id`; there is no second identity
  for plugin authors to keep in sync.
- Author-facing `acquire`. Authors write `start`; the adapter lowers it to current-engine `acquire`.
- Author callback dependency lookup with `ctx.use(...)`. Callbacks keep `ctx` for runtime helpers, but
  dependency values arrive as the second argument.
- One-off tag/resource registries such as `DevstackResourceRegistry` and `ResourceRegistration`.
- Central capability unions and bespoke declaration types. Custom capability declarations can stay
  structural; typed runtime sinks use `DevstackCapabilityRegistry` interface-map augmentation.
- Plugin and stack type parameters for generated output shapes. Codegen emits files, and those files
  export their own app-facing values and types.
- `pluginGroup(...)` and group-as-capability. A group is just a plugin whose `dependsOn` are the
  members it coordinates.
- `capabilities(...)` wrapper helpers and double nesting. Capabilities are plain arrays or dynamic
  array factories.
- Name-literal value types. Resource ids carry graph identity; resolved values should be normal human
  object shapes.
- `as const` in public examples. `const` generics should carry tuple/object inference.
- Trailing positional options for `defineDevstack`. Stack config is one object.
- Repeating every dependency in `defineDevstack([...])`. Root members are entrypoints, and
  plugin-valued dependencies are expanded recursively.
- Generic plugin `compose` hooks. Special built-in expansion such as `wallet({ accounts: 'all' })`
  should live in built-in preprocessing before dependency expansion and validation.

These concepts remain, but with narrower meaning:

- `id` remains because the runtime graph needs stable identity for validation, lowering to current
  tags, codegen/snapshot names, and duplicate-provider detection. Use `defineId(...)` when a factory
  builds a template-literal id and needs to preserve literal inference.
- `ctx` remains because lifecycle callbacks need a home for runtime helpers. It is no longer a
  dependency locator.
- `kind`, `rebootCost`, `watch`, `displayHint`, lifted siblings, and error contributions remain as
  lifecycle metadata.
- Current-engine `provides`, `consumes`, and `acquire` can remain inside the adapter until the engine
  itself is simplified.
- Bare refs like `accountRef(...)` may remain for advanced cases where a stack references an external
  provider, but normal app/plugin authoring should pass plugin values through `dependsOn`.

### 3. Preserve public stack authoring where possible

Most app configs should only see small renames or dependency-shape improvements. Public factories can
keep their domain names and options:

```ts
const app = hostService({
	name: 'arena-app',
	command: 'pnpm dev',
	port: 5176,
	dependsOn: { wallet: devWallet, pkg: connectFour },
	env: (_ctx, { wallet, pkg }) => ({
		WALLET_URL: wallet.url,
		PACKAGE_ID: pkg.packageId,
	}),
});

export default defineDevstack({
	members: [app],
	stackName: 'arena',
});
```

`defineDevstack({ members })` should treat members as entrypoints and recursively include
plugin-valued dependencies. That lets app configs list the thing they actually run without spelling
every dependency twice.

### 4. Migrate plugin authors by deleting ceremony

For plugin authors, the common conversion should be mostly deletion:

```ts
const redis = <const Name extends string>(name: Name) => {
	const id = defineId(`redis/${name}`);

	return definePlugin({
		id,
		dependsOn: Sui,
		kind: 'leaf-long-running',
		start: () => Effect.succeed({ name, url: `redis://127.0.0.1:6379/${name}` }),
		capabilities: ({ value }) => [
			snapshotable({ subtrees: [id], missingTolerance: 'fine' }),
			codegenable({
				emitterName: id,
				outputPath: `${id}.ts`,
				emit: (writer) =>
					writer.writeTypeScript(
						`export const redis = ${JSON.stringify({ name, url: value.url })};\n`,
					),
			}),
		],
	});
};
```

Do not recreate old tag/resource registry shapes in plugin space. A plugin only needs an `id`,
dependencies, lifecycle metadata, a `start` value, and any capabilities it contributes.

### 5. Keep runtime sinks boring

Capabilities stay as plain declarations until a runtime sink consumes them. Built-in sinks can switch
over `kind` exactly as they do today for snapshots, routing, strategy contributions, and codegen.
Custom capability kinds can stay structural until the engine has a concrete sink/layer that needs
validation or scheduling behavior. A concrete sink opts into one `kind` through
`DevstackCapabilityRegistry`; unknown capability kinds are reported as unhandled so the supervisor can
warn without making plugin authors register everything.

### 6. Remove old authoring concepts after conversion

Once built-ins and examples are converted, remove the old authoring exports rather than keeping
aliases:

- no public `consumes`
- no public `provides: resource(...)`
- no public `pluginKey`
- no `ctx.use(...)` in author callbacks
- no plugin/codegen output type plumbing
- no resource/tag registry augmentation for ordinary plugins
- no central capability union edits; typed custom sinks extend `DevstackCapabilityRegistry`
- no group capability
- no generic plugin `compose` escape hatch

The current-engine field names can remain inside the adapter until the engine itself is simplified.

### 7. Verification checklist

The migration is ready when these checks pass against the real package:

- Built-in factories still lower to current-engine members with the same `provides` and `consumes`
  ids the supervisor expects.
- Missing-provider and duplicate-provider failures still happen at stack definition time.
- `dependsOn` works for single values, tuples, and objects in plugin `start`, action bodies, and host
  env hooks.
- Object-shaped `dependsOn` is not confused with refs when keys are named `id` or `pluginKey`.
- Current-engine `consumes` is deduped by id while callback dependency shapes are preserved.
- `defineDevstack({ members: [entrypoint] })` includes plugin-valued dependencies recursively.
- `defineDevstackWith({ network }, build)` preserves mode-narrowed factory access while returning
  the same member graph shape as the flat form.
- At least one generated file is imported by an example app so codegen still proves compile-time use.
- Existing snapshot, routing, strategy, and codegen sinks can consume the new capability declarations.
- Lifted-sibling conflicts and cross-plugin witness requirements still fail at stack definition time.
- Custom capability sinks can opt in by `kind`, and unknown capability kinds are observable as
  unhandled instead of silently becoming type-system ceremony.

## Feedback Folded In

- Public authoring uses `dependsOn`; `consumes` is now only the current-engine field produced by the
  adapter.
- `defineDevstack` takes one config object with `members`, `stackName`, `network`, and `codegen`;
  options are no longer a trailing positional argument.
- Root members are entrypoints. Plugin-valued dependencies are recursively expanded so examples can
  say `defineDevstack({ members: [app] })` when `app` already depends on the rest of the stack.
- Public examples do not use `as const`; `const` generics carry the tuple/object inference.
- `dependsOn` accepts a single item, an array, or an object. Author callbacks receive a single
  resolved value, tuple, or object to match that syntax.
- Author callbacks no longer expose `ctx.use(...)`.
- Plugin authors spell `id`, not `provides: resource(...)`; the provided value type is inferred from
  `start`.
- Plugin authors write `start`, while the adapter lowers to the current engine's `acquire`.
- Capabilities are plain arrays; no `capabilities(...)` wrapper.
- Generated output types were removed from plugin and stack types.
- Codegen emits through an opaque writer instead of returning a generated-module export shape.
- Multi-member topology is normal dependency structure; `kind: 'group'` is metadata about the
  parent plugin, not a separate capability.
- Resolved value types no longer carry name literals. Literal names remain only on resource ids
  where they are needed for missing-provider and duplicate-provider validation.
- Built-in factories that derive ids from names, such as `hostService`, preserve those literal ids
  so unrelated members do not collapse into broad patterns like `host-service/${string}`.
- Custom resources now show why the `start` return value matters: the Redis value feeds a host
  service's dev-server environment.
- Resource type registration was removed. Resource refs carry their own value type, so plugin
  authors do not need to declare `ResourceRegistration` entries or broad id patterns like
  `cache-warmup/${string}`.
- Central capability union registration was removed. Custom capability declarations can stay
  structural, and concrete typed runtime sinks extend `DevstackCapabilityRegistry` by capability key.
- Public `pluginKey` was removed. Current-engine tag keys are derived from `id` inside the adapter.
- Refs are nominally branded so object-shaped dependencies can safely use ordinary property names
  like `id`.
- Current-engine `consumes` are deduped by id, while author callback deps preserve the requested
  single/tuple/object shape.
- The public stack no longer exposes `engine`; current-engine lowering is explicit through
  `toCurrentEngineStack(...)` in the internal adapter.
- Generic plugin `compose` was removed from the authoring API. Built-in expansion happens before
  dependency expansion.

## Preserved Requirements

- `start` is Effect-shaped, so current scoped finalizer and substrate-service patterns still fit.
- Dynamic capabilities receive resolved value plus runtime context.
- Lifecycle metadata is present: `kind`, `rebootCost`, `watch`, `displayHint`, lifted siblings, and
  error contributions.
- Group topology is modeled through the same `dependsOn` graph as every other plugin relationship.
- Built-in expansion behavior is represented: auto-Sui and `wallet({ accounts: 'all' })`.
- Public generated-app usage remains stable enough to model current imports like generated packages,
  dapp-kit config, and Sui network bindings.
- Internal adapter output still carries the current engine's `consumes` field so the engine can stay
  mostly the same while authors use clearer names.
- Lifted-sibling conflict checks and witness satisfaction checks are represented without exposing the
  old plugin/tag authoring shape.
- Structural custom capability routing is represented without module augmentation, and typed custom
  sinks use interface-map augmentation.

## Type Guarantees

- Missing providers fail at stack composition after built-in auto-Sui is applied.
- Duplicate resource ids fail at stack composition.
- Factories can require resource families, for example `localPackage(..., { publisher })` only
  accepts an account resource.
- Plugin `start`, host env helpers, and action bodies receive only the resolved values listed in
  `dependsOn`.
- Plugin-owned capability kinds can be added without editing a central union; typed sinks opt in by
  augmenting `DevstackCapabilityRegistry`.
- Registered capability sinks infer payload shape from `DevstackCapabilityRegistry`.
- Registered capability helpers reject unknown payload fields, so option typos do not silently become
  structural capability data.
- Interface-map extension points preserve key-specific payloads and reject unregistered keys.
- Object dependency keys can be named naturally, including `id`, without being mistaken for a ref.
- Lifted siblings with the same `(plugin, kind, scope)` must agree on `inputHash`.
- Resolved values can carry optional witness phantoms, and stack validation rejects unsatisfied
  witnesses.
- Runtime capability sinks handle declared kinds explicitly and report unhandled kinds.

## Review Followups

The latest review passes agreed with the public API direction above. The prototype now folds in their
concrete followups: branded refs, literal id helpers, adapter dedupe, internal-only adapter output,
internal-only built-in expansion, one public identity, mode-narrowed callback authoring,
lifted-sibling validation, witness validation, interface-map extension points, inferred typed
capability sinks, opaque codegen writer output, and structural fallback capability routing.

Run the prototype check with:

```bash
npx tsc --noEmit -p packages/devstack/prototypes/simple-plugin-system/tsconfig.json
pnpm exec tsx packages/devstack/prototypes/simple-plugin-system/src/examples/runtime-smoke.ts
```
