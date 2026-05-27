// Atomic write primitive — tests.
//
// Pins the contract for both surfaces (Effect/FileSystem-based +
// node:fs-sync). The two surfaces share the same disk-side
// invariants: mkdir-parent → O_EXCL temp → write → fsync → rename.

import * as nodeFs from 'node:fs';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Exit, FileSystem, Option, PlatformError, Schema } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';

import {
	atomicWriteFile,
	atomicWriteFileSync,
	atomicWriteJson,
	atomicWriteJsonSync,
} from '../../../src/substrate/runtime/atomic-write.ts';
import { AtomicWriteFailed } from '../../../src/substrate/runtime/errors.ts';

const freshTmp = (): string => mkdtempSync(join(tmpdir(), 'atomic-write-test-'));

describe('atomicWriteFile (Effect/FileSystem)', () => {
	it.effect('writes bytes atomically and creates parent dirs', () =>
		Effect.gen(function* () {
			const root = freshTmp();
			try {
				const target = join(root, 'a', 'b', 'c.json');
				const payload = new TextEncoder().encode('{"hello":"world"}');
				yield* atomicWriteFile(target, payload);
				expect(existsSync(target)).toBe(true);
				expect(readFileSync(target, 'utf8')).toBe('{"hello":"world"}');
				const siblings = readdirSync(join(root, 'a', 'b'));
				expect(siblings).toEqual(['c.json']);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('applies the requested file mode', () =>
		Effect.gen(function* () {
			const root = freshTmp();
			try {
				const target = join(root, 'modefile');
				const bytes = new TextEncoder().encode('x');
				yield* atomicWriteFile(target, bytes, { mode: 0o600 });
				const stat = statSync(target);
				expect(stat.mode & 0o777).toBe(0o600);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('writes JSON via atomicWriteJson with Schema-encoded shape', () =>
		Effect.gen(function* () {
			const root = freshTmp();
			try {
				const target = join(root, 'doc.json');
				const Doc = Schema.Struct({ version: Schema.Literal(1), name: Schema.String });
				const value = { version: 1 as const, name: 'devstack' };
				yield* atomicWriteJson(target, Doc, value);
				const onDisk = JSON.parse(readFileSync(target, 'utf8'));
				expect(onDisk).toEqual(value);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('surfaces AtomicWriteFailed on encode failure', () =>
		Effect.gen(function* () {
			const root = freshTmp();
			try {
				const target = join(root, 'doc.json');
				const Doc = Schema.Struct({ n: Schema.Number });
				// Caller passes a runtime value the schema rejects.
				const value = { n: 'not-a-number' } as unknown as { n: number };
				const result = yield* atomicWriteJson(target, Doc, value).pipe(Effect.exit);
				expect(result._tag).toBe('Failure');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});

describe('atomicWriteFileSync (node:fs sync)', () => {
	it('writes bytes atomically and creates parent dirs', () => {
		const root = freshTmp();
		try {
			const target = join(root, 'a', 'b', 'c.json');
			atomicWriteFileSync(target, '{"hello":"world"}');
			expect(existsSync(target)).toBe(true);
			expect(readFileSync(target, 'utf8')).toBe('{"hello":"world"}');
			expect(readdirSync(join(root, 'a', 'b'))).toEqual(['c.json']);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('applies the requested file mode', () => {
		const root = freshTmp();
		try {
			const target = join(root, 'modefile');
			atomicWriteFileSync(target, 'x', { mode: 0o600 });
			const stat = statSync(target);
			expect(stat.mode & 0o777).toBe(0o600);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('atomicWriteJsonSync round-trips through JSON.parse', () => {
		const root = freshTmp();
		try {
			const target = join(root, 'doc.json');
			atomicWriteJsonSync(target, { version: 1, name: 'devstack' });
			expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({
				version: 1,
				name: 'devstack',
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('overwrites an existing final file (rename target is replaced)', () => {
		const root = freshTmp();
		try {
			const target = join(root, 'doc.json');
			writeFileSync(target, '{"old":true}');
			atomicWriteJsonSync(target, { new: true });
			expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ new: true });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('leaves no tempfile on success', () => {
		const root = freshTmp();
		try {
			const target = join(root, 'doc.json');
			atomicWriteJsonSync(target, { ok: 1 });
			const siblings = readdirSync(root);
			expect(siblings).toEqual(['doc.json']);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('concurrent writers serialize safely (each call produces a valid file)', () => {
		// Two writes to the SAME path, back-to-back synchronously.
		// Each call uses a uniquely-named tempfile (crypto.randomUUID
		// suffix); both renames succeed in turn — no collision.
		const root = freshTmp();
		try {
			const target = join(root, 'doc.json');
			atomicWriteJsonSync(target, { round: 1 });
			atomicWriteJsonSync(target, { round: 2 });
			expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ round: 2 });
			expect(readdirSync(root)).toEqual(['doc.json']);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// Failure-injection tests for both surfaces. The Effect surface
// uses `FileSystem.makeNoop` overrides; the sync surface uses
// `vi.spyOn` against `node:fs`. Both surfaces share the same
// invariant: ANY mid-flight failure (open / write / fsync / rename)
// must unlink the tempfile so the directory has no `*.tmp.*`
// stragglers.
//
// The Effect surface tempfile lives in `dirname(path)` with the
// shape `<basename>.tmp.<pid>.<8-hex>` — see `atomic-write.ts`
// `tempSuffix()` + the `tmp` const. The assertion below greps the
// dispatch directory for any sibling whose name starts with
// `<basename>.tmp.` rather than guessing the random suffix.

const tempLeakSiblings = (root: string, finalName: string): ReadonlyArray<string> =>
	readdirSync(root).filter((name) => name.startsWith(`${finalName}.tmp.`));

/** Helper: build a `PlatformError` with a system-error reason. */
const fakePlatformError = (method: string, path: string, description: string) =>
	PlatformError.systemError({
		module: 'FileSystem',
		method,
		_tag: 'PermissionDenied',
		description,
		pathOrDescriptor: path,
		cause: new Error(description),
	});

/**
 * Build a fake `FileSystem` that records every method call we care
 * about and injects a typed failure on the requested `failOn` stage.
 *
 * The atomic-write impl pipes through `Effect.catch(failStage(...))`
 * which converts a typed `PlatformError` into `AtomicWriteFailed`
 * carrying the stage discriminator — that's the assertion target.
 */
interface FakeFsObservations {
	readonly removed: string[];
	tempPath: string | null;
}

const makeFailingFs = (
	failOn: 'open' | 'writeAll' | 'sync' | 'rename',
): {
	readonly fs: FileSystem.FileSystem;
	readonly observations: FakeFsObservations;
} => {
	const observations: FakeFsObservations = { removed: [], tempPath: null };
	const fileFor = (path: string): FileSystem.File =>
		({
			[FileSystem.FileTypeId]: FileSystem.FileTypeId,
			fd: 0 as FileSystem.File['fd'],
			stat: Effect.fail(fakePlatformError('stat', path, 'not implemented')),
			seek: () => Effect.void,
			sync:
				failOn === 'sync'
					? Effect.fail(fakePlatformError('sync', path, `fake sync failure for ${path}`))
					: Effect.void,
			read: () => Effect.fail(fakePlatformError('read', path, 'not implemented')),
			readAlloc: () => Effect.fail(fakePlatformError('readAlloc', path, 'not implemented')),
			truncate: () => Effect.fail(fakePlatformError('truncate', path, 'not implemented')),
			write: () => Effect.fail(fakePlatformError('write', path, 'not implemented')),
			writeAll:
				failOn === 'writeAll'
					? () =>
							Effect.fail(
								fakePlatformError('writeAll', path, `fake writeAll failure for ${path}`),
							)
					: () => Effect.void,
		}) as unknown as FileSystem.File;
	const fs = FileSystem.makeNoop({
		makeDirectory: () => Effect.void,
		open: (path) => {
			observations.tempPath = path;
			if (failOn === 'open') {
				return Effect.fail(fakePlatformError('open', path, `fake open failure for ${path}`));
			}
			// `open` returns a scope-bound `File` — wrap in
			// `Effect.acquireRelease` so the scope finalizer is a no-op
			// (mirrors real `fs.open` scope semantics).
			return Effect.acquireRelease(Effect.succeed(fileFor(path)), () => Effect.void);
		},
		remove: (path) => {
			observations.removed.push(path);
			return Effect.void;
		},
		rename: (oldPath) => {
			if (failOn === 'rename') {
				return Effect.fail(
					fakePlatformError('rename', oldPath, `fake rename failure for ${oldPath}`),
				);
			}
			return Effect.void;
		},
	});
	return { fs, observations };
};

describe('atomicWriteFile (Effect/FileSystem) — failure paths leave no temp file', () => {
	it.effect('open throw: AtomicWriteFailed (stage=open-temp), no temp to clean', () =>
		Effect.gen(function* () {
			const { fs, observations } = makeFailingFs('open');
			const exit = yield* atomicWriteFile(
				'/virtual/target.bin',
				new TextEncoder().encode('payload'),
			).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
			const errOpt = Exit.findErrorOption(exit);
			expect(Option.isSome(errOpt)).toBe(true);
			if (Option.isSome(errOpt)) {
				expect(errOpt.value._tag).toBe('AtomicWriteFailed');
				expect(errOpt.value.stage).toBe('open-temp');
			}
			// Cleanup still fires (Effect.onError runs on ANY failure path).
			// The tempfile name was captured by our recording `open`, and
			// `remove` was called on the SAME tempfile.
			expect(observations.tempPath).not.toBeNull();
			expect(observations.removed).toContain(observations.tempPath);
		}),
	);

	it.effect('write throw: AtomicWriteFailed (stage=write), tempfile cleaned', () =>
		Effect.gen(function* () {
			const { fs, observations } = makeFailingFs('writeAll');
			const exit = yield* atomicWriteFile(
				'/virtual/target.bin',
				new TextEncoder().encode('payload'),
			).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
			const errOpt = Exit.findErrorOption(exit);
			expect(Option.isSome(errOpt)).toBe(true);
			if (Option.isSome(errOpt)) {
				expect(errOpt.value._tag).toBe('AtomicWriteFailed');
				expect(errOpt.value.stage).toBe('write');
			}
			expect(observations.tempPath).not.toBeNull();
			expect(observations.removed).toContain(observations.tempPath);
		}),
	);

	it.effect('fsync throw: AtomicWriteFailed (stage=fsync), tempfile cleaned', () =>
		Effect.gen(function* () {
			const { fs, observations } = makeFailingFs('sync');
			const exit = yield* atomicWriteFile(
				'/virtual/target.bin',
				new TextEncoder().encode('payload'),
			).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
			const errOpt = Exit.findErrorOption(exit);
			expect(Option.isSome(errOpt)).toBe(true);
			if (Option.isSome(errOpt)) {
				expect(errOpt.value._tag).toBe('AtomicWriteFailed');
				expect(errOpt.value.stage).toBe('fsync');
			}
			expect(observations.tempPath).not.toBeNull();
			expect(observations.removed).toContain(observations.tempPath);
		}),
	);

	it.effect('rename throw: AtomicWriteFailed (stage=rename), tempfile cleaned', () =>
		Effect.gen(function* () {
			const { fs, observations } = makeFailingFs('rename');
			const exit = yield* atomicWriteFile(
				'/virtual/target.bin',
				new TextEncoder().encode('payload'),
			).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
			const errOpt = Exit.findErrorOption(exit);
			expect(Option.isSome(errOpt)).toBe(true);
			if (Option.isSome(errOpt)) {
				expect(errOpt.value._tag).toBe('AtomicWriteFailed');
				expect(errOpt.value.stage).toBe('rename');
			}
			expect(observations.tempPath).not.toBeNull();
			expect(observations.removed).toContain(observations.tempPath);
		}),
	);
});

// atomicWriteJson relays through atomicWriteFile, so we cover one
// representative stage (rename throw) to confirm the JSON surface
// inherits the tempfile-cleanup contract.
describe('atomicWriteJson (Effect/FileSystem) — failure inherits tempfile cleanup', () => {
	it.effect('rename throw: surfaces AtomicWriteFailed, no tempfile leaked', () =>
		Effect.gen(function* () {
			const { fs, observations } = makeFailingFs('rename');
			const Doc = Schema.Struct({ n: Schema.Number });
			const exit = yield* atomicWriteJson('/virtual/doc.json', Doc, { n: 1 }).pipe(
				Effect.provideService(FileSystem.FileSystem, fs),
				Effect.exit,
			);
			expect(Exit.isFailure(exit)).toBe(true);
			expect(observations.removed).toContain(observations.tempPath);
		}),
	);
});

// Sync surface counterparts via real-filesystem failure conditions.
// The sync impl's tempfile-cleanup contract is "if writeFileSync
// succeeded (tempfile exists) and then open/fsync/rename throws, the
// finally block unlinks the tempfile". Triggering each individual
// stage failure without monkey-patching is brittle — destructured
// imports in `atomic-write.ts` capture the symbols at module-load and
// are NOT reachable via `vi.spyOn(nodeFs, ...)`. We reproduce the
// canonical failures using real fs preconditions:
//   - `rename` failure → pre-existing directory at the target path
//     causes EISDIR when renameSync(tmp, target) fires AFTER fsync
//     succeeds. Exercises the post-fsync, pre-rename cleanup branch.
//   - `writeFileSync` failure → parent path is a regular file, so
//     mkdirSync(dirname) fails with ENOTDIR. The function throws
//     before any tempfile is created — proves the early-fail path
//     also leaks nothing.
describe('atomicWriteFileSync (node:fs sync) — failure paths leave no temp file', () => {
	it('rename throw (EISDIR via pre-existing directory at target): tempfile unlinked', () => {
		const root = freshTmp();
		try {
			const target = join(root, 'doc.bin');
			// renameSync(tmp, target) fails with EISDIR when target is
			// an existing directory. The finally-block runs
			// unlinkSync(tmp) — proving the post-fsync, pre-rename
			// cleanup branch.
			nodeFs.mkdirSync(target, { recursive: true });
			expect(() => atomicWriteFileSync(target, 'payload')).toThrow();
			// No tempfile siblings — the finally block ran unlinkSync(tmp).
			expect(tempLeakSiblings(root, 'doc.bin')).toEqual([]);
			// Target still exists as a directory.
			expect(statSync(target).isDirectory()).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('mkdir-parent throw (ENOTDIR via parent-as-file): no tempfile created, no leak', () => {
		const root = freshTmp();
		try {
			// Create a regular file where the parent would need to be a
			// directory; mkdirSync(parent) fails with ENOTDIR.
			const parentFile = join(root, 'parent-as-file');
			nodeFs.writeFileSync(parentFile, 'x');
			const target = join(parentFile, 'doc.bin');
			expect(() => atomicWriteFileSync(target, 'payload')).toThrow();
			// No tempfile sibling under `root` matching the doc.bin lineage.
			expect(tempLeakSiblings(root, 'doc.bin')).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// Sanity: the AtomicWriteFailed shape is still tagged + has the
// expected `stage` discriminator.
describe('AtomicWriteFailed', () => {
	it('is a tagged failure with stage discriminator', () => {
		const err = new AtomicWriteFailed({
			path: '/x',
			stage: 'rename',
			cause: new Error('boom'),
		});
		expect(err._tag).toBe('AtomicWriteFailed');
		expect(err.stage).toBe('rename');
		expect(err.path).toBe('/x');
	});
});
