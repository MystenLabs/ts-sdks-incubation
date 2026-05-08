// `any` here is required by function-parameter contravariance: `Provides<TState>` is a record
// of recipes with heterogeneous `TData` per key, and a recipe taking `(state, data: { name })`
// is NOT assignable to one taking `(state, data: unknown)` — the input position needs a top-type
// that's a subtype of every possible TData. Same reasoning applies to `Producer<unknown, any>`.

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

export type Provides<TState> = Record<string, DepRecipe<TState, any, any>>;

export type ProvidesData<TP, K extends keyof TP> =
	TP[K] extends DepRecipe<any, infer D, any> ? D : never;

export type ProvidesView<TP, K extends keyof TP> =
	TP[K] extends DepRecipe<any, any, infer V> ? V : never;

export interface Dep<TData, TConsumerView> {
	__producer?: Producer<any, any>;
	__pluginId?: symbol;
	type: string;
	data?: TData;
	get: (producerState: any, data: TData) => TConsumerView;
}

export type ResolvedDeps<TDeps> = {
	[K in keyof TDeps]: TDeps[K] extends Dep<any, infer R> ? R : never;
};

export type ProducerGet<TProvides> = <K extends keyof TProvides>(
	key: K,
	...args: ProvidesData<TProvides, K> extends void ? [] : [ProvidesData<TProvides, K>]
) => Dep<ProvidesData<TProvides, K>, ProvidesView<TProvides, K>>;

export interface Producer<TState, TProvides extends Provides<TState>> {
	__id: symbol;
	__pluginId?: symbol;
	__stateBrand?: TState;
	__providesBrand?: TProvides;
	name: string;
	get: ProducerGet<TProvides>;
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
	runsAs?: string;

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
