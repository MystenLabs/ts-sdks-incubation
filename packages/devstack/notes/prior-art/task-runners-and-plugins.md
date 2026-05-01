# Prior art: task runners and plugin architectures

Context: `@mysten-incubation/devstack` owns a multi-step deploy pipeline (RPC wait -> accounts ->
faucet -> publish Move packages -> import packages -> seed tokens -> plugin deploy hooks -> manifest
write -> codegen) and a plugin model (`DevstackPlugin`) where each plugin contributes `buildImage` /
`render` / `deploy` / `manifest` / `endpoints` / `doctor` / `vite` hooks. The deploy steps are
hardcoded in `runDeploy`; plugin orchestration is hand-rolled (`topoSortPlugins` + a `contributions`
accumulator threaded through hook calls). This file surveys nearby tools so we can decide what's
worth borrowing.

## 1. Task runners and build systems

### Turborepo (already in use)

Config shape:

```jsonc
{
	"tasks": {
		"build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
		"test": { "dependsOn": ["build"], "outputs": ["coverage/**"] },
		"dev": { "cache": false, "persistent": true },
	},
}
```

Tasks live in `package.json` scripts; `turbo.json` only describes the _graph_ between them. Two edge
types: `^foo` ("foo of every workspace dep first"), `foo` ("foo in the same package first").
Topo-sorted DAG with parallel scheduling, content-hashed cache (local + remote). Failures are
per-task; `--continue` keeps the rest going, otherwise the run aborts. No plugin API per se --
extension is "add another script and another `tasks` entry." Inserting a step is
`dependsOn: ["existing-step"]`.
([Configuring tasks](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks),
[Running tasks](https://turborepo.dev/docs/crafting-your-repository/running-tasks))

### Nx (most relevant single reference)

Two-layer model: **executors** (the thing that runs) and **generators** (codemods/scaffolds).
Project Crystal flips the older "every project hand-writes targets" model on its head: a plugin
implements `createNodesV2(globPattern, fn)` that _infers_ targets by inspecting tool config files,
and `createDependencies(ctx)` that contributes edges to the project graph. Plugins live in `nx.json`
as either `"@nx/vite/plugin"` or `{ plugin, options }`. Task graph is a DAG; targets declare
`dependsOn` plus inputs/outputs for hashing. Failures bubble per-target; `--parallel=N` and
`--skipNxCache` are the main knobs. Inserting a step = either contribute a new target via
`createNodesV2`, or override `targetDefaults` for an existing one.
([Inferred Tasks (Project Crystal)](https://nx.dev/docs/concepts/inferred-tasks),
[Extending the Project Graph](https://nx.dev/docs/extending-nx/project-graph-plugins))

The split is the interesting bit: _generator_ = scaffolding-time codemod (creates configs, files);
_executor_ = run-time task implementation. We currently fuse these, e.g. seal both renders compose
and runs `seal-cli genkey` from the same plugin object.

### Bazel and `rules_*`

`MODULE.bazel` registers toolchains with `register_toolchains(...)`; targets resolve toolchains
lazily by _label_, not by name lookup. Plugins are Starlark "rules" packaged as `rules_go`,
`rules_scala`, etc. and consumed via Bzlmod. The "Toolchainization" pattern (rules_go, rules_scala)
lets a module extension register multiple variants of a toolchain at the right priority. Failures:
hermetic, per-action; one failed action aborts that branch, the rest of the DAG continues. Inserting
a step = define a new rule that depends on existing labels; the user wires it into their `BUILD`
graph. ([Toolchains](https://bazel.build/extending/toolchains))

The label-as-tool-reference pattern is genuinely good. We do something similar implicitly when
seal's `deploy()` reads `imageTags['seal']` and `packages.seal`.

### Just / Task / Mage / Make

All variations on "named recipes with deps":

- **Just** -- `b: a && c` for "run a, then b, then c"; `[parallel]` attribute runs deps
  concurrently. No plugins; recipes are scripts.
  ([Dependencies](https://just.systems/man/en/dependencies.html))
- **go-task** -- YAML, `deps:` (parallel by default), `preconditions:` (skip if false), `cmds:`,
  `requires:`, fingerprinting via `sources/generates`.
  ([Taskfile schema](https://taskfile.dev/docs/reference/schema))
- **Mage** -- Go file with exported functions; `mg.Deps(f, g)` runs in parallel and dedupes. Each
  function is a node; the dep graph is implicit in source code.
  ([Dependencies](https://magefile.org/dependencies/))

These bottom out at "topologically sort named functions, run them with deduplication, fail fast."
Nothing here is a plugin system; each is a pure task graph.

### Tekton

Pipelines as Kubernetes CRDs. A `Pipeline` lists `tasks`, each a `taskRef` with `params`,
`workspaces` (shared volumes), and `runAfter` for explicit ordering. **Results** are first-class:
`$(tasks.build.results.image-digest)` is how downstream tasks consume upstream output. Failures
abort the run (or `finally:` runs cleanup). Inserting a step = add a Pipeline task entry with
`runAfter` plus param wiring. ([Pipelines](https://tekton.dev/docs/pipelines/pipelines/))

The `params + results + workspaces` triple is the cleanest pipeline contract I've seen. It's exactly
the shape we'd want if we made the deploy pipeline data-driven.

### GitHub Actions

`action.yml` declares `inputs:` and `outputs:`. Composite actions (`runs.using: composite`) are
sequences of `steps` reusable as a single unit; reusable workflows
(`uses: org/repo/.github/workflows/foo.yml@ref`) are full jobs. Inputs are explicit; outputs are
explicit. Failures stop a job by default unless `continue-on-error`. Inserting a step = edit YAML;
you can't really inject "between A and B" without forking the workflow.
([Composite actions](https://docs.github.com/actions/creating-actions/creating-a-composite-action))

### mise / asdf

Plugin = a git repo with shell scripts (`bin/install`, `bin/list-all`). Registered globally in a
`~/.tool-versions` / `mise.toml`. The plugin community is maintained as a registry mapping short
names -> repo URLs (`asdf-vm/asdf-plugins`, `mise-plugins/registry`). Not a task runner -- but the
_plugin distribution model_ (registry of git repos with a thin shell-script contract) is worth
noting. ([mise plugins](https://mise.jdx.dev/plugins.html))

### Lefthook

Config is a YAML map of git-hook -> command list, with `parallel: true`, `glob:`, `stage_fixed:` per
command. Not a plugin system; just declarative orchestration with parallelism.
([lefthook](https://github.com/evilmartians/lefthook))

## 2. Plugin / hook frameworks

### Vite (and Rollup beneath it)

Plugins are POJOs with named hook properties. Hooks have _kinds_: **first** (run sequentially until
one returns non-null), **sequential** (await each), **parallel** (fire and forget). Order is
`enforce: 'pre' | undefined | 'post'`, then within a band, source order. Hooks themselves can be
`{ handler, order: 'pre'|'post', sequential: true }` for finer control.
([Vite plugin API](https://vite.dev/guide/api-plugin),
[Rollup plugin development](https://rollupjs.org/plugin-development/))

This is the canonical "lifecycle hooks at well-defined extension points" model. **Inserting between
two existing steps**: you don't -- there are no "existing steps" in user space, only _hooks_. Two
plugins both tap `transform` and order is `enforce` + source order.

### Webpack / tapable

Compiler/Compilation expose typed hooks: `SyncHook`, `AsyncSeriesHook`, `AsyncParallelHook`,
`AsyncSeriesWaterfallHook`, plus `*BailHook` variants ("first non-null wins"). Plugins call
`compiler.hooks.compile.tap('MyPlugin', cb)`. The rich type catalog (sync vs async, series vs
parallel, bail vs waterfall) is a richer vocabulary than Vite's three kinds.
([tapable](https://github.com/webpack/tapable))

### Fastify / hapi

Encapsulated plugin contexts: when you `register(plugin)`, modifications happen in a child context
that doesn't leak. Lifecycle hooks (`onRequest`, `preValidation`, `preHandler`, `onSend`,
`onResponse`) are explicit phases. **Decorators** add new methods/properties to the framework's core
objects. ([Fastify hooks](https://fastify.dev/docs/latest/Reference/Hooks/))

The encapsulation is interesting -- plugins compose without globals -- but our scale doesn't need
it.

### Hardhat (v2 -> v3)

V2: `extendEnvironment(hre => { hre.foo = ... })` decorates the runtime,
`task('name').setAction(...)` defines tasks,
`task('existing').setAction((args, hre, runSuper) => ...)` overrides with `runSuper` for super-call
semantics. V3: replaced with a typed **hook system**: each extension point is a `Hook`, plugins
register `Hook Handlers` for `extendUserConfig`, `validateUserConfig`, `resolveConfig`, etc.
([Hardhat plugin development](https://hardhat.org/docs/plugin-development),
[Hardhat 3 hooks](https://hardhat.org/docs/learn-more/whats-new))

The `runSuper` pattern is the cleanest way I've seen to handle "I want to insert behavior between
existing steps" -- you override a step and call `runSuper()` at the right moment.

### VS Code

Two-layer: **Contribution Points** (declarative JSON in `package.json` -- commands, menus,
languages) and **Activation Events** (`onLanguage:foo`, `onCommand:bar`,
`workspaceContains:**/*.move`) that decide _when_ the extension code wakes up. The declarative layer
is loaded eagerly and used to populate UI; the imperative layer activates lazily.
([Contribution Points](https://code.visualstudio.com/api/references/contribution-points))

Useful split: declarative metadata ("I contribute these things") vs imperative behavior ("here's the
code"). Our plugin object mixes both.

### Apollo Federation

Subgraphs each declare a partial schema;
`extend type Product @key(fields: "id") { inStock: Boolean! }` adds fields to a type owned
elsewhere. Composition (build-time) merges subgraphs into a supergraph; the router routes fields to
the owning subgraph at runtime. Conflicts are detected statically.
([Federated schemas](https://www.apollographql.com/docs/graphos/schema-design/federated-schemas/schema-types))

This is the "schema-merging" pattern: each plugin contributes a typed fragment of a global schema,
and a composer validates + merges. Our `manifest()` + Zod merge is a small instance of this.

## 3. Cross-cutting questions

### Inserting a step between two existing steps

| Tool                    | Mechanism                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Turborepo / Nx / Tekton | Add a node, declare it `dependsOn` step A; make B `dependsOn` the new node. Pure graph edit.                   |
| Hardhat v2              | Override the existing task with `setAction((args, hre, runSuper) => { pre(); await runSuper(args); post() })`. |
| Vite / Rollup           | Tap the same hook with `enforce: 'pre'                                                                         | 'post'` -- but only at hook boundaries, not arbitrary positions. |
| Webpack                 | Same: tap a hook with a stage/order; `*WaterfallHook` lets later plugins transform earlier output.             |
| Bazel                   | Define a new rule whose label is consumed by what used to consume A's label.                                   |
| Just / Make             | Edit the recipe. No injection point.                                                                           |

The graph-edit form (Turborepo/Nx/Tekton) is the cleanest at config time; the `runSuper` form is the
cleanest at code time.

### Plugin A depends on output from plugin B

| Tool           | Mechanism                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Tekton         | `params: - name: digest, value: $(tasks.build.results.image-digest)` -- explicit param/result wiring at config time. |
| Nx             | Outputs declared per target; downstream targets read inputs that include those outputs.                              |
| Webpack        | `AsyncSeriesWaterfallHook` -- each tap returns transformed value, next tap receives it.                              |
| Rollup/Vite    | `first`-kind hooks short-circuit; `enforce` orders; for shared state use a closure or `this.meta`.                   |
| Hardhat v3     | Hooks have typed payloads and return values; downstream hooks receive the merged config.                             |
| Devstack today | Plugins read `ctx.contributions[earlierPluginName]` from a mutable accumulator threaded through the topo walk.       |

Tekton's `results -> params` is the most explicit; ours is the loosest (it's an untyped
`Record<string, DeployContribution>`).

### Failure propagation

Most tools default to fail-fast: first error stops the run, with optional `--continue` /
`continue-on-error` to keep going. Tekton has `finally:` blocks; Nx has dependency-aware skipping
(downstream tasks of a failure are skipped, not failed). Our deploy has no equivalent of `finally:`
-- on failure we leave the user with a half-deployed Compose stack and a comment in CLAUDE.md saying
"callers decide whether to tear down."

### Parallelism

- DAG-based (Turborepo, Nx, Bazel, Mage's `mg.Deps`, Just `[parallel]`, Tekton fan-out): scheduler
  picks ready nodes off the queue.
- Hook-list-based (Vite, Webpack `AsyncParallelHook`): hooks tagged "parallel" all fire
  concurrently.
- Sequential-by-default (Lefthook without `parallel: true`, our orchestrator): order = config order.

Our orchestrator topo-sorts but then runs serially. We've never measured whether plugin `deploy()`
calls could run in parallel for siblings (no `needs` between them); today seal is the only non-sui
plugin so it doesn't matter, but it will once we add walrus + an indexer.

## 4. Recommendations for the devstack

### Is `DevstackPlugin` in good company?

Yes. The "object with optional named hook methods" shape matches Vite, Rollup, and Hardhat v2
closely, and the Project Crystal direction in Nx is similar (a plugin object with optional
`createNodesV2` / `createDependencies`). It's a well-trodden idiom. The tactical wins are
vocabulary, not structural redesign:

- **Hook ordering vocabulary.** Today every hook walks topo order. Adopt Vite's
  `enforce: 'pre' | 'post'` _and_ Rollup's hook-kind labels (`sequential` vs `parallel` vs
  `first`/`bail`) so e.g. `buildImage` can run in parallel where deps allow, and `endpoints()` can
  stay sequential for stable banner ordering.
- **Decouple "declarative metadata" from "imperative behavior"** the way VS Code does.
  `requiredPorts`, `manifestKey`, `manifestSchema`, `needs` are pure data; they could live in a
  `meta` object that's loadable without importing the plugin's runtime code (useful for
  `devstack doctor` over a non-running stack, and for codegen).
- **`runSuper` for the few places we want override semantics.** When walrus eventually wants to wrap
  sui's `deploy()` step (e.g. snapshot blob storage before the publish step lands), expose a
  Hardhat-style override rather than forcing a new hook.

### Should `runDeploy` become a declarative task graph?

**Halfway, not fully.** Going full Tekton/Nx (every step is a typed node with declared
inputs/outputs) buys two things: pluggable insertion of new steps, and parallelism between
independent steps (e.g. `getOrCreateAccounts` and `setupContainerCli` could run concurrently). The
cost is a layer of indirection a single-consumer codebase doesn't need yet.

Concrete proposal -- one step at a time:

1. Refactor `runDeploy` into named functions that each take `(ctx) => Promise<Partial<DeployState>>`
   and merge their result into `ctx`. This is the Mage / `mg.Deps` shape -- still imperative, but
   each step has a typed contract. Today's friction: the function is 250 lines reading from ten
   ad-hoc locals.
2. Sequence them with an explicit array of step references:
   `const steps = [waitForRpc, getAccounts, fundFromFaucet, publishPackages, importPackages, seedTokens, deployPlugins, writeManifest, codegen]`.
   The CLI iterates; each step throws on failure; `--continue` and `--from-step` become trivial
   flags.
3. _Then_ let plugins contribute steps via a typed `steps()` hook returning
   `{ name, after: [...], run: (ctx) => ... }`. That's the smallest declarative task graph that
   solves "I want to insert a step between two existing ones." Don't build it on day one.

The Tekton-style `results: Record<string, ResultValue>` already exists in our `contributions`
accumulator; what's missing is _types_. A `DeployContribution` carrying
`captured?: Record<string, string>` is too loose. Generic the type on the plugin:
`DevstackPlugin<TContrib>` with `deploy: (ctx) => Promise<TContrib>` and
`ctx.contributions: Record<string, unknown>` typed via a per-plugin lookup.

### Plugin A wants output from plugin B

Today: `ctx.contributions[B.name].captured?.foo`. Untyped, runtime-checked.

Cleanest available pattern: **Tekton-style explicit param wiring**
(`needs: [{ plugin: 'sui', as: 'sui' }]`, plugin reads `ctx.deps.sui.results.rpcUrl`) with
TypeScript narrowing on the declared type. This buys static checking that plugin B's contribution
actually has the field plugin A expects; the topo-sort is the same.

A more idiomatic TS form: each plugin exports a typed `contract` (its result shape), and consuming
plugins declare `needs: { sui: typeof suiPlugin.contract }`. That's the Apollo Federation /
`extend type` story translated to a Zod schema -- which we already do for `manifestSchema`.
Extending the same idea to deploy contributions removes a whole class of "I expected
`captured.keyServerId` and got `undefined`" bugs.

### Don't yet need

- **Encapsulation** (Fastify-style child contexts) -- our plugins don't pollute a shared object.
- **Remote cache** -- Turborepo's killer feature, but our deploy is not a content-hashable build.
- **Generators** (Nx) -- we have one consumer per plugin. Re-evaluate when we ship a
  `devstack init <plugin>` UX.

## Sources

- Turborepo --
  [Configuring tasks](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks),
  [Running tasks](https://turborepo.dev/docs/crafting-your-repository/running-tasks),
  [Configuration reference](https://turborepo.dev/docs/reference/configuration),
  [Remote caching](https://turborepo.dev/docs/core-concepts/remote-caching)
- Nx -- [Inferred Tasks (Project Crystal)](https://nx.dev/docs/concepts/inferred-tasks),
  [Extending the Project Graph](https://nx.dev/docs/extending-nx/project-graph-plugins),
  [createNodes API compatibility](https://nx.dev/docs/extending-nx/createnodes-compatibility)
- Bazel -- [Toolchains](https://bazel.build/extending/toolchains)
- Tekton -- [Pipelines](https://tekton.dev/docs/pipelines/pipelines/),
  [Tasks](https://tekton.dev/docs/pipelines/tasks/),
  [Workspaces](https://tekton.dev/docs/pipelines/workspaces/)
- GitHub Actions --
  [Creating a composite action](https://docs.github.com/actions/creating-actions/creating-a-composite-action)
- mise -- [Plugins](https://mise.jdx.dev/plugins.html),
  [asdf-plugins registry](https://github.com/asdf-vm/asdf-plugins)
- Just -- [Dependencies](https://just.systems/man/en/dependencies.html),
  [Parallelism](https://just.systems/man/en/parallelism.html)
- go-task -- [Schema](https://taskfile.dev/docs/reference/schema)
- Mage -- [Dependencies](https://magefile.org/dependencies/)
- Lefthook -- [README](https://github.com/evilmartians/lefthook)
- Vite -- [Plugin API](https://vite.dev/guide/api-plugin)
- Rollup -- [Plugin development](https://rollupjs.org/plugin-development/)
- Webpack -- [tapable](https://github.com/webpack/tapable),
  [Compiler hooks](https://webpack.js.org/api/compiler-hooks/),
  [Plugin API](https://webpack.js.org/api/plugins/)
- Fastify -- [Hooks](https://fastify.dev/docs/latest/Reference/Hooks/),
  [Plugins guide](https://fastify.dev/docs/latest/Guides/Plugins-Guide/)
- Hardhat --
  [v2 plugin development](https://v2.hardhat.org/hardhat-runner/docs/advanced/building-plugins),
  [v3 plugin development](https://hardhat.org/docs/plugin-development),
  [v3 config hooks](https://hardhat.org/docs/plugin-development/explanations/config)
- VS Code --
  [Contribution Points](https://code.visualstudio.com/api/references/contribution-points),
  [Activation Events](https://code.visualstudio.com/api/references/activation-events)
- Apollo Federation --
  [Federated schemas](https://www.apollographql.com/docs/graphos/schema-design/federated-schemas/schema-types),
  [Subgraph spec](https://www.apollographql.com/docs/graphos/schema-design/federated-schemas/reference/subgraph-spec)
