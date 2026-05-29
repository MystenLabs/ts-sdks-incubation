// State-store implementation.
//
// Per-stack JSON file at `<runtime-root>/stacks/<stack>/state.json`.
// Plugin-keyed namespacing; tombstone-vs-missing distinction;
// atomic-write on every mutation; cross-process safety via the
// injected lock.
//
// Tombstones:
//   - `get` on a tombstoned key returns `null` (same as missing) —
//     the type-level contract is "absent". The on-disk distinction
//     is preserved so snapshot/restore round-trips correctly
//     classify a deletion (tombstone) vs a never-written key
//     (missing). Inspectors can `peek` to see the discriminator;
//     normal plugin code never needs it.
//   - `delete` writes a tombstone (rather than deleting the field).
//     Two reasons:
//       (a) Snapshot equality is now precise — "removed since
//           snapshot" survives the round-trip.
//       (b) An interrupted writer never silently resurrects a
//           previously-deleted key (the present-record stays
//           tombstone-shaped until set() runs again).
//   - `wipe()` (full plugin namespace removal) IS a hard remove;
//     tombstones are field-grain, namespace-grain wipe is route-
//     grain.

import { Context, Effect, FileSystem, Layer, Ref } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { StateKey, StateStore } from '../../state-store.ts';
import { atomicWriteJson } from '../atomic-write.ts';
import { CrossProcessLock } from '../cross-process/lock.ts';
import type { StackLockIoError, StackLockTimeoutError } from '../cross-process/stack-lock.ts';
import { StateStoreError } from '../errors.ts';
import { StackPathsService } from '../paths.ts';
import { decodeJsonText } from '../runtime-decode.ts';
import { emptyDocument, StateDocument, type StateEntry } from './schema.ts';

/**
 * The substrate-internal state-store service. The
 * `StateStore` interface re-exported from `substrate/state-store.ts`
 * is the user-facing shape; this is the wired-up implementation.
 */
export class StateStoreService extends Context.Service<StateStoreService, StateStore>()(
	'@devstack/substrate/StateStore',
) {}

/**
 * Parse `StateKey<V>` (`<pluginKey>/<suffix>`) into its two parts.
 * The key invariant from `substrate/state-store.ts`'s
 * `defineStateKey` is the single `/` separator; we cope with
 * suffix-contains-slash by splitting on the FIRST `/`.
 */
const splitKey = (key: string): { readonly plugin: string; readonly suffix: string } => {
	const i = key.indexOf('/');
	// A key without `/` is programmer error (`defineStateKey`
	// always produces one). Fall back gracefully so we don't
	// hard-crash on a misuse — store the whole string under a
	// `__malformed__` namespace, surfaced on listUnder for the
	// authoring plugin to notice in dev.
	if (i < 0) return { plugin: '__malformed__', suffix: key };
	return { plugin: key.slice(0, i), suffix: key.slice(i + 1) };
};

/** Read+decode the document. Missing file → empty document. */
const readDocument: Effect.Effect<
	StateDocument,
	StateStoreError,
	FileSystem.FileSystem | StackPathsService
> = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const paths = yield* StackPathsService;
	const exists = yield* fs.exists(paths.stateFile).pipe(
		Effect.catch((cause) =>
			Effect.fail(
				new StateStoreError({
					reason: 'io-failed',
					detail: `failed to stat state file: ${paths.stateFile}`,
					cause,
				}),
			),
		),
	);
	if (!exists) return emptyDocument;
	const text = yield* fs.readFileString(paths.stateFile).pipe(
		Effect.catch((cause) =>
			Effect.fail(
				new StateStoreError({
					reason: 'io-failed',
					detail: `failed to read state file: ${paths.stateFile}`,
					cause,
				}),
			),
		),
	);
	return yield* decodeJsonText(StateDocument, text, {
		source: paths.stateFile,
		mkError: (issue) =>
			new StateStoreError({
				reason: 'corruption',
				detail:
					issue.message === 'failed to parse JSON'
						? `state file is not valid JSON: ${paths.stateFile}`
						: `state file failed schema decode: ${paths.stateFile}`,
				cause: issue.cause,
			}),
	});
}).pipe(Effect.withSpan('substrate.stateStore.read'));

/** Write+encode the document atomically. */
const writeDocument = (
	doc: StateDocument,
): Effect.Effect<void, StateStoreError, FileSystem.FileSystem | StackPathsService> =>
	Effect.gen(function* () {
		const paths = yield* StackPathsService;
		yield* atomicWriteJson(paths.stateFile, StateDocument, doc).pipe(
			Effect.catch((cause) =>
				Effect.fail(
					new StateStoreError({
						reason: 'io-failed',
						detail: `atomic write failed: ${paths.stateFile}`,
						cause,
					}),
				),
			),
		);
	}).pipe(Effect.withSpan('substrate.stateStore.write'));

/**
 * The state-store Layer. Caches the document in a process-local
 * `Ref` so reads after the first don't touch disk; every mutation
 * runs under the cross-process lock so foreign processes don't
 * trample our changes mid-flight.
 *
 * Cache semantics: the in-process `Ref` is the truth for in-process
 * readers; it is invalidated by re-reading inside the locked
 * mutation. This deliberately does NOT poll the file — if another
 * process writes between our reads, we'll observe the change on the
 * next `withLock` r-m-w (re-read inside the critical section).
 * Plugins that need "see foreign writes" must invoke `refresh`
 * (exposed for the supervisor / watch dispatcher).
 */
export const layerStateStore: Layer.Layer<
	StateStoreService,
	StateStoreError,
	FileSystem.FileSystem | StackPathsService | CrossProcessLock
> = Layer.effect(
	StateStoreService,
	Effect.gen(function* () {
		const lock = yield* CrossProcessLock;
		const fs = yield* FileSystem.FileSystem;
		const paths = yield* StackPathsService;
		// `readDocument` / `writeDocument` declare `FileSystem |
		// StackPathsService` requirements; we discharge both from the
		// Layer-level closure so the per-method Effects are `R = never`,
		// matching the `StateStore` contract.
		const provideEnv = <A, E>(
			effect: Effect.Effect<A, E, FileSystem.FileSystem | StackPathsService>,
		): Effect.Effect<A, E> =>
			effect.pipe(
				Effect.provideService(FileSystem.FileSystem, fs),
				Effect.provideService(StackPathsService, paths),
			);
		// Prime the cache with the on-disk document. If decoding
		// fails at boot, we fail the Layer — the supervisor must
		// surface the corruption to the user (not silently re-init).
		const initial = yield* provideEnv(readDocument);
		const cache = yield* Ref.make(initial);

		const get: StateStore['get'] = <V>(key: StateKey<V>) =>
			Effect.gen(function* () {
				const doc = yield* Ref.get(cache);
				const { plugin, suffix } = splitKey(key);
				const entry: StateEntry | undefined = doc.plugins[plugin]?.[suffix];
				if (!entry) return null;
				if (entry.state === 'tombstone') return null;
				return entry.value as V;
			});

		// Map the lock's typed acquire failures onto our `lock-contention`
		// reason on `StateStoreError`. The `StateStore` contract already
		// advertises that mutation methods surface this reason — caller
		// recovery is the same shape as any other write failure (retry on
		// the next user action; surface in the supervisor cascade).
		const mapLockErrors = <A, R>(
			eff: Effect.Effect<A, StateStoreError | StackLockTimeoutError | StackLockIoError, R>,
		): Effect.Effect<A, StateStoreError, R> =>
			eff.pipe(
				Effect.catchTags({
					StackLockTimeoutError: (e) =>
						Effect.fail(
							new StateStoreError({
								reason: 'lock-contention',
								detail: `state-store write blocked: peer holds ${e.path} (waited ${e.waitedMillis}ms)`,
								cause: e,
							}),
						),
					StackLockIoError: (e) =>
						Effect.fail(
							new StateStoreError({
								reason: 'io-failed',
								detail: `state-store lock IO error on ${e.path}`,
								cause: e.cause,
							}),
						),
				}),
			);

		const set: StateStore['set'] = <V>(key: StateKey<V>, value: V) =>
			mapLockErrors(
				lock.withLock(
					provideEnv(
						// Uninterruptible: an interrupt landing between the
						// disk write and the cache update would leave the
						// in-process cache stale vs disk. The section is
						// short and already serialized by `withLock`, so
						// masking interruption here costs nothing and keeps
						// cache/disk coherent.
						Effect.uninterruptible(
							Effect.gen(function* () {
								// Re-read INSIDE the lock so we don't clobber
								// foreign writes that landed since our prime.
								const fresh = yield* readDocument;
								const { plugin, suffix } = splitKey(key);
								const next: StateDocument = {
									version: 1,
									plugins: {
										...fresh.plugins,
										[plugin]: {
											...fresh.plugins[plugin],
											[suffix]: {
												state: 'present',
												value: value as unknown,
												updatedAt: Date.now(),
											},
										},
									},
								};
								yield* writeDocument(next);
								yield* Ref.set(cache, next);
							}),
						),
					),
				),
			);

		const del: StateStore['delete'] = <V>(key: StateKey<V>) =>
			mapLockErrors(
				lock.withLock(
					provideEnv(
						// Uninterruptible for the same cache/disk coherence
						// reason as `set` — see the note there.
						Effect.uninterruptible(
							Effect.gen(function* () {
								const fresh = yield* readDocument;
								const { plugin, suffix } = splitKey(key);
								// Tombstone-write — preserves the
								// "deleted-since" record across snapshots.
								const next: StateDocument = {
									version: 1,
									plugins: {
										...fresh.plugins,
										[plugin]: {
											...fresh.plugins[plugin],
											[suffix]: {
												state: 'tombstone',
												value: null,
												updatedAt: Date.now(),
											},
										},
									},
								};
								yield* writeDocument(next);
								yield* Ref.set(cache, next);
							}),
						),
					),
				),
			);

		const listUnder: StateStore['listUnder'] = (prefix: PluginKey) =>
			Effect.gen(function* () {
				const doc = yield* Ref.get(cache);
				const ns = doc.plugins[prefix];
				if (!ns) return [];
				// Skip tombstones from `listUnder` — they're
				// internally observable via `peek` but the public
				// "what keys are present?" view hides them.
				return Object.entries(ns)
					.filter(([, entry]) => entry.state === 'present')
					.map(([suffix]) => `${prefix}/${suffix}`);
			});

		return StateStoreService.of({
			get,
			set,
			delete: del,
			listUnder,
		});
	}),
);
