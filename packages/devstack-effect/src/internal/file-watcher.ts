// File watcher — emits change events for a watched path so the engine can
// interrupt + restart affected layers on edit.
//
// Ported from `packages/devstack/src/file-watcher.ts` (v3) but adapted to
// Effect v4 idioms:
//
//   - Each `watch(path)` returns a `Stream.Stream<ChangeEvent>` built via
//     `Stream.callback` (the v4 successor of `Stream.async*`). The fs.watch
//     handle is registered through `Effect.addFinalizer`, so the watcher
//     closes when the consuming scope (or the stream itself) tears down.
//   - All failures funnel through a single tagged `FileWatcherError`.
//   - v3's debounce + multi-path engine integration lives at the engine
//     layer — this service only emits raw events. Coalescing is a
//     follow-up; for v1 each fs event becomes one ChangeEvent.
//
// Linux note: node's `fs.watch` with `recursive: true` silently degrades
// to non-recursive on Linux (no native inotify recursion). v3 documents
// the same caveat — defer chokidar until someone reports it.

import { Cause, Context, Effect, Layer, Queue, Schema, Scope, Stream } from 'effect';
import * as fs from 'node:fs';
import { stringifyCause } from './stringify-cause.js';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface ChangeEvent {
	readonly kind: 'change' | 'add' | 'remove';
	readonly path: string;
}

export class FileWatcherError extends Schema.TaggedErrorClass<FileWatcherError>()(
	'FileWatcherError',
	{
		path: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

export interface FileWatcherShape {
	/** Watch a path (file or directory recursively). Returns a Stream of change events. */
	readonly watch: (path: string) => Stream.Stream<ChangeEvent, FileWatcherError, Scope.Scope>;
}

export class FileWatcher extends Context.Service<FileWatcher, FileWatcherShape>()(
	'@devstack/FileWatcher',
) {}

// -----------------------------------------------------------------------------
// Live layer
// -----------------------------------------------------------------------------

// Translate node's `fs.watch` event type to our normalized ChangeEvent kind.
// fs.watch emits 'change' for content updates and 'rename' for create/delete
// (it can't tell add from remove without an extra stat). For v1 we collapse
// 'rename' to 'change' and let the engine do its own classification if it
// cares. Callers that need add/remove disambiguation can stat the path.
const toChangeEvent = (
	_eventType: string,
	filename: string | null,
	rootPath: string,
): ChangeEvent => {
	const path = filename === null || filename.length === 0 ? rootPath : filename;
	return { kind: 'change', path };
};

export const FileWatcherLive: Layer.Layer<FileWatcher> = Layer.succeed(FileWatcher, {
	watch: (path: string) =>
		Stream.callback<ChangeEvent, FileWatcherError>((queue) =>
			Effect.gen(function* () {
				const watcher = yield* Effect.try({
					try: () => fs.watch(path, { recursive: true }),
					catch: (cause) =>
						new FileWatcherError({
							path,
							message: `failed to watch ${path}: ${stringifyCause(cause)}`,
							cause,
						}),
				});

				watcher.on('change', (eventType, filename) => {
					const name =
						typeof filename === 'string'
							? filename
							: filename instanceof Buffer
								? filename.toString('utf8')
								: null;
					Queue.offerUnsafe(queue, toChangeEvent(eventType, name, path));
				});

				watcher.on('error', (err) => {
					Queue.failCauseUnsafe(
						queue,
						Cause.fail(
							new FileWatcherError({
								path,
								message: `fs.watch error on ${path}: ${err.message}`,
								cause: err,
							}),
						),
					);
				});

				// Close the underlying watcher when the stream's internal scope
				// tears down (stream completion or interruption upstream).
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						try {
							watcher.close();
						} catch {
							// best-effort: a watcher that errored during construction
							// or was already closed should not block scope teardown.
						}
					}),
				);
			}).pipe(Effect.withSpan('FileWatcher.watch', { attributes: { path } })),
		),
});
