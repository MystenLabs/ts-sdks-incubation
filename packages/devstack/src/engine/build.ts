import { buildDownstreamIndex, topoSort } from './topo.js';
import type {
	AnyNodeImpl,
	BuiltGraph,
	Dep,
	DevstackConfig,
	Producer,
	ProducerNode,
} from './types.js';

export class BuildError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BuildError';
	}
}

export function buildGraph(config: DevstackConfig): BuiltGraph {
	const nodes = new Map<symbol, ProducerNode>();
	const requests = new Map<symbol, Map<string, unknown[]>>();
	const schemaInstances = new Map<symbol, Producer<any, any>>();
	const idByName = new Map<string, symbol>();

	for (const producer of config.stack) {
		if (producer.__pluginId !== undefined) {
			const prior = schemaInstances.get(producer.__pluginId);
			if (prior !== undefined && prior.__id !== producer.__id) {
				throw new BuildError(
					`two instances of the same schema in stack; pick one (collision between "${prior.name}" and "${producer.name}")`,
				);
			}
			schemaInstances.set(producer.__pluginId, producer);
		}
	}

	const visit = (producer: Producer<any, any>): void => {
		if (nodes.has(producer.__id)) return;

		const existingId = idByName.get(producer.name);
		if (existingId !== undefined && existingId !== producer.__id) {
			throw new BuildError(`duplicate producer name "${producer.name}"`);
		}
		idByName.set(producer.name, producer.__id);

		const impl = producer as AnyNodeImpl;
		if (typeof impl.start !== 'function' && typeof impl.run !== 'function') {
			throw new BuildError(`producer "${producer.name}" must define at least one of start, run`);
		}

		const node: ProducerNode = { producer, edges: new Set() };
		nodes.set(producer.__id, node);

		for (const dep of flattenDeps(impl.deps)) {
			let upstream: Producer<any, any>;
			if (dep.__producer) {
				upstream = dep.__producer;
			} else if (dep.__pluginId !== undefined) {
				const instance = schemaInstances.get(dep.__pluginId);
				if (!instance) {
					const tag = dep.__pluginId.description ?? '<anonymous>';
					throw new BuildError(
						`producer "${producer.name}" depends on schema "${tag}" but no instance of that schema is in the stack — add its .create({...}) call`,
					);
				}
				upstream = instance;
			} else {
				throw new BuildError(
					`producer "${producer.name}" has a dep with neither __producer nor __pluginId set`,
				);
			}

			visit(upstream);
			node.edges.add(upstream.__id);

			let byType = requests.get(upstream.__id);
			if (!byType) {
				byType = new Map();
				requests.set(upstream.__id, byType);
			}
			let list = byType.get(dep.type);
			if (!list) {
				list = [];
				byType.set(dep.type, list);
			}
			list.push(dep.data);
		}
	};

	for (const item of config.stack) visit(item);

	const ids = [...nodes.keys()];
	const upstreamOf = (id: symbol): Iterable<symbol> => nodes.get(id)?.edges ?? [];
	const nameOf = (id: symbol): string =>
		nodes.get(id)?.producer.name ?? id.description ?? '<anonymous>';

	const topoOrder = topoSort({ ids, upstreamOf, nameOf });
	const downstreamIndex = buildDownstreamIndex({ ids, upstreamOf });

	return {
		nodes,
		topoOrder,
		requestsByProducer: requests,
		idByName,
		pluginInstances: schemaInstances,
		downstreamSubtreeOf: (id) => downstreamIndex.get(id) ?? new Set(),
	};
}

export function flattenDeps(deps: unknown): Dep<never>[] {
	const out: Dep<never>[] = [];
	collect(deps, out, new Set());
	return out;
}

function collect(value: unknown, out: Dep<never>[], seen: Set<unknown>): void {
	if (value === null || value === undefined) return;
	if (isDep(value)) {
		out.push(value);
		return;
	}
	if (typeof value !== 'object') return;
	if (seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) collect(item, out, seen);
		return;
	}
	for (const v of Object.values(value as Record<string, unknown>)) collect(v, out, seen);
}

function isDep(value: unknown): value is Dep<never> {
	if (typeof value !== 'object' || value === null) return false;
	return '__producer' in value || '__pluginId' in value;
}
