# Simple Plugin System Migration Plan

This prototype is intended to replace the current author-facing plugin API in place. The repo is not
published, so the migration should delete the old surface instead of carrying shims.

## Target Shape

Public plugin authors write:

```ts
definePlugin({
	id: 'redis/cache',
	dependsOn: { sui, sidecar },
	kind: 'leaf-long-running',
	start: (ctx, { sui, sidecar }) => Effect.succeed({ url: sidecar.url }),
	capabilities: ({ value }) => [routable(...), codegenable(...)],
});
```

Stack authors write:

```ts
defineDevstack({
	members: [app],
	stackName: 'arena',
	network,
	codegen: { outputDir: 'src/generated' },
});
```

An internal adapter lowers that authoring shape to the current engine shape:

```ts
{ provides, consumes, acquire, capabilities }
```

That keeps the supervisor, lifecycle graph, process supervision, snapshots, routing, strategy
registry, and codegen sinks on the existing path while replacing the public type system. The public
stack handle should not expose this current-engine output directly.

## Current Files To Change

| Current file | Migration action |
| --- | --- |
| `src/api/define-plugin.ts` | Replace `defineNodePlugin({ provides, consumes, acquire })` as the public helper with `definePlugin({ id, dependsOn, start })`. Keep the old lowering shape inside the adapter only. |
| `src/substrate/plugin.ts` | Keep `StackMember`, `acquire`, `provides`, and `consumes` as engine-internal for the first cut. Remove `ctx.use` from author callbacks; dependency values are resolved before calling `start`. |
| `src/substrate/tag.ts` and `src/api/tag.ts` | Stop making plugin authors define tags directly. Keep tag construction internal to the adapter. Derive the current tag key from one public `id`; remove public `pluginKey` from plugin authoring. |
| `src/api/define-devstack.ts` | Replace variadic members plus trailing options with one object: `{ members, stackName, network, codegen, ... }`. Keep auto-Sui and wallet `accounts: 'all'` expansion here. |
| `src/api/define-devstack-with.ts` | Keep the callback form for mode narrowing, but have it call the object-form composer after building ordinary members. |
| `src/api/consume-members.ts` and `src/api/plugin-authoring.ts` | Delete `readConsumedTag` / `consumeMembers` authoring helpers once built-ins use `start(ctx, deps)`. They exist to paper over `ctx.use` and should not survive the migration. |
| `src/api/define-capabilities.ts` | Delete the public `capabilities(...)` wrapper unless a specific internal call still needs it. Public capabilities should be arrays or dynamic array factories. |
| `src/contracts/capability-decl.ts` | Replace the hardcoded union with an extensible `DevstackCapabilityRegistry` interface. Keys are capability kinds; values are payload shapes. `CapabilityDecl<K>` adds the `kind` field from the key. |
| `src/substrate/runtime/capability-sinks/service.ts` | Keep the existing kind-to-sink registry. It already matches the target runtime model; update types/docs so unknown custom kinds are intentionally ignored or warned at the supervisor boundary. |
| `src/contracts/codegenable.ts` | Remove generated-output shapes from plugin/stack typing. Keep the runtime codegen capability contract, preferably as an opaque writer/context. Generated files export app-facing types directly. |
| `src/substrate/lifted-sibling.ts` and `src/substrate/witness.ts` | Keep these validation concepts, but route them through the simpler plugin shape. The prototype proves both without exposing tags in author code. |
| `src/substrate/network.ts` | Convert network modes to `DevstackNetworkModeRegistry`, so mode-specific fields attach to the mode key instead of widening every network config. |
| `src/contracts/routable.ts` | Convert routable upstream variants to `DevstackRoutableUpstreamRegistry`, keyed by upstream `type`. |
| `src/substrate/lifecycle.ts` | Consider `DevstackPluginKindRegistry` for plugin kinds. Keep scheduler-owned cost values closed. |

## Phased Cutover

### 1. Land the public substrate and internal adapter

Add the minimal public substrate from `src/core.ts`:

- branded `ResourceRef`
- `defineId`
- `definePlugin`
- `dependsOn` single/array/object resolution
- recursive plugin-valued dependency expansion

Keep the current-engine bridge in a separate internal adapter module:

- lower `id` to the current `provides` tag
- lower `dependsOn` to current `consumes`
- lower `start(ctx, deps)` to current `acquire(ctx)`
- dedupe current-engine `consumes` by id without changing callback dependency shape

The initial adapter can still create real `Tag` values and `StackMember` values internally. Do not
return this current-engine shape from the public stack handle.

### 2. Convert built-ins

Convert built-ins before examples or third-party plugins:

- `sui`
- `account`
- `localPackage`
- `wallet`
- `action`
- `hostService`
- service families such as Seal, Walrus, DeepBook, Pyth, Postgres, and Faucet

Each factory should return a plugin value that is also a dependency reference. Factories should own
their `id`; resolved values should be normal object shapes, not name-literal-heavy types.

### 3. Delete author-facing tags and consumed lookup helpers

After the first built-ins are converted, remove public use of:

- `defineTag(...)`
- public `pluginKey(...)`
- public `provides`
- public `consumes`
- public `acquire`
- `ctx.use(...)`
- `readConsumedTag(...)`
- `consumeMembers(...)`

The adapter can keep those names privately until the engine itself is simplified.

### 4. Convert stack composition

Change stack config call sites from variadic/trailing-options to one object. This is intentionally a
breaking change:

```ts
defineDevstack({
	members: [app],
	stackName: 'arena',
	network,
});
```

`members` are entrypoints. Plugin-valued dependencies are recursively included. Bare refs still need
a provider in the reachable graph.

### 5. Preserve mode narrowing

Keep `defineDevstackWith` for mode-specific factories:

```ts
defineDevstackWith({ network }, ({ network }) => {
	const seal = sealFor.for(network).forkKnown(...);
	return [seal];
});
```

The callback should return the same member list shape as `defineDevstack({ members })`, then delegate
to the object composer.

### 6. Simplify capabilities and codegen

Capabilities should be plain declarations:

```ts
capabilities: ({ value }) => [snapshotable(...), routable(...)]
```

Do not carry generated-output types through plugin types. Keep runtime codegen routing, but make
generated files own their app-facing exports and types. Prefer an opaque writer/context shape over a
plugin-authored module-export payload:

```ts
codegenable({
	emitterName: 'redis/cache',
	outputPath: 'redis/cache.ts',
	emit: (writer) => writer.writeTypeScript(sourceText),
});
```

For custom capabilities, plugin authors define structural helpers:

```ts
declare module '@mysten-incubation/devstack' {
	interface DevstackCapabilityRegistry {
		'health-check': {
			readonly url: string;
			readonly intervalMs: number;
		};
	}
}

const healthCheck = defineCapability('health-check');
```

Runtime behavior comes from a registered sink. Unknown kinds should be observable as unhandled.
Plugins that only emit an opaque custom capability do not need augmentation; plugins that want a
typed sink callback extend `DevstackCapabilityRegistry`.

With the registry in place, sink callbacks should infer their payload:

```ts
capabilitySink('health-check', (capability) =>
	Effect.sync(() => {
		void capability.url;
	}),
);
```

## Verification Gates

Run these before migrating more built-ins:

```bash
npx tsc --noEmit -p packages/devstack/prototypes/simple-plugin-system/tsconfig.json
pnpm exec tsx packages/devstack/prototypes/simple-plugin-system/src/examples/runtime-smoke.ts
pnpm --filter @mysten-incubation/devstack typecheck
```

After real package migration starts, add targeted tests for:

- object `dependsOn` keys named `id` or `pluginKey`
- single dependency callback without destructuring
- tuple dependency callback without `as const`
- host-service env callback receiving resolved deps
- distinct host-service names preserving distinct resource ids
- recursive entrypoint expansion
- duplicate providers in the recursive dependency closure
- missing providers from bare refs
- current-engine `consumes` dedupe by id
- public stack handle not exposing the current-engine `engine` / `provides` / `consumes` / `acquire`
  shape directly
- wallet `accounts: 'all'` expansion after recursive deps are included
- `defineDevstackWith` mode-narrowed illegal factory access
- lifted-sibling hash conflict rejection
- witness satisfaction rejection
- structural custom capability routed by a registered sink
- registered capability sink callback parameter inference
- registered capability helpers rejecting unknown payload fields
- custom network modes, routable upstreams, plugin kinds, and lifted-sibling scopes through
  interface-map augmentation
- invalid mode-specific fields, for example `checkpoint` on a local network
- unknown custom capability behavior at the supervisor boundary
- at least one generated file imported by a real example app

## Deletion Checklist

These should be gone from public authoring when the migration is done:

- tag-type ceremony
- public `pluginKey`
- public `provides`
- public `consumes`
- public `acquire`
- `ctx.use`
- `readConsumedTag`
- `consumeMembers`
- `capabilities(...)` wrapper
- codegen output type plumbing in plugin types
- plugin-authored generated module-export payload shape
- resource/tag registry augmentation for ordinary plugins
- central capability union edits
- `pluginGroup`
- generic public `compose`
- trailing positional options for `defineDevstack`
- public examples requiring `as const`

## Engine Boundary

Do not rewrite the supervisor first. The safer sequence is:

1. Convert authoring to the simple API.
2. Lower through the adapter to the current `StackMember` shape.
3. Keep current supervisor behavior green.
4. Later, simplify engine names like `provides`, `consumes`, and `acquire` if the engine no longer
   needs them.

This keeps the critical runtime data flow intact while deleting the authoring complexity that plugin
authors see.
