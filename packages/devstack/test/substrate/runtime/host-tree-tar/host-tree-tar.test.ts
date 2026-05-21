// host-tree-tar — system-`tar`-backed archive primitive.
//
// These tests exercise the round-trip against real `tar` (BSD on
// macOS, GNU on Linux). Both honour the flags used; if the binary is
// missing the test framework skips via the spawn-failure surfacing
// path.

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Exit, Stream } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	HostTreeTarError,
	tarHostTree,
	untarHostTree,
} from '../../../../src/substrate/runtime/host-tree-tar/index.ts';

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'host-tree-tar-test-'));

const tarWithFileEntry = (entryPath: string, content: string): Buffer => {
	const contentBytes = Buffer.from(content, 'utf8');
	const header = Buffer.alloc(512);
	const writeOctal = (value: number, offset: number, length: number): void => {
		header.write(value.toString(8).padStart(length - 1, '0'), offset, 'ascii');
		header[offset + length - 1] = 0;
	};
	header.write(entryPath, 0, 'utf8');
	writeOctal(0o644, 100, 8);
	writeOctal(0, 108, 8);
	writeOctal(0, 116, 8);
	writeOctal(contentBytes.length, 124, 12);
	writeOctal(0, 136, 12);
	header.fill(0x20, 148, 156);
	header[156] = '0'.charCodeAt(0);
	header.write('ustar\0', 257, 'ascii');
	header.write('00', 263, 'ascii');
	const checksum = header.reduce((sum, byte) => sum + byte, 0);
	header.write(checksum.toString(8).padStart(6, '0'), 148, 'ascii');
	header[154] = 0;
	header[155] = 0x20;
	const padding = Buffer.alloc((512 - (contentBytes.length % 512)) % 512);
	return Buffer.concat([header, contentBytes, padding, Buffer.alloc(1024)]);
};

describe('tarHostTree + untarHostTree', () => {
	it.effect('round-trips a small subtree preserving content', () =>
		Effect.gen(function* () {
			const src = freshRoot();
			const dst = freshRoot();
			try {
				mkdirSync(join(src, 'a'), { recursive: true });
				writeFileSync(join(src, 'a', 'one.txt'), 'hello-one');
				writeFileSync(join(src, 'a', 'two.txt'), 'hello-two');

				const archiveBytes = yield* Stream.runCollect(
					tarHostTree({ parentDir: src, relPaths: ['a'] }),
				);
				const archive = Array.from(archiveBytes).flatMap((c) => Array.from(c));
				expect(archive.length).toBeGreaterThan(0);

				const source = Stream.fromIterable([new Uint8Array(archive)]);
				yield* Effect.scoped(untarHostTree(source, { target: dst }));

				expect(readFileSync(join(dst, 'a', 'one.txt'), 'utf8')).toBe('hello-one');
				expect(readFileSync(join(dst, 'a', 'two.txt'), 'utf8')).toBe('hello-two');
			} finally {
				rmSync(src, { recursive: true, force: true });
				rmSync(dst, { recursive: true, force: true });
			}
		}),
	);

	it.effect('preserves 0o600 mode bits across the round-trip', () =>
		Effect.gen(function* () {
			const src = freshRoot();
			const dst = freshRoot();
			try {
				mkdirSync(join(src, 'secret'), { recursive: true });
				const secretPath = join(src, 'secret', 'key');
				writeFileSync(secretPath, 'shh');
				chmodSync(secretPath, 0o600);

				const archiveBytes = yield* Stream.runCollect(
					tarHostTree({ parentDir: src, relPaths: ['secret'] }),
				);
				const archive = Array.from(archiveBytes).flatMap((c) => Array.from(c));
				const source = Stream.fromIterable([new Uint8Array(archive)]);
				yield* Effect.scoped(untarHostTree(source, { target: dst }));

				const mode = statSync(join(dst, 'secret', 'key')).mode & 0o777;
				expect(mode).toBe(0o600);
			} finally {
				rmSync(src, { recursive: true, force: true });
				rmSync(dst, { recursive: true, force: true });
			}
		}),
	);

	it.effect('rejects unsafe archive paths inside untarHostTree before extraction writes them', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			const dst = join(root, 'target');
			const escaped = join(root, 'escape.txt');
			try {
				mkdirSync(dst, { recursive: true });
				const archive = tarWithFileEntry('../escape.txt', 'owned');
				const source = Stream.fromIterable([archive.subarray(0, 128), archive.subarray(128)]);

				const exit = yield* Effect.exit(Effect.scoped(untarHostTree(source, { target: dst })));

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(HostTreeTarError);
					expect(error.value.stage).toBe('entry-validation');
					expect(error.value.detail).toContain('unsafe tar entry path');
				}
				expect(existsSync(escaped)).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('empty relPaths list fails with stage: "no-subtrees"', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
				const exit = yield* Effect.exit(
					Stream.runCollect(tarHostTree({ parentDir: root, relPaths: [] })),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				expect(JSON.stringify(exit)).toContain('no-subtrees');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('tar on missing subtree surfaces stage: "exit-code"', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
				const exit = yield* Effect.exit(
					Stream.runCollect(tarHostTree({ parentDir: root, relPaths: ['no-such-thing'] })),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				expect(JSON.stringify(exit)).toContain('exit-code');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it('HostTreeTarError is a tagged failure', () => {
		const err = new HostTreeTarError({
			stage: 'spawn',
			operation: 'tar',
			detail: 'boom',
		});
		expect(err._tag).toBe('HostTreeTarError');
		expect(existsSync('/')).toBe(true);
	});
});
