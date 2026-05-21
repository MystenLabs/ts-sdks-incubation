import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Layer, Stream } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import { DockerHost, DockerSpawner, layerDockerHost } from '../../../src/runtime/docker/client.ts';
import { saveImage, tagImage } from '../../../src/runtime/docker/image.ts';

const layerDockerSpawnerFromNode: Layer.Layer<DockerSpawner, never, ChildProcessSpawner> =
	Layer.effect(
		DockerSpawner,
		Effect.gen(function* () {
			return yield* ChildProcessSpawner;
		}),
	);

const fakeDockerLayer = (bin: string): Layer.Layer<DockerHost | DockerSpawner> =>
	Layer.merge(
		layerDockerHost({ bin }),
		layerDockerSpawnerFromNode.pipe(
			Layer.provideMerge(
				NodeChildProcessSpawner.layer.pipe(
					Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
				),
			),
		),
	);

describe('saveImage', () => {
	it.effect('does not remove snapshot-looking tags unless cleanup is explicit', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-save-test-'));
			try {
				const bin = join(root, 'docker');
				const log = join(root, 'docker.log');
				writeFileSync(
					bin,
					[
						'#!/bin/sh',
						`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
						'if [ "$1" = "save" ]; then',
						'  printf "image-bytes"',
						'  exit 0',
						'fi',
						'if [ "$1" = "image" ] && [ "$2" = "rm" ]; then',
						'  exit 0',
						'fi',
						'exit 0',
						'',
					].join('\n'),
				);
				chmodSync(bin, 0o755);

				const chunks = yield* Stream.runCollect(saveImage('devstack-snapshot:user-tag')).pipe(
					Effect.provide(fakeDockerLayer(bin)),
				);

				expect(Buffer.concat(Array.from(chunks, (chunk) => Buffer.from(chunk))).toString()).toBe(
					'image-bytes',
				);
				expect(readFileSync(log, 'utf8')).toBe('save devstack-snapshot:user-tag\n');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('removes a snapshot temp tag when cleanup is explicit', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-save-test-'));
			try {
				const bin = join(root, 'docker');
				const log = join(root, 'docker.log');
				writeFileSync(
					bin,
					[
						'#!/bin/sh',
						`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
						'if [ "$1" = "save" ]; then',
						'  printf "image-bytes"',
						'  exit 0',
						'fi',
						'if [ "$1" = "image" ] && [ "$2" = "rm" ]; then',
						'  exit 0',
						'fi',
						'exit 0',
						'',
					].join('\n'),
				);
				chmodSync(bin, 0o755);

				yield* Stream.runCollect(
					saveImage('devstack-snapshot:owned-temp', { removeAfterSave: true }),
				).pipe(Effect.provide(fakeDockerLayer(bin)));

				expect(readFileSync(log, 'utf8')).toBe(
					'save devstack-snapshot:owned-temp\nimage rm devstack-snapshot:owned-temp\n',
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('fails when docker save exits non-zero after producing no stdout', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-save-test-'));
			try {
				const bin = join(root, 'docker');
				writeFileSync(
					bin,
					[
						'#!/bin/sh',
						'if [ "$1" = "save" ]; then',
						'  echo "No such image: missing:tag" >&2',
						'  exit 1',
						'fi',
						'exit 0',
						'',
					].join('\n'),
				);
				chmodSync(bin, 0o755);

				const exit = yield* Stream.runCollect(saveImage('missing:tag')).pipe(
					Effect.provide(fakeDockerLayer(bin)),
					Effect.exit,
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value._tag).toBe('ImageSaveFailed');
					if (error.value._tag === 'ImageSaveFailed') {
						expect(error.value.detail).toContain('docker save exited 1');
						expect(error.value.detail).toContain('No such image');
					}
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});

describe('tagImage', () => {
	it.effect('does not remove snapshot-looking source tags unless cleanup is explicit', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-tag-test-'));
			try {
				const bin = join(root, 'docker');
				const log = join(root, 'docker.log');
				writeFileSync(
					bin,
					[
						'#!/bin/sh',
						`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
						'if [ "$1" = "tag" ]; then',
						'  exit 0',
						'fi',
						'if [ "$1" = "image" ] && [ "$2" = "rm" ]; then',
						'  exit 0',
						'fi',
						'exit 0',
						'',
					].join('\n'),
				);
				chmodSync(bin, 0o755);

				yield* tagImage('devstack-snapshot:user-tag', 'target:latest').pipe(
					Effect.provide(fakeDockerLayer(bin)),
				);

				expect(readFileSync(log, 'utf8')).toBe('tag devstack-snapshot:user-tag target:latest\n');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('removes a snapshot temp source tag when cleanup is explicit', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-tag-test-'));
			try {
				const bin = join(root, 'docker');
				const log = join(root, 'docker.log');
				writeFileSync(
					bin,
					[
						'#!/bin/sh',
						`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
						'if [ "$1" = "tag" ]; then',
						'  exit 0',
						'fi',
						'if [ "$1" = "image" ] && [ "$2" = "rm" ]; then',
						'  exit 0',
						'fi',
						'exit 0',
						'',
					].join('\n'),
				);
				chmodSync(bin, 0o755);

				yield* tagImage('devstack-snapshot:owned-temp', 'target:latest', {
					removeSourceAfterTag: true,
				}).pipe(Effect.provide(fakeDockerLayer(bin)));

				expect(readFileSync(log, 'utf8')).toBe(
					'tag devstack-snapshot:owned-temp target:latest\nimage rm devstack-snapshot:owned-temp\n',
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
