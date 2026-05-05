// File watcher. For each action that surfaces an implicit watch path
// (Q4: Publish → `<path>/sources/**/*.move` + `Move.toml`; Build →
// dockerfile + context), arms a chokidar instance. On any add/change/
// unlink, the action name is queued; queued names are debounced and then
// handed to the supervisor, which resets each action's reconciler state
// and triggers a cycle.
//
// We deliberately do not feed FS digests into the action's input hash
// here — that's the publish/build helper's job in P3+ (Q3). For now,
// "any FS event in the watched paths counts as stale"; the reconciler's
// per-action `getStatus()` (when defined) is the second gate.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Action } from '../core/types.js';

interface FileWatcherOptions {
	actions: Action[];
	appDir: string;
	onStale: (actionNames: string[]) => void;
	debounceMs?: number;
}

export class FileWatcher {
	private readonly watchers: FSWatcher[] = [];
	private readonly debounceMs: number;
	private readonly onStale: (actionNames: string[]) => void;
	private readonly pending = new Set<string>();
	private timer: NodeJS.Timeout | null = null;
	private armed = false;

	constructor(opts: FileWatcherOptions) {
		this.onStale = opts.onStale;
		this.debounceMs = opts.debounceMs ?? 150;

		for (const action of opts.actions) {
			const paths = watchPathsFor(action, opts.appDir);
			if (paths.length === 0) continue;
			const w = chokidar.watch(paths, {
				ignoreInitial: true,
				awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
			});
			w.on('all', () => this.markStale(action.name));
			this.watchers.push(w);
		}
	}

	start(): void {
		this.armed = true;
	}

	async stop(): Promise<void> {
		this.armed = false;
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		await Promise.all(this.watchers.map((w) => w.close()));
		this.watchers.length = 0;
	}

	private markStale(name: string): void {
		if (!this.armed) return;
		this.pending.add(name);
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			const names = Array.from(this.pending);
			this.pending.clear();
			this.timer = null;
			this.onStale(names);
		}, this.debounceMs);
	}
}

function watchPathsFor(action: Action, appDir: string): string[] {
	let candidates: string[] = [];
	if (action.type === 'Publish') {
		const pkgDir = resolve(appDir, action.path);
		candidates = [join(pkgDir, 'Move.toml'), join(pkgDir, 'sources')];
	} else if (action.type === 'Build') {
		const inputs = action.inputs as { dockerfile?: string; context?: string } | undefined;
		if (inputs?.dockerfile) candidates.push(resolve(appDir, inputs.dockerfile));
		if (inputs?.context) candidates.push(resolve(appDir, inputs.context));
	}
	// User-declared `watches` paths union with the inferred globs above.
	// Useful for non-Move-package inputs (GraphQL schemas, JSON configs,
	// generated SDLs) that the action shape can't infer.
	for (const extra of action.watches ?? []) {
		candidates.push(resolve(appDir, extra));
	}
	// Skip paths that don't exist on the host. Move sources for image-resident
	// packages (e.g. the seal Move package, baked into the seal image) point
	// at non-host paths by design — chokidar would silently watch-once-they-
	// appear, which is a memory leak we don't need.
	return candidates.filter((p) => existsSync(p));
}
