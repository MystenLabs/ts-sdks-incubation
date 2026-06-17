// L0 file watcher — the "thick watcher" the lifecycle architecture
// describes (§ L3 Watch dispatcher: "receives watcher events from L0
// which already debounced + dedup'd").
//
// Generic: it watches the literal roots derived from the supervisor's
// watch index — the union of every plugin's declared `watch` paths,
// whatever they are — and feeds each changed path to `notifyWatchFire`,
// which attributes it to the owning plugin(s) and issues a selective
// restart (→ re-acquire → re-cache-key → cache-miss → re-produce). The
// package plugin's Move sources are today's only declarer, but nothing
// here is Move-specific. Without this, the watch index +
// `notifyWatchFire` are built but never driven, so a `watch`-declaring
// plugin never restarts on a source edit.
//
// Dev-only: wired from the `up` verb (see `cli/wirings/up.ts`). `apply`
// and the snapshot verbs boot once and exit, so they never start it.
//
// Dependency-free by design — devstack pulls in no glob/watch library
// (cf. the hand-rolled `collectHashedSources`). Node's recursive
// `fs.watch` is supported on macOS and Windows, and on Linux from
// Node 20; one watcher is placed per distinct root.

import { type FSWatcher, watch as fsWatch } from 'node:fs';
import { join } from 'node:path';

import { Effect, Queue, Scope } from 'effect';

import { deriveWatchRoots, type WatchEntry } from './watch-attribution.ts';

/** Coalescing window for a burst of fs events. Editors save by
 *  rename-replace (temp write + rename), so a single save surfaces as
 *  several events within a few ms — one settle window collapses them
 *  into one restart per plugin. */
const DEFAULT_DEBOUNCE_MILLIS = 150;

export interface FileWatcherParams {
	readonly watchIndex: ReadonlyArray<WatchEntry>;
	readonly notifyWatchFire: (path: string) => Effect.Effect<void>;
	readonly debounceMillis?: number;
}

/**
 * Start the L0 file watcher. Acquires one recursive `fs.watch` per
 * distinct root (released on scope close) and forks a debouncing drain
 * loop that fires `notifyWatchFire` for each distinct changed path.
 * Returns once the watchers + loop are installed; it lives for the
 * lifetime of the surrounding scope, so callers `Effect.forkScoped` it
 * (or just `yield*` it inside a scoped region).
 *
 * Watcher setup never fails the boot: a root that cannot be watched
 * (e.g. a not-yet-created directory) is logged and skipped.
 */
export const startFileWatcher = (
	params: FileWatcherParams,
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.gen(function* () {
		const roots = deriveWatchRoots(params.watchIndex);
		if (roots.length === 0) return;

		const debounceMillis = params.debounceMillis ?? DEFAULT_DEBOUNCE_MILLIS;
		// Bounded so a pathological event storm (e.g. a `git checkout` touching
		// thousands of files) can't grow the queue unboundedly; offers into a
		// dropping queue never suspend, so the fs.watch callback stays cheap.
		// 1024 comfortably covers a normal multi-file save burst, whose
		// duplicates the drain loop collapses within the settle window into one
		// restart per plugin. If a burst ever exceeds the bound the overflow is
		// dropped — at worst a reload is missed until the next edit re-fires the
		// path (and dev reload stays manually recoverable).
		const events = yield* Queue.dropping<string>(1024);
		// Capture the supervisor Context so the offer fork inherits its
		// logger Layer / fiber-refs (mirrors `installSignalHandler`); a bare
		// `Effect.runFork` would evaluate against an empty context.
		const supervisorContext = yield* Effect.context<never>();
		const runForkInherited = Effect.runForkWith(supervisorContext);

		for (const root of roots) {
			const watcher = yield* Effect.acquireRelease(
				Effect.sync((): FSWatcher | null => {
					try {
						const fsWatcher = fsWatch(root, { recursive: true }, (_eventType, filename) => {
							if (filename === null) return;
							const abs = join(root, filename.toString());
							// Bridge the Node callback into the queue via the captured
							// Context. Dropping queue ⇒ offer never suspends.
							runForkInherited(Queue.offer(events, abs));
						});
						// A watcher-level error (e.g. the root was removed) must not
						// crash the supervisor; swallow it. Scope close still calls
						// `close()` on the finalizer below.
						fsWatcher.on('error', () => {});
						return fsWatcher;
					} catch {
						return null;
					}
				}),
				(watcher) => Effect.sync(() => watcher?.close()),
			);
			if (watcher === null) {
				yield* Effect.logWarning(`file-watcher: could not watch ${root}`);
			}
		}

		// Drain loop: block for one change, settle, then drain + dedup the
		// burst and fire each distinct path once. `notifyWatchFire` itself
		// dedups owning plugins, so editing several files in one save yields
		// one restart per affected plugin.
		const drain = Effect.gen(function* () {
			const first = yield* Queue.take(events);
			yield* Effect.sleep(`${debounceMillis} millis`);
			const rest = yield* Queue.takeAll(events);
			const paths = new Set<string>([first, ...rest]);
			for (const path of paths) {
				yield* params.notifyWatchFire(path);
			}
		}).pipe(Effect.forever);

		yield* Effect.forkScoped(drain);
	});
