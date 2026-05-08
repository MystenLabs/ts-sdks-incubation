import { canonicalize, computeInputHash, hash } from './identity.js';
import type {
	AnyNodeImpl,
	BuiltGraph,
	CycleResult,
	Dep,
	EngineEvent,
	Env,
	NodeError,
	NodeState,
	Producer,
	ResolvedDeps,
	RunArgs,
	WorkIntent,
} from './types.js';

export interface CycleArgs {
	graph: BuiltGraph;
	env: Env;
	nodeStates: Map<string, NodeState>;
	forceRun: Map<string, WorkIntent>;
	isFirstCycle: boolean;
	emit: (event: EngineEvent) => void;
	registerWatch?: (nodeName: string, paths: string[]) => void;
	registerShutdown?: (nodeName: string, fn: () => Promise<void>) => void;
	now?: () => number;
}

export interface CycleOutcome {
	result: CycleResult;
	pendingReruns: Map<string, WorkIntent>;
}

export async function runCycle(args: CycleArgs): Promise<CycleOutcome> {
	const { graph, env, nodeStates, forceRun, isFirstCycle, emit } = args;
	const now = args.now ?? Date.now;

	const workIntents = computeWorkSet(graph, forceRun, isFirstCycle);

	const result: CycleResult = { ran: [], skipped: [], errored: [] };
	const pendingReruns = new Map<string, WorkIntent>();
	const erroredIds = new Set<symbol>();

	for (const id of graph.topoOrder) {
		if (!workIntents.has(id)) continue;

		const node = graph.nodes.get(id);
		if (!node) continue;
		const producer = node.producer;
		const impl = producer as AnyNodeImpl;
		const intent = workIntents.get(id) ?? 'rerun';
		const prior = nodeStates.get(producer.name);

		if (anyUpstreamErrored(node.edges, erroredIds)) {
			result.skipped.push({ id, name: producer.name, reason: 'upstream_errored' });
			emit({
				type: 'node:status',
				name: producer.name,
				before: priorStatus(prior),
				after: 'skipped',
			});
			continue;
		}

		let resolvedDeps: ResolvedDeps<unknown>;
		try {
			resolvedDeps = resolveDeps(impl.deps, nodeStates, graph) as ResolvedDeps<unknown>;
		} catch (err) {
			recordError({
				err,
				id,
				name: producer.name,
				prior,
				inputHash: prior?.lastInputHash,
				nodeStates,
				result,
				erroredIds,
				emit,
				now,
			});
			continue;
		}

		const upstreamIdentities = collectUpstreamIdentities(node.edges, graph, nodeStates);

		let ownInputs: unknown;
		if (impl.inputs) {
			try {
				ownInputs = await impl.inputs({ env, deps: resolvedDeps });
			} catch (err) {
				recordError({
					err,
					id,
					name: producer.name,
					prior,
					inputHash: prior?.lastInputHash,
					nodeStates,
					result,
					erroredIds,
					emit,
					now,
				});
				continue;
			}
		}

		const inputHash = computeInputHash({ upstreamIdentities, ownInputs });

		let shouldRun: boolean;
		if (intent === 'restart') {
			shouldRun = true;
		} else if (forceRun.has(producer.name)) {
			shouldRun = true;
		} else if (impl.getStatus) {
			try {
				const status = await impl.getStatus({
					prior: prior?.state,
					deps: resolvedDeps,
					inputHash,
					env,
				});
				shouldRun = !status.ok;
			} catch (err) {
				recordError({
					err,
					id,
					name: producer.name,
					prior,
					inputHash,
					nodeStates,
					result,
					erroredIds,
					emit,
					now,
				});
				continue;
			}
		} else {
			shouldRun = inputHash !== prior?.lastInputHash;
		}

		const hasStart = typeof impl.start === 'function';
		const hasRun = typeof impl.run === 'function';
		const willDispatch = intent === 'restart' || hasStart || (hasRun && shouldRun);

		if (!willDispatch) {
			result.skipped.push({ id, name: producer.name, reason: 'satisfied' });
			emit({
				type: 'node:status',
				name: producer.name,
				before: priorStatus(prior),
				after: 'satisfied',
			});
			continue;
		}

		const requests = bucketsToObject(graph.requestsByProducer.get(id));
		const invalidationTargets: string[] = [];
		const restartTargets: string[] = [];
		const watchPaths: string[] = [];

		const log = (line: string): void => emit({ type: 'node:log', name: producer.name, line });
		const onShutdown = (fn: () => Promise<void>): void =>
			args.registerShutdown?.(producer.name, fn);

		const runArgs: RunArgs<unknown, any, unknown> = {
			env,
			log,
			onShutdown,
			inputHash,
			prior: prior?.state,
			requests,
			deps: resolvedDeps,
			requestRerun: () => invalidationTargets.push(producer.name),
			requestRestart: () => restartTargets.push(producer.name),
			invalidate: (other) => invalidationTargets.push(other),
			watch: (paths) => {
				watchPaths.push(...(Array.isArray(paths) ? paths : [paths]));
			},
		};

		emit({
			type: 'node:status',
			name: producer.name,
			before: priorStatus(prior),
			after: 'running',
		});

		const startedAt = now();
		try {
			let newState: unknown = prior?.state;

			if (intent === 'restart') {
				if (impl.restart) {
					newState = await impl.restart(runArgs);
				} else {
					if (impl.stop && newState !== undefined) {
						await impl.stop({ env, log, state: newState });
					}
					if (impl.start) {
						newState = await impl.start(runArgs);
					}
				}
			} else {
				if (hasStart) {
					newState = await impl.start!(runArgs);
				}
				if (hasRun && shouldRun) {
					newState = await impl.run!({ ...runArgs, prior: newState });
				}
			}

			const newIdentity = hash(canonicalize(newState));
			const representations = computeRepresentations(impl, newState);

			const nextNodeState: NodeState = {
				lastInputHash: inputHash,
				lastRunAt: now(),
				identity: newIdentity,
				state: newState,
			};
			if (representations) nextNodeState.representations = representations;
			nodeStates.set(producer.name, nextNodeState);

			result.ran.push({ id, name: producer.name });
			emit({ type: 'node:state-changed', name: producer.name });
			emit({
				type: 'node:status',
				name: producer.name,
				before: 'running',
				after: 'satisfied',
			});
			void startedAt;
		} catch (err) {
			recordError({
				err,
				id,
				name: producer.name,
				prior,
				inputHash,
				nodeStates,
				result,
				erroredIds,
				emit,
				now,
			});
		}

		if (watchPaths.length > 0) args.registerWatch?.(producer.name, watchPaths);

		for (const target of invalidationTargets) {
			if (pendingReruns.get(target) !== 'restart') {
				pendingReruns.set(target, 'rerun');
			}
		}
		for (const target of restartTargets) {
			pendingReruns.set(target, 'restart');
		}
	}

	return { result, pendingReruns };
}

function computeWorkSet(
	graph: BuiltGraph,
	forceRun: Map<string, WorkIntent>,
	isFirstCycle: boolean,
): Map<symbol, WorkIntent> {
	const work = new Map<symbol, WorkIntent>();
	if (isFirstCycle) {
		for (const id of graph.topoOrder) work.set(id, 'rerun');
		return work;
	}
	for (const [name, intent] of forceRun) {
		const id = graph.idByName.get(name);
		if (id === undefined) continue;
		work.set(id, intent);
		for (const downstream of graph.downstreamSubtreeOf(id)) {
			if (!work.has(downstream)) work.set(downstream, 'rerun');
		}
	}
	return work;
}

function anyUpstreamErrored(edges: Set<symbol>, erroredIds: Set<symbol>): boolean {
	for (const e of edges) {
		if (erroredIds.has(e)) return true;
	}
	return false;
}

function priorStatus(prior: NodeState | undefined): 'idle' | 'errored' | 'satisfied' {
	if (!prior) return 'idle';
	if (prior.error) return 'errored';
	if (prior.lastInputHash) return 'satisfied';
	return 'idle';
}

function bucketsToObject(buckets: Map<string, unknown[]> | undefined): Record<string, unknown[]> {
	const out: Record<string, unknown[]> = {};
	if (!buckets) return out;
	for (const [k, v] of buckets) out[k] = v;
	return out;
}

function resolveDeps(
	deps: unknown,
	nodeStates: Map<string, NodeState>,
	graph: BuiltGraph,
): unknown {
	if (deps === null || deps === undefined) return {};
	return walk(deps, nodeStates, graph, new Set());
}

function walk(
	value: unknown,
	nodeStates: Map<string, NodeState>,
	graph: BuiltGraph,
	seen: Set<unknown>,
): unknown {
	if (value === null || value === undefined) return value;
	if (isDep(value)) {
		const upstream = resolveProducer(value, graph);
		const upstreamState = nodeStates.get(upstream.name)?.state;
		return value.get(upstreamState, value.data as unknown);
	}
	if (typeof value !== 'object') return value;
	if (seen.has(value)) return value;
	seen.add(value);
	if (Array.isArray(value)) {
		return value.map((item) => walk(item, nodeStates, graph, seen));
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		out[k] = walk(v, nodeStates, graph, seen);
	}
	return out;
}

function isDep(value: unknown): value is Dep<unknown, unknown> {
	if (typeof value !== 'object' || value === null) return false;
	return '__producer' in value || '__pluginId' in value;
}

function resolveProducer(dep: Dep<unknown, unknown>, graph: BuiltGraph): Producer<any, any> {
	if (dep.__producer) return dep.__producer;
	if (dep.__pluginId !== undefined) {
		const inst = graph.pluginInstances.get(dep.__pluginId);
		if (inst) return inst;
	}
	throw new Error(
		`unable to resolve producer for dep type "${dep.type}" — missing __producer and __pluginId not found`,
	);
}

function collectUpstreamIdentities(
	edges: Set<symbol>,
	graph: BuiltGraph,
	nodeStates: Map<string, NodeState>,
): string[] {
	const result: string[] = [];
	for (const id of edges) {
		const node = graph.nodes.get(id);
		if (!node) continue;
		const state = nodeStates.get(node.producer.name);
		result.push(state?.identity ?? '');
	}
	return result;
}

function computeRepresentations(
	impl: AnyNodeImpl,
	state: unknown,
): Record<string, unknown[]> | undefined {
	if (!impl.represents || state === undefined) return undefined;
	const out: Record<string, unknown[]> = {};
	for (const [category, fn] of Object.entries(impl.represents)) {
		try {
			out[category] = fn(state);
		} catch {
			// A failing represents callback shouldn't fail the node — observability is best-effort.
		}
	}
	return out;
}

function asError(err: unknown): Error {
	if (err instanceof Error) return err;
	return new Error(String(err));
}

function errToNodeError(err: unknown, now: () => number): NodeError {
	const e = asError(err);
	const result: NodeError = { message: e.message, at: now() };
	if (e.stack !== undefined) result.stack = e.stack;
	return result;
}

interface RecordErrorArgs {
	err: unknown;
	id: symbol;
	name: string;
	prior: NodeState | undefined;
	inputHash: string | undefined;
	nodeStates: Map<string, NodeState>;
	result: CycleResult;
	erroredIds: Set<symbol>;
	emit: (event: EngineEvent) => void;
	now: () => number;
}

function recordError(args: RecordErrorArgs): void {
	const error = asError(args.err);
	const next: NodeState = {
		...args.prior,
		error: errToNodeError(args.err, args.now),
	};
	if (args.inputHash !== undefined) next.lastInputHash = args.inputHash;
	args.nodeStates.set(args.name, next);
	args.result.errored.push({ id: args.id, name: args.name, error });
	args.erroredIds.add(args.id);
	args.emit({ type: 'engine:error', error, name: args.name });
	args.emit({
		type: 'node:status',
		name: args.name,
		before: 'running',
		after: 'errored',
	});
}
