import type { AnyNodeImpl, BuiltGraph, Env, NodeState, SnapshotRecord } from './types.js';

export const DEVSTACK_NEXT_VERSION = '0.0.0-dev';

export interface CreateSnapshotArgs {
	env: Env;
	graph: BuiltGraph;
	nodeStates: Map<string, NodeState>;
	now?: () => number;
}

export async function createSnapshot(args: CreateSnapshotArgs): Promise<SnapshotRecord> {
	const now = args.now ?? Date.now;
	const result: Record<string, NodeState> = {};

	for (const [name, prior] of args.nodeStates) {
		const id = args.graph.idByName.get(name);
		const node = id !== undefined ? args.graph.nodes.get(id) : undefined;
		const impl = node?.producer as AnyNodeImpl | undefined;

		if (impl?.snapshot && prior.state !== undefined) {
			const snapshotted = await impl.snapshot({ env: args.env, state: prior.state });
			result[name] = { ...prior, state: snapshotted };
		} else {
			result[name] = prior;
		}
	}

	return {
		createdAt: now(),
		env: {
			appName: args.env.appName,
			network: args.env.network,
			...(args.env.stack !== undefined && { stack: args.env.stack }),
		},
		nodeStates: result,
		meta: { devstackVersion: DEVSTACK_NEXT_VERSION },
	};
}

export function hydrateNodeStates(snapshot: SnapshotRecord | undefined): Map<string, NodeState> {
	const map = new Map<string, NodeState>();
	if (!snapshot) return map;
	for (const [name, state] of Object.entries(snapshot.nodeStates)) {
		map.set(name, state);
	}
	return map;
}
