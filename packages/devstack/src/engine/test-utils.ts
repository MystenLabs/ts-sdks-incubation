import type { AnyNodeImpl, Dep, NodeImpl } from './types.js';

export interface MockProducerOptions<TState = unknown> {
	name: string;
	pluginId?: symbol;
	deps?: unknown;
	start?: NodeImpl<TState, any, any>['start'];
	run?: NodeImpl<TState, any, any>['run'];
	stop?: NodeImpl<TState, any, any>['stop'];
	restart?: NodeImpl<TState, any, any>['restart'];
	getStatus?: NodeImpl<TState, any, any>['getStatus'];
	inputs?: NodeImpl<TState, any, any>['inputs'];
	represents?: NodeImpl<TState, any, any>['represents'];
}

export function mockProducer<TState = unknown>(options: MockProducerOptions<TState>): AnyNodeImpl {
	const id = Symbol(options.name);
	const producer: AnyNodeImpl = {
		__id: id,
		name: options.name,
		get: (key, ...args) => {
			const dep: Dep<never> = {
				type: key as string,
				data: args[0],
				__producer: producer,
				get: (state: unknown) => state,
			};
			return dep;
		},
	};
	if (options.pluginId !== undefined) producer.__pluginId = options.pluginId;
	if (options.deps !== undefined) producer.deps = options.deps;
	if (options.start) producer.start = options.start;
	if (options.run) producer.run = options.run;
	if (options.stop) producer.stop = options.stop;
	if (options.restart) producer.restart = options.restart;
	if (options.getStatus) producer.getStatus = options.getStatus;
	if (options.inputs) producer.inputs = options.inputs;
	if (options.represents) producer.represents = options.represents;
	if (!producer.start && !producer.run) {
		producer.start = async () => undefined as TState;
	}
	return producer;
}

export function makeSchemaDep(args: {
	pluginId: symbol;
	type: string;
	data?: unknown;
	get?: (state: unknown, data: unknown) => unknown;
}): Dep<unknown> {
	return {
		__pluginId: args.pluginId,
		type: args.type,
		data: args.data,
		get: args.get ?? ((state) => state),
	};
}

export function dep(
	producer: AnyNodeImpl,
	type: string,
	data?: unknown,
	project?: (state: unknown, data: unknown) => unknown,
): Dep<unknown> {
	return {
		__producer: producer,
		type,
		data,
		get: project ?? ((state) => state),
	};
}
