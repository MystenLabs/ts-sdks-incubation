// `Dep<TConsumerView>` is the public, plugin-facing handle for a
// producer-emitted value. One type parameter — the view a consumer
// gets when the engine resolves the Dep. Plugin authors write
// `Dep<Package>`, `Dep<Keypair>`, `Dep<string>`.
//
// Runtime fields (`__producer`, `__pluginId`, `data`, `get`) live on
// the same interface but are engine-populated; plugin authors never
// read or write them. The engine internally types a Dep as
// `Dep<never>` when it doesn't care about the view (the brand is
// bottom, the runtime fields are what it actually uses).
//
// Why a covariant brand: `__viewBrand?: TConsumerView` makes
// `Dep<Endpoint>[]` accept any concrete `Dep<Endpoint>` a producer
// hands back, regardless of the producer's state shape or the data
// passed at `.get(...)`.
//
// `Provides<TState>` still uses `any` in the inner `DepRecipe`'s TData
// + TConsumerView slots: it's a record of heterogeneous recipes per
// key, and the recipe's `get(state, data)` puts TData in contravariant
// position so `unknown` would not accept e.g. `(data: { name })`.
// Recipes never appear on the public Dep surface, so this `any` is
// contained inside the producer-construction machinery.

export interface Env {
	appName: string;
	appDir: string;
	network: string;
	stack?: string;
}

export type LogFn = (line: string) => void;

export interface DepRecipe<TState, TData, TConsumerView> {
	__dataBrand?: TData;
	get: (state: TState, data: TData) => TConsumerView;
}

// Exclusive recipes carry a `lockKey` that the engine uses to
// serialize concurrent consumers within a topo rank. Two Deps that
// project to recipes with the same `lockKey` value MAY NOT run in the
// same parallel batch — they're scheduled sequentially. Two with
// distinct lockKeys can run concurrently. Plugins declare this via
// the `exclusiveDep({ get, lockKey })` factory; consumer code is
// unchanged (`pool.get('exclusive', { name })` returns a regular
// `Dep<View>`).
export interface ExclusiveDepRecipe<TState, TData, TConsumerView>
	extends DepRecipe<TState, TData, TConsumerView> {
	__exclusive: true;
	lockKey: (state: TState, data: TData) => string;
}

export function isExclusiveRecipe(
	recipe: DepRecipe<unknown, unknown, unknown>,
): recipe is ExclusiveDepRecipe<unknown, unknown, unknown> {
	return (recipe as { __exclusive?: unknown }).__exclusive === true;
}

export type Provides<TState> = Record<string, DepRecipe<TState, any, any>>;

export type ProvidesData<TP, K extends keyof TP> =
	TP[K] extends DepRecipe<any, infer D, any> ? D : never;

export type ProvidesView<TP, K extends keyof TP> =
	TP[K] extends DepRecipe<any, any, infer V> ? V : never;

// Public surface — one type parameter, phantom (covariant) so a
// consumer holding `Dep<Endpoint>[]` accepts any concrete projection.
//
// Runtime fields (`__producer`, `__pluginId`, `data`, `get`) live on
// this same interface; they're optional and engine-populated. Plugin
// authors never read or write them — they obtain typed Deps from
// `Producer.get(...)` and hand them to the engine via `deps:`.
//
// Internally the engine holds Deps as `Dep<never>` when it doesn't
// care about the view (the brand is bottom there, so a `Dep<never>`
// also satisfies "this is a Dep" without claiming a specific view).
export interface Dep<TConsumerView> {
	__viewBrand?: TConsumerView;
	type: string;
	__producer?: Producer<any, any>;
	__pluginId?: symbol;
	data?: unknown;
	get: (producerState: any, data: any) => unknown;
}

// Recursive Dep unwrapper. Mirrors `walk()` in cycle.ts: a Dep becomes
// its consumer view, an array maps element-wise, a plain object recurses
// into its values, primitives pass through unchanged. So a `TDeps` of
// `{ nodes: Dep<NodeState>[] }` resolves to `{ nodes: NodeState[] }`
// — no cast needed at the call site. Order matters: Dep is checked
// first so its structural shape doesn't trip the `object` branch.
export type ResolveDep<T> = T extends Dep<infer R>
	? R
	: T extends readonly (infer U)[]
		? ResolveDep<U>[]
		: T extends object
			? { [K in keyof T]: ResolveDep<T[K]> }
			: T;

export type ResolvedDeps<TDeps> = {
	[K in keyof TDeps]: ResolveDep<TDeps[K]>;
};

export type ProducerGet<TState, TProvides extends Provides<TState>> = <K extends keyof TProvides>(
	key: K,
	...args: ProvidesData<TProvides, K> extends void ? [] : [ProvidesData<TProvides, K>]
) => Dep<ProvidesView<TProvides, K>>;

export interface Producer<TState, TProvides extends Provides<TState>> {
	__id: symbol;
	__pluginId?: symbol;
	__stateBrand?: TState;
	__providesBrand?: TProvides;
	name: string;
	get: ProducerGet<TState, TProvides>;
}

export type Represents<TState> = Record<string, (state: TState) => unknown[]>;

export interface RunArgs<TState, TProvides extends Provides<TState>, TDeps> {
	env: Env;
	log: LogFn;
	onShutdown: (fn: () => Promise<void>) => void;
	inputHash: string;
	prior: TState | undefined;
	requests: { [K in keyof TProvides]: ProvidesData<TProvides, K>[] };
	deps: ResolvedDeps<TDeps>;
	requestRerun: (reason?: string) => void;
	requestRestart: (reason?: string) => void;
	invalidate: (nodeName: string, reason?: string) => void;
	watch: (paths: string | string[]) => void;
}

export interface StopArgs<TState> {
	env: Env;
	log: LogFn;
	state: TState;
}

export interface GetStatusArgs<TState, TDeps> {
	prior: TState | undefined;
	deps: ResolvedDeps<TDeps>;
	inputHash: string;
	env: Env;
}

export interface InputsArgs<TDeps> {
	env: Env;
	deps: ResolvedDeps<TDeps>;
}

export interface NodeImpl<TState, TProvides extends Provides<TState>, TDeps> extends Producer<
	TState,
	TProvides
> {
	deps?: TDeps;
	provides?: TProvides;

	// Same-resource mutex used to live here as `runsAs?: string` —
	// removed in Phase 5. Express serialization via `exclusiveDep` on
	// the producer that owns the resource, not on the consumer node.

	start?: (args: RunArgs<TState, TProvides, TDeps>) => Promise<TState>;
	run?: (args: RunArgs<TState, TProvides, TDeps>) => Promise<TState>;
	stop?: (args: StopArgs<TState>) => Promise<void>;
	restart?: (args: RunArgs<TState, TProvides, TDeps>) => Promise<TState>;

	getStatus?: (args: GetStatusArgs<TState, TDeps>) => Promise<{ ok: boolean }> | { ok: boolean };
	inputs?: (args: InputsArgs<TDeps>) => unknown | Promise<unknown>;
	snapshot?: (args: { env: Env; state: TState }) => Promise<TState>;
	represents?: Represents<TState>;
}

export type AnyNodeImpl = NodeImpl<any, any, any>;

export interface NodeError {
	message: string;
	stack?: string;
	at: number;
}

export interface NodeState<TState = unknown> {
	lastInputHash?: string;
	lastRunAt?: number;
	identity?: string;
	state?: TState;
	representations?: Record<string, unknown[]>;
	error?: NodeError;
}

export interface SnapshotRecord {
	createdAt: number;
	env: { appName: string; network: string; stack?: string };
	nodeStates: Record<string, NodeState>;
	meta: { devstackVersion: string };
}

export type NodeStatus = 'idle' | 'running' | 'satisfied' | 'errored' | 'skipped';

export interface NodeView {
	name: string;
	status: NodeStatus;
	state?: unknown;
	representations?: Record<string, unknown[]>;
	lastInputHash?: string;
	lastRunAt?: number;
	durationMs?: number;
	lastError?: { message: string; stack?: string };
	logs: string[];
}

export type CycleStatus = 'idle' | 'running' | 'paused';

export interface EngineState {
	cycle: {
		id: number;
		startedAt?: number;
		status: CycleStatus;
	};
	nodes: Map<string, NodeView>;
}

export type EngineEvent =
	| { type: 'cycle:start'; cycleId: number }
	| { type: 'cycle:end'; cycleId: number; durationMs: number }
	| { type: 'node:status'; name: string; before: NodeStatus; after: NodeStatus }
	| { type: 'node:log'; name: string; line: string }
	| { type: 'node:state-changed'; name: string }
	| { type: 'engine:error'; error: Error; name?: string }
	| { type: 'shutdown' };

export interface DevstackConfig {
	stack: Producer<any, any>[];
}

export interface ProducerNode {
	producer: Producer<any, any>;
	edges: Set<symbol>;
}

export interface BuiltGraph {
	nodes: Map<symbol, ProducerNode>;
	topoOrder: symbol[];
	requestsByProducer: Map<symbol, Map<string, unknown[]>>;
	idByName: Map<string, symbol>;
	pluginInstances: Map<symbol, Producer<any, any>>;
	downstreamSubtreeOf: (id: symbol) => Set<symbol>;
}

export type WorkIntent = 'rerun' | 'restart';

export interface CycleInput {
	forceRun: Map<string, WorkIntent>;
}

export interface CycleResult {
	ran: { id: symbol; name: string }[];
	skipped: { id: symbol; name: string; reason: 'satisfied' | 'upstream_errored' }[];
	errored: { id: symbol; name: string; error: Error }[];
}
