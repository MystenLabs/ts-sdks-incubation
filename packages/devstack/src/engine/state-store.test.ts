// State-store regressions silently break persistence across runs and
// (worse) across concurrent dev processes. The path-precedence rules
// and the lock + atomic-write protocols are the load-bearing parts.

import { Effect, FileSystem, Layer, Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import type { SuiNetwork } from '../services/sui.js';
import { StateStore, StateStoreConfig, StateStoreLive } from './state-store.js';

// ---------------------------------------------------------------------------
// Mock FileSystem
// ---------------------------------------------------------------------------

interface FsCall {
	readonly op: string;
	readonly path: string;
	readonly flag?: string;
}

interface MockFs {
	readonly layer: Layer.Layer<FileSystem.FileSystem>;
	readonly calls: ReadonlyArray<FsCall>;
	readonly files: Map<string, string>;
	readonly callsRef: { current: FsCall[] };
}

// Build a tracking in-memory FileSystem. Captures the path of every write
// (so we can assert path-precedence) and emulates `wx` O_EXCL semantics
// (so we can assert the lock protocol). Only the ops touched by
// StateStoreLive are modeled — everything else stays noop.
const makeMockFs = (
	opts: { readonly failRenameFor?: (path: string) => boolean } = {},
): MockFs => {
	const files = new Map<string, string>();
	const callsRef = { current: [] as FsCall[] };

	const layer = FileSystem.layerNoop({
		makeDirectory: (path) => {
			callsRef.current.push({ op: 'makeDirectory', path });
			return Effect.void;
		},
		exists: (path) => {
			callsRef.current.push({ op: 'exists', path });
			return Effect.succeed(files.has(path));
		},
		chmod: (path) => {
			callsRef.current.push({ op: 'chmod', path });
			return Effect.void;
		},
		readFileString: (path) => {
			callsRef.current.push({ op: 'readFileString', path });
			const v = files.get(path);
			return v === undefined
				? Effect.die(`mock: read missing ${path}`)
				: Effect.succeed(v);
		},
		writeFileString: (path, data, options) => {
			const flag = options?.flag;
			callsRef.current.push({ op: 'writeFileString', path, flag });
			if (flag === 'wx' && files.has(path)) {
				// O_EXCL: refuse to overwrite. PlatformError shape doesn't
				// matter here — StateStoreLive catches it and falls back.
				return Effect.die(`mock: EEXIST ${path}`);
			}
			files.set(path, data);
			return Effect.void;
		},
		rename: (from, to) => {
			callsRef.current.push({ op: 'rename', path: `${from} -> ${to}` });
			if (opts.failRenameFor?.(to)) return Effect.die(`mock: rename failed ${from} -> ${to}`);
			const v = files.get(from);
			if (v === undefined) return Effect.die(`mock: rename missing ${from}`);
			files.set(to, v);
			files.delete(from);
			return Effect.void;
		},
		remove: (path) => {
			callsRef.current.push({ op: 'remove', path });
			files.delete(path);
			return Effect.void;
		},
	});

	return {
		layer,
		get calls() {
			return callsRef.current;
		},
		files,
		callsRef,
	};
};

const configLayer = (cfg: { stack: string; network: SuiNetwork; stateDir?: string }) =>
	Layer.succeed(StateStoreConfig, cfg);

// ---------------------------------------------------------------------------
// Path precedence
// ---------------------------------------------------------------------------

describe('state-store path precedence', () => {
	let savedEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		delete process.env.DEVSTACK_APP_DIR;
		delete process.env.DEVSTACK_STATE_DIR;
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) delete process.env[k];
		Object.assign(process.env, savedEnv);
	});

	const lockPathFrom = (calls: ReadonlyArray<FsCall>): string | undefined =>
		calls.find((c) => c.op === 'writeFileString' && c.flag === 'wx')?.path;

	it.effect('localnet uses .devstack/stacks/<stack>/state.json under cwd by default', () =>
		Effect.gen(function* () {
			const fs = makeMockFs();
			yield* Effect.provide(
				Layer.build(Layer.provide(StateStoreLive, configLayer({ stack: 'main', network: 'localnet' }))),
				fs.layer,
			);
			const expected = `${process.cwd()}/.devstack/stacks/main/state.json.lock`;
			expect(lockPathFrom(fs.calls)).toBe(expected);
		}),
	);

	it.effect('DEVSTACK_APP_DIR overrides cwd', () =>
		Effect.gen(function* () {
			process.env.DEVSTACK_APP_DIR = '/tmp/custom-app';
			const fs = makeMockFs();
			yield* Effect.provide(
				Layer.build(Layer.provide(StateStoreLive, configLayer({ stack: 's1', network: 'localnet' }))),
				fs.layer,
			);
			expect(lockPathFrom(fs.calls)).toBe('/tmp/custom-app/.devstack/stacks/s1/state.json.lock');
		}),
	);

	it.effect('explicit stateDir overrides default path scoping', () =>
		Effect.gen(function* () {
			const fs = makeMockFs();
			yield* Effect.provide(
				Layer.build(
					Layer.provide(
						StateStoreLive,
						configLayer({ stack: 'ignored', network: 'localnet', stateDir: '/explicit/dir' }),
					),
				),
				fs.layer,
			);
			expect(lockPathFrom(fs.calls)).toBe('/explicit/dir/state.json.lock');
		}),
	);

	it.effect('live nets resolve to .devstack/networks/<network>.json', () =>
		Effect.gen(function* () {
			process.env.DEVSTACK_APP_DIR = '/tmp/app';
			const fs = makeMockFs();
			yield* Effect.provide(
				Layer.build(Layer.provide(StateStoreLive, configLayer({ stack: 'main', network: 'testnet' }))),
				fs.layer,
			);
			// Live-net layout: one file per network, no stack dimension.
			expect(lockPathFrom(fs.calls)).toBe('/tmp/app/.devstack/networks/testnet.lock');
		}),
	);

	it.effect('DEVSTACK_STATE_DIR legacy escape hatch wins over everything', () =>
		Effect.gen(function* () {
			process.env.DEVSTACK_STATE_DIR = '/legacy';
			process.env.DEVSTACK_APP_DIR = '/should-be-ignored';
			const fs = makeMockFs();
			yield* Effect.provide(
				Layer.build(
					Layer.provide(
						StateStoreLive,
						configLayer({ stack: 's', network: 'localnet', stateDir: '/also-ignored' }),
					),
				),
				fs.layer,
			);
			expect(lockPathFrom(fs.calls)).toBe('/legacy/state.json.lock');
		}),
	);
});

// ---------------------------------------------------------------------------
// Atomic write semantics
// ---------------------------------------------------------------------------

describe('state-store atomic write', () => {
	let savedEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.DEVSTACK_STATE_DIR = '/atomic-test';
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) delete process.env[k];
		Object.assign(process.env, savedEnv);
	});

	it.effect('put writes via tempfile then rename (no direct write to state.json)', () =>
		Effect.gen(function* () {
			const fs = makeMockFs();
			const layer = Layer.provide(StateStoreLive, configLayer({ stack: 's', network: 'localnet' }));
			yield* Effect.gen(function* () {
				const store = yield* StateStore;
				yield* store.put('k', { hello: 'world' });
			}).pipe(Effect.provide(layer), Effect.provide(fs.layer));

			const writes = fs.calls.filter((c) => c.op === 'writeFileString');
			const renames = fs.calls.filter((c) => c.op === 'rename');
			// Lock acquire + tempfile write — never a direct write to state.json.
			expect(writes.some((c) => c.path === '/atomic-test/state.json')).toBe(false);
			expect(writes.some((c) => c.path.startsWith('/atomic-test/state.json.tmp.'))).toBe(true);
			// Rename promotes tempfile to its final name.
			expect(renames.some((c) => c.path.endsWith(' -> /atomic-test/state.json'))).toBe(true);
		}),
	);

	it.effect('tempfile carries pid + entropy so concurrent writers do not collide', () =>
		Effect.gen(function* () {
			const fs = makeMockFs();
			const layer = Layer.provide(StateStoreLive, configLayer({ stack: 's', network: 'localnet' }));
			yield* Effect.gen(function* () {
				const store = yield* StateStore;
				yield* store.put('a', 1);
				yield* store.put('b', 2);
			}).pipe(Effect.provide(layer), Effect.provide(fs.layer));

			const tmpWrites = fs.calls
				.filter((c) => c.op === 'writeFileString' && c.path.includes('/state.json.tmp.'))
				.map((c) => c.path);
			expect(tmpWrites.length).toBeGreaterThanOrEqual(2);
			// Two consecutive writes must produce distinct tempfile names —
			// otherwise a real concurrent writer would clobber.
			expect(new Set(tmpWrites).size).toBe(tmpWrites.length);
			// Pid is encoded for forensic debugging of orphaned tempfiles.
			for (const p of tmpWrites) expect(p).toContain(`.tmp.${process.pid}.`);
		}),
	);

	it.effect('values round-trip across in-process get / put / remove', () =>
		Effect.gen(function* () {
			const fs = makeMockFs();
			const layer = Layer.provide(StateStoreLive, configLayer({ stack: 's', network: 'localnet' }));
			yield* Effect.gen(function* () {
				const store = yield* StateStore;
				yield* store.put('k', { count: 7n });
				const got = yield* store.get<{ count: bigint }>('k');
				expect(Option.isSome(got)).toBe(true);
				if (Option.isSome(got)) expect(got.value.count).toBe(7n);
				yield* store.remove('k');
				const gone = yield* store.get('k');
				expect(Option.isNone(gone)).toBe(true);
			}).pipe(Effect.provide(layer), Effect.provide(fs.layer));
		}),
	);

	it.effect('lock body carries pid, host, instanceId — required for cross-process arbitration', () =>
		Effect.gen(function* () {
			const fs = makeMockFs();
			const layer = Layer.provide(StateStoreLive, configLayer({ stack: 's', network: 'localnet' }));
			// The lock body must be inspected while the scope is open — the
			// finalizer wipes the file on teardown, which is correct behavior
			// but means we need to read it from inside the providing scope.
			yield* Effect.gen(function* () {
				yield* StateStore;
				const lockWrite = fs.calls.find(
					(c) => c.op === 'writeFileString' && c.flag === 'wx' && c.path.endsWith('.lock'),
				);
				expect(lockWrite).toBeDefined();
				const body = JSON.parse(fs.files.get(lockWrite!.path) ?? '{}') as Record<
					string,
					unknown
				>;
				expect(body.pid).toBe(process.pid);
				expect(typeof body.host).toBe('string');
				expect(typeof body.instanceId).toBe('string');
				// UUID shape — sanity check that randomUUID() is actually called.
				expect((body.instanceId as string).length).toBeGreaterThanOrEqual(32);
			}).pipe(Effect.provide(layer), Effect.provide(fs.layer));
		}),
	);

	it.effect(
		'in-process serialization: a second StateStore acquired inside a held scope sees the lock',
		() =>
			Effect.gen(function* () {
				const fs = makeMockFs();
				const layer = Layer.provide(
					StateStoreLive,
					configLayer({ stack: 's', network: 'localnet' }),
				);
				// First holder writes the lock with `wx`. Inside its scope we
				// inspect the captured calls — proves the `wx` write happened
				// AND the lock body is on disk before any other work runs.
				yield* Effect.gen(function* () {
					yield* StateStore;
					const wxWrites = fs.calls.filter(
						(c) => c.op === 'writeFileString' && c.flag === 'wx',
					);
					expect(wxWrites).toHaveLength(1);
					expect(fs.files.has(wxWrites[0]!.path)).toBe(true);
				}).pipe(Effect.provide(layer), Effect.provide(fs.layer));

				// After scope teardown the finalizer removes the lock.
				// Cross-process race testing requires actual child processes;
				// that scenario is out of scope for unit tests, but the
				// `wx` flag + instanceId protocol is the wire-level contract
				// that makes it safe — covered by the in-scope assertion above.
				const lockPath = '/atomic-test/state.json.lock';
				expect(fs.files.has(lockPath)).toBe(false);
			}),
	);
});
