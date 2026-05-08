import { buildGraph } from './build.js';
import { runCycle } from './cycle.js';
import { createSnapshot, hydrateNodeStates } from './snapshot.js';
import type {
	BuiltGraph,
	CycleResult,
	CycleStatus,
	DevstackConfig,
	EngineEvent,
	EngineState,
	Env,
	NodeState,
	NodeStatus,
	NodeView,
	SnapshotRecord,
	WorkIntent,
} from './types.js';

const LOG_RING_SIZE = 100;

export interface EngineOptions {
	env: Env;
	initialSnapshot?: SnapshotRecord;
}

export class Engine {
	private readonly graph: BuiltGraph;
	private readonly env: Env;
	private readonly nodeStates: Map<string, NodeState>;
	private readonly subscribers = new Set<(event: EngineEvent) => void>();
	private readonly logBuffers = new Map<string, string[]>();
	private readonly shutdownHandlers = new Map<string, (() => Promise<void>)[]>();
	private readonly watchPaths = new Map<string, string[]>();
	private cycleCounter = 0;
	private cycleStatus: CycleStatus = 'idle';
	private cycleStartedAt?: number;
	private hasRunFirstCycle = false;
	private pendingForceRun = new Map<string, WorkIntent>();
	private inflightCycle?: Promise<CycleResult>;
	private isPaused = false;
	private isStopped = false;

	constructor(config: DevstackConfig, options: EngineOptions) {
		this.graph = buildGraph(config);
		this.env = options.env;
		this.nodeStates = hydrateNodeStates(options.initialSnapshot);
		this.subscribers.add((event) => this.captureLog(event));
	}

	getState(): EngineState {
		const nodes = new Map<string, NodeView>();
		for (const id of this.graph.topoOrder) {
			const node = this.graph.nodes.get(id);
			if (!node) continue;
			const name = node.producer.name;
			nodes.set(name, this.nodeView(name));
		}
		const cycle: EngineState['cycle'] = {
			id: this.cycleCounter,
			status: this.cycleStatus,
		};
		if (this.cycleStartedAt !== undefined) cycle.startedAt = this.cycleStartedAt;
		return { cycle, nodes };
	}

	subscribe(handler: (event: EngineEvent) => void): () => void {
		this.subscribers.add(handler);
		return () => {
			this.subscribers.delete(handler);
		};
	}

	async runOnce(): Promise<CycleResult> {
		return this.cycle();
	}

	async start(): Promise<void> {
		await this.cycle();
		if (this.isStopped) return;
		await new Promise<void>((resolve) => {
			const unsubscribe = this.subscribe((event) => {
				if (event.type === 'shutdown') {
					unsubscribe();
					resolve();
				}
			});
		});
	}

	async stop(): Promise<void> {
		if (this.isStopped) return;
		this.isStopped = true;
		if (this.inflightCycle) {
			try {
				await this.inflightCycle;
			} catch {
				// already surfaced via engine:error
			}
		}
		const handlers = [...this.shutdownHandlers.values()].flat();
		for (const fn of handlers) {
			try {
				await fn();
			} catch (err) {
				this.emit({ type: 'engine:error', error: asError(err) });
			}
		}
		this.shutdownHandlers.clear();
		this.emit({ type: 'shutdown' });
	}

	async pause(): Promise<void> {
		this.isPaused = true;
		if (this.inflightCycle) {
			try {
				await this.inflightCycle;
			} catch {
				// already surfaced
			}
		}
		this.cycleStatus = 'paused';
	}

	async resume(): Promise<void> {
		this.isPaused = false;
		this.cycleStatus = 'idle';
	}

	async saveSnapshot(): Promise<SnapshotRecord> {
		return createSnapshot({
			env: this.env,
			graph: this.graph,
			nodeStates: this.nodeStates,
		});
	}

	invalidate(name: string): void {
		if (!this.graph.idByName.has(name)) return;
		const existing = this.pendingForceRun.get(name);
		if (existing === 'restart') return;
		this.pendingForceRun.set(name, 'rerun');
	}

	restart(name: string): void {
		if (!this.graph.idByName.has(name)) return;
		this.pendingForceRun.set(name, 'restart');
	}

	retry(name: string): void {
		this.invalidate(name);
	}

	async cycle(): Promise<CycleResult> {
		if (this.isStopped) throw new Error('engine has been stopped');
		if (this.isPaused) throw new Error('engine is paused — call resume() first');
		if (this.inflightCycle) return this.inflightCycle;
		this.inflightCycle = this.doCycle();
		try {
			return await this.inflightCycle;
		} finally {
			this.inflightCycle = undefined;
		}
	}

	private async doCycle(): Promise<CycleResult> {
		this.cycleCounter += 1;
		this.cycleStartedAt = Date.now();
		this.cycleStatus = 'running';
		this.emit({ type: 'cycle:start', cycleId: this.cycleCounter });

		const forceRun = new Map(this.pendingForceRun);
		this.pendingForceRun.clear();
		const isFirstCycle = !this.hasRunFirstCycle;
		const startedMs = Date.now();

		const { result, pendingReruns } = await runCycle({
			graph: this.graph,
			env: this.env,
			nodeStates: this.nodeStates,
			forceRun,
			isFirstCycle,
			emit: (event) => this.emit(event),
			registerShutdown: (name, fn) => {
				const arr = this.shutdownHandlers.get(name) ?? [];
				arr.push(fn);
				this.shutdownHandlers.set(name, arr);
			},
			registerWatch: (name, paths) => {
				this.watchPaths.set(name, paths);
			},
		});

		this.hasRunFirstCycle = true;

		for (const [name, intent] of pendingReruns) {
			const existing = this.pendingForceRun.get(name);
			if (intent === 'restart' || existing !== 'restart') {
				this.pendingForceRun.set(name, intent);
			}
		}

		this.cycleStatus = 'idle';
		this.emit({
			type: 'cycle:end',
			cycleId: this.cycleCounter,
			durationMs: Date.now() - startedMs,
		});

		return result;
	}

	private nodeView(name: string): NodeView {
		const state = this.nodeStates.get(name);
		const view: NodeView = {
			name,
			status: this.deriveStatus(state),
			logs: [...(this.logBuffers.get(name) ?? [])],
		};
		if (state?.state !== undefined) view.state = state.state;
		if (state?.representations) view.representations = state.representations;
		if (state?.lastInputHash !== undefined) view.lastInputHash = state.lastInputHash;
		if (state?.lastRunAt !== undefined) view.lastRunAt = state.lastRunAt;
		if (state?.error) {
			const lastError: { message: string; stack?: string } = { message: state.error.message };
			if (state.error.stack !== undefined) lastError.stack = state.error.stack;
			view.lastError = lastError;
		}
		return view;
	}

	private deriveStatus(state: NodeState | undefined): NodeStatus {
		if (!state) return 'idle';
		if (state.error) return 'errored';
		if (state.lastInputHash) return 'satisfied';
		return 'idle';
	}

	private emit(event: EngineEvent): void {
		for (const handler of this.subscribers) {
			try {
				handler(event);
			} catch {
				// subscriber errors must not break the engine
			}
		}
	}

	private captureLog(event: EngineEvent): void {
		if (event.type !== 'node:log') return;
		const buf = this.logBuffers.get(event.name) ?? [];
		buf.push(event.line);
		while (buf.length > LOG_RING_SIZE) buf.shift();
		this.logBuffers.set(event.name, buf);
	}

	getWatchPaths(name: string): readonly string[] {
		return this.watchPaths.get(name) ?? [];
	}
}

function asError(err: unknown): Error {
	if (err instanceof Error) return err;
	return new Error(String(err));
}
