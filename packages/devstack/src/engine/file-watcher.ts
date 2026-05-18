// File watcher — emits change events for a watched path so the engine can
// interrupt + restart affected layers on edit.
//
//   - Each `watch(path)` returns a `Stream.Stream<ChangeEvent>` built via
//     `Stream.callback`. The fs.watch handle is registered through
//     `Effect.addFinalizer`, so the watcher closes when the consuming
//     scope (or the stream itself) tears down.
//   - All failures funnel through a single tagged `FileWatcherError`.
//   - Debounce + multi-path engine integration lives at the engine layer
//     — this service only emits raw events. Coalescing is a follow-up;
//     each fs event currently becomes one ChangeEvent.
//
// Linux note: node's `fs.watch` with `recursive: true` silently degrades
// to non-recursive on Linux (no native inotify recursion). Defer chokidar
// until someone reports it.

import { Cause, Context, Effect, Layer, Queue, Schema, Scope, Stream } from 'effect';
import * as fs from 'node:fs';

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
// FSWatcher's documented surface emits a single `'change'` event with an
// `eventType` arg of either `'change'` (content modified) or `'rename'`
// (file created, deleted, or renamed). We map 'rename' to ChangeEvent
// `'add'` because the supervisor's downstream classification only cares
// that SOMETHING changed at the path; we don't stat the file to
// distinguish add-vs-remove, but emitting a non-'change' kind helps
// downstream filters (and future consumers) reason about it. Some Node
// versions ALSO emit a separate top-level `'rename'` event (this is
// the surface the @types/node FSWatcher signature exposes); we
// subscribe to both so a platform that splits them doesn't drop
// rename-fired creates of new `.move` files.
const toChangeEvent = (
	eventType: string,
	filename: string | null,
	rootPath: string,
): ChangeEvent => {
	const path = filename === null || filename.length === 0 ? rootPath : filename;
	const kind: ChangeEvent['kind'] = eventType === 'rename' ? 'add' : 'change';
	return { kind, path };
};

const filenameToString = (filename: string | Buffer | null): string | null =>
	typeof filename === 'string'
		? filename
		: filename instanceof Buffer
			? filename.toString('utf8')
			: null;

export const FileWatcherLive: Layer.Layer<FileWatcher> = Layer.succeed(FileWatcher, {
	watch: (path: string) =>
		Stream.callback<ChangeEvent, FileWatcherError>((queue) =>
			Effect.gen(function* () {
				const watcher = yield* Effect.try({
					try: () => fs.watch(path, { recursive: true }),
					catch: (cause) =>
						new FileWatcherError({
							path,
							message: `failed to watch ${path}`,
							cause,
						}),
				});

				const onEvent = (eventType: string, filename: string | Buffer | null): void => {
					Queue.offerUnsafe(queue, toChangeEvent(eventType, filenameToString(filename), path));
				};
				// Subscribe to both event names. FSWatcher historically
				// fires a single 'change' event with the eventType arg
				// discriminating, but @types/node also documents a
				// separate 'rename' listener and some platform/Node
				// versions split the surfaces. Subscribing to both is
				// idempotent for the common path and load-bearing for
				// the split-event platforms — without the 'rename'
				// listener, `touch new.move` doesn't trigger restart on
				// those Node builds.
				watcher.on('change', onEvent);
				watcher.on('rename', onEvent);

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
