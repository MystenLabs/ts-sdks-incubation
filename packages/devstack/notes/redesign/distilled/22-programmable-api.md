# 22 Programmable API (distilled)

## Purpose

The user-facing surface of devstack — what a `devstack.config.ts` author writes against, and what a
plugin author extends. It translates a declarative description ("I want a Sui localnet, a publisher
account, a Move package, a dev server") into the runtime stack the engine launches. Three concentric
tiers live here:

1. A **top-level entry** that turns a list of stack members (accounts, packages, services, apps)
   into a runnable handle, with sensible defaults filled in.
2. A **tag substrate** by which any service / package / account / action is identified, declares
   dependencies on other members, projects display data for the TUI, and binds itself into the
   resolved dependency graph.
3. **Plugin-author primitives** (long-lived container, content-addressed image build, git clone,
   host process, one-shot container) — higher-level shapes that compose the substrate so a
   third-party plugin can land a new container-backed service in a handful of lines.

## User-experience requirements

- **Minimal config for the common case.** The trivial `devstack.config.ts` should be a one-liner
  that lists what the user wants and Just Works — Sui localnet and a Faucet appear automatically if
  not specified; manifest emission and codegen wiring happen without explicit user setup.
- **Scales to complex setups.** Renderer choice, watch paths, stack name, network, custom state dir,
  custom extras data, and overrides for individual primitives must all be reachable without dropping
  out of the same call.
- **Type-safe dependencies.** When a member yields another tag's value, the type system must surface
  the shape of the resolved value; missing or mistyped dependencies should be caught at compile time
  where feasible.
- **Composability.** Members produced by one plugin must compose cleanly with members from another.
  Default-fills (Sui, Faucet, manifest, codegen wiring) must not collide with user-supplied
  equivalents — the user wins, silently.
- **Override-friendly.** A user must be able to swap any default-filled member (e.g. supply their
  own Faucet, Sui variant, or renderer) without unusual ceremony — the top-level entry should detect
  the equivalent member and suppress the auto-fill.
- **Plugin-extensible.** A third-party plugin author needs a documented escape-hatch tier with
  enough power to declare new tags, build new containers, fetch upstream sources, and attribute
  lifecycle events to their plugin — without reaching into engine internals.
- **One way to do the simple thing, an escape hatch for the hard thing.** Common patterns
  (single-shape service, single-shape package, single-shape action) should have one canonical form.
  Composites that need to project a single body into multiple interface tags, or lift inner siblings
  to top-level for parallel scheduling, are an opt-in advanced path.

## defineDevstack semantics (conceptual)

A config-level call accepts a description of the stack and produces a runnable handle. The handle
exposes:

- A representation of the fully-resolved stack (the layer graph or its moral equivalent) ready to
  run.
- A function to launch it under the current process — taking optional per-launch overrides (renderer
  choice, etc.).
- A function tailored for CLI-style entry that wires signal handling and exit codes.
- An escape that returns the underlying effect/program for callers that want to embed devstack
  inside a larger runtime.

The user expresses the stack as a flat list of members. Each member is either:

- A leaf primitive (a service, account, package, action, app), constructed by calling a factory
  exported by devstack or a plugin.
- A composite that internally lifts inner siblings to the top level (the user does not see this;
  they reference the composite as if it were a single member).

The entry must accept these members in any order — order does not encode dependency. Dependency is
declared by each member.

A trailing options bag (renderer, stack name, watch paths, network, state dir, extras data) is
optional and recognised structurally so the user never has to remember a delimiter between members
and options.

## Tag / provide pattern (conceptual)

A **tag** is a typed identity for a member of the stack: a unique key, the shape of the value it
eventually resolves to, and the metadata needed to display and schedule it. Two construction styles
coexist by intent:

- **Per-instance tag construction** — for one-off members whose identity is unique to that callsite
  (a specific account, a specific Move package, a specific action). The user supplies a name and a
  build function; identity, key, and resolved shape come into being together.
- **Provide-against-canonical-tag** — for members that implement a _shared_ interface tag that other
  parts of the stack consume by type (Sui, Faucet, Postgres, Pyth — anyone that yields "the Sui RPC"
  should get whatever Sui variant was provided). Multiple implementations exist (localnet, testnet,
  mainnet, fork) but they all bind into the same canonical identity. Calling two implementations
  against the same canonical identity in one stack is a configuration error.

A **build function** is the recipe that produces the resolved value, with the engine's lifecycle
hooks (acquiring → ready → failed) wrapped around it automatically.

**Dependencies between members** are declared by each member naming the keys (or references to other
tags) it consumes. The runtime uses these declarations to:

- Topologically schedule acquisition (provider before consumer).
- Compute downstream closures for selective restart when one member's inputs change.
- Surface the dependency edges in the TUI.

A member that yields another tag's value at runtime _must_ also have declared that tag as an
upstream — otherwise it lands as a graph leaf with no incoming edges and any selective-restart
cascade silently misses it. The runtime treats undeclared yields as a soft failure; loud-by-default
warnings are appropriate for an unreleased product.

**Outputs are accessed** by yielding the tag inside any consumer's build function. The resolved
value's shape is determined by the tag's type. A tag's resolved value is also the input to the
optional display projection that shapes how it appears in the TUI.

## Composite primitives at this layer

From the user's perspective a composite is _one_ member. They construct it once, place it in the
stack list, and any siblings it lifts to top level are invisible. Internally, a composite:

- Holds an inner layer graph (e.g. four nodes + a proxy + a config-build action).
- Projects one body into multiple interface tags when downstream consumers should be able to yield
  any of them (e.g. walrus exposing both network and proxy tags from one cluster body).
- Lifts inner siblings to top-level so they appear as independent dep-graph nodes, schedule in
  parallel where possible, and dedupe across multiple composites that share an upstream (e.g. two
  walrus instances sharing the same upstream source clone).

**Lifted siblings** are a key user-facing requirement even though most users won't author them: when
a composite lifts shared inner work (a git clone, a Move build), the runtime must dedupe by key,
schedule in parallel, and present the work as separate top-level rows so the TUI is honest about
what's happening. From the user's perspective the composite "just" parallelises correctly.

**Ordering inside a composite** is provider-before-consumer: inner layers expose values, the primary
body consumes them, projections expose the result under multiple interface tags. A composite that
gets this wrong fails at runtime with a missing-service error — not at compose time.

## Override / extension points

- **Default-filled members.** The top-level entry default-fills Sui and Faucet when not present.
  Detection must work for both the canonical type identity (an exact tag match) and a key-prefix
  variant so a user-renamed equivalent (custom Faucet name) still suppresses the auto-fill.
- **Renderer.** Three modes (interactive TUI, plain text, silent) with TTY-auto-detection as the
  default. Both a per-stack default and a per-launch override are required. CLI flag → per-launch
  override → per-stack option → auto-detect, in that precedence.
- **Watch paths.** A user-level watch list is merged with each member's own watch declaration. A
  change anywhere triggers selective invalidation today; selective per-primitive teardown using each
  member's own watch declarations is a near-term goal.
- **Hot-restart.** A boolean knob to keep watching while suppressing actual restarts (log-only) —
  useful for diagnostic runs.
- **Plugins.** A new plugin loads simply by being imported and its factories called inside the stack
  list. There is no registration step. Plugins surface new tags via the tag/provide pattern and
  lifecycle attribution via a plugin-name annotation.
- **Test-only overrides.** A lower-level entry point accepts an already-built stack with knobs for
  swapping the platform layer, injecting deterministic infra (ports, clocks), and providing a custom
  renderer resolver. Not for production users — pinned at the test fixture surface.

## Type-safety expectations

**Must be checked at compile time:**

- The shape of a tag's resolved value flows through to every consumer that yields it (no `any` at
  the surface).
- Image source for a container primitive cannot be a bare string — the caller must spell out
  pull-vs-build explicitly so the same option can't silently mean two different things at different
  callsites.
- Trailing options to the top-level entry are distinguished from members structurally; an
  accidentally-shaped options-like object that carries a tag identity is still treated as a member.
- Removed/deprecated options (e.g. a lifecycle knob that the engine no longer honours) should fail
  to compile so stale config can't sit silently in user code.

**Acceptably runtime-checked:**

- Duplicate keys between user-authored members at compose time (warn — rare hand-rolled-layer cases
  legitimately collide; first-wins for dep graph, last-wins for layer composition).
- Missing upstream declarations (warn loud-by-default for unreleased devstack; currently gated by
  env var).
- Git repo / ref validation in the git-fetch primitive (synchronous throw at factory construction so
  the stack trace lands at the user's call site, not deep in an effect chain).
- Container ready-probe timeouts, image pull failures, host process timeouts.
- Routing entrypoint name mismatches (the routing layer's concern, but surfaced through the
  container primitive's options).

**Constraints worth elevating to types in the redesign:**

- `StackMember` is currently structural ("anything carrying a layer field") and call sites scatter
  casts to reach optional metadata fields. A richer member type with all metadata first-class would
  remove this.
- A composite/hand-rolled escape-hatch member has no public helper and no first-class type today;
  new code reinventing the shape risks silently breaking the dep graph or TUI sectioning. A
  `compositeTag()`-equivalent should carry the contract in one place.
- Watch-only / hidden / build-only sub-variants of the option bag could exclude fields that don't
  make sense for them (e.g. `hidden` overrides `kind` and `display` semantically — pin that at the
  type level).

## Lifecycle states

**Of the config object:**

- _Authored_ — the user's `devstack.config.ts` exists; calling the top-level entry has not yet
  happened.
- _Composed_ — entry has been called, defaults filled, members flattened (inner siblings lifted),
  dep graph built, watch set aggregated. The handle exists; no actual work has started.
- _Launched_ — the user (or CLI) invoked the run/runMain action. Engine, state store, identity, file
  watcher come up as a bootstrap that survives across hot-restart cycles.
- _Running_ — each cycle: per-primitive scopes acquire in topo order; lifecycle events flow into the
  engine; the renderer presents them.
- _Restarting_ — full (user-triggered) closes every per-primitive scope and rebuilds; selective
  (watch-triggered) invalidates a subset and its downstream closure.
- _Teardown_ — final close cascades through finalizers; bootstrap layer shuts down last.

**Of an individual member:**

- _Seeded_ — entry registered in the TUI as pending (unless hidden).
- _Acquiring_ — build function running.
- _Ready_ — resolved value available; downstream consumers can yield it; the display projection runs
  once at this transition.
- _Failed_ — build error captured; full cause appended to logs in human-readable form; the layer
  build halts and the launch loop waits on a restart signal.
- _Invalidated_ — selective restart closed this primitive's scope (and its downstream closure);
  rebuild on next cycle.

Hidden members go through the same lifecycle but produce no TUI row; failures still propagate
normally.

## Inputs / dependencies

- The user's config file (the list of members + optional bag of options).
- Environment variables for stack name, network, state dir, missing-upstream warnings — each with an
  explicit config override.
- The engine's lifecycle hooks (acquire/ready/fail, log append, primitive-scope registration,
  selective invalidation).
- Identity, state store, file system, child-process spawner, endpoint registry, router-entrypoint
  registry — consumed by plugin-author primitives.
- The runtime platform's standard services (file system, child process, scheduler).

## Outputs / capabilities provided

- A handle (layer/stack representation, config snapshot, run, runMain, escape to a raw
  effect/program).
- Per-member TUI seed entries with key, kind, plugin attribution, and friendly title — feeding the
  renderer.
- Per-member spans for tracing, with structured attributes (image name, repo, ref, container name,
  …).
- Per-member ambient scopes registered with the engine so a future selective invalidation can target
  just that primitive.
- A manifest output that surfaces extras data + per-member endpoints/values for downstream tooling,
  scheduled as the last topo level so every user-stack ref is resolvable when extras runs.
- Codegen emitters wired with sibling-key upstreams so the emitter can yield any user-stack ref
  without racing the topo graph.
- A barrel of plugin-author exports (tag substrate, container/image/git-fetch/host-script
  primitives, registry helpers, faucet strategies, router-entrypoint API, low-level interface tags)
  packaged behind an `/advanced` subpath.

## Invariants and constraints

- **One ordering rule for composites:** inner provides, primary consumes, projections expose the
  result; reversing this fails at runtime with missing-service errors.
- **Tag identity is unique per stack.** Two implementations against the same canonical tag is a
  configuration error; user-authored duplicate keys warn at compose time; lifted-sibling collisions
  across composites are an intended dedupe, not a warning.
- **Hidden members don't reach the engine UI** but still run, still propagate failures, and still
  register their primitive scope.
- **Inputs to `gitFetch` are validated synchronously** at factory construction so misspellings throw
  at config load, not deep in an Effect chain.
- **`dockerImage` is content-addressed** and short-circuits when the daemon already has the tag; the
  context tree-hash must exclude build outputs and caches, and changing that exclusion list
  invalidates every cache hit downstream.
- **`dockerContainer` images are explicit unions** (pull XOR build); bare strings rejected at the
  type level.
- **Builder-form container options** (a function of identity → options) require an image known at
  factory time so the build layer can be wrapped around the container layer — opt-in advanced path.
- **Default-fill detection** matches Sui by exact key and Faucet by key-prefix so user-renamed
  Faucet still suppresses the auto-add.
- **Auto-filled Faucet is hidden** because the user didn't ask for it — surfacing a row they don't
  recognise is confusing.
- **The manifest emitter** must declare every sibling as an upstream so the user's extras body can
  yield anything without race.
- **Lifecycle is one-shot per build**, not per yield: acquire→ready fires once; subsequent yields
  read from the resolved value.

## Edge cases and known failure modes

- Build fails inside a regular member: lifecycle marks failed, error walked into logs, layer build
  halts, launch loop waits on restart signal. User restarts (keypress) or edits config (watch).
- Build fails inside a hidden member: same flow but no row to mark; failure still propagates to the
  consumer's normal failure path.
- Trailing argument to top-level entry can't be classified: structurally inspect for a tag identity;
  a malformed tag-shaped object slips through as a member and produces a clear error downstream.
- Duplicate keys: warn-and-continue (first-wins for dep graph, last-wins for layer composition)
  because some legitimate hand-rolled cases collide; user removes the duplicate.
- Composite lifts a shared inner sibling already lifted by another composite: dedupe silently (the
  whole point of the lift).
- Member forgot to declare upstreams: works at the layer level (memo-map dedupes) but appears as a
  leaf in the dep graph; selective restart drops its downstream cascade silently. Loud-by-default
  warning is the right redesign default.
- Container ready-probe times out: error tags the phase, includes container log tail.
- Stale removed option (e.g. an old lifecycle knob): must fail at the type level so users can't
  carry obsolete config forward silently.

## Learnings from current implementation

**Works well, preserve as a property:**

- Variadic + trailing-options entry feels natural for the simple case yet scales to many members.
- Default-fill of Sui + Faucet (with key-prefix dedupe for renamed user variants) keeps the trivial
  config a one-liner without preventing customisation.
- Tag pattern unifies identity, type of resolved value, lifecycle hooks, and display projection in
  one binding — consumers yield by tag and the type flows through.
- Per-instance vs canonical-interface tags is the right axis. Most members are per-instance; shared
  interfaces (Sui, Faucet, Postgres) get the canonical treatment.
- Plugin-author primitives (container, image, git-fetch) make new container-backed services land in
  ~15 lines.
- Hidden tags as a first-class option (build runs, no UI row, failures still propagate) cleanly
  model the cache-clone-of-an-upstream case.
- Lifted siblings via composites is the right answer for honest parallel scheduling and dedupe.
- One-shot per-build lifecycle (rather than per-yield) is simple and correct.
- Synchronous validation at primitive-factory construction (git-fetch repo/ref) keeps stack traces
  at user call sites.

**Awkward today, candidate to fix in the redesign:**

- Tag substrate mutates the canonical class in-place to attach metadata; safer if metadata lives
  alongside the class rather than on it.
- Hand-rolled composites duplicate the same field set as a plain object with no helper; a
  first-class composite helper would centralise the contract.
- The lifecycle wrap that the regular tag substrate applies does _not_ apply to hand-rolled
  composites — they call acquire/ready/fail manually and re-thread phase setters. A new engine
  method requires touching every composite.
- Two ways to attribute a plugin name (option on tag/provide, or post-construction stamping) — pick
  one.
- Trailing-options vs member discrimination depends on a brand symbol that hand-rolled composite
  POJOs don't always carry; the rule works today by accident in some cases.
- Codegen-prefixed members get post-compose upstream patching to read user extras — a one-off escape
  that doesn't generalise. A declarative "this member reads extras" opt would let manifest and
  codegen share the same path.
- Missing-upstreams check is gated by env var; for unreleased devstack the default should be loud.
- The `StackMember` interface is structural and consumers cast to reach optional fields; a richer
  member type would remove the casts.
- Two sunset-marked primitives (one-shot container, host-script) currently have no in-tree callers;
  the redesign should either justify retention or drop them at the documented sunset date.

## Cross-component references

- **Engine core** owns the supervisor, dep graph builder, topo scheduler, lifecycle hooks,
  primitive-scope registration, and selective-invalidation API. The programmable API is the
  user-visible layer above it.
- **Observability** consumes spans and span attributes emitted by every plugin-author primitive.
- **Runtime / Docker** is consumed by `dockerImage`, `dockerContainer`, `dockerOneShot` (image
  build/pull, container run/adoption, label-based sweep).
- **Router** registers entrypoints that container primitives reference by name.
- **Codegen** registers emitters that need sibling-key upstream patching to read user extras.
- **Sui / Faucet** are default-filled by the top-level entry's auto-fill logic.
- **Walrus / Seal** are the canonical composite-primitive sites that exercise the lifted-siblings +
  multi-projection escape hatch.
- **Snapshot** consumes the content-addressed image tags from `dockerImage` and the cached results
  from one-shot primitives.
- **CLI** wraps the handle's run/runMain and supplies the renderer override.

## Open questions / decisions deferred

- The shape of a first-class composite helper: what fields must it carry, what lifecycle hooks does
  it own vs delegate, and is its surface advanced-only or part of the main barrel?
- Ordering semantics for deeply-nested composites: if A lifts B and B lifts C, where does C end up
  in the dep graph?
- Should the lower-level entry (test-fixture-targeted) also default-wire renderer detection, or stay
  silent unless told?
- Generalised "this member reads extras" opt vs the current per-prefix patching for codegen +
  manifest.
- Whether the missing-upstream warning should be loud-by-default (likely yes, per
  unreleased-devstack stance) or escalate to a throw.
- Whether to fold the `makeService` plugin-name stamping into the tag/provide options bag and remove
  the duplicate path.
- Whether the long-lived container primitive should be repackaged as the canonical race-safe
  `containerPrimitive` shape that the runtime layer already prefers internally, deprecating the
  older surface.
- Sunset disposition for one-shot container + host-script (no in-tree callers, plugin-author surface
  only).
- Whether to expose tiered subpath imports (`/advanced/substrate`, `/advanced/plugin-author`, …) for
  tree-shake-friendly navigation.

## Opportunities noticed

- Centralise the metadata-stamping pattern in one helper; both construction styles currently
  duplicate the same conditional field assignment, and hand-rolled composites duplicate it again.
- Provide a first-class `compositeTag` helper so the contract (inner→primary→projections ordering,
  lifted siblings, manual lifecycle attribution) lives in one place instead of being reinvented per
  composite site.
- Pick one path for plugin-name attribution and remove the redundancy between the tag/provide option
  and the post-construction stamping HOF.
- Generalise the codegen-sibling-keys patch via a declarative "reads extras" opt so manifest and
  codegen share one path.
- Default-loud for missing-upstream warnings on unreleased devstack.
- Tighten `StackMember` to carry the metadata fields first-class and eliminate the scattered casts
  in supervisor code.
- Standardise the span-name convention across all plugin-author primitives via a single helper.
- Either repackage the container primitive on the race-safe shape that the runtime layer already
  prefers, or document explicitly why the simpler historical surface stays.
- Split the container-primitive module so the public surface and the in-tree pre-resolved-image
  escape hatch don't share a file.
- Pin hidden-or-not at the type level so options that don't apply to hidden members (display, kind)
  can't be accidentally passed.
- Make the trailing-options discriminator a positive brand check on members rather than a negative
  one on options, so hand-rolled members can opt in explicitly and the ambiguity around composites
  disappears.
- If one-shot container + host-script pass their sunset date without callers, delete them in one go
  (source + barrel + tests).
