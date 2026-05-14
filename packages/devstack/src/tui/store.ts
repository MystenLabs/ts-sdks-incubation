import type { Engine } from '../engine/class.js';
import type { EngineEvent, EngineState } from '../engine/types.js';

// Tiny in-memory store the React tree subscribes to via
// `useSyncExternalStore`. We re-pull engine.getState() on every event so
// React always sees a fresh snapshot; a version counter triggers
// reconciliation (since EngineState contains a Map, reference-equality
// alone isn't reliable).

export interface TuiSnapshot {
	version: number;
	state: EngineState;
	/** Last-N transient events shown above the status table — useful
	 * during shutdown to give visual confirmation that something is
	 * happening even after the cycle ends. */
	tail: string[];
}

export interface Store {
	subscribe: (cb: () => void) => () => void;
	getSnapshot: () => TuiSnapshot;
	getServerSnapshot: () => TuiSnapshot;
}

const TAIL_SIZE = 8;

export function createStore(engine: Engine): { store: Store; detach: () => void } {
	let snapshot: TuiSnapshot = {
		version: 0,
		state: engine.getState(),
		tail: [],
	};
	const listeners = new Set<() => void>();

	const bump = () => {
		snapshot = {
			version: snapshot.version + 1,
			state: engine.getState(),
			tail: snapshot.tail,
		};
		for (const cb of listeners) cb();
	};

	const pushTail = (line: string): void => {
		const next = snapshot.tail.slice(-TAIL_SIZE + 1);
		next.push(line);
		snapshot = { version: snapshot.version + 1, state: snapshot.state, tail: next };
		for (const cb of listeners) cb();
	};

	const detach = engine.subscribe((event: EngineEvent) => {
		switch (event.type) {
			case 'cycle:start':
				pushTail(`cycle ${event.cycleId} start`);
				break;
			case 'cycle:end':
				pushTail(`cycle ${event.cycleId} end (${event.durationMs}ms)`);
				bump();
				break;
			case 'node:status':
				bump();
				break;
			case 'node:state-changed':
				bump();
				break;
			case 'node:log':
				// Logs are already mirrored into NodeView.logs by the engine
				// — getState() returns them. No need to mirror here. Bump
				// so the per-node log preview re-renders.
				bump();
				break;
			case 'engine:error':
				pushTail(
					`! engine error${event.name !== undefined ? ` in ${event.name}` : ''}: ${event.error.message}`,
				);
				break;
			case 'shutdown':
				pushTail('[shutdown]');
				bump();
				break;
		}
	});

	return {
		store: {
			subscribe: (cb) => {
				listeners.add(cb);
				return () => listeners.delete(cb);
			},
			getSnapshot: () => snapshot,
			getServerSnapshot: () => snapshot,
		},
		detach,
	};
}
