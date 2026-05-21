import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import {
	DockerSpawner,
	dockerRunOneShot,
	layerDockerHost,
	type DockerHost,
} from '../../../src/runtime/docker/index.ts';

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

const createFakeDocker = (root: string): { readonly bin: string; readonly log: string } => {
	const bin = join(root, 'docker');
	const log = join(root, 'docker.log');
	writeFileSync(
		bin,
		['#!/bin/sh', `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`, 'exit 0', ''].join('\n'),
	);
	chmodSync(bin, 0o755);
	return { bin, log };
};

describe('dockerRunOneShot', () => {
	it.effect('passes the optional user through to docker run', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-one-shot-test-'));
			try {
				const { bin, log } = createFakeDocker(root);
				yield* Effect.scoped(
					dockerRunOneShot({
						name: 'devstack-test-oneshot',
						image: 'alpine:3.20',
						entrypoint: 'sh',
						user: '1234:5678',
						argv: ['-c', 'id'],
					}),
				).pipe(Effect.provide(fakeDockerLayer(bin)));

				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines[0]).toBe(
					'run --rm --name devstack-test-oneshot --entrypoint sh --user 1234:5678 alpine:3.20 -c id',
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
