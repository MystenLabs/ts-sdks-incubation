import type {
	Dep,
	DepRecipe,
	Env,
	GetStatusArgs,
	InputsArgs,
	NodeImpl,
	Producer,
	ProducerGet,
	Provides,
	Represents,
	RunArgs,
	StopArgs,
} from '../engine/types.js';

// User-facing config for `define()`. The factory adds `__id` and the typed
// `get` accessor. `provides` is optional — leaf actions that don't expose
// any state to consumers can omit it.
export interface DefineInput<TState, TProvides extends Provides<TState>, TDeps> {
	name: string;
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

// `define()` — produces a concrete Producer instance. Use for plugins
// that take no required config (eager exports like `ports`) or for any
// hand-rolled node that doesn't need the schema/instance split.
//
// The returned object also implements NodeImpl (engine reads lifecycle
// hooks via a `as AnyNodeImpl` widening at graph-build time), but the
// public type is Producer<TState, TProvides> so consumers see a clean
// surface (name, get, brands).
//
// TS can't always infer TState from the provides+lifecycle constraint
// pair on its own — especially when start/run destructure `prior` without
// an explicit return-type annotation. Pass TState as the first explicit
// type argument when that happens: `define<PortsState>({...})`. TProvides
// and TDeps still infer from the literal.
export function define<
	TState,
	TProvides extends Provides<TState> = Provides<TState>,
	TDeps = unknown,
>(config: DefineInput<TState, TProvides, TDeps>): Producer<TState, TProvides> {
	if (!config.name) {
		throw new Error('define: `name` is required');
	}
	if (typeof config.start !== 'function' && typeof config.run !== 'function') {
		throw new Error(`define("${config.name}"): must define at least one of start, run`);
	}

	const __id = Symbol(config.name);
	const provides = (config.provides ?? {}) as Record<string, DepRecipe<any, any, any>>;

	const producer = {
		...config,
		__id,
		name: config.name,
	} as NodeImpl<TState, TProvides, TDeps>;

	producer.get = buildProducerGet(producer, provides) as ProducerGet<TProvides>;
	return producer;
}

// Builds the typed `get(key, args?)` accessor for a producer instance.
// Closures capture the producer ref so consumer Deps carry `__producer`,
// letting the engine pull the producer into the graph transitively.
export function buildProducerGet(
	producer: Producer<any, any>,
	provides: Record<string, DepRecipe<any, any, any>>,
): (key: string, data?: unknown) => Dep<any, any> {
	return (key, data) => {
		const recipe = provides[key];
		if (!recipe) {
			const declared = Object.keys(provides);
			const list = declared.length ? declared.join(', ') : '<none>';
			throw new Error(
				`producer "${producer.name}" does not provide "${key}" (declared keys: ${list})`,
			);
		}
		const dep: Dep<any, any> = {
			__producer: producer,
			type: key,
			get: recipe.get,
		};
		if (data !== undefined) dep.data = data;
		return dep;
	};
}
