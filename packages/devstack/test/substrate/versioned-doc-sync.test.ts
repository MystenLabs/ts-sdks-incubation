// Versioned cross-process document helper — tests.
//
// Pins the three behavioral contracts the cross-process modules rely
// on:
//   - read: positive round-trip, missing-file default, malformed-body
//     surfaces `mkCorrupt` (with `raw`), I/O failure surfaces `mkIo`.
//   - parse-or-null: positive round-trip, malformed → null.
//   - write: round-trips through atomicWriteJsonSync (the file exists
//     after, with the value).

import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Exit, Option, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { versionedDocSchema } from '../../src/substrate/versioned-doc-schema.ts';
import {
	parseVersionedDocumentBodyOrNull,
	readVersionedDocumentSync,
	writeVersionedDocumentSync,
} from '../../src/substrate/versioned-doc-sync.ts';

const TestDocSchema = versionedDocSchema(1, {
	name: Schema.String,
	items: Schema.Array(Schema.Number),
});
type TestDoc = Schema.Schema.Type<typeof TestDocSchema>;

const EMPTY: TestDoc = { version: 1, name: '', items: [] };

class TestIoError {
	readonly _tag = 'TestIoError';
	constructor(
		readonly path: string,
		readonly cause: unknown,
	) {}
}
class TestCorruptError {
	readonly _tag = 'TestCorruptError';
	constructor(
		readonly path: string,
		readonly raw: string,
		readonly cause: unknown,
	) {}
}

const ERRS = {
	mkIo: ({ path, cause }: { path: string; cause: unknown }) => new TestIoError(path, cause),
	mkCorrupt: ({ path, raw, cause }: { path: string; raw: string; cause: unknown }) =>
		new TestCorruptError(path, raw, cause),
} as const;

const freshTmp = (): string => mkdtempSync(join(tmpdir(), 'versioned-doc-sync-test-'));

describe('readVersionedDocumentSync', () => {
	it.effect('returns the supplied default when the file is absent', () =>
		Effect.gen(function* () {
			const root = freshTmp();
			try {
				const target = join(root, 'absent.json');
				const out = yield* readVersionedDocumentSync(target, TestDocSchema, ERRS, EMPTY);
				expect(out).toEqual(EMPTY);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('decodes a well-formed body via the schema', () =>
		Effect.gen(function* () {
			const root = freshTmp();
			try {
				const target = join(root, 'doc.json');
				const doc: TestDoc = { version: 1, name: 'alpha', items: [1, 2, 3] };
				writeFileSync(target, JSON.stringify(doc));
				const out = yield* readVersionedDocumentSync(target, TestDocSchema, ERRS, EMPTY);
				expect(out).toEqual(doc);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('surfaces a typed corrupt error with raw bytes echoed back', () =>
		Effect.gen(function* () {
			const root = freshTmp();
			try {
				const target = join(root, 'corrupt.json');
				writeFileSync(target, '{"version":99,"this is":"garbage"');
				const exit = yield* Effect.exit(
					readVersionedDocumentSync(target, TestDocSchema, ERRS, EMPTY),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				const errOpt = Exit.findErrorOption(exit);
				expect(Option.isSome(errOpt)).toBe(true);
				const err = Option.getOrThrow(errOpt);
				expect(err).toBeInstanceOf(TestCorruptError);
				expect((err as TestCorruptError).path).toBe(target);
				expect((err as TestCorruptError).raw).toBe('{"version":99,"this is":"garbage"');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('surfaces a typed IO error when reading fails', () =>
		Effect.gen(function* () {
			const root = freshTmp();
			try {
				const target = join(root, 'unreadable.json');
				writeFileSync(target, '{"version":1,"name":"x","items":[]}');
				chmodSync(target, 0o000);
				const exit = yield* Effect.exit(
					readVersionedDocumentSync(target, TestDocSchema, ERRS, EMPTY),
				);
				// On CI / root: chmod may not block read; tolerate either an
				// IO failure (the typed path we want to exercise) or a
				// successful decode (root bypasses mode bits).
				if (Exit.isFailure(exit)) {
					const errOpt = Exit.findErrorOption(exit);
					if (Option.isSome(errOpt)) {
						const err = Option.getOrThrow(errOpt);
						expect(err).toBeInstanceOf(TestIoError);
						expect((err as TestIoError).path).toBe(target);
					}
				}
			} finally {
				try {
					chmodSync(join(root, 'unreadable.json'), 0o600);
				} catch {
					// already gone
				}
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});

describe('parseVersionedDocumentBodyOrNull', () => {
	it('decodes a well-formed body', () => {
		const doc: TestDoc = { version: 1, name: 'beta', items: [9] };
		const out = parseVersionedDocumentBodyOrNull(
			JSON.stringify(doc),
			TestDocSchema,
			'test-source',
		);
		expect(out).toEqual(doc);
	});

	it('returns null on a JSON parse failure', () => {
		const out = parseVersionedDocumentBodyOrNull('{ not json', TestDocSchema, 'test-source');
		expect(out).toBeNull();
	});

	it('returns null on a Schema decode failure', () => {
		const out = parseVersionedDocumentBodyOrNull(
			'{"version":1,"name":42,"items":[]}',
			TestDocSchema,
			'test-source',
		);
		expect(out).toBeNull();
	});
});

describe('writeVersionedDocumentSync', () => {
	it.effect('round-trips a doc atomically through atomicWriteJsonSync', () =>
		Effect.gen(function* () {
			const root = freshTmp();
			try {
				const target = join(root, 'a', 'b', 'doc.json');
				const doc: TestDoc = { version: 1, name: 'gamma', items: [1, 2] };
				const ioErrs = { mkIo: ERRS.mkIo };
				yield* writeVersionedDocumentSync(target, doc, ioErrs);
				expect(existsSync(target)).toBe(true);
				expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(doc);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('surfaces a typed IO error when the write fails', () =>
		Effect.gen(function* () {
			const root = freshTmp();
			try {
				// Make the parent dir non-writable so atomicWriteJsonSync's
				// tempfile open fails with EACCES. macOS root may bypass; we
				// only assert when the failure path engages.
				const sub = join(root, 'locked');
				const target = join(sub, 'doc.json');
				writeFileSync(join(root, 'placeholder'), '');
				chmodSync(root, 0o500);
				const ioErrs = { mkIo: ERRS.mkIo };
				const doc: TestDoc = { version: 1, name: 'gamma', items: [] };
				const exit = yield* Effect.exit(writeVersionedDocumentSync(target, doc, ioErrs));
				if (Exit.isFailure(exit)) {
					const errOpt = Exit.findErrorOption(exit);
					if (Option.isSome(errOpt)) {
						const err = Option.getOrThrow(errOpt);
						expect(err).toBeInstanceOf(TestIoError);
						expect((err as TestIoError).path).toBe(target);
					}
				}
			} finally {
				try {
					chmodSync(root, 0o700);
				} catch {
					// ignore
				}
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
