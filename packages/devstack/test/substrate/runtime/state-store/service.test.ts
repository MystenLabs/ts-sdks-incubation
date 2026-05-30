// State-store service — tests.
//
// The state-store had ZERO coverage. This pins the contract the
// substrate exposes via `StateStore`: typed-key round-trip, the
// tombstone-vs-missing discriminator, atomic-write-on-mutation,
// re-read-inside-lock foreign-write reconciliation, corruption-at-
// boot surfacing as a typed Layer failure, the `lock-contention` /
// `io-failed` error mapping, and the cache/disk coherence guarantee
// that the `Effect.uninterruptible` wrap in `set`/`del` exists to
// uphold.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect, Exit, FileSystem, Fiber, Layer, Option } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';

import { appName, chainId, pluginKey, stackName } from '../../../../src/substrate/brand.ts';
import { defineStateKey } from '../../../../src/substrate/state-store.ts';
import {
	CrossProcessLock,
	layerCrossProcessLockInProcess,
} from '../../../../src/substrate/runtime/cross-process/lock.ts';
import { StackLockTimeoutError } from '../../../../src/substrate/runtime/cross-process/stack-lock.ts';
import { StateStoreError } from '../../../../src/substrate/runtime/errors.ts';
import {
	layerIdentity,
	layerRuntimeRoot,
	layerStackPaths,
	StackPathsService,
} from '../../../../src/substrate/runtime/paths.ts';
import {
	layerStateStore,
	StateStoreService,
} from '../../../../src/substrate/runtime/state-store/index.ts';
import { withTempRoot } from '../../../helpers/with-temp-root.ts';

// ---------------------------------------------------------------
// Wiring. The state-store Layer needs FileSystem + StackPaths +
// CrossProcessLock. We pin a tempdir-backed RuntimeRoot + a fixed
// identity so `stateFile` resolves under `<root>/stacks/main/`.
// The in-process lock is the sanctioned test lock (STYLE_GUIDE §
// "test wiring uses layerCrossProcessLockInProcess").
// ---------------------------------------------------------------
const identity = {
	app: appName('app'),
	stack: stackName('main'),
	chain: chainId('sui:localnet'),
};

const stateFilePath = (root: string): string => join(root, 'stacks', 'main', 'state.json');

const fooKey = pluginKey('foo');

// The base environment shared by every test: real fs + node path +
// the tempdir-pinned paths resolver + the in-process lock.
const baseLayer = (root: string): Layer.Layer<FileSystem.FileSystem | StackPathsService | CrossProcessLock> =>
	Layer.mergeAll(
		NodeFileSystem.layer,
		layerStackPaths.pipe(
			Layer.provide(layerRuntimeRoot(root)),
			Layer.provide(layerIdentity(identity)),
			Layer.provide(NodePath.layer),
		),
		layerCrossProcessLockInProcess,
	);

const storeLayer = (root: string): Layer.Layer<StateStoreService, StateStoreError> =>
	layerStateStore.pipe(Layer.provide(baseLayer(root)));

// Typed keys reused across cases. The phantom value shape pins the
// get/set type contract.
const greeting = defineStateKey<string>(fooKey, 'greeting');
const counter = defineStateKey<number>(fooKey, 'counter');

describe('StateStoreService', () => {
	it.effect('round-trips set -> get -> listUnder', () =>
		withTempRoot('state-store-test', (root) =>
			Effect.gen(function* () {
				const store = yield* StateStoreService;
				yield* store.set(greeting, 'hello');
				yield* store.set(counter, 7);

				expect(yield* store.get(greeting)).toBe('hello');
				expect(yield* store.get(counter)).toBe(7);

				const keys = yield* store.listUnder(fooKey);
				expect([...keys].sort()).toEqual(['foo/counter', 'foo/greeting']);
			}).pipe(Effect.provide(storeLayer(root))),
		),
	);

	it.effect('get on a never-written key returns null', () =>
		withTempRoot('state-store-test', (root) =>
			Effect.gen(function* () {
				const store = yield* StateStoreService;
				expect(yield* store.get(greeting)).toBeNull();
				// A namespace with no keys lists empty.
				expect(yield* store.listUnder(fooKey)).toEqual([]);
			}).pipe(Effect.provide(storeLayer(root))),
		),
	);

	it.effect('delete tombstones: get returns null and listUnder hides the key', () =>
		withTempRoot('state-store-test', (root) =>
			Effect.gen(function* () {
				const store = yield* StateStoreService;
				yield* store.set(greeting, 'hello');
				yield* store.set(counter, 1);
				yield* store.delete(greeting);

				// Tombstone reads back as absent (type-level "absent").
				expect(yield* store.get(greeting)).toBeNull();
				// listUnder excludes tombstones but keeps the live sibling.
				expect(yield* store.listUnder(fooKey)).toEqual(['foo/counter']);
			}).pipe(Effect.provide(storeLayer(root))),
		),
	);

	it.effect('delete preserves the tombstone discriminator on disk (vs missing)', () =>
		withTempRoot('state-store-test', (root) =>
			Effect.gen(function* () {
				const store = yield* StateStoreService;
				yield* store.set(greeting, 'hello');
				yield* store.delete(greeting);

				// On-disk distinction: a deleted key is a `tombstone`
				// record, NOT a removed field — snapshot fidelity hinges
				// on this. A never-written key has no record at all.
				const onDisk = JSON.parse(readFileSync(stateFilePath(root), 'utf8'));
				expect(onDisk.plugins.foo.greeting.state).toBe('tombstone');
				expect(onDisk.plugins.foo.greeting.value).toBeNull();
				expect(onDisk.plugins.foo.unwritten).toBeUndefined();
			}).pipe(Effect.provide(storeLayer(root))),
		),
	);

	it.effect('mutation writes a schema-shaped document (not torn)', () =>
		withTempRoot('state-store-test', (root) =>
			Effect.gen(function* () {
				const store = yield* StateStoreService;
				yield* store.set(greeting, 'hello');

				// Atomic-write means the final file is a fully-formed,
				// parseable, schema-shaped document — never a partial
				// fragment. The rename-based primitive guarantees this.
				const text = readFileSync(stateFilePath(root), 'utf8');
				const onDisk = JSON.parse(text);
				expect(onDisk.version).toBe(1);
				expect(onDisk.plugins.foo.greeting).toEqual({
					state: 'present',
					value: 'hello',
					updatedAt: expect.any(Number),
				});
			}).pipe(Effect.provide(storeLayer(root))),
		),
	);

	it.effect('re-reads inside the lock: a foreign on-disk write is reconciled on the next mutation', () =>
		withTempRoot('state-store-test', (root) =>
			Effect.gen(function* () {
				const store = yield* StateStoreService;
				// Prime the cache from an empty doc.
				yield* store.set(greeting, 'hello');

				// Simulate a foreign process writing the file out-of-band:
				// inject a second plugin namespace the in-process cache has
				// never seen. The next locked mutation re-reads INSIDE the
				// lock, so it must NOT clobber this foreign key.
				const foreign = {
					version: 1,
					plugins: {
						foo: { greeting: { state: 'present', value: 'hello', updatedAt: 1 } },
						bar: { adopted: { state: 'present', value: 'from-peer', updatedAt: 2 } },
					},
				};
				writeFileSync(stateFilePath(root), JSON.stringify(foreign));

				// A mutation under a DIFFERENT key. After it, the foreign
				// `bar/adopted` must still be present on disk — proof the
				// re-read-inside-lock merged rather than overwrote.
				yield* store.set(counter, 99);

				const onDisk = JSON.parse(readFileSync(stateFilePath(root), 'utf8'));
				expect(onDisk.plugins.bar.adopted.value).toBe('from-peer');
				expect(onDisk.plugins.foo.counter.value).toBe(99);
			}).pipe(Effect.provide(storeLayer(root))),
		),
	);

	it.effect('corruption at boot surfaces as a typed StateStoreError (reason=corruption) Layer failure', () =>
		withTempRoot('state-store-test', (root) =>
			Effect.gen(function* () {
				// Plant a malformed (non-JSON) state file BEFORE the Layer
				// boots. `layerStateStore` primes the cache via
				// `readDocument`, which decodes the file and fails the
				// whole Layer on corruption rather than silently re-init.
				const fs = yield* FileSystem.FileSystem;
				const paths = yield* StackPathsService;
				yield* fs.makeDirectory(join(root, 'stacks', 'main'), { recursive: true });
				yield* fs.writeFileString(paths.stateFile, 'this is not json');

				// Building the Layer (= booting the store) must fail with
				// the typed corruption error.
				const exit = yield* Layer.build(storeLayer(root)).pipe(
					Effect.scoped,
					Effect.exit,
				);
				expect(Exit.isFailure(exit)).toBe(true);
				const err = Exit.findErrorOption(exit);
				expect(Option.isSome(err)).toBe(true);
				if (Option.isSome(err)) {
					expect(err.value).toBeInstanceOf(StateStoreError);
					expect(err.value.reason).toBe('corruption');
				}
			}).pipe(Effect.provide(baseLayer(root))),
		),
	);

	it.effect('lock-contention: a StackLockTimeoutError from the lock maps to reason=lock-contention', () =>
		withTempRoot('state-store-test', (root) =>
			Effect.gen(function* () {
				const store = yield* StateStoreService;
				const result = yield* store.set(greeting, 'hello').pipe(Effect.flip);
				expect(result).toBeInstanceOf(StateStoreError);
				expect(result.reason).toBe('lock-contention');
			}).pipe(
				// Swap in a lock whose acquire always times out, so the
				// mapLockErrors branch is exercised end-to-end.
				Effect.provide(layerStateStore.pipe(Layer.provide(timeoutLockBase(root)))),
			),
		),
	);

	it.effect('io-failed: an underlying atomic-write failure maps to reason=io-failed', () =>
		withTempRoot('state-store-test', (root) =>
			Effect.gen(function* () {
				const store = yield* StateStoreService;
				const result = yield* store.set(greeting, 'hello').pipe(Effect.flip);
				expect(result).toBeInstanceOf(StateStoreError);
				expect(result.reason).toBe('io-failed');
			}).pipe(Effect.provide(layerStateStore.pipe(Layer.provide(writeFailBase(root))))),
		),
	);

	it.effect('interrupting a set leaves cache and disk in agreement (uninterruptible RMW)', () =>
		withTempRoot('state-store-test', (root) =>
			Effect.gen(function* () {
				const store = yield* StateStoreService;
				yield* store.set(greeting, 'first');

				// Fork a second set, then immediately interrupt it. The
				// critical section is wrapped in `Effect.uninterruptible`,
				// so the disk write and the cache update either BOTH land
				// or NEITHER does — interruption can never wedge them
				// apart. Whatever the fiber's fate, the in-process cache
				// (`get`) must equal the on-disk truth.
				const fiber = yield* Effect.forkScoped(store.set(greeting, 'second'));
				yield* Fiber.interrupt(fiber);

				const cached = yield* store.get(greeting);
				const onDisk = existsSync(stateFilePath(root))
					? JSON.parse(readFileSync(stateFilePath(root), 'utf8')).plugins.foo.greeting.value
					: null;
				expect(cached).toBe(onDisk);
			}).pipe(Effect.provide(storeLayer(root))),
		),
	);
});

// ---------------------------------------------------------------
// Failure-injection lock + fs wiring for the error-mapping cases.
// ---------------------------------------------------------------

// A lock whose `withLock` never even runs the body — it fails the
// acquire with a `StackLockTimeoutError`-shaped error so the
// state-store's `mapLockErrors` lifts it to `lock-contention`. We
// import the tag lazily through a synthetic failure rather than
// reaching into stack-lock internals.
const timeoutLockLayer: Layer.Layer<CrossProcessLock> = Layer.succeed(CrossProcessLock)({
	withLock: <A, E, R>(_effect: Effect.Effect<A, E, R>) =>
		Effect.fail(
			new StackLockTimeoutError({ path: '/virtual/stack.lock', waitedMillis: 5000, holder: null }),
		),
});

const timeoutLockBase = (root: string) =>
	Layer.mergeAll(
		NodeFileSystem.layer,
		layerStackPaths.pipe(
			Layer.provide(layerRuntimeRoot(root)),
			Layer.provide(layerIdentity(identity)),
			Layer.provide(NodePath.layer),
		),
		timeoutLockLayer,
	);

// A FileSystem whose writes always fail, so the atomic-write
// primitive surfaces an error the state-store maps to `io-failed`.
// Reads succeed (empty file → empty doc) so boot priming works; the
// failure only bites on the mutation's write.
const writeFailFs: Layer.Layer<FileSystem.FileSystem> = Layer.succeed(
	FileSystem.FileSystem,
)(
	FileSystem.makeNoop({
		exists: () => Effect.succeed(false),
		makeDirectory: () => Effect.void,
		open: () =>
			Effect.fail(
				// Any PlatformError flowing out of atomic-write becomes
				// AtomicWriteFailed, which the store maps to io-failed.
				new Error('fake open failure') as never,
			),
	}),
);

const writeFailBase = (root: string) =>
	Layer.mergeAll(
		writeFailFs,
		layerStackPaths.pipe(
			Layer.provide(layerRuntimeRoot(root)),
			Layer.provide(layerIdentity(identity)),
			Layer.provide(NodePath.layer),
		),
		layerCrossProcessLockInProcess,
	);
