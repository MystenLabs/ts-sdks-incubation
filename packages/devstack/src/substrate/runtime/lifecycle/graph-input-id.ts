// Graph input identity.
//
// This is the substrate-level desired-state identity primitive for a resolved
// graph. Each node gets a deterministic input id from its declared static
// inputs plus upstream node input ids; the graph gets an aggregate id from
// node ids, graph shape, runtime-root-affecting options, and the devstack
// version. Snapshot policy can compare these ids to warn or refuse restores;
// warm restore uses the aggregate id for baseline validity.

import { createHash } from 'node:crypto';

import { Effect, Exit, Schema } from 'effect';

import type { GraphInputId, NodeInputId } from '../../brand.ts';
import { graphInputId, nodeInputId } from '../../brand.ts';
import type { DevstackOptions } from '../../options.ts';
import { resolveGraph, type DepGraphError, type DepNode, type ResolvedGraph } from './dep-graph.ts';

const GRAPH_INPUT_ID_VERSION = 1 as const;

export interface NodeInputIdentity {
	readonly key: string;
	readonly inputId: NodeInputId;
	readonly upstreamInputIds: ReadonlyArray<{
		readonly key: string;
		readonly inputId: NodeInputId;
	}>;
}

export interface GraphInputIdentity {
	readonly graphInputId: GraphInputId;
	readonly nodes: ReadonlyArray<NodeInputIdentity>;
}

export interface StackGraphInputSource {
	readonly members: ReadonlyArray<DepNode['member']>;
	readonly options: DevstackOptions;
}

export class GraphInputIdentityError extends Schema.TaggedErrorClass<GraphInputIdentityError>()(
	'GraphInputIdentityError',
	{
		pluginKey: Schema.String,
		detail: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

export type StackGraphInputIdentityError = DepGraphError | GraphInputIdentityError;

const canonicalize = (value: unknown): unknown => {
	if (typeof value === 'bigint') {
		return { type: 'bigint', value: value.toString() };
	}
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalize(entry));
	}
	if (value !== null && typeof value === 'object') {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort((a, b) => a.localeCompare(b))) {
			const entry = source[key];
			if (entry === undefined) continue;
			out[key] = canonicalize(entry);
		}
		return out;
	}
	return value;
};

const canonicalStringify = (value: unknown): string => {
	const encoded = JSON.stringify(canonicalize(value));
	return encoded === undefined ? String(encoded) : encoded;
};

const sha256Hex = (data: string | Uint8Array): string =>
	createHash('sha256').update(data).digest('hex');

const sortStrings = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
	[...values].sort((a, b) => a.localeCompare(b));

export const graphRelevantOptions = (options: DevstackOptions): unknown => {
	const { renderer: _renderer, extras: _extras, codegen: _codegen, ...rest } = options;
	return rest;
};

const nodeBaseDocument = (node: DepNode, inputIdentity: unknown): unknown => ({
	resourceId: node.member.id,
	role: node.member.role,
	section: node.member.section,
	...(node.member.endpointSection === undefined
		? {}
		: { endpointSection: node.member.endpointSection }),
	keepAliveOnRestore: node.keepAliveOnRestore,
	upstreamResources: sortStrings(node.upstreamResources.map((resource) => resource.id)),
	...(node.member.watch === undefined
		? {}
		: {
				watch: {
					paths: sortStrings(node.member.watch.paths),
					cascade: node.member.watch.cascade ?? true,
				},
			}),
	...(inputIdentity === undefined ? {} : { inputIdentity }),
});

const resolveNodeInputIdentity = (
	node: DepNode,
): Effect.Effect<unknown, GraphInputIdentityError> => {
	const contribution = node.member.inputIdentity;
	if (contribution === undefined) return Effect.succeed(undefined);
	if (contribution.kind === 'static') return Effect.succeed(contribution.value);

	const pluginKey = String(node.key);
	return Effect.try({
		try: () => contribution.compute(),
		catch: (cause) =>
			new GraphInputIdentityError({
				pluginKey,
				detail: 'node input identity computation could not be created',
				cause,
			}),
	}).pipe(
		Effect.flatMap((effect) => Effect.exit(effect)),
		Effect.flatMap((exit) =>
			Exit.isSuccess(exit)
				? Effect.succeed(exit.value)
				: Effect.fail(
						new GraphInputIdentityError({
							pluginKey,
							detail: 'node input identity computation failed',
							cause: exit.cause,
						}),
					),
		),
	);
};

export const computeGraphInputIdentity = (args: {
	readonly graph: ResolvedGraph;
	readonly options: DevstackOptions;
	readonly devstackVersion: string;
}): Effect.Effect<GraphInputIdentity, GraphInputIdentityError> =>
	Effect.gen(function* () {
		const inputIdByKey = new Map<string, NodeInputId>();
		const nodeIdentityByKey = new Map<string, NodeInputIdentity>();

		for (const level of args.graph.levels) {
			for (const key of level) {
				const node = args.graph.nodes.get(key);
				if (node === undefined) continue;
				const upstreamInputIds: Array<{ key: string; inputId: NodeInputId }> = [];
				for (const upstreamKey of node.upstreamKeys) {
					const upstreamKeyString = String(upstreamKey);
					const inputId = inputIdByKey.get(upstreamKeyString);
					if (inputId === undefined) {
						return yield* Effect.fail(
							new GraphInputIdentityError({
								pluginKey: String(key),
								detail: `upstream node input id missing for ${upstreamKeyString}`,
							}),
						);
					}
					upstreamInputIds.push({ key: upstreamKeyString, inputId });
				}
				upstreamInputIds.sort((a, b) => a.key.localeCompare(b.key));
				const inputIdentity = yield* resolveNodeInputIdentity(node);
				const inputId = nodeInputId(
					sha256Hex(
						canonicalStringify({
							v: GRAPH_INPUT_ID_VERSION,
							node: nodeBaseDocument(node, inputIdentity),
							upstreamInputIds,
						}),
					),
				);
				inputIdByKey.set(String(key), inputId);
				nodeIdentityByKey.set(String(key), {
					key: String(key),
					inputId,
					upstreamInputIds,
				});
			}
		}

		const nodes = [...nodeIdentityByKey.values()].sort((a, b) => a.key.localeCompare(b.key));
		const downstream = [...args.graph.downstream.entries()]
			.map(([key, children]) => ({
				key: String(key),
				children: sortStrings([...children].map(String)),
			}))
			.sort((a, b) => a.key.localeCompare(b.key));

		const graphDoc = {
			v: GRAPH_INPUT_ID_VERSION,
			devstackVersion: args.devstackVersion,
			options: graphRelevantOptions(args.options),
			levels: args.graph.levels.map((level) => sortStrings(level.map(String))),
			nodes: nodes.map((node) => ({ key: node.key, inputId: node.inputId })),
			downstream,
		};

		return {
			graphInputId: graphInputId(sha256Hex(canonicalStringify(graphDoc))),
			nodes,
		};
	});

export const computeStackGraphInputIdentity = (args: {
	readonly stack: StackGraphInputSource;
	readonly devstackVersion: string;
}): Effect.Effect<GraphInputIdentity, StackGraphInputIdentityError> =>
	Effect.gen(function* () {
		const graph = yield* resolveGraph(args.stack.members);
		return yield* computeGraphInputIdentity({
			graph,
			options: args.stack.options,
			devstackVersion: args.devstackVersion,
		});
	});
