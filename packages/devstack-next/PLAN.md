# Devstack Architecture Redesign

## Context

`packages/devstack/` has accreted to ~29k LoC across 148 files and feels sprawling. The user wants
to redesign the architecture from first principles, one layer at a time, **fully designed before
writing any code**.

**Clean-implementation directive**: this is a parallel rebuild, not a refactor. No code from the
current `packages/devstack/` is being preserved or migrated. The current file layout is considered
bad and is being abandoned. The current code's behavior is informative (what use cases must work)
but its structure is not. No compatibility shims.

This document is a working plan — it captures the design in progress, not a finished proposal. We
start with the core runtime layer and expand outward.

## Phase 1 findings (current state)

The current code is closer to a clean layered design than initially thought, but with three sources
of mess:

1. **Bundled-but-extractable concerns inside `runtime/`** — manifest I/O, port allocator, accounts
   materialization, file-watcher, snapshot, supervisor-lock, active-stack are all peer concerns
   living next to the actual engine (reconciler/supervisor/topo/one-shot).
2. **8 action discriminators when 2 would suffice** —
   `Build`/`Service`/`HostProcess`/`Publish`/`Register`/`Seed`/`Emit`/`Verify` collapse to
   **Process** (long-running) and **Action** (one-off), with dirtiness and status-failure policy as
   pluggable per-action declarations.
3. **3 places where action-kind knowledge leaks into reconcile.ts** — `Seed` import (`seedRunsOn`),
   `Verify` special path (`evaluateVerify`), `Emit` cascade serialization. Two are easy fixes; the
   third (Emit) is genuinely deep semantic glue.

The cli/vitest/playwright frontends are already thin wrappers over `Supervisor` / `runOneShot`, so
the outermost layer is fine.

## Design decisions made so far

- **2 node shapes**: `Process` (start/stop/health, restart-on-input-change) and `Action`
  (run-once-when-dirty, getStatus as satisfaction check). Today's 8 discriminators collapse here.
- **Pluggable dirtiness signal**: input-hash (default), kind subscription (today's Emit), or
  always-with-no-run (today's Verify). Removes the need for separate types.
- **Pluggable status-failure policy**: re-fire (default) or abort-cycle (Verify).
- **Process has pluggable runner**: host-process, docker-container. Today's
  `Service`/`HostProcess`/`ContainerService` are 3 implementations, not 3 types.
- **`deps:` accepts either an array or an object** — same JS destructuring shapes:

  ```typescript
  // Object form (with renaming or shorthand):
  define({
    deps: { account, rpc },                    // shorthand: vars in scope
    run: ({ deps: { account, rpc } }) => ...,
  });

  define({
    deps: { acc: sui.get('account', { name: 'publisher' }), r: sui.get('rpc') },
    run: ({ deps: { acc, r } }) => ...,
  });

  // Array form (positional):
  define({
    deps: [sui.get('account', { name: 'publisher' }), sui.get('rpc')],
    run: ({ deps: [account, rpc] }) => ...,
  });
  ```

  The shape passed to `run`/`start` mirrors the shape declared in `deps:`. Engine doesn't care — it
  walks the structure either way to collect Deps.

- **Runtime data-flow uses Deps only**: there is no registry-as-runtime-mechanism. Everything
  between actions/plugins during reconcile flows through typed `Dep<T>` values.

- **Typed representations live on each NodeState** (not as a separate WorldView):

  Producers optionally declare `represents:` callbacks that project their result into typed shapes
  (Package, Service, Account, custom kinds). Engine runs these at end-of-cycle and stores the
  projections directly on the NodeState. There is no separate "WorldView" object — there's just
  per-node state, which carries both the raw result AND the typed projections.

  ```typescript
  // Shared shape types from @mysten-incubation/devstack/shapes
  // Plugins can define their own shapes too.
  interface Package { name: string; packageId: string }
  interface Endpoint { name: string; url: string; kind: string }   // renamed from "Service"
  interface Account { name: string; address: string }

  const sui = define({
    start: async (...) => ({ rpcUrl, faucetUrl, containerId }),
    represents: {
      endpoints: (r): Endpoint[] => [
        { name: 'sui-rpc', url: r.rpcUrl, kind: 'rpc' },
        { name: 'sui-faucet', url: r.faucetUrl, kind: 'faucet' },
      ],
    },
  });

  const token = define({
    run: async (...) => ({ packageId, treasuryCap }),
    represents: {
      packages: (r): Package[] => [{ name: 'token', packageId: r.packageId }],
    },
  });

  // On-disk: just nodes + their states + per-node representations.
  // {
  //   nodes: {
  //     'sui.localnet': {
  //       state: { rpcUrl, faucetUrl, containerId },
  //       representations: { services: [...] },
  //       lastInputHash, lastRunAt, ...
  //     },
  //     'token.publish': {
  //       state: { packageId, treasuryCap },
  //       representations: { packages: [...] },
  //     },
  //   },
  // }
  ```

  Tools that want categorized views project on demand:

  ```typescript
  const allEndpoints: Endpoint[] = Object.values(manifest.nodes).flatMap(
  	(n) => n.representations?.services ?? [],
  );
  ```

  Properties:
  - `represents:` is **optional** per producer per category. portAllocator skips it.
  - Categories are open-ended — any plugin can emit `represents: { walrusNodes: ... }`. No
    `defineKind` ceremony.
  - **Single source of truth**: NodeStates carry the projections. No separate WorldView aggregate to
    maintain. "WorldView" is just a vocabulary for the tool-side projection pattern, not a persisted
    object.
  - Consumers **never** read representations during reconcile. They use typed Deps for runtime data
    flow. Representations are purely for observability (status, TUI, web dashboard, vitest, etc.).
  - Producers can opt into shared shape types from `@mysten-incubation/devstack/shapes` so UIs
    render uniformly. New plugins define their own shapes as needed.

  A `Dep<TData, TConsumerView>` has the shape:

  ```typescript
  type Dep<TData, TConsumerView> = {
  	data?: TData; // request payload sent up to the producer
  	get: (producerState) => TConsumerView; // project consumer's typed value from producer state
  	// ...plus an internal __producer back-reference and a `type` discriminator (the provides key)
  };
  ```

  Plugin authors expose Deps however suits the API:

  ```typescript
  const sui = {
  	hostname: { get: () => 'localhost:9000' }, // static, no producer call
  	account: (name: string) => ({
  		data: { name },
  		get: (result) => result.accounts[name], // projects from sui.run() output
  	}),
  	rpc: { get: (result) => ({ url: result.rpcUrl }) },
  };
  ```

  Engine flow:
  1. **Build**: walk the graph from root producers; for each Dep, follow `__producer` back-ref to
     add producers transitively. Collect each Dep's `data` payload into the producer's request
     bucket grouped by Dep `type` (the `provides` catalog key).
  2. **Resolve**: invoke each producer's `start`/`run(args)` with `args.requests` (typed by
     `provides`) and `args.deps` (resolved upstream values). Producer returns its new state.
  3. **Inject**: when resolving a consumer's `deps`, engine calls each Dep's
     `get(producerState, data)` to project the consumer's typed value.

  ```typescript
  const fund = define({
  	deps: {
  		account: sui.get('account', { name: 'publisher' }),
  		rpc: sui.get('rpc'),
  	},
  	run: async ({ deps: { account, rpc } }) => {
  		// account: { address: string }   ← typed from sui.provides.account.get
  		// rpc:     { url: string }       ← typed from sui.provides.rpc.get
  		return undefined;
  	},
  });
  ```

  No registry. No string keys. No publish/subscribe. The Dep IS the dependency edge AND the data
  channel.

- **Ambient deps via Dep back-references**: because every Dep carries a back-ref to its producer
  plugin, listing it in any `deps:` automatically pulls the producer into the graph. Config
  simplifies dramatically:

  ```typescript
  // Before: explicit plugin list, order-fragile
  { plugins: [sui(), accounts({ publisher: ... }), codegen()] }

  // After: just declare leaf consumers; producers pulled in transitively
  { plugins: [codegen({ deps: [sui.account('publisher')] })] }
  ```

  Plugin authors no longer have to remember which plugins need to be added explicitly — the
  dependency closure is computed from the needs.

- **Engine state is purely internal**: input hashes, identity, "is done" — user code never sees it.
- **Today's "registry" is split**: most current uses become typed direct deps; the genuinely
  cross-cutting kinds (packages-for-codegen, services-for-frontend) become broadcast kinds. The
  conflated `ctx.registry.services.require('sui-rpc')` pattern goes away.
- **Ports, accounts, etc. become graph nodes**: not ambient runtime fixtures. A `portAllocator`
  Process node has `outputs: { allocate: (req) => Promise<number[]> }`; actions
  `deps: { ports: portAllocator }` and call `ctx.deps.ports.allocate(...)`. Same for the
  `accountPool`. Runtime engine has zero domain knowledge.

## Proposed layering

Layers stack bottom-up; each layer depends only on layers below.

```
┌─────────────────────────────────────────────────────────────┐
│  L7: Frontends + persistence (cli/, vitest/, playwright/)   │
│      Thin wrappers around Engine. Read/write SnapshotRecord │
│      JSON to disk. Stack management. TUI subscriber.        │
├─────────────────────────────────────────────────────────────┤
│  L6: Plugins (plugins/)                                     │
│      Bundles of (graph nodes + actions) for a domain.       │
│      sui, walrus, seal, deepbook, codegen, accounts, etc.   │
├─────────────────────────────────────────────────────────────┤
│  L5: Action helpers (actions/)                              │
│      Sugar over L4 primitives.                              │
│      publishMove, runTransaction, registerCoin.             │
├─────────────────────────────────────────────────────────────┤
│  L4: Action primitives + runners + standard graph nodes     │
│      action() factory, process() factory.                   │
│      Process runners: hostProcess, dockerContainer.         │
│      Standard graph nodes: portAllocator, accountPool.      │
├─────────────────────────────────────────────────────────────┤
│  L3: Execution context (runtime/context)                    │
│      Graph build (transitive Dep walk). NodeCtx.            │
│      defineDevstackConfig({ stack, ... }).                  │
├─────────────────────────────────────────────────────────────┤
│  L1: Graph engine (engine/)                                 │
│      Nodes, edges, reconciliation, input hashing, identity  │
│      cascades, topo sort, event emission, snapshot in/out.  │
│      Pure logic. No I/O, no domain knowledge.               │
│      (L2 removed — engine has no persistence layer.)        │
└─────────────────────────────────────────────────────────────┘
```

### Key boundary properties

- **L1 has zero domain knowledge.** It doesn't know about Docker, signers, ports, RPC URLs, or what
  a "package" is. It operates on opaque `Node` objects with two channels: typed direct outputs (1:1
  deps) and broadcast kinds (N:M).
- **L3 is the action contract.** What actions see in `ctx`: `ctx.deps.<alias>` (typed from `deps:`),
  `ctx.publish/consume` (for kinds), `ctx.env`, `ctx.appendLog`, `ctx.onShutdown`, `ctx.inputHash`.
  No string-based registry lookups.
- **L4 ships standard graph nodes and kinds.** `portAllocator` and `accountPool` are Process nodes
  with typed outputs. `packages` and `services` are kinds (only useful when you genuinely have many
  publishers OR many consumers). Both ship with devstack but neither is built into the engine.
- **L6 plugins compose L4 primitives.** `sui()` plugin uses
  `define({ runner: dockerContainer(...), deps: { ports: portAllocator } })` to run the localnet.
  The localnet's typed outputs (rpc/faucet URLs) are consumed directly by `accounts.fund` via
  `deps: { sui }`. The localnet _also_ publishes service entries to the broadcast `services` kind so
  the frontend codegen can list them all.

## L1 — Graph engine: detailed design

### Core types

```typescript
// A typed Dep recipe — declared inside a producer's `provides:` catalog.
// The producer's TState and the recipe's TData are linked via the get fn signature.
interface DepRecipe<TState, TData, TConsumerView> {
	__dataBrand?: TData;
	get: (state: TState, data: TData) => TConsumerView;
}

// Helper to construct a recipe with TS inference. TData defaults to void.
//
//   dep((state) => ({ url: state.rpcUrl }))                      // TData = void
//   dep((state, data: { name: string }) => state.accounts[data.name])
//
function dep<TState = any, TData = void, TConsumerView = unknown>(
	get: (state: TState, data: TData) => TConsumerView,
): DepRecipe<TState, TData, TConsumerView>;

// A consumed Dep — what `producer.get('key', args?)` returns. Engine reads __producer + type.
interface Dep<TData, TConsumerView> {
	__producer: Producer<unknown, any>;
	type: string; // catalog key from producer.provides
	data?: TData;
	get: (state: unknown, data: TData) => TConsumerView;
}

// `provides:` catalog. Keys are the dep types (the discriminator engine groups by).
type Provides<TState> = Record<string, DepRecipe<TState, any, any>>;

// A producer is a node that other nodes can dep against.
// Identity = reference equality. The TProvides generic types its `get` accessor.
interface Producer<TState, TProvides extends Provides<TState>> {
	__id: symbol;
	__stateBrand?: TState;
	__providesBrand?: TProvides;
	name: string;
	// (No 'kind' discriminator — lifecycle determined by which hooks the impl provides)

	// Fully-typed Dep accessor derived from provides.
	// - If recipe has TData = void: get('key') with no args.
	// - If recipe has TData ≠ void: get('key', dataArg) is required.
	get: <K extends keyof TProvides>(
		key: K,
		...args: ProvidesData<TProvides, K> extends void ? [] : [ProvidesData<TProvides, K>]
	) => Dep<ProvidesData<TProvides, K>, ProvidesView<TProvides, K>>;
}

// Helper conditional types
type ProvidesData<TP, K extends keyof TP> = TP[K] extends DepRecipe<any, infer D, any> ? D : never;
type ProvidesView<TP, K extends keyof TP> = TP[K] extends DepRecipe<any, any, infer V> ? V : never;

// One unified node shape. No action vs service factory distinction.
// Lifecycle behavior emerges from which optional hooks the impl provides.
//
// At least one of `start` or `run` must be present. All other hooks are optional.
interface NodeImpl<TState, TProvides extends Provides<TState>, TDeps> extends Producer<
	TState,
	TProvides
> {
	deps?: TDeps;
	provides?: TProvides;

	// ── Lifecycle hooks ──

	// Setup phase. Always called every cycle. Use for long-running infrastructure
	// (containers, host processes) that should stay alive across cycles. Impl returns
	// state, typically resumes prior. Cheap when the resource is already up.
	start?: (args: RunArgs<TState, TProvides, TDeps>) => Promise<TState>;

	// Work phase. Engine handles input-hash skip by default — only called when
	// inputHash differs from prior (or getStatus says not-ok).
	// Use for transactional operations (publish, register, emit).
	// If `start` is also defined: run receives start's returned state as `prior`,
	// and start runs first within the cycle.
	run?: (args: RunArgs<TState, TProvides, TDeps>) => Promise<TState>;

	// Cleanup. Called on engine.stop() and as part of default `restart` (stop + start).
	stop?: (args: { env: Env; log: LogFn; state: TState }) => Promise<void>;

	// Restart. Called when engine.restart(name) or ctx.requestRestart() is invoked.
	// Default: stop + start. Override for efficient impls (docker signal reload, etc.).
	restart?: (args: RunArgs<TState, TProvides, TDeps>) => Promise<TState>;

	// ── Optional skip override ──

	// Override the default input-hash-based skip for run. Returns { ok: true } → skip.
	getStatus?: (args: {
		prior: TState | undefined;
		deps: ResolvedDeps<TDeps>;
		inputHash: string;
		env: Env;
	}) => Promise<{ ok: boolean }> | { ok: boolean };

	// ── Optional input-hash material ──

	// Folded into inputHash. Use for material beyond upstream identities (file content, env vars).
	inputs?: (args: { env: Env; deps: ResolvedDeps<TDeps> }) => unknown | Promise<unknown>;

	// ── Snapshot ──

	// Called during engine.saveSnapshot(). Returns augmented state for the record.
	snapshot?: (args: { env: Env; state: TState }) => Promise<TState>;

	represents?: Represents<TState>;
}

// Identity is auto-derived from state hash by the engine. No manual identity callback.
// State change → identity change → downstream nodes' inputHash flips → cascade re-fires.

// RunArgs — single object passed to start/run. Producer destructures what it uses.
type RunArgs<TState, TProvides extends Provides<TState>, TDeps> = {
	// Cycle-global:
	env: { appName: string; appDir: string; network: string; stack?: string };
	log: (line: string) => void;
	onShutdown: (fn: () => Promise<void>) => void;

	// Node-specific:
	inputHash: string;
	prior: TState | undefined;
	// Requests auto-typed from provides catalog: each key in provides → array of its TData
	requests: { [K in keyof TProvides]: ProvidesData<TProvides, K>[] };
	deps: ResolvedDeps<TDeps>;
};

// Optional projections from plugin state into typed categories for UIs/tools.
type Represents<TState> = Record<string, (state: TState) => unknown[]>;

// Engine-persisted per-node state. Engine writes/reads this; producers don't see the wrapper.
interface NodeState<TState> {
	// Engine-managed (opaque to plugin):
	lastInputHash?: string;
	lastRunAt?: number;
	identity?: string;

	// Plugin-managed (engine persists/retrieves but doesn't read):
	state?: TState; // whatever start/run last returned
	representations?: Record<string, unknown[]>; // computed via represents callbacks at end-of-cycle
}

// Resolved deps: shape mirrors the declared deps.
// Object input → object output (keys preserved); array input → array output (positional).
type ResolvedDeps<TDeps> = {
	[K in keyof TDeps]: TDeps[K] extends Dep<unknown, infer R> ? R : never;
};
// Note: this single mapped-type definition naturally handles both object and tuple
// (readonly array) inputs because TS treats both as objects keyed by their indices/names.
```

### Engine flow (one cycle)

```
1. BUILD GRAPH
   - Walk leaf consumers' needs.
   - For each Dep, look at __producer back-ref → add producer to graph.
   - Recurse into producer's own needs (transitive).
   - Result: set of producer nodes + edges, with each producer's
     aggregated request set (data payloads grouped from downstream).

2. TOPO SORT
   - Stable topological order. Cycle detection.

3. EXECUTE (in topo order)
   For each node N:
     a. Build RunArgs (env, log, onShutdown, prior, requests, resolvedDeps).
     b. Resolve N's own deps:
        - For each (alias, dep) in N.deps:
          - Look up producer P's persisted state.
          - Call dep.get(P.state, dep.data) → resolved value.
        - Pass as `resolvedDeps` mirroring N.deps' shape (object or array).
     c. Compute inputHash:
        - Hash of: upstream identities (from each dep's producer's persisted identity)
          + N's own `inputs(args)` callback result (if defined)
        - Engine-managed; passed in RunArgs.inputHash
     d. Lifecycle dispatch (sequential within the cycle):
        i.  If N.start defined: state = await N.start(args). Always called.
        ii. If N.run defined:
            - Compute shouldRun:
              · If N.getStatus defined: call it; shouldRun = !result.ok
              · Else: shouldRun = inputHash !== prior.lastInputHash
            - If shouldRun: state = await N.run({ ...args, prior: state ?? prior })
            - Else: state = state ?? prior  (run skipped, state unchanged)
        iii. If neither defined: error at config-load time (validation).
     e. Compute identity = hash(state) — engine-managed; no plugin callback.
        If identity differs from prior.identity, mark downstream nodes dirty
        (their inputHash will flip next cycle).
     f. Run N.represents callbacks against the new state → update
        NodeState.representations for tools/UIs.
     g. Persist updated NodeState (lastInputHash, state, identity, representations,
        timestamps) at end of cycle.

4. PERSIST
   - Write all NodeStates back to manifest (single atomic write).
```

### Public Engine API + subscribable state

The Engine has **no I/O of its own**. It takes an optional initial snapshot at construction; outer
layer drives all storage. UIs subscribe to events for live updates.

```typescript
class Engine {
	constructor(
		config: DevstackConfig,
		opts: {
			env: { appName: string; appDir: string; network: string; stack?: string };
			initialSnapshot?: SnapshotRecord; // resume from here, or start fresh
		},
	);

	// Lifecycle modes
	runOnce(): Promise<CycleResult>; // one-shot — for `devstack apply`
	start(): Promise<void>; // long-running — for `devstack up`
	stop(): Promise<void>; // graceful shutdown

	// State + subscription — every UI uses these
	getState(): EngineState; // current runtime state, sync read, no side effects
	subscribe(handler: (event: EngineEvent) => void): () => void; // returns unsubscribe

	// Pause/resume — for snapshot save cooperation
	pause(): Promise<void>; // finish in-flight work, hold still without starting new
	resume(): Promise<void>;

	// Snapshots — pure in/out, no storage. Outer layer persists/loads SnapshotRecords.
	// Forwards-only: there is NO restoreSnapshot() on a running engine. To restore,
	// construct a new Engine with `initialSnapshot`. Plugins never see a "restore" call.
	saveSnapshot(): Promise<SnapshotRecord>;
}

interface SnapshotRecord {
	createdAt: number;
	env: { appName: string; network: string; stack?: string };
	nodeStates: Record<string, NodeState<unknown>>;
	meta: { devstackVersion: string };
}

// EngineState is a structured view of "what's happening right now"
interface EngineState {
	cycle: {
		id: number;
		startedAt?: number;
		status: 'idle' | 'running' | 'paused';
	};
	nodes: Map<string, NodeView>; // keyed by producer.name
}

interface NodeView {
	name: string;
	// (No 'kind' discriminator — lifecycle determined by which hooks the impl provides)
	status: 'idle' | 'running' | 'satisfied' | 'errored' | 'skipped';
	state?: unknown; // plugin's persisted state (typed externally if needed)
	representations?: Record<string, unknown[]>;
	lastInputHash?: string;
	lastRunAt?: number;
	durationMs?: number;
	lastError?: { message: string; stack?: string };
	logs: string[]; // recent log lines (bounded ring buffer)
}

// Events for "something changed" notifications
type EngineEvent =
	| { type: 'cycle:start'; cycleId: number }
	| { type: 'cycle:end'; cycleId: number; durationMs: number }
	| { type: 'node:status'; name: string; before: NodeStatus; after: NodeStatus }
	| { type: 'node:log'; name: string; line: string }
	| { type: 'node:state-changed'; name: string }
	| { type: 'engine:error'; error: Error }
	| { type: 'shutdown' };
```

Engine internals call `emit(event)` whenever state changes. Subscribers get notified; they can
re-read `getState()` for the full picture or pull just what changed from the event payload.

### What L1 owns

- `Dep`, `Producer`, `Process`, `Action`, `NodeState`, `NodeCtx` types
- The Engine class with public API (`runOnce`, `start`, `stop`, `getState`, `subscribe`, `pause`,
  `resume`)
- `EngineState`, `NodeView`, `EngineEvent` types
- Graph build (transitive Dep walking, request aggregation) — delegated to L3 module but exposed via
  Engine constructor
- Topo sort + cycle detection
- Reconciliation loop
- Per-`runsAs` serialization (only one inflight per signer key)
- Identity cascades
- In-memory `NodeState` map across cycles
- Event emission on every state change
- Snapshot in/out via SnapshotRecord (no I/O, no host)

### What L1 does NOT own

- Disk I/O — engine has none. Outer layer reads/writes SnapshotRecord JSON.
- NodeCtx construction — L3 (engine calls `host.buildCtx(node)`)
- Process/Action _implementation_ — L4 (engine calls user-supplied `start`/`run`)
- Docker, signers, ports, accounts — L4+
- Anything CLI-specific

### File layout

```
packages/devstack/src/engine/
  types.ts          — Node, Dep, Producer, NodeState, NodeCtx
  build.ts          — graph build from leaf consumers (transitive Dep walk)
  topo.ts           — extracted from current runtime/topo.ts, unchanged
  cycle.ts          — main reconciliation loop (Engine.cycle())
  identity.ts       — input hash + identity cascade computation
  serialize.ts      — pure NodeState ↔ JSON (no fs)
  index.ts          — public exports
  *.test.ts         — unit tests with synthetic producers
```

### Test strategy

- L1 is pure logic. Tests construct an `Engine` with a small synthetic config (test producers like
  `define({ start: async () => 42 })`) and an optional initialSnapshot.
- No fs, no Docker, no real producers needed.
- Test nodes are simple: `start: async () => 42`. We assert engine behavior (ordering, dirty
  propagation, skip on hash match, etc.) without any domain logic.
- Test that:
  - Topo order is correct; cycles throw
  - Aggregated request set arrives at producer
  - `Dep.get()` is called with the producer's last result
  - Skipping uses prior result for downstream Dep resolution
  - Identity cascades propagate dirtiness downstream
  - `runsAs` serialization holds (only one inflight per signer key)
  - Per-cycle state diff is correctly computed and handed to L2

### Use cases the new code must cover

(Derived from current code's behavior — but no code is being migrated.)

- One-shot `apply` mode (run graph to satisfaction, exit)
- Long-running `up` mode with file watching, hot-reload, supervisor lock
- Status reporting (read NodeStates, format human/JSON output)
- Snapshot save/restore (Docker images + NodeStates) cooperating with engine via pause/resume
- Action shapes today: build images, run containers, run host processes, publish Move, register,
  seed, emit codegen, verify invariants — all collapse to Process or Action under new model
- Multiple stacks per app (localnet); per-network state for live-net
- Test integrations: vitest globalSetup discovers a manifest, playwright stack-per-file

## L4 — define/defineSchema factories + standard nodes: detailed design

### Plugin pattern via `defineSchema()` (for plugins that take config)

For plugins that take config (most plugins), `defineSchema()` returns a plain object with two
methods: `create(config)` to instantiate and `get(key, args?)` to build static Deps. **Not a
callable** — just methods on an object.

```typescript
// In @mysten-incubation/devstack (src/plugins/sui.ts):
import { defineSchema, dep, define, ports } from '@mysten-incubation/devstack';

type SuiState = {
	rpcUrl: string;
	faucetUrl: string;
	accounts: Record<string, string>;
	containerId: string;
};
type SuiConfig = { network: Network; image?: string };

export const sui = defineSchema('sui', {
	state: type<SuiState>(),
	provides: {
		endpoint: dep<SuiState>((s) => ({ url: s.rpcUrl })),
		faucet: dep<SuiState>((s) => ({ url: s.faucetUrl })),
		account: dep<SuiState, { name: string }>((s, { name }) => ({ address: s.accounts[name] })),
	},
	create: (config: SuiConfig) => {
		if (!config?.network) throw new Error('sui requires { network } config');
		if (config.network === 'localnet') {
			// Real Producer — spins up container
			return define({
				name: 'sui.localnet',
				deps: { rpcPort: ports.get('allocate', { slot: 'sui.rpc' }) },
				start: async ({ prior, deps }) => {
					/* docker start */
				},
				// ...
			});
		}
		// Stub Producer — no container; just a static endpoint URL
		return define({
			name: `sui.${config.network}`,
			start: async () => ({ rpcUrl: rpcForNetwork(config.network), accounts: {} /* ... */ }),
		});
	},
});
```

User-side:

```typescript
import { sui, codegen } from '@mysten-incubation/devstack/plugins';

defineDevstackConfig({
	stack: [
		sui.create({ network: 'localnet' }), // adds Producer instance to stack
		codegen.create({ host: sui.get('endpoint') }), // static Dep; engine wires at graph build
	],
});
```

**`sui` is a plain object** with `.create()` and `.get()` methods:

- `sui.create(config)` → calls factory, returns a Producer.
- `sui.get('endpoint')` → static `Dep<void, { url: string }>` referencing the sui schema.
- `sui.get('account', { name: 'publisher' })` → static `Dep<{name}, {address}>`.

**Lazy by network**: plugin authors can branch on config inside `create()`. On localnet, spin up a
container; on testnet/mainnet, return a stub Producer that just exposes static endpoint URLs. Same
Dep contract for consumers either way.

**Engine resolution at graph build**:

- For each Dep: check `__producer` (concrete instance) vs `__pluginId` (schema ref).
- If schema: search the stack for a Producer whose plugin === this schema.
  - 0 matches: error "codegen depends on `sui.get('endpoint')` but no sui instance in the stack —
    add `sui.create({...})` to your config."
  - 1 match: use that Producer.
  - > 1 matches: error "ambiguous — multiple sui instances; use the specific instance's `.get(...)`
    > accessor."

### Eager-export pattern (for plugins with no required config)

For plugins like `ports` (no config), the simplest pattern is to **eagerly export a Producer at
module load**:

```typescript
// In @mysten-incubation/devstack/standard:
export const ports = define({
	name: 'ports',
	provides: { allocate: dep<PortsState, PortRequest, number>((s, req) => s.map[req.slot]) },
	start: async ({ prior, requests }) => {
		/* ... */
	},
});

// `ports.get('allocate', {...})` returns Dep with __producer = ports (concrete).
// Engine pulls ports into graph via Dep back-ref. User never explicitly adds it.
```

Both patterns coexist:

- **Eager export** for no-config plugins (ports). Produces concrete Deps via `__producer`.
- **`defineSchema()`** for config-taking plugins (sui, walrus, etc.). Produces schema Deps via
  `__pluginId`.

Both expose the same `.get(...)` accessor surface.

**Updated `Dep` type** to support both modes:

```typescript
interface Dep<TData, TConsumerView> {
	__producer?: Producer<unknown, any>; // EITHER: concrete instance ref (eager exports)
	__pluginId?: symbol; // OR: schema ref, resolved at graph build (defineSchema)
	type: string;
	data?: TData;
	get: (producerState: unknown, data: TData) => TConsumerView;
}
```

### Factories

```typescript
// Single primitive. Lifecycle (long-running vs transactional) is determined by
// which hooks the impl provides (start, run, etc.) — NOT by which factory is called.

// Eager Producer — for nodes with no required config (e.g., `ports`).
// Returns a Producer directly. Consumers reference via concrete `__producer`.
function define<TState, TProvides extends Provides<TState>, TDeps>(
	config: NodeImpl<TState, TProvides, TDeps> & { name: string; state: TypeMarker<TState> },
): Producer<TState, TProvides>;

// Schema + factory — for nodes that take config (most plugins).
// Returns { create(config), get(key, args?), __id }. Consumers reference via __pluginId
// (engine resolves to the running instance at graph build).
function defineSchema<TConfig, TState, TProvides extends Provides<TState>>(config: {
	id: string; // unique per plugin
	state: TypeMarker<TState>;
	provides: TProvides;
	create: (config: TConfig) => Omit<NodeImpl<TState, TProvides, any>, 'state' | 'provides'>;
}): {
	create: (config: TConfig) => Producer<TState, TProvides>;
	get: <K extends keyof TProvides>(
		key: K,
		...args: ProvidesData<TProvides, K> extends void ? [] : [ProvidesData<TProvides, K>]
	) => Dep<ProvidesData<TProvides, K>, ProvidesView<TProvides, K>>;
	__id: symbol;
};

// `dep()` is a recipe builder used inside `provides:`. TS infers TData from the get fn.
//
//   provides: {
//     endpoint: dep((state) => ({ url: state.rpcUrl })),                    // TData = void
//     account:  dep((state, data: { name: string }) =>                       // TData = { name }
//       state.accounts[data.name]),
//   }
//
// Consumers get typed Deps via the producer's typed `get`:
//   sui.get('endpoint')                          // Dep<void, { url: string }>
//   sui.get('account', { name: 'publisher' })    // Dep<{ name }, Account>
function dep<TState = any, TData = void, TConsumerView = unknown>(
	get: (state: TState, data: TData) => TConsumerView,
): DepRecipe<TState, TData, TConsumerView>;
```

### Process runners (templates that build Process producers)

```typescript
function hostProcess(config: {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  readyProbe?: (handle) => Promise<boolean>;
}): Process implementation;

function dockerContainer<TProvides, TDeps>(config: {
  // Standard Producer config:
  name: string;
  deps?: TDeps;
  provides?: TProvides;
  runsAs?: string;
  networks?: Network | Network[];
  represents?: Represents<DockerContainerState>;

  // Docker-specific:
  image: string;
  args?: string[];
  ports?: { slot: string; containerPort: number }[];   // host port allocated via standard `ports` graph node
  env?: Record<string, string>;
  volumes?: { host: string; container: string }[];
  readyProbe?: (handle: { containerId: string; hostPorts: Record<string, number> }) => Promise<boolean>;
}): Producer<DockerContainerState, TProvides>;
```

Runners are full Producer factories — they wrap `process()` internally with standard impls of
start/stop/snapshot for their lifecycle type. They auto-declare implicit upstream deps (e.g.,
`dockerContainer` with `ports:` config implicitly deps on the standard `ports` graph node for each
slot). Plugin authors don't need to wire those.

For 90% of cases this is enough; for custom lifecycle, drop to raw `process()`.

### Worked example 1: portAllocator (a standard graph node)

```typescript
type PortsState = { map: Record<string, number>; reqs: PortRequest[] };

// `provides:` declares the dep recipes. Engine derives sui.get(...) from this.
export const ports = define({
	name: 'ports',
	provides: {
		allocate: dep<PortsState, PortRequest, number>((state, req) => state.map[req.slot]),
	},
	start: async ({ env, prior, requests }) => {
		// requests: { allocate: PortRequest[] } — auto-typed from provides
		const allReqs = [...(prior?.reqs ?? []), ...requests.allocate];
		const map = await loadOrAllocate(env.appDir, allReqs);
		return { map, reqs: allReqs };
	},
});

// Consumers use:
//   ports.get('allocate', { slot: 'sui.rpc' })   // Dep<PortRequest, number>
```

**Engine flow**: every consumer that calls `ports.get('allocate', { slot: 'sui.rpc' })` produces a
`Dep` with `__producer = ports` and `type: 'allocate'`. Engine collects them, hands `ports.start`
the aggregated `requests: { allocate: [{slot:'sui.rpc'}, ...] }`. New state is persisted; downstream
`dep.get(state, data)` projects per-consumer values.

### Worked example 2: sui.localnet

```typescript
type SuiState = { containerId: string; rpcUrl: string; faucetUrl: string };

export const sui = define({
	name: 'sui.localnet',
	deps: {
		rpcPort: ports.get('allocate', { slot: 'sui.rpc' }),
		faucetPort: ports.get('allocate', { slot: 'sui.faucet' }),
	},
	provides: {
		rpc: dep<SuiState>((s) => ({ url: s.rpcUrl })),
		faucet: dep<SuiState>((s) => ({ url: s.faucetUrl })),
	},
	start: async ({ prior, deps: { rpcPort, faucetPort } }) => {
		if (prior && (await stillHealthy(prior.containerId))) {
			return prior; // resume existing container
		}
		const containerId = await startSuiContainer({ rpcPort, faucetPort });
		return {
			containerId,
			rpcUrl: `http://localhost:${rpcPort}`,
			faucetUrl: `http://localhost:${faucetPort}`,
		};
	},
	stop: async ({ state }) => stopContainer(state.containerId),
	represents: {
		endpoints: (s): Endpoint[] => [
			{ name: 'sui-rpc', url: s.rpcUrl, kind: 'rpc' },
			{ name: 'sui-faucet', url: s.faucetUrl, kind: 'faucet' },
		],
	},
});

// Consumers:
//   sui.get('rpc')      // Dep<void, { url: string }>
//   sui.get('faucet')   // Dep<void, { url: string }>
```

### Worked example 3: publishMove (action sugar from L5)

```typescript
type PublishState = { packageId: string; treasuryCap: string };

function publishMove(opts: { name: string; path: string; signer: Dep<unknown, Signer> }) {
	return define({
		name: `publish.${opts.name}`,
		runsAs: 'publisher',
		deps: {
			signer: opts.signer,
			rpc: sui.get('rpc'), // ambient: pulls sui in transitively
		},
		// Without `inputs`, the input hash would only depend on signer + rpc identities,
		// which are stable. Adding contentHash makes the action re-fire when sources change.
		inputs: ({ env }) => ({ contentHash: hashMovePackage(env.appDir, opts.path) }),
		provides: {
			package: dep<PublishState>((s) => ({ packageId: s.packageId })),
			treasury: dep<PublishState>((s) => s.treasuryCap),
		},
		run: async ({ deps: { signer, rpc } }) => {
			const result = await publishToChain(opts.path, signer, rpc.url);
			return { packageId: result.packageId, treasuryCap: result.treasuryCap };
		},
		represents: {
			packages: (s): Package[] => [{ name: opts.name, packageId: s.packageId }],
		},
	});
}

// Usage:
const token = publishMove({
	name: 'token',
	path: './move/token',
	signer: accounts.get('signer', { name: 'publisher' }),
});

// Consumers:
//   token.get('package')    // Dep<void, { packageId: string }>
//   token.get('treasury')   // Dep<void, string>

// Codegen reading multiple packages:
codegen({ packages: [token.get('package'), nft.get('package'), marketplace.get('package')] });
```

Codegen consuming all three packages:

```typescript
codegen({ packages: [tokenPackage, nftPackage, marketplacePackage] });
```

### What L4 owns

- `action()`, `process()` factory functions
- `dep()` helper for Dep construction
- `hostProcess()`, `dockerContainer()` runner templates
- Standard graph nodes: `portAllocator` / `ports` (query API), `accountPool` / `accounts` (query
  API)
- The TypeScript machinery for `ResolvedDeps<T>`, query-key grouping types

### What L4 does NOT own

- Anything CLI/test-runner-specific (L7)
- Domain plugins (sui, walrus, seal, etc. — those are L6, built on top of L4)
- Plugin sugar like `publishMove`, `runTransaction` (L5)

### L4 → L1 validation results

Working through these three examples revealed:

1. **`provides:` catalog typed by TProvides<TState>** — gives end-to-end type safety: `requests` arg
   is auto-typed, consumer-side `producer.get('key', args?)` is fully typed against the catalog.
   This is the typed-from-parent-generic guarantee the user wanted.
2. **Action's plugin state must be JSON-serializable** so it round-trips through the manifest for
   skip-with-prior-state. Process state typically is too; live handles aren't serialized but are
   reconstructable from container/PID strings on warm-start.
3. **Producer object identity = plugin instance identity.** Two consumers calling
   `sui.get('account', { name: 'publisher' })` and `sui.get('account', { name: 'minter' })` both
   build Deps with `__producer = sui`, same object reference. Engine de-dupes producers by `__id`
   symbol. Plugin author who wants two separate sui instances calls the factory twice.
4. **Ambient deps work cleanly**: each Dep's `__producer` back-ref is set by the factory when
   `producer.get(...)` is called. Engine walks transitively from leaf consumers.
5. **No registry needed anywhere.** All data flow goes through typed Deps.

## L6 — Plugin walk-throughs (validating L4 against trickier shapes)

The portAllocator/sui/publishMove examples in L4 cover the simplest cases. Three more plugins stress
different aspects of the model:

### accountPool (signer materialization)

```typescript
type AccountPoolState = { signers: Record<string, SerializedSigner> };

function createAccountPool(specs: Record<string, AccountSpec>) {
  const pool = define({
    name: 'accounts.pool',
    provides: {
      signer: dep<AccountPoolState, { name: string }, Signer>(
        (state, { name }) => deserializeSigner(state.signers[name]),
      ),
      all: dep<AccountPoolState>((state) => state.signers),
    },
    start: async ({ env, prior, requests }) => {
      // requests.signer = [{ name: 'publisher' }, { name: 'minter' }, ...]
      // requests.all = [void] (or none)
      const signers = await materializeSigners(specs, env, prior?.signers);
      return { signers };
    },
    represents: {
      accounts: (s): Account[] =>
        Object.entries(s.signers).map(([name, sig]) => ({ name, address: sig.address })),
    },
  });

  // Fund Action depends on sui's faucet + the pool's "all" view, faucets every account.
  const fundAll = define({
    name: 'accounts.fund',
    deps: { faucet: sui.get('faucet'), allAccounts: pool.get('all') },
    run: async ({ deps: { faucet, allAccounts } }) => {
      for (const [name, sig] of Object.entries(allAccounts)) {
        await faucetTo(faucet.url, sig.address);
      }
      return { fundedAt: Date.now() };
    },
  });

  return { pool, fundAll };
}

// Usage:
const accounts = createAccountPool({ publisher: ..., minter: ... });
// accounts.pool.get('signer', { name: 'publisher' })  → Dep<{name}, Signer>
```

**Pattern surfaced**: typed `provides:` catalog naturally supports both static (no-arg) Deps like
`all` and parameterized Deps like `signer`. TS infers everything from the recipe signatures.

### codegen (cross-plugin fan-in via explicit Dep lists)

```typescript
type CodegenState = { lastEmittedHash: string };

function codegen(opts: {
	packages?: Dep<void, Package>[];
	services?: Record<string, Dep<void, Service>>;
	outputDir?: string;
}) {
	return define({
		name: 'codegen.generate',
		deps: {
			packages: opts.packages ?? [],
			services: opts.services ?? {},
		},
		run: async ({ deps: { packages, services } }) => {
			const content = renderManifestTs({ packages, services });
			await writeFile(path.join(opts.outputDir ?? 'src/generated', 'manifest.ts'), content);
			return { lastEmittedHash: hashOf(content) };
		},
	});
}

// Usage:
codegen({
	packages: [token.get('package'), nft.get('package')],
	services: { rpc: sui.get('rpc'), faucet: sui.get('faucet') },
});
```

**Pattern surfaced**: re-firing on upstream changes is automatic. When `token`'s state changes, its
identity flips, codegen's input hash flips, codegen re-runs. Today's "subscribes to \*" mechanic
dissolves — you list specific Deps, engine re-fires when any change.

The frontend reads the emitted file directly. Hot-reload picks up the file change.

### walrus (dynamic node fan-out + fan-in)

```typescript
type WalrusNodeState = { containerId: string; rpcUrl: string };
type WalrusNetworkState = { nodeCount: number; urls: string[] };

function walrus(config: { nodeCount: number }) {
	const nodes = Array.from({ length: config.nodeCount }, (_, i) =>
		define({
			name: `walrus.node-${i}`,
			deps: { rpcPort: ports.get('allocate', { slot: `walrus.node-${i}` }) },
			provides: {
				rpc: dep<WalrusNodeState>((s) => ({ url: s.rpcUrl })),
				full: dep<WalrusNodeState>((s) => s),
			},
			start: async ({ prior, deps: { rpcPort } }) => {
				if (prior && (await stillHealthy(prior.containerId))) return prior;
				const containerId = await startWalrusNode({ index: i, rpcPort });
				return { containerId, rpcUrl: `http://localhost:${rpcPort}` };
			},
			represents: {
				endpoints: (s): Endpoint[] => [
					{ name: `walrus-node-${i}`, url: s.rpcUrl, kind: 'walrus-node' },
				],
			},
		}),
	);

	// Aggregator Process: depends on every node's full state, produces a unified handle.
	const appNetwork = define({
		name: 'walrus.app-network',
		deps: { nodes: nodes.map((n) => n.get('full')) },
		provides: {
			allRpcs: dep<WalrusNetworkState>((s) => s.urls),
		},
		start: async ({ deps: { nodes } }) => {
			return { nodeCount: nodes.length, urls: nodes.map((n) => n.rpcUrl) };
		},
	});

	return { nodes, appNetwork };
}

// Usage:
const w = walrus({ nodeCount: 3 });
defineDevstackConfig({ stack: [w.appNetwork] }); // appNetwork pulls in all nodes
```

**Patterns surfaced**:

- **Dynamic producer creation**: factory takes a count and creates N producers. Each has a stable
  `name` (with index). Engine treats them as N independent nodes.
- **`'full'` provides recipe**: a convention for "the full state as a Dep" — useful when an
  aggregator wants the whole upstream state.
- **Aggregator Process for fan-in**: a Process whose `deps:` is an array of sibling `get('full')`
  Deps. Consumers depend on the aggregator instead of listing siblings individually.

### Verdict on L4

These three walk-throughs validate that L4's model holds for:

- Signer pools (materialization-on-demand, request aggregation)
- Cross-plugin fan-in via explicit Dep lists (codegen)
- Dynamic node sets with aggregator nodes (walrus)
- Per-producer query APIs as loose JS objects (everywhere)

No gaps surfaced that require changes to L1 or L4 types. Two **conventions** worth formalizing:

1. **`producer.full` Dep**: encourage plugin authors to expose a Dep returning the full state.
   Useful for "I depend on this being up" patterns.
2. **Aggregator Process**: a Process whose only job is to depend on N siblings and surface a unified
   handle.

Both are pure conventions — no engine support needed.

## L7 — Frontends + persistence (cli, vitest, playwright, TUI)

L7 is the outer layer that wraps the Engine for different invocation modes. All persistence
(SnapshotRecord on disk) lives here. The Engine itself is purely in-memory.

### Common pattern across all frontends

Every frontend follows the same skeleton:

```typescript
// 1. Discover config + env
const configPath = await findDevstackConfig(cwd);
const config = await loadConfig(configPath);
const env = {
	appName: config.appName ?? readAppName(configPath),
	appDir: dirname(configPath),
	network: opts.network ?? 'localnet',
	stack: opts.stack ?? 'main',
};

// 2. Read on-disk SnapshotRecord if it exists
const snapshotPath = snapshotPathFor(env); // e.g., <appDir>/.devstack/stacks/main/snapshot.json
const initialSnapshot = await tryReadSnapshot(snapshotPath);

// 3. Construct Engine
const engine = new Engine(config, { env, initialSnapshot });

// 4. Subscribe (for UI / progress)
const unsubscribe = engine.subscribe((event) => {
	/* render or log */
});

// 5. Run in mode-specific way
await engine.runOnce(); // or .start() / etc.

// 6. Optionally save snapshot
const newSnapshot = await engine.saveSnapshot();
await writeFile(snapshotPath, JSON.stringify(newSnapshot, null, 2));

// 7. Cleanup
unsubscribe();
await engine.stop();
```

### CLI commands

```
devstack up [--stack=<name>] [--network=<net>] [--no-tui]
  Long-running. Reads config, constructs engine, attaches TUI, calls engine.start().
  File-watches devstack.config.ts and source files; engine re-runs cycle on change.
  Auto-saves snapshot at cycle:end events.

devstack apply [--stack=<name>] [--network=<net>]
  One-shot. engine.runOnce(). Exits when satisfied or on error.

devstack status [--stack=<name>] [--network=<net>] [--json]
  Out-of-process. Reads SnapshotRecord from disk; prints structured view (or raw JSON).
  Doesn't construct engine.

devstack snapshot save [--stack=<name>] [--name=<label>]
  Constructs engine, calls pause + saveSnapshot, writes labeled snapshot to disk.

devstack snapshot restore <id> [--stack=<name>]
  Reads snapshot from disk; replaces current snapshot for the stack.
  Stops any running engine; next `devstack up` boots from the restored snapshot.

devstack snapshot list [--stack=<name>]
  Reads snapshot dir; lists labeled snapshots with metadata.

devstack snapshot delete <id>
  Removes snapshot file.

devstack reset [--stack=<name>]
  Stops engine; deletes SnapshotRecord (and per-stack .devstack/ dir contents).

devstack doctor
  Diagnostic checks: docker daemon, sui CLI, ports.json conflicts, etc.
```

### TUI as engine subscriber

```typescript
// In src/tui/renderer.ts
class TuiRenderer {
	private state: EngineState;

	constructor(private engine: Engine) {
		this.state = engine.getState();
		engine.subscribe((event) => this.onEvent(event));
		process.stdin.on('data', (key) => this.onKey(key));
	}

	private onEvent(event: EngineEvent) {
		if (event.type === 'cycle:end' || event.type === 'node:status') {
			this.state = this.engine.getState();
			this.render();
		} else if (event.type === 'node:log') {
			this.appendLog(event.name, event.line);
		}
	}

	private onKey(key) {
		if (key === 'q') this.engine.stop();
		if (key === 's') this.engine.saveSnapshot().then(write);
		// ... etc.
	}

	private render() {
		// Draw the current EngineState (cycle status, node statuses, recent logs)
		// Group nodes by source plugin or alphabetical; show status icons; etc.
	}
}
```

TUI is a pure subscriber. No engine internals. Same code could power a web dashboard via WebSocket
(subscribe → forward events; getState → reply with snapshot).

### SnapshotRecord on-disk paths

```
<appDir>/.devstack/
  stacks/
    main/
      snapshot.json           # latest auto-saved snapshot for stack 'main' (localnet)
      snapshots/
        <id>-<label>.json     # labeled snapshots from `devstack snapshot save`
    test/
      snapshot.json
  networks/
    testnet.json              # latest snapshot for testnet (no per-stack)
    mainnet.json              # latest snapshot for mainnet
```

- Localnet: per-stack directory. Stacks allow multi-user dev (`main` for dev, `test` for tests, `ci`
  for CI).
- Live-net (testnet/mainnet): per-network. No stack dimension — only one testnet exists.
- Discovery: outer layer walks up from cwd looking for `devstack.config.ts`; resolves stack/network
  from CLI flags or env vars.

### Vitest harness

```typescript
// In src/vitest/harness.ts
export async function setupDevstackForTest(opts: {
	configPath?: string;
	stack?: string;
	network?: string;
}) {
	const env = await resolveEnv(opts);
	const initialSnapshot = await tryReadSnapshot(snapshotPathFor(env));
	const engine = new Engine(loadConfig(env), { env, initialSnapshot });
	await engine.runOnce(); // bring stack to satisfaction before tests run
	return engine;
}

// Usage in app's vitest.config.ts:
import { defineConfig } from 'vitest/config';
import { devstackVitest } from '@mysten-incubation/devstack/vitest';

export default defineConfig({
	test: {
		globalSetup: devstackVitest.globalSetup({ stack: 'test' }),
		globalTeardown: devstackVitest.globalTeardown,
	},
});

// Test code reads endpoints from the snapshot:
import { readSnapshot } from '@mysten-incubation/devstack/vitest';
const snapshot = await readSnapshot();
const rpcUrl = snapshot.nodes['sui.localnet'].state.rpcUrl;
```

### Playwright fixtures

Similar to vitest, but per-test-file stack management. Each spec file gets a fresh stack constructed
from the same `setup` snapshot (saved once via `setupAll`).

```typescript
// In src/playwright/fixture.ts
export const test = base.extend({
  devstack: async ({}, use, testInfo) => {
    const env = { ..., stack: `test-${testInfo.workerIndex}` };
    const engine = new Engine(config, { env, initialSnapshot: setupSnapshot });
    await engine.runOnce();
    await use(engine);
    await engine.stop();
  },
});

// Test code:
test('mints a token', async ({ page, devstack }) => {
  const rpcUrl = devstack.getState().nodes['sui.localnet'].state.rpcUrl;
  // ... navigate, interact ...
});
```

### Package + file layout (clean parallel build)

Single package, plugins as subpath exports:

```
packages/devstack/                # one package
  src/
    engine/                       # L1 — pure logic
      types.ts                    # NodeImpl, Producer, Dep, DepRecipe, EngineState, EngineEvent
      build.ts                    # transitive Dep walk + request aggregation
      cycle.ts                    # reconciliation loop
      identity.ts                 # input hash + auto-hashed identity
      snapshot.ts                 # saveSnapshot orchestration
      topo.ts                     # topo sort, cycle detection
      class.ts                    # Engine class (public API)
      *.test.ts
    ctx/                          # L3 — graph build + RunArgs
      config.ts                   # defineDevstackConfig
      runargs.ts                  # RunArgs construction per cycle
      *.test.ts
    factories/                    # L4
      define.ts                   # define()
      defineSchema.ts             # defineSchema()
      dep.ts                      # dep() recipe builder
      runners/
        docker-container.ts       # dockerContainer({...})
        host-process.ts           # hostProcess({...})
    standard/                     # L4 — standard graph nodes
      ports.ts                    # port allocator (no-config singleton)
      accounts.ts                 # createAccountPool factory
    shapes/                       # WorldView typed shapes
      package.ts
      endpoint.ts                 # renamed from "service"
      account.ts
    helpers/                      # L5 — sugar (publishMove, etc.) — built on factories
      publish-move.ts
      run-transaction.ts
      register-coin.ts
      idempotent.ts               # input-hash skip helper
    plugins/                      # L6 — sui, walrus, seal, deepbook, accounts,
                                  #      bindings, manifest. All ship in this
                                  #      package; consumers import from
                                  #      `@mysten-incubation/devstack/plugins`.
    cli/                          # L7
      main.ts                     # entry point; argv routing
      up.ts
      apply.ts
      status.ts
      snapshot.ts
      reset.ts
      doctor.ts
    tui/                          # L7
      renderer.ts                 # engine subscriber, screen updates
    vitest/                       # L7
      harness.ts
      discovery.ts
    playwright/                   # L7
      fixture.ts
    persistence/                  # L7 — snapshot file I/O
      paths.ts                    # snapshotPathFor(env)
      read.ts
      write.ts
    index.ts                      # public exports
```

**Public exports** (subpath exports in `package.json`):

- `@mysten-incubation/devstack` → main barrel: `define`, `defineSchema`, `dep`,
  `defineDevstackConfig`, `idempotent`, `Engine`, types
- `@mysten-incubation/devstack/runners` → `dockerContainer`, `hostProcess`
- `@mysten-incubation/devstack/standard` → `ports`, `createAccountPool`
- `@mysten-incubation/devstack/shapes` → `Package`, `Endpoint`, `Account`
- `@mysten-incubation/devstack/helpers` → `publishMove`, `runTransaction`, `registerCoin`
- `@mysten-incubation/devstack/plugins` → `sui`, `walrus`, `seal`, `deepbook`, `accounts`, `bindings`, `manifest`
- `@mysten-incubation/devstack/cli` → CLI entry (also exposed as bin)
- `@mysten-incubation/devstack/tui` → `TuiRenderer`
- `@mysten-incubation/devstack/vitest` → harness
- `@mysten-incubation/devstack/playwright` → fixture

### Build location

Build new `packages/devstack/` from scratch (alongside any existing code in worktree branches). Old
`packages/devstack/` content is replaced when the new build is feature-complete. No migration; no
compatibility layer; old → new is a hard cutover at the package level (consumers update their
imports once).

If parallel work during build is needed, use a separate branch (`integrate-devstack-v2` or similar)
and rename only on cutover.

## L2 — REMOVED. Persistence collapsed into outer layer.

The engine has no I/O. `SnapshotRecord` is the only on-the-wire format the engine deals in. Outer
layer (L7) handles all storage: where on disk to write snapshots, per-stack vs per-network paths,
atomic writes, discovery from cwd, snapshot listing/deletion. None of this is engine knowledge.

Practically, the CLI / vitest / playwright wrappers each:

1. Read a `SnapshotRecord` from disk if one exists for the current stack.
2. Construct `new Engine(config, { env, initialSnapshot })`.
3. Subscribe to engine events, optionally calling `engine.saveSnapshot()` and writing the returned
   record to disk on `cycle:end` or shutdown (or never — depending on mode).
4. The path/format of those files is an L7 convention, not engine knowledge.

Snapshot save/restore is forwards-only at the engine level: there is no in-place restore. To
restore, construct a new engine with the saved record. Plugins never see a "restore" call — restored
state arrives at their `start({ prior })` like any other prior state.

## L3 — Execution context + graph build: detailed design

L3 splits cleanly into **two passes** with completely separate purposes:

- **Pass 1 — Parse: config → DAG.** Walk up from each item in `stack[]`, follow Dep back-refs,
  collect deps + their parameters into per-producer buckets. _Just parsing._ No execution, no engine
  machinery, no state. Produces a static `BuiltGraph` structure. Runs once at `new Engine(...)` (and
  again only if config reloads in long-running mode).

- **Pass 2 — Resolve: DAG → execution.** Standard topo walk. For each node: resolve deps from
  current state, compute inputHash, dispatch lifecycle hooks, persist new state. Cycle-by-cycle.

The passes share nothing — Pass 1's output is consumed by Pass 2, but neither knows about the
other's internals. Pass 1 is deterministic and side-effect-free; Pass 2 has all the lifecycle
complexity.

### Pass 1 — Parse: config → DAG (one-time, at Engine construction)

Inputs: `stack: Producer[]` from `defineDevstackConfig({ stack })`.

Build state:

```typescript
const nodes = new Map<symbol, ProducerNode>(); // by Producer.__id
const edges = new Map<symbol, Set<symbol>>(); // node id → upstream ids
const requests = new Map<symbol, Map<string, unknown[]>>(); // node id → (dep type → data payloads)
const schemaInstances = new Map<symbol, Producer>(); // schema __pluginId → instance
```

**Pre-pass — index schema instances:**

```typescript
for (const producer of stack) {
	if (producer.__pluginId) {
		if (schemaInstances.has(producer.__pluginId)) {
			throw new BuildError(`Two instances of schema in stack — pick one`);
		}
		schemaInstances.set(producer.__pluginId, producer);
	}
}
```

**Walk pass — DFS from each stack item, resolving Deps to concrete upstream producers:**

```typescript
function visit(producer: Producer): void {
	if (nodes.has(producer.__id)) return;
	nodes.set(producer.__id, { producer, edges: new Set() });

	for (const dep of flattenDeps(producer.deps)) {
		let upstream: Producer;
		if (dep.__producer) {
			upstream = dep.__producer;
		} else if (dep.__pluginId) {
			const inst = schemaInstances.get(dep.__pluginId);
			if (!inst) throw new BuildError(`${producer.name} deps on missing schema; add .create()`);
			upstream = inst;
		} else {
			throw new BuildError(`Dep has neither __producer nor __pluginId`);
		}
		visit(upstream);
		nodes.get(producer.__id)!.edges.add(upstream.__id);

		// Bucket dep.data into upstream's request map keyed by dep.type:
		const byType = requests.get(upstream.__id) ?? new Map();
		requests.set(upstream.__id, byType);
		const list = byType.get(dep.type) ?? [];
		byType.set(dep.type, list);
		list.push(dep.data);
	}
}
for (const item of stack) visit(item);
```

**Validate pass:**

- Name uniqueness across all reached producers (names are used as snapshot keys, log routing, status
  display).
- Topological sort (DFS-based with in-progress markers; throws on cycle with the cycle path).
- Each producer must have at least one of `start` or `run`.

**Output:** A `BuiltGraph` containing `nodes`, `topoOrder`, `requestsByProducer`, `namesByName`.
Engine holds this for its lifetime; rebuilds only if config changes (e.g., file watcher in
long-running mode reloads `devstack.config.ts`).

### Pass 2 — Resolve: DAG → execution (per cycle)

A cycle processes a **dirty set** over the DAG. The dirty set's transitive downstream subtree forms
the **work set**, which is walked in topo order. Each node's lifecycle dispatch produces ran /
skipped / errored. Failures stop the local cascade but don't abort the cycle — other branches still
process.

**Cycle inputs:**

- `BuiltGraph` (from Pass 1)
- `nodeStates: Map<name, NodeState>` (engine's in-memory current state)
- `forceRun: Set<name>` (nodes explicitly invalidated by outer layer or by node code)

**Algorithm:**

```typescript
async function cycle(input: CycleInput): Promise<CycleResult> {
	// 1. Compute work set = forceRun + transitive downstream subtree.
	const work = new Set<symbol>();
	for (const name of input.forceRun) {
		const id = builtGraph.namesByName.get(name)!;
		work.add(id);
		for (const d of builtGraph.downstreamSubtreeOf(id)) work.add(d);
	}
	// First-cycle case: work = all nodes (everything implicitly dirty on cold start).

	// 2. Topo-walk the work set.
	const result: CycleResult = { ran: [], skipped: [], errored: [] };
	const requestedReruns = new Set<string>();

	for (const id of builtGraph.topoOrder.filter((x) => work.has(x))) {
		const node = builtGraph.nodes.get(id)!.producer;
		const state = nodeStates.get(node.name);

		// 2a. Skip if any upstream errored this cycle.
		const upstreamErrored = upstreamOf(id).some((u) => result.errored.some((e) => e.id === u));
		if (upstreamErrored) {
			result.skipped.push({ id, reason: 'upstream_errored' });
			continue;
		}

		// 2b. Resolve deps, compute inputHash.
		const resolvedDeps = resolveDepsFor(node, nodeStates);
		const inputHash = await computeInputHash(node, resolvedDeps, nodeStates);

		// 2c. Decide skip vs run.
		let shouldRun: boolean;
		if (input.forceRun.has(node.name)) {
			shouldRun = true; // explicit invalidation: always run
		} else if (node.getStatus) {
			shouldRun = !(
				await node.getStatus({ prior: state?.state, deps: resolvedDeps, inputHash, env })
			).ok;
		} else {
			shouldRun = inputHash !== state?.lastInputHash;
		}

		if (!shouldRun) {
			result.skipped.push({ id, reason: 'satisfied' });
			continue; // state unchanged; downstream won't cascade from here
		}

		// 2d. Build RunArgs (with rerun/invalidate context hooks).
		const args = {
			env,
			log,
			onShutdown,
			inputHash,
			prior: state?.state,
			requests: bucketsToObject(builtGraph.requestsByProducer.get(id)),
			deps: resolvedDeps,
			requestRerun: (_reason) => {
				requestedReruns.add(node.name);
			},
			invalidate: (other, _reason) => {
				requestedReruns.add(other);
			},
		};

		// 2e. Dispatch lifecycle (under runsAs lock).
		try {
			await withRunsAsLock(node.runsAs, async () => {
				let newState = state?.state;
				if (node.start) newState = await node.start(args);
				if (node.run) newState = await node.run({ ...args, prior: newState ?? state?.state });

				const newIdentity = hash(canonicalize(newState));
				const representations = node.represents
					? Object.fromEntries(
							Object.entries(node.represents).map(([cat, fn]) => [cat, fn(newState)]),
						)
					: undefined;

				nodeStates.set(node.name, {
					lastInputHash: inputHash,
					lastRunAt: Date.now(),
					identity: newIdentity,
					state: newState,
					representations,
					error: undefined, // clear prior error on success
				});
				result.ran.push({ id });
			});
		} catch (err) {
			nodeStates.set(node.name, {
				...state,
				lastInputHash: inputHash,
				error: { message: err.message, stack: err.stack, at: Date.now() },
			});
			result.errored.push({ id, error: err });
			engine.emit({ type: 'engine:error', error: err, name: node.name });
			// Continue to next node — don't abort the cycle.
		}
	}

	// 3. If reruns were requested mid-cycle, schedule a follow-up cycle.
	if (requestedReruns.size > 0) engine.scheduleCycle(requestedReruns);

	return result;
}
```

**Key properties:**

- **Failures are local.** A failed node's downstream is skipped _this cycle_, but the cycle
  continues — other branches still process. The errored node stays errored across cycles until
  invalidated (no auto-retry). Engine emits `engine:error` for visibility.
- **Dirty set vs work set.** Dirty (forceRun) is "what was explicitly invalidated"; work set is
  "dirty + downstream subtree." Only work-set nodes are walked. Nodes outside it stay "satisfied"
  from prior cycles.
- **Cycle is bounded.** Each cycle processes the work set once. Mid-cycle `requestRerun()` calls are
  batched into the next cycle's forceRun, not retried within this one. No infinite loops within a
  single cycle.

**Node-initiated re-runs + file watching via context** (new `RunArgs` methods):

```typescript
type RunArgs<...> = {
  // ...existing (env, log, onShutdown, inputHash, prior, requests, deps)...

  // Schedule this node to re-run normally on next cycle.
  requestRerun: (reason?: string) => void;

  // Schedule this node to RESTART (drop live state via stop + start, or via custom
  // restart hook) on next cycle. Use case: node detects config drift mid-run.
  requestRestart: (reason?: string) => void;

  // Invalidate any other node by name (forces re-run on next cycle).
  invalidate: (nodeName: string, reason?: string) => void;

  // Set up file-watching. Paths can be globs. On change, this node is invalidated.
  // Watchers reset each time start/run is called — re-register every cycle as needed.
  watch: (paths: string | string[]) => void;
};
```

These are batched: collected during a cycle, applied as the next cycle's work-set entries (with
intent: 'rerun' or 'restart'). No within-cycle restarts.

**Engine API additions:**

```typescript
class Engine {
	// ...existing...
	invalidate(nodeName: string, reason?: string): void; // re-run on next cycle
	restart(nodeName: string, reason?: string): void; // stop + start (or restart hook) on next cycle
	retry(nodeName: string): void; // alias for invalidate
	cycle(): Promise<CycleResult>; // run one cycle now (manual trigger)
}
```

**Cycle dispatch with restart intent:**

Work-set entries carry intent: `'rerun'` (default) or `'restart'`. `engine.restart(name)` and
`ctx.requestRestart()` set intent to `'restart'`.

```typescript
for (const id of workSetInTopoOrder) {
  const intent = workIntents.get(node.name) ?? 'rerun';

  if (intent === 'restart') {
    if (node.restart) {
      newState = await node.restart(args);
    } else {
      if (node.stop) await node.stop(args);
      if (node.start) newState = await node.start(args);
    }
    // restart implies fresh state; run is NOT called in the same cycle.
  } else {
    // Normal flow: start always (if defined), run conditionally.
    if (node.start) newState = await node.start(args);
    if (node.run && shouldRun(...)) newState = await node.run({ ...args, prior: newState ?? state.state });
  }
}
```

**Watcher lifecycle:**

`ctx.watch(paths)` is called inside start/run to register watchers. Engine maintains a per-node
watcher set:

- Before invoking start/run, engine clears the prior watcher set (allows re-registration if config
  changed).
- Inside start/run, plugin author calls `watch(...)` to set up fresh watchers.
- After start/run returns, engine activates the watchers.
- On file change: engine calls `invalidate(thisNodeName)` automatically.

**Use case examples:**

```typescript
// publishMove auto-invalidates on Move source changes:
run: async ({ env, watch, deps }) => {
  watch(['./move/token/**/*.move']);             // change → invalidate this node
  return await publishToChain(...);
},
inputs: ({ env }) => ({ contentHash: hashMovePackage(env.appDir, './move/token') }),

// A service that detects mid-run "I need to restart":
start: async ({ prior, requestRestart }) => {
  if (prior?.config && configHasChanged(prior.config)) {
    requestRestart('config drift detected');
    return prior;                                // engine restarts next cycle
  }
  // ... normal start ...
},

// Docker container with efficient restart override:
restart: async ({ state }) => {
  await dockerExec(state.containerId, 'kill -HUP 1');  // signal reload — much faster than full bounce
  return state;
},
```

**Long-running mode:**

- File watcher calls `engine.invalidate(name)` on file changes.
- Engine debounces (e.g., 100ms), then runs a cycle.
- After the cycle: if `requestedReruns` non-empty, schedules another. Otherwise idle.

**Failure-retry policy.** Engine itself is policy-free. Outer layer can implement:

- TUI keystroke "r" → retry all errored (iterate, call `engine.retry`)
- Periodic auto-retry timer
- Exponential backoff per error class
- These are L7 concerns, not engine concerns.

— old per-node walkthrough preserved below for reference —

For each node in `topoOrder`:

```typescript
async function processNode(id: symbol): Promise<void> {
	const { producer } = nodes.get(id)!;
	const priorNodeState = engine.nodeStates.get(producer.name); // from prior cycle or initialSnapshot
	const priorPluginState = priorNodeState?.state;

	// 1. Resolve deps — upstream is already processed (topo order), so its state is current.
	const resolvedDeps = resolveDepsFor(producer);
	// For each (alias, dep) in producer.deps:
	//   upstreamProducer = depToUpstreamProducer(dep);
	//   upstreamState = engine.nodeStates.get(upstreamProducer.name)?.state;
	//   resolvedDeps[alias] = dep.get(upstreamState, dep.data);
	// (Mirroring producer.deps shape: object → object, array → array)

	// 2. Compute inputHash material
	const upstreamIdentities = collectUpstreamIdentities(producer); // from current-cycle NodeStates
	const ownInputs = producer.inputs
		? await producer.inputs({ env: ctx.env, deps: resolvedDeps })
		: undefined;
	const inputHash = hash({ upstream: upstreamIdentities, own: ownInputs });

	// 3. Build RunArgs
	const args: RunArgs = {
		env: ctx.env,
		log: (line) => engine.emit({ type: 'node:log', name: producer.name, line }),
		onShutdown: (fn) => engine.registerShutdown(producer.name, fn),
		inputHash,
		prior: priorPluginState,
		requests: bucketsToObject(requests.get(id)), // { [type]: data[] }
		deps: resolvedDeps,
	};

	// 4. Lifecycle dispatch (acquiring runsAs lock if specified)
	await withRunsAsLock(producer.runsAs, async () => {
		let newState = priorPluginState;
		if (producer.start) {
			newState = await producer.start(args); // always called when defined
		}
		if (producer.run) {
			const shouldRun = producer.getStatus
				? !(
						await producer.getStatus({
							prior: newState ?? priorPluginState,
							deps: resolvedDeps,
							inputHash,
							env: ctx.env,
						})
					).ok
				: inputHash !== priorNodeState?.lastInputHash;
			if (shouldRun) {
				newState = await producer.run({ ...args, prior: newState ?? priorPluginState });
			}
		}

		// 5. Auto-hash identity from new state (canonicalize first for stability)
		const newIdentity = hash(canonicalize(newState));

		// 6. Run represents callbacks
		const representations = producer.represents
			? Object.fromEntries(
					Object.entries(producer.represents).map(([cat, fn]) => [cat, fn(newState)]),
				)
			: undefined;

		// 7. Persist NodeState to engine's in-memory map
		engine.nodeStates.set(producer.name, {
			lastInputHash: inputHash,
			lastRunAt: Date.now(),
			identity: newIdentity,
			state: newState,
			representations,
		});

		// 8. Emit events for subscribers (state-changed, status, etc.)
		engine.emit({ type: 'node:state-changed', name: producer.name });
	});
}
```

**Per-`runsAs` serialization**: wraps step 4 with a global per-`runsAs`-key promise queue. Only one
node per runsAs key inflight at a time. Different runsAs keys (or no runsAs) parallelize freely.

**Identity cascade is implicit** in the topo walk. Each downstream reads its upstream's
_current-cycle_ identity when computing inputHash. No separate "mark dirty" pass needed within a
cycle. Across cycles, prior.identity comes from the prior cycle's NodeState; if it differs from
current upstream identity, downstream's inputHash flips → re-run.

### Long-running mode + invalidation

`engine.start()` runs an initial cycle then waits. To trigger a re-cycle:

```typescript
class Engine {
	// ...existing...
	invalidate(nodeName: string): void; // mark node for re-evaluation on next cycle (file watcher uses this)
	cycle(): Promise<CycleResult>; // manually run one cycle
}
```

`invalidate(name)` schedules a cycle. On that cycle, the named node's `inputs` callback (if defined)
is re-evaluated; its inputHash reflects whatever the callback now returns. If different from prior,
run fires. Downstream cascade follows naturally via topo walk.

File watcher (L7) is the typical caller of `invalidate()` — it watches source paths used by node
`inputs` callbacks (or watches `devstack.config.ts` for full graph rebuild).

### What L3 owns

- `defineDevstackConfig({ stack, ... })` factory
- **Pass 1**: parse config into BuiltGraph (transitive Dep walk, schema instance lookup, request
  aggregation, name uniqueness, topo sort + cycle detection)
- **Pass 2**: per-cycle resolve loop (dep resolution, inputHash computation, lifecycle dispatch,
  identity hashing, represents callbacks, persistence to engine's in-memory NodeState map)
- `RunArgs` construction per node per cycle
- (No EngineHost — engine has no I/O; env is passed to Engine constructor; log/onShutdown route
  through engine event emission and shutdown registry)

### What L3 does NOT own

- Topo sort / cycle detection — L1 (operates on the node set L3 hands it)
- Reconciliation logic — L1
- Disk persistence — outer layer (L7); engine takes initialSnapshot at construction and emits
  SnapshotRecord on demand

### File layout

```
packages/devstack/src/context/
  config.ts        — defineDevstackConfig
  build.ts         — buildGraph (transitive Dep walk + request aggregation)
  ctx.ts           — buildNodeCtx
  *.test.ts        — graph-build tests with synthetic producers
```

## Resolved: fan-in is just typed Dep lists

Codegen-style "I need to know about everything of kind X" is handled by accepting a typed list of
Deps:

```typescript
const config = {
	plugins: [codegen({ packages: [token, nft, marketplace] })],
};
```

Where `token`, `marketplace`, etc. are `publishMove(...)` instances. Each one exposes a
`Dep<PackageInfo>` (or whatever shape codegen's prop type expects). Codegen's prop type pins the
shape; TypeScript enforces that only Deps of that shape are accepted.

No built-in aggregator. No registry. No `defineKind`. The verbosity of listing N items is fine —
it's the same effort as today's `use:[]` and arguably more honest about the data flow.

## Resolved (going into L1 design)

- **Producer API**: Loose JS objects on the plugin. `sui.hostname = { get: () => '...' }`,
  `sui.account = (name) => ({ data, get })`. TypeScript enforces shape. No builder DSL, no factory
  helpers — add later if pain materializes.
- **State-driven entry point**: Engine calls one entry point per node (`start` for Process, `run`
  for Action). Engine passes the node's prior state as an arg. Implementation decides: resume from
  running state, restore from snapshot, fresh start, or skip and return prior result. Engine has no
  skip logic, no separate rehydrate callback, no warm/cold branching. Snapshots, restarts, and fresh
  starts share one code path.
- **Verify**: Action with no work; impl just runs `getStatus`-equivalent and throws on failure. No
  special engine support.
- **Snapshot save/restore**: CLI-invoked. Cooperates with engine via
  `engine.pause()`/`engine.resume()`. Not an engine mode.

## Remaining open

- **Q5**: Plugin instance identity — how the engine maps `sui.account('publisher')` and
  `sui.account('minter')` to the same producer node. Likely: producer ref equality on the plugin
  object literal. Resolve during L1 design.

## Path forward

1. **Done**: Conceptual model (2 shapes, typed Deps, no registry, ambient deps). L1 detailed design
   drafted above.
2. **Next**: Detail L7 (CLI / vitest / playwright wrappers + on-disk SnapshotRecord file format
   conventions).
3. **Then**: L4 — design action helpers (`action`/`process` factories), runners (host-process,
   docker-container), and standard graph nodes (portAllocator, accountPool).
4. **Then**: L5 (action sugar like publishMove), L6 (port each plugin to the new model), L7
   (cli/vitest/playwright wrappers).
5. **Then**: Migration strategy. Likely: build `engine/` as a parallel module alongside today's
   `runtime/`. Port plugins one at a time. Cut over examples last. Retire `runtime/` once everything
   moves.

We are NOT writing code. This document is the design.
