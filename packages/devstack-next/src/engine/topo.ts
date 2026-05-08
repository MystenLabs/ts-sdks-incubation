export class CycleError extends Error {
	readonly cycleNames: string[];
	constructor(cycleNames: string[]) {
		super(`cycle detected: ${cycleNames.join(' → ')}`);
		this.name = 'CycleError';
		this.cycleNames = cycleNames;
	}
}

export interface TopoArgs {
	ids: Iterable<symbol>;
	upstreamOf: (id: symbol) => Iterable<symbol>;
	nameOf?: (id: symbol) => string;
}

export function topoSort(args: TopoArgs): symbol[] {
	const order: symbol[] = [];
	const color = new Map<symbol, 'gray' | 'black'>();
	const nameOf = args.nameOf ?? ((id) => id.description ?? '<anonymous>');

	const visit = (id: symbol, path: symbol[]): void => {
		const c = color.get(id);
		if (c === 'black') return;
		if (c === 'gray') {
			const cycleStart = path.indexOf(id);
			const cycle = [...path.slice(cycleStart), id].map(nameOf);
			throw new CycleError(cycle);
		}
		color.set(id, 'gray');
		const nextPath = [...path, id];
		for (const upstream of args.upstreamOf(id)) {
			visit(upstream, nextPath);
		}
		color.set(id, 'black');
		order.push(id);
	};

	for (const id of args.ids) {
		visit(id, []);
	}

	return order;
}

export function buildDownstreamIndex(
	args: Pick<TopoArgs, 'ids' | 'upstreamOf'>,
): Map<symbol, Set<symbol>> {
	const directDownstream = new Map<symbol, Set<symbol>>();
	for (const id of args.ids) {
		if (!directDownstream.has(id)) directDownstream.set(id, new Set());
		for (const up of args.upstreamOf(id)) {
			let set = directDownstream.get(up);
			if (!set) {
				set = new Set();
				directDownstream.set(up, set);
			}
			set.add(id);
		}
	}

	const subtree = new Map<symbol, Set<symbol>>();
	for (const id of directDownstream.keys()) {
		const result = new Set<symbol>();
		const queue: symbol[] = [...(directDownstream.get(id) ?? [])];
		while (queue.length > 0) {
			const cur = queue.shift() as symbol;
			if (result.has(cur)) continue;
			result.add(cur);
			const next = directDownstream.get(cur);
			if (next) for (const n of next) queue.push(n);
		}
		subtree.set(id, result);
	}

	return subtree;
}
