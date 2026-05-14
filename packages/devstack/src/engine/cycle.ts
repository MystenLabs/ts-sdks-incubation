import { flattenDeps } from './build.js';
import { canonicalize, computeInputHash, hash } from './identity.js';
import { colorByLockKeys, decomposeRanks } from './scheduling.js';
import {
	isExclusiveRecipe,
	type AnyNodeImpl,
	type BuiltGraph,
	type CycleResult,
	type Dep,
	type DepRecipe,
	type EngineEvent,
	type Env,
	type NodeError,
	type NodeState,
	type Producer,
	type ResolvedDeps,
	type RunArgs,
	type WorkIntent,
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

// Per-node execution outcome — what `executeNode` returns to the
// rank-coordinator loop.
interface NodeOutcome {
	id: symbol;
	name: string;
	classification: 'ran' | 'skipped' | 'errored';
	skipReason?: 'satisfied' | 'upstream_errored';
	error?: Error;
	invalidationTargets: string[];
	restartTargets: string[];
	watchPaths: string[];
}

export async function runCycle(args: CycleArgs): Promise<CycleOutcome> {
	const { graph, env, nodeStates, forceRun, isFirstCycle, emit } = args;
	const now = args.now ?? Date.now;

	const workIntents = computeWorkSet(graph, forceRun, isFirstCycle);

	const result: CycleResult = { ran: [], skipped: [], errored: [] };
	const pendingReruns = new Map<string, WorkIntent>();
	const erroredIds = new Set<symbol>();

	// Decompose the work-set into ranks. Within a rank, nodes have no
	// upstream-of-each-other edges, so they're free to run in parallel
	// modulo lockKey conflicts. Decomposition is over the full topo
	// order — nodes outside the work-set still affect rank assignment
	// (so a downstream consumer ends up at rank > its upstream even if
	// the upstream isn't being re-run this cycle).
	const ranks = decomposeRanks(
		graph.topoOrder,
		(id) => graph.nodes.get(id)?.edges ?? new Set(),
	);
	const workByRank = new Map<number, symbol[]>();
	for (const id of graph.topoOrder) {
		if (!workIntents.has(id)) continue;
		const r = ranks.get(id) ?? 0;
		const list = workByRank.get(r) ?? [];
		list.push(id);
		workByRank.set(r, list);
	}
	const rankNumbers = [...workByRank.keys()].sort((a, b) => a - b);

	for (const rank of rankNumbers) {
		const ids = workByRank.get(rank)!;

		// Two nodes in the same rank conflict iff their resolved
		// exclusive-Dep lockKeys intersect. Pure greedy coloring assigns
		// each node a color number; nodes within one color have pairwise-
		// disjoint lockKeys, so they're safe to run concurrently.
		const lockKeysById = new Map<symbol, Set<string>>();
		for (const id of ids) {
			lockKeysById.set(id, collectLockKeys(id, graph, nodeStates));
		}
		const colors = colorByLockKeys(ids, (id) => lockKeysById.get(id) ?? new Set());

		const idsByColor = new Map<number, symbol[]>();
		for (const id of ids) {
			const c = colors.get(id) ?? 0;
			const list = idsByColor.get(c) ?? [];
			list.push(id);
			idsByColor.set(c, list);
		}
		const colorNumbers = [...idsByColor.keys()].sort((a, b) => a - b);

		for (const color of colorNumbers) {
			const batch = idsByColor.get(color)!;
			// Within a color: parallel execution. Use Promise.allSettled
			// rather than Promise.all so one node's failure doesn't
			// short-circuit its siblings — each node's error is recorded
			// via its own `executeNode` outcome.
			const outcomes = await Promise.all(
				batch.map((id) =>
					executeNode({
						id,
						graph,
						env,
						nodeStates,
						forceRun,
						emit,
						now,
						intent: workIntents.get(id) ?? 'rerun',
						erroredIds,
						registerShutdown: args.registerShutdown,
					}),
				),
			);

			for (const outcome of outcomes) {
				if (outcome.classification === 'ran') {
					result.ran.push({ id: outcome.id, name: outcome.name });
				} else if (outcome.classification === 'skipped') {
					result.skipped.push({
						id: outcome.id,
						name: outcome.name,
						reason: outcome.skipReason ?? 'satisfied',
					});
				} else {
					result.errored.push({
						id: outcome.id,
						name: outcome.name,
						error: outcome.error ?? new Error('unknown'),
					});
					erroredIds.add(outcome.id);
				}
				for (const target of outcome.invalidationTargets) {
					if (pendingReruns.get(target) !== 'restart') {
						pendingReruns.set(target, 'rerun');
					}
				}
				for (const target of outcome.restartTargets) {
					pendingReruns.set(target, 'restart');
				}
				if (outcome.watchPaths.length > 0) {
					args.registerWatch?.(outcome.name, outcome.watchPaths);
				}
			}
		}
	}

	return { result, pendingReruns };
}

interface ExecuteNodeArgs {
	id: symbol;
	graph: BuiltGraph;
	env: Env;
	nodeStates: Map<string, NodeState>;
	forceRun: Map<string, WorkIntent>;
	emit: (event: EngineEvent) => void;
	now: () => number;
	intent: WorkIntent;
	erroredIds: ReadonlySet<symbol>;
	registerShutdown: ((nodeName: string, fn: () => Promise<void>) => void) | undefined;
}

async function executeNode(args: ExecuteNodeArgs): Promise<NodeOutcome> {
	const { id, graph, env, nodeStates, forceRun, emit, now, intent, erroredIds } = args;
	const node = graph.nodes.get(id);
	if (!node) {
		// Shouldn't happen — work-set is built from topoOrder which is
		// built from graph.nodes. Treat as a no-op for safety.
		return {
			id,
			name: id.description ?? '<anonymous>',
			classification: 'skipped',
			skipReason: 'satisfied',
			invalidationTargets: [],
			restartTargets: [],
			watchPaths: [],
		};
	}
	const producer = node.producer;
	const impl = producer as AnyNodeImpl;
	const prior = nodeStates.get(producer.name);

	const outcome: NodeOutcome = {
		id,
		name: producer.name,
		classification: 'skipped',
		invalidationTargets: [],
		restartTargets: [],
		watchPaths: [],
	};

	if (anyUpstreamErrored(node.edges, erroredIds)) {
		outcome.skipReason = 'upstream_errored';
		emit({
			type: 'node:status',
			name: producer.name,
			before: priorStatus(prior),
			after: 'skipped',
		});
		return outcome;
	}

	let resolvedDeps: ResolvedDeps<unknown>;
	try {
		resolvedDeps = resolveDeps(impl.deps, nodeStates, graph) as ResolvedDeps<unknown>;
	} catch (err) {
		return errorOutcome({
			outcome,
			err,
			prior,
			inputHash: prior?.lastInputHash,
			nodeStates,
			emit,
			now,
		});
	}

	const upstreamIdentities = collectUpstreamIdentities(node.edges, graph, nodeStates);

	let ownInputs: unknown;
	if (impl.inputs) {
		try {
			ownInputs = await impl.inputs({ env, deps: resolvedDeps });
		} catch (err) {
			return errorOutcome({
				outcome,
				err,
				prior,
				inputHash: prior?.lastInputHash,
				nodeStates,
				emit,
				now,
			});
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
			return errorOutcome({
				outcome,
				err,
				prior,
				inputHash,
				nodeStates,
				emit,
				now,
			});
		}
	} else {
		shouldRun = inputHash !== prior?.lastInputHash;
	}

	const hasStart = typeof impl.start === 'function';
	const hasRun = typeof impl.run === 'function';
	const willDispatch = intent === 'restart' || hasStart || (hasRun && shouldRun);

	if (!willDispatch) {
		outcome.skipReason = 'satisfied';
		emit({
			type: 'node:status',
			name: producer.name,
			before: priorStatus(prior),
			after: 'satisfied',
		});
		return outcome;
	}

	const requests = bucketsToObject(graph.requestsByProducer.get(id));

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
		requestRerun: () => outcome.invalidationTargets.push(producer.name),
		requestRestart: () => outcome.restartTargets.push(producer.name),
		invalidate: (other) => outcome.invalidationTargets.push(other),
		watch: (paths) => {
			outcome.watchPaths.push(...(Array.isArray(paths) ? paths : [paths]));
		},
	};

	emit({
		type: 'node:status',
		name: producer.name,
		before: priorStatus(prior),
		after: 'running',
	});

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

		emit({ type: 'node:state-changed', name: producer.name });
		emit({
			type: 'node:status',
			name: producer.name,
			before: 'running',
			after: 'satisfied',
		});

		outcome.classification = 'ran';
		return outcome;
	} catch (err) {
		return errorOutcome({
			outcome,
			err,
			prior,
			inputHash,
			nodeStates,
			emit,
			now,
		});
	}
}

interface ErrorOutcomeArgs {
	outcome: NodeOutcome;
	err: unknown;
	prior: NodeState | undefined;
	inputHash: string | undefined;
	nodeStates: Map<string, NodeState>;
	emit: (event: EngineEvent) => void;
	now: () => number;
}

function errorOutcome(args: ErrorOutcomeArgs): NodeOutcome {
	const { outcome, err, prior, inputHash, nodeStates, emit, now } = args;
	const error = asError(err);
	const next: NodeState = {
		...prior,
		error: errToNodeError(err, now),
	};
	if (inputHash !== undefined) next.lastInputHash = inputHash;
	nodeStates.set(outcome.name, next);
	emit({ type: 'engine:error', error, name: outcome.name });
	emit({
		type: 'node:status',
		name: outcome.name,
		before: 'running',
		after: 'errored',
	});
	outcome.classification = 'errored';
	outcome.error = error;
	return outcome;
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

function anyUpstreamErrored(edges: Set<symbol>, erroredIds: ReadonlySet<symbol>): boolean {
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
		return value.get(upstreamState, value.data);
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

function isDep(value: unknown): value is Dep<never> {
	if (typeof value !== 'object' || value === null) return false;
	return '__producer' in value || '__pluginId' in value;
}

function resolveProducer(dep: Dep<never>, graph: BuiltGraph): Producer<any, any> {
	if (dep.__producer) return dep.__producer;
	if (dep.__pluginId !== undefined) {
		const inst = graph.pluginInstances.get(dep.__pluginId);
		if (inst) return inst;
	}
	throw new Error(
		`unable to resolve producer for dep type "${dep.type}" — missing __producer and __pluginId not found`,
	);
}

// Walk every Dep a node consumes; for each Dep whose underlying recipe
// is an `exclusiveDep`, resolve its `lockKey(state, data)` and collect
// the result. The returned set is the node's contribution to the
// rank's conflict graph.
function collectLockKeys(
	id: symbol,
	graph: BuiltGraph,
	nodeStates: Map<string, NodeState>,
): Set<string> {
	const node = graph.nodes.get(id);
	if (!node) return new Set();
	const impl = node.producer as AnyNodeImpl;
	if (impl.deps === undefined) return new Set();

	const keys = new Set<string>();
	for (const dep of flattenDeps(impl.deps)) {
		let upstream: Producer<any, any> | undefined;
		if (dep.__producer) {
			upstream = dep.__producer;
		} else if (dep.__pluginId !== undefined) {
			upstream = graph.pluginInstances.get(dep.__pluginId);
		}
		if (upstream === undefined) continue;
		const provides = (upstream as AnyNodeImpl).provides;
		if (provides === undefined) continue;
		const recipe = (provides as Record<string, DepRecipe<unknown, unknown, unknown>>)[dep.type];
		if (recipe === undefined || !isExclusiveRecipe(recipe)) continue;
		const upstreamState = nodeStates.get(upstream.name)?.state;
		try {
			const key = recipe.lockKey(upstreamState, dep.data);
			keys.add(key);
		} catch {
			// lockKey threw — skip this contribution. Better to lose a
			// mutex than fail the whole cycle; the user-visible failure
			// (gas-coin equivocation) will still surface at run time.
		}
	}
	return keys;
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
