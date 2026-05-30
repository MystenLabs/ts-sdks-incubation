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
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { Effect, Exit, Stream } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	HostTreeTarError,
	tarHostTree,
	untarHostTree,
} from '../../../../src/substrate/runtime/host-tree-tar/index.ts';
import { withTempRoot } from '../../../helpers/with-temp-root.ts';

// Build a single 512-byte ustar header block for `entryPath` with the
// given `typeflag` and declared content `size` (checksum computed over
// the finished block). Shared by the plain-file and the
// PAX/GNU-extended-header fixtures below.
const tarHeaderBlock = (entryPath: string, typeflag: string, size: number): Buffer => {
	const header = Buffer.alloc(512);
	const writeOctal = (value: number, offset: number, length: number): void => {
		header.write(value.toString(8).padStart(length - 1, '0'), offset, 'ascii');
		header[offset + length - 1] = 0;
	};
	header.write(entryPath, 0, 'utf8');
	writeOctal(0o644, 100, 8);
	writeOctal(0, 108, 8);
	writeOctal(0, 116, 8);
	writeOctal(size, 124, 12);
	writeOctal(0, 136, 12);
	header.fill(0x20, 148, 156);
	header[156] = typeflag.charCodeAt(0);
	header.write('ustar\0', 257, 'ascii');
	header.write('00', 263, 'ascii');
	const checksum = header.reduce((sum, byte) => sum + byte, 0);
	header.write(checksum.toString(8).padStart(6, '0'), 148, 'ascii');
	header[154] = 0;
	header[155] = 0x20;
	return header;
};

// A 512-aligned content block (the extended-header payload, or a file
// body) padded with zeros up to the next block boundary.
const tarContentBlocks = (contentBytes: Uint8Array): Buffer => {
	const padding = Buffer.alloc((512 - (contentBytes.length % 512)) % 512);
	return Buffer.concat([Buffer.from(contentBytes), padding]);
};

const tarWithFileEntry = (entryPath: string, content: string): Buffer => {
	const contentBytes = Buffer.from(content, 'utf8');
	const header = tarHeaderBlock(entryPath, '0', contentBytes.length);
	return Buffer.concat([header, tarContentBlocks(contentBytes), Buffer.alloc(1024)]);
};

// Encode a single PAX extended-header record. The leading length count
// covers the WHOLE record including the digits, the space, and the
// trailing newline — matching the parser in `index.ts`
// (`parsePaxRecords`).
const paxRecord = (key: string, value: string): Buffer => {
	const body = ` ${key}=${value}\n`;
	// Iterate to a fixed point: the declared length includes the digits
	// of the declared length itself.
	let length = body.length + 1;
	while (`${length}`.length + body.length !== length) {
		length = `${length}`.length + body.length;
	}
	return Buffer.from(`${length}${body}`, 'utf8');
};

// Build an archive where a benign ustar entry (`safe.txt`) is preceded
// by a malicious extended-header block (`typeflag` 'x' PAX local, or
// 'L' GNU long-name) carrying `path=../escape.txt`. The validator must
// adopt the extended-header path and reject it.
const tarWithExtendedPathOverride = (
	typeflag: 'x' | 'L',
	maliciousPath: string,
	benignName = 'safe.txt',
	content = 'owned',
): Buffer => {
	const recordBytes =
		typeflag === 'x' ? paxRecord('path', maliciousPath) : Buffer.from(`${maliciousPath}\0`, 'utf8');
	const extendedHeader = tarHeaderBlock(
		typeflag === 'x' ? 'PaxHeaders/safe.txt' : '././@LongLink',
		typeflag,
		recordBytes.length,
	);
	const contentBytes = Buffer.from(content, 'utf8');
	const fileHeader = tarHeaderBlock(benignName, '0', contentBytes.length);
	return Buffer.concat([
		extendedHeader,
		tarContentBlocks(recordBytes),
		fileHeader,
		tarContentBlocks(contentBytes),
		Buffer.alloc(1024),
	]);
};

describe('tarHostTree + untarHostTree', () => {
	it.effect('round-trips a small subtree preserving content', () =>
		withTempRoot('host-tree-tar-test', (src) =>
			withTempRoot('host-tree-tar-test', (dst) =>
				Effect.gen(function* () {
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
				}),
			),
		),
	);

	it.effect('preserves 0o600 mode bits across the round-trip', () =>
		withTempRoot('host-tree-tar-test', (src) =>
			withTempRoot('host-tree-tar-test', (dst) =>
				Effect.gen(function* () {
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
				}),
			),
		),
	);

	it.effect('rejects unsafe archive paths inside untarHostTree before extraction writes them', () =>
		withTempRoot('host-tree-tar-test', (root) =>
			Effect.gen(function* () {
				const dst = join(root, 'target');
				const escaped = join(root, 'escape.txt');
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
			}),
		),
	);

	it.effect(
		'rejects a malicious PAX `x` path override even when the ustar header name is benign',
		() =>
			withTempRoot('host-tree-tar-test', (root) =>
				Effect.gen(function* () {
					const dst = join(root, 'target');
					const escaped = join(root, 'escape.txt');
					mkdirSync(dst, { recursive: true });
					// Benign ustar name `safe.txt`; the preceding PAX `x`
					// extended-header record overrides it with `../escape.txt`.
					// A name-only validator would pass this; the entry must be
					// validated against the EFFECTIVE (PAX-overridden) path.
					const archive = tarWithExtendedPathOverride('x', '../escape.txt');
					const source = Stream.fromIterable([archive.subarray(0, 200), archive.subarray(200)]);

					const exit = yield* Effect.exit(Effect.scoped(untarHostTree(source, { target: dst })));

					expect(Exit.isFailure(exit)).toBe(true);
					const error = Exit.findErrorOption(exit);
					expect(error._tag).toBe('Some');
					if (error._tag === 'Some') {
						expect(error.value).toBeInstanceOf(HostTreeTarError);
						expect(error.value.stage).toBe('entry-validation');
						expect(error.value.detail).toContain('unsafe tar entry path');
						expect(error.value.detail).toContain('../escape.txt');
					}
					expect(existsSync(escaped)).toBe(false);
				}),
			),
	);

	it.effect(
		'rejects a malicious GNU `L` long-name override even when the ustar header name is benign',
		() =>
			withTempRoot('host-tree-tar-test', (root) =>
				Effect.gen(function* () {
					const dst = join(root, 'target');
					const escaped = join(root, 'escape.txt');
					mkdirSync(dst, { recursive: true });
					const archive = tarWithExtendedPathOverride('L', '../escape.txt');
					const source = Stream.fromIterable([archive.subarray(0, 200), archive.subarray(200)]);

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
				}),
			),
	);

	it.effect('empty relPaths list fails with stage: "no-subtrees"', () =>
		withTempRoot('host-tree-tar-test', (root) =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(
					Stream.runCollect(tarHostTree({ parentDir: root, relPaths: [] })),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				expect(JSON.stringify(exit)).toContain('no-subtrees');
			}),
		),
	);

	it.effect('tar on missing subtree surfaces stage: "exit-code"', () =>
		withTempRoot('host-tree-tar-test', (root) =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(
					Stream.runCollect(tarHostTree({ parentDir: root, relPaths: ['no-such-thing'] })),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				expect(JSON.stringify(exit)).toContain('exit-code');
			}),
		),
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
