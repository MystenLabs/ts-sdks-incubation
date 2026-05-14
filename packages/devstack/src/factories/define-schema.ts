import type {
	Dep,
	DepRecipe,
	NodeImpl,
	Producer,
	ProducerGet,
	Provides,
} from '../engine/types.js';
import { buildProducerGet, type DefineInput } from './define.js';

// User-supplied per-instance config. `provides` is hoisted to the schema
// definition (shared across all instances), so the user's `create`
// callback returns everything else.
export type SchemaInstanceConfig<
	TState,
	TProvides extends Provides<TState>,
	TDeps = unknown,
> = Omit<DefineInput<TState, TProvides, TDeps>, 'provides'>;

export interface SchemaDefinition<TConfig, TState, TProvides extends Provides<TState>> {
	id: string;
	provides: TProvides;
	create: (config: TConfig) => SchemaInstanceConfig<TState, TProvides, any>;
}

export interface Schema<TConfig, TState, TProvides extends Provides<TState>> {
	__id: symbol;
	create: (config: TConfig) => Producer<TState, TProvides>;
	get: ProducerGet<TState, TProvides>;
}

// `defineSchema()` — for plugins that take config (sui, walrus, seal, …).
// Returns a schema object with three things:
//   - `__id`: unique symbol per schema, used as `__pluginId` on Deps
//   - `create(config)`: instantiate. Multiple calls produce distinct
//     producers sharing `__pluginId`; the engine errors if more than one
//     instance is in the stack while a static Dep references the schema.
//   - `get(key, args?)`: static Dep accessor — usable BEFORE any instance
//     exists. Engine resolves `__pluginId` to the running instance at
//     graph build time.
//
// Example shape:
//   const sui = defineSchema({
//     id: 'sui',
//     provides: { rpc: dep((s) => ({ url: s.rpcUrl })) },
//     create: (config: SuiConfig) => ({
//       name: `sui.${config.network}`,
//       start: async () => ({ rpcUrl: rpcForNetwork(config.network) }),
//     }),
//   });
//   sui.get('rpc');                 // static Dep, __pluginId
//   sui.create({ network: 'localnet' }).get('rpc');   // instance Dep, __producer
export function defineSchema<TConfig, TState, TProvides extends Provides<TState>>(
	schema: SchemaDefinition<TConfig, TState, TProvides>,
): Schema<TConfig, TState, TProvides> {
	if (!schema.id) {
		throw new Error('defineSchema: `id` is required');
	}
	if (!schema.provides) {
		throw new Error(`defineSchema("${schema.id}"): \`provides\` is required`);
	}
	if (typeof schema.create !== 'function') {
		throw new Error(`defineSchema("${schema.id}"): \`create\` must be a function`);
	}

	const __pluginId = Symbol(schema.id);
	const providesRec = schema.provides as Record<string, DepRecipe<any, any, any>>;

	const get = ((key: string, data?: unknown): Dep<never> => {
		const recipe = providesRec[key];
		if (!recipe) {
			const declared = Object.keys(providesRec);
			const list = declared.length ? declared.join(', ') : '<none>';
			throw new Error(`schema "${schema.id}" does not provide "${key}" (declared keys: ${list})`);
		}
		const dep: Dep<never> = {
			__pluginId,
			type: key,
			get: recipe.get,
		};
		if (data !== undefined) dep.data = data;
		return dep;
	}) as unknown as ProducerGet<TState, TProvides>;

	const create = (userConfig: TConfig): Producer<TState, TProvides> => {
		const instanceCfg = schema.create(userConfig);
		if (!instanceCfg.name) {
			throw new Error(`defineSchema("${schema.id}").create: returned config must include \`name\``);
		}
		if (typeof instanceCfg.start !== 'function' && typeof instanceCfg.run !== 'function') {
			throw new Error(
				`defineSchema("${schema.id}").create("${instanceCfg.name}"): must define at least one of start, run`,
			);
		}

		const __id = Symbol(instanceCfg.name);
		const producer = {
			...instanceCfg,
			__id,
			__pluginId,
			provides: schema.provides,
		} as NodeImpl<TState, TProvides, any>;

		producer.get = buildProducerGet(producer, providesRec) as unknown as ProducerGet<TState, TProvides>;
		return producer;
	};

	return { __id: __pluginId, create, get };
}
