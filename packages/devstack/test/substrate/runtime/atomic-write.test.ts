// Atomic write primitive — tests.
//
// Pins the contract for both surfaces (Effect/FileSystem-based +
// node:fs-sync). The two surfaces share the same disk-side
// invariants: mkdir-parent → O_EXCL temp → write → fsync → rename.

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

import { Effect, Schema } from 'effect';
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
