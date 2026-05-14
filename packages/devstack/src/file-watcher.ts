import { watch as fsWatch } from 'node:fs/promises';
import type { Engine } from './engine/class.js';

export interface FileWatcherOptions {
	/** Debounce window in ms. fs events arriving within this window
	 * coalesce into a single `engine.cycle()` call. Default 150. */
	debounceMs?: number;
	/** Optional log sink. When set, the watcher writes one line per
	 * triggered cycle (`[watch] cycle triggered by <name>, …`). When
	 * undefined, the watcher is silent — the user's renderer / event
	 * subscribers handle visibility. */
	log?: (line: string) => void;
}

// `attachFileWatcher` wires `node:fs/promises` watchers to an engine.
// Subscribes to `cycle:end` so the watcher set follows the engine's
// authoritative `getWatchPaths(name)` (nodes register paths via
// `runArgs.watch(...)` during start). On any fs event, marks the
// originating node dirty (`engine.invalidate(name)`) and fires a
// debounced `engine.cycle()` — bursts of editor saves coalesce into a
// single rebuild.
//
// Returns a detach function that aborts every watcher and unsubscribes.
//
// Public API: usable from outside the bundled `up` CLI. Custom
// supervisors (vitest harnesses, embedded engines in larger tools)
// can opt into watching independently. `up` uses this internally.
//
// Linux note: node's `watch()` with `recursive: true` silently
// degrades to non-recursive (no native inotify recursion). Move trees
// on linux may want chokidar instead — defer until someone reports it.
export function attachFileWatcher(
	engine: Engine,
	opts: FileWatcherOptions = {},
): () => void {
	const debounceMs = opts.debounceMs ?? 150;
	const log = opts.log ?? (() => undefined);

	// path → { aborter, names: which nodes care about this path }
	const active = new Map<string, { aborter: AbortController; names: Set<string> }>();
	const pendingInvalidations = new Set<string>();
	let debounceTimer: NodeJS.Timeout | undefined;
	let detached = false;

	const fireCycle = (): void => {
		debounceTimer = undefined;
		if (pendingInvalidations.size === 0 || detached) return;
		const triggered = [...pendingInvalidations].sort();
		pendingInvalidations.clear();
		for (const name of triggered) engine.invalidate(name);
		log(`[watch] cycle triggered by ${triggered.join(', ')}`);
		// engine.cycle errors surface as engine:error events through
		// subscribers; swallow the rejection here so the watcher's
		// microtask doesn't bubble an unhandled rejection.
		void engine.cycle().catch(() => undefined);
	};

	const scheduleCycle = (): void => {
		if (debounceTimer !== undefined) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(fireCycle, debounceMs);
	};

	const startWatcher = (path: string): AbortController => {
		const aborter = new AbortController();
		(async () => {
			try {
				for await (const _evt of fsWatch(path, {
					recursive: true,
					signal: aborter.signal,
				})) {
					const entry = active.get(path);
					if (!entry) continue;
					for (const name of entry.names) pendingInvalidations.add(name);
					scheduleCycle();
				}
			} catch (err) {
				if (aborter.signal.aborted) return;
				const code = (err as { code?: string }).code;
				if (code === 'ENOENT') {
					// Path doesn't exist (yet). Common on cold starts before
					// a node has actually written its source dir. Drop the
					// watcher; the next cycle:end refresh re-attempts when
					// the path has been registered fresh.
					return;
				}
				log(`[watch] error on ${path}: ${(err as Error).message ?? String(err)}`);
			}
		})();
		return aborter;
	};

	const refresh = (): void => {
		if (detached) return;
		const desired = new Map<string, Set<string>>();
		for (const name of engine.getState().nodes.keys()) {
			for (const p of engine.getWatchPaths(name)) {
				let set = desired.get(p);
				if (!set) {
					set = new Set();
					desired.set(p, set);
				}
				set.add(name);
			}
		}
		// Cancel watchers no longer wanted.
		for (const [path, entry] of active) {
			if (!desired.has(path)) {
				entry.aborter.abort();
				active.delete(path);
			}
		}
		// Add or update remaining watchers.
		for (const [path, names] of desired) {
			const existing = active.get(path);
			if (existing === undefined) {
				active.set(path, { aborter: startWatcher(path), names });
			} else {
				existing.names = names;
			}
		}
	};

	const detachSubscriber = engine.subscribe((event) => {
		if (event.type === 'cycle:end') refresh();
	});

	// Initial pass — for `runOnce`-style integrations where there is
	// no cycle:end before the supervisor takes over.
	refresh();

	return () => {
		detached = true;
		detachSubscriber();
		if (debounceTimer !== undefined) clearTimeout(debounceTimer);
		for (const { aborter } of active.values()) aborter.abort();
		active.clear();
	};
}
