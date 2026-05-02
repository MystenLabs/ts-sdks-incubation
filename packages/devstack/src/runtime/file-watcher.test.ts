import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Action, BuildAction, PublishAction } from '../core/types.js';
import { FileWatcher } from './file-watcher.js';

// chokidar's awaitWriteFinish (50ms stability + 25ms poll inside the
// watcher) plus the watcher's own debounce sets the lower bound on a
// "flush" wait. ARM_MS is the gap after start() before the first write
// (chokidar needs a beat to attach FSEvents); FLUSH_MS is the gap after a
// write before assertions. Keep both small to stay within the suite's
// <5s budget.
const DEBOUNCE_MS = 30;
const ARM_MS = 100;
const FLUSH_MS = 180;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let tmpDirs: string[] = [];

const newAppDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-watcher-'));
	tmpDirs.push(dir);
	return dir;
};

const movePackage = (appDir: string, name: string): string => {
	// Lay out a Publish-shaped package: `<name>/Move.toml` + `<name>/sources/`.
	// Returns a path relative to appDir (the form Publish.path takes).
	const rel = name;
	const abs = join(appDir, rel);
	mkdirSync(join(abs, 'sources'), { recursive: true });
	writeFileSync(join(abs, 'Move.toml'), `[package]\nname = "${name}"\n`);
	return rel;
};

const publish = (name: string, path: string, watches?: string[]): PublishAction => ({
	name,
	type: 'Publish',
	path,
	inputs: { path },
	run: async () => {},
	...(watches !== undefined ? { watches } : {}),
});

const build = (name: string, dockerfile: string, context: string): BuildAction => ({
	name,
	type: 'Build',
	inputs: { dockerfile, context },
	run: async () => {},
});

beforeEach(() => {
	tmpDirs = [];
});

afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('FileWatcher — lifecycle', () => {
	it('start() then stop() leaves no hanging chokidar handles', async () => {
		const appDir = newAppDir();
		const path = movePackage(appDir, 'pkg_a');
		const actions: Action[] = [publish('pub', path)];
		const watcher = new FileWatcher({
			actions,
			appDir,
			onStale: () => {},
			debounceMs: DEBOUNCE_MS,
		});
		watcher.start();
		await watcher.stop();
		// Second stop is a no-op (no error).
		await watcher.stop();
	});

	it('does not arm onStale before start() — events between construction and start are dropped', async () => {
		const appDir = newAppDir();
		const path = movePackage(appDir, 'pkg_a');
		const calls: string[][] = [];
		const watcher = new FileWatcher({
			actions: [publish('pub', path)],
			appDir,
			onStale: (names) => calls.push(names),
			debounceMs: DEBOUNCE_MS,
		});
		// No start() — touch a file. Even after waits, the callback
		// shouldn't fire.
		writeFileSync(join(appDir, path, 'sources', 'a.move'), 'module a::m {}\n');
		await wait(FLUSH_MS);
		expect(calls).toEqual([]);
		await watcher.stop();
	});

	it('skips actions whose watch paths do not exist on the host (review: imported-package safety)', async () => {
		// Publish action with `path: '<imported>'` — the imported-package
		// placeholder. The watcher filters paths that don't exist; this
		// shouldn't crash or arm a watcher.
		const appDir = newAppDir();
		const watcher = new FileWatcher({
			actions: [publish('imported_pub', '<imported>')],
			appDir,
			onStale: () => {
				throw new Error('onStale should not fire for imported package');
			},
			debounceMs: DEBOUNCE_MS,
		});
		watcher.start();
		await wait(ARM_MS);
		await watcher.stop();
	});
});

describe('FileWatcher — Publish path watching', () => {
	it('fires onStale([action.name]) when a Move source file changes after debounce', async () => {
		const appDir = newAppDir();
		const path = movePackage(appDir, 'pkg_a');
		const calls: string[][] = [];
		const watcher = new FileWatcher({
			actions: [publish('pub_a', path)],
			appDir,
			onStale: (names) => calls.push(names),
			debounceMs: DEBOUNCE_MS,
		});
		watcher.start();
		// chokidar needs a beat to attach its FSEvents listeners.
		await wait(ARM_MS);
		writeFileSync(join(appDir, path, 'sources', 'foo.move'), 'module a::m {}\n');
		await wait(FLUSH_MS);
		expect(calls.length).toBeGreaterThanOrEqual(1);
		expect(calls[0]).toEqual(['pub_a']);
		await watcher.stop();
	});

	it('fires onStale when Move.toml itself changes', async () => {
		const appDir = newAppDir();
		const path = movePackage(appDir, 'pkg_a');
		const calls: string[][] = [];
		const watcher = new FileWatcher({
			actions: [publish('pub_a', path)],
			appDir,
			onStale: (names) => calls.push(names),
			debounceMs: DEBOUNCE_MS,
		});
		watcher.start();
		await wait(ARM_MS);
		writeFileSync(
			join(appDir, path, 'Move.toml'),
			`[package]\nname = "pkg_a"\nedition = "2024.beta"\n`,
		);
		await wait(FLUSH_MS);
		expect(calls.length).toBeGreaterThanOrEqual(1);
		expect(calls.flat()).toContain('pub_a');
		await watcher.stop();
	});

	it('does not fire onStale on a write outside the watched paths', async () => {
		const appDir = newAppDir();
		const path = movePackage(appDir, 'pkg_a');
		// Create a sibling dir that's NOT registered as a watched path.
		const unrelatedDir = join(appDir, 'unrelated');
		mkdirSync(unrelatedDir, { recursive: true });

		const calls: string[][] = [];
		const watcher = new FileWatcher({
			actions: [publish('pub_a', path)],
			appDir,
			onStale: (names) => calls.push(names),
			debounceMs: DEBOUNCE_MS,
		});
		watcher.start();
		await wait(ARM_MS);
		writeFileSync(join(unrelatedDir, 'random.txt'), 'irrelevant\n');
		await wait(FLUSH_MS);
		expect(calls).toEqual([]);
		await watcher.stop();
	});

	it('coalesces multiple rapid changes into one debounced onStale call', async () => {
		const appDir = newAppDir();
		const path = movePackage(appDir, 'pkg_a');
		const calls: string[][] = [];
		const watcher = new FileWatcher({
			actions: [publish('pub_a', path)],
			appDir,
			onStale: (names) => calls.push(names),
			debounceMs: 80, // Above chokidar's 50ms stability threshold so
			// awaitWriteFinish can't break the coalescing.
		});
		watcher.start();
		await wait(ARM_MS);
		// Burst of writes inside one debounce window.
		writeFileSync(join(appDir, path, 'sources', 'a.move'), 'module a::m {}\n');
		writeFileSync(join(appDir, path, 'sources', 'b.move'), 'module b::m {}\n');
		writeFileSync(join(appDir, path, 'sources', 'c.move'), 'module c::m {}\n');
		await wait(300);
		// Implementation reads: each event resets the debounce timer; after
		// the burst settles, exactly one onStale fires. The pending Set
		// dedupes identical names so the call carries `['pub_a']` once.
		expect(calls.length).toBe(1);
		expect(calls[0]).toEqual(['pub_a']);
		await watcher.stop();
	});

	it('two distinct Publish actions touched in the same window coalesce into one call with both names', async () => {
		const appDir = newAppDir();
		const pathA = movePackage(appDir, 'pkg_a');
		const pathB = movePackage(appDir, 'pkg_b');
		const calls: string[][] = [];
		const watcher = new FileWatcher({
			actions: [publish('pub_a', pathA), publish('pub_b', pathB)],
			appDir,
			onStale: (names) => calls.push(names),
			debounceMs: 80,
		});
		watcher.start();
		await wait(ARM_MS);
		writeFileSync(join(appDir, pathA, 'sources', 'a.move'), 'module a::m {}\n');
		writeFileSync(join(appDir, pathB, 'sources', 'b.move'), 'module b::m {}\n');
		await wait(300);
		expect(calls.length).toBe(1);
		expect(calls[0]?.sort()).toEqual(['pub_a', 'pub_b']);
		await watcher.stop();
	});
});

describe('FileWatcher — `watches:` extra paths', () => {
	it('honors action.watches and fires onStale on changes to those paths', async () => {
		const appDir = newAppDir();
		const path = movePackage(appDir, 'pkg_a');
		// Extra watched file outside the inferred Move-package globs.
		const extraDir = join(appDir, 'schemas');
		mkdirSync(extraDir, { recursive: true });
		const extraFile = join(extraDir, 'schema.graphql');
		writeFileSync(extraFile, '# v0\n');
		const calls: string[][] = [];
		const watcher = new FileWatcher({
			actions: [publish('pub_a', path, ['schemas/schema.graphql'])],
			appDir,
			onStale: (names) => calls.push(names),
			debounceMs: DEBOUNCE_MS,
		});
		watcher.start();
		await wait(ARM_MS);
		writeFileSync(extraFile, '# v1\n');
		await wait(FLUSH_MS);
		expect(calls.length).toBeGreaterThanOrEqual(1);
		expect(calls.flat()).toContain('pub_a');
		await watcher.stop();
	});

	it('Build actions watch dockerfile + context paths', async () => {
		const appDir = newAppDir();
		const ctxDir = join(appDir, 'ctx');
		mkdirSync(ctxDir, { recursive: true });
		const dockerfile = join(appDir, 'Dockerfile');
		writeFileSync(dockerfile, 'FROM scratch\n');
		const calls: string[][] = [];
		const watcher = new FileWatcher({
			actions: [build('img', 'Dockerfile', 'ctx')],
			appDir,
			onStale: (names) => calls.push(names),
			debounceMs: DEBOUNCE_MS,
		});
		watcher.start();
		await wait(ARM_MS);
		writeFileSync(dockerfile, 'FROM scratch\nLABEL touched=1\n');
		await wait(FLUSH_MS);
		expect(calls.length).toBeGreaterThanOrEqual(1);
		expect(calls.flat()).toContain('img');
		await watcher.stop();
	});
});

describe('FileWatcher — stop() semantics', () => {
	it('stop() drops pending debounced events — no late onStale after stop resolves', async () => {
		const appDir = newAppDir();
		const path = movePackage(appDir, 'pkg_a');
		const calls: string[][] = [];
		const watcher = new FileWatcher({
			actions: [publish('pub_a', path)],
			appDir,
			// Big debounce so the timer is still pending when we call stop().
			onStale: (names) => calls.push(names),
			debounceMs: 500,
		});
		watcher.start();
		await wait(ARM_MS);
		writeFileSync(join(appDir, path, 'sources', 'a.move'), 'module a::m {}\n');
		// Don't wait for the debounce — stop right away. The pending timer
		// must be cleared in stop() so we don't get a late callback.
		await wait(50);
		await watcher.stop();
		await wait(600);
		expect(calls).toEqual([]);
	});

	// Mid-cycle behavior (review 06): the watcher itself doesn't know about
	// reconcile cycles; it just emits debounced onStale callbacks. The
	// supervisor coordinates "ignore mid-cycle events" via the `armed`
	// flag — set false during stop() and (separately, in the supervisor)
	// while a cycle is running. The watcher itself does NOT serialize on the
	// onStale promise: an event during a slow onStale fires another debounced
	// onStale after the next debounce window. Document that contract.
	it('events arriving during a slow onStale still produce a second debounced call (no internal serialization)', async () => {
		const appDir = newAppDir();
		const pathA = movePackage(appDir, 'pkg_a');
		const calls: string[][] = [];
		let releaseSlowOnStale: (() => void) | null = null;
		const watcher = new FileWatcher({
			actions: [publish('pub_a', pathA)],
			appDir,
			onStale: (names) => {
				calls.push(names);
				// Block the first onStale handler — emulates a long-running
				// reconcile cycle the supervisor would normally wrap.
				if (calls.length === 1) {
					return new Promise<void>((resolve) => {
						releaseSlowOnStale = resolve;
					}) as unknown as void;
				}
			},
			debounceMs: 80,
		});
		watcher.start();
		await wait(ARM_MS);
		writeFileSync(join(appDir, pathA, 'sources', 'a.move'), 'module a::m {}\n');
		await wait(250);
		expect(calls.length).toBe(1);
		// While the synthetic "cycle" is in flight, fire another event.
		writeFileSync(join(appDir, pathA, 'sources', 'b.move'), 'module b::m {}\n');
		await wait(250);
		// The watcher's own behavior: the second event triggers another
		// debounced onStale once the debounce window expires. The watcher
		// does not gate on "is the previous onStale still resolving" —
		// that's the supervisor's job. Document the actual contract.
		expect(calls.length).toBe(2);
		if (releaseSlowOnStale !== null) (releaseSlowOnStale as () => void)();
		await watcher.stop();
	});
});
