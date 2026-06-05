// Verifies `docker build` is invoked with `--label key=value` flags
// when `BuildOptions.labels` is set. Without this, devstack-built
// images land unlabelled and are invisible to label-driven prune.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import { DockerHost, DockerSpawner, layerDockerHost } from '../../../src/runtime/docker/client.ts';
import { build, pull } from '../../../src/runtime/docker/image.ts';
import {
	RuntimeInvalidationTrackerService,
	layerRuntimeInvalidationTracker,
} from '../../../src/substrate/runtime/invalidation-tracker.ts';

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

const writeShim = (path: string, log: string): void => {
	// Shim writes its argv to $log and emits a stub image id on
	// `image inspect`. `build()` invokes `docker build …` first
	// and then `docker image inspect --format {{.Id}} <tag>` via
	// inspectDigest, so both need to succeed.
	writeFileSync(
		path,
		[
			'#!/bin/sh',
			`printf '%s\\0' "$@" >> ${JSON.stringify(log)}`,
			`printf '\\n--\\n' >> ${JSON.stringify(log)}`,
			'if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then',
			'  printf "sha256:deadbeef"',
			'  exit 0',
			'fi',
			'exit 0',
			'',
		].join('\n'),
	);
	chmodSync(path, 0o755);
};

const writeEnvShim = (path: string, envLog: string): void => {
	writeFileSync(
		path,
		[
			'#!/bin/sh',
			`printf '%s' "\${DOCKER_CONFIG:-}" > ${JSON.stringify(envLog)}`,
			'if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then',
			'  printf "sha256:deadbeef"',
			'  exit 0',
			'fi',
			'exit 0',
			'',
		].join('\n'),
	);
	chmodSync(path, 0o755);
};

const readArgvBatches = (log: string): ReadonlyArray<ReadonlyArray<string>> => {
	const raw = readFileSync(log, 'utf8');
	return raw
		.split('\n--\n')
		.filter((batch) => batch.length > 0)
		.map((batch) => batch.split('\0').filter((arg) => arg.length > 0));
};

describe('build — image label stamping', () => {
	it.effect('runs docker with a credential-helper-free DOCKER_CONFIG', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-build-config-'));
			const previousDockerConfig = process.env.DOCKER_CONFIG;
			try {
				const sourceConfig = join(root, 'source-docker-config');
				mkdirSync(sourceConfig);
				writeFileSync(
					join(sourceConfig, 'config.json'),
					JSON.stringify({
						auths: { 'registry.example.com': { auth: 'static-token' } },
						credsStore: 'desktop',
						credHelpers: { 'registry-1.docker.io': 'desktop' },
						currentContext: 'desktop-linux',
						proxies: { default: { httpProxy: 'http://proxy.local:8080' } },
					}),
				);
				process.env.DOCKER_CONFIG = sourceConfig;
				const bin = join(root, 'docker');
				const envLog = join(root, 'docker-config.txt');
				writeEnvShim(bin, envLog);

				yield* build({
					tag: 'devstack-build:abc123',
					contextPath: '/tmp/ctx',
				}).pipe(Effect.provide(fakeDockerLayer(bin)));

				const dockerConfig = readFileSync(envLog, 'utf8');
				expect(dockerConfig).not.toBe('');
				const parsed = JSON.parse(readFileSync(join(dockerConfig, 'config.json'), 'utf8')) as {
					readonly auths?: unknown;
					readonly credsStore?: unknown;
					readonly credHelpers?: unknown;
					readonly currentContext?: unknown;
					readonly proxies?: unknown;
				};
				expect(parsed.auths).toEqual({ 'registry.example.com': { auth: 'static-token' } });
				expect(parsed.credsStore).toBeUndefined();
				expect(parsed.credHelpers).toBeUndefined();
				expect(parsed.currentContext).toBe('desktop-linux');
				expect(parsed.proxies).toEqual({
					default: { httpProxy: 'http://proxy.local:8080' },
				});
			} finally {
				if (previousDockerConfig === undefined) {
					delete process.env.DOCKER_CONFIG;
				} else {
					process.env.DOCKER_CONFIG = previousDockerConfig;
				}
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('records runtime invalidation when an image is pulled', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-pull-invalidation-'));
			try {
				const bin = join(root, 'docker');
				const log = join(root, 'docker.log');
				writeShim(bin, log);

				const digest = yield* pull('registry.example.com/devstack/image:latest').pipe(
					Effect.provide(fakeDockerLayer(bin)),
				);
				expect(digest).toBe('sha256:deadbeef');

				const tracker = yield* RuntimeInvalidationTrackerService;
				const reasons = yield* tracker.reasons;
				expect(reasons).toEqual([
					{
						kind: 'docker-image-pulled',
						ref: 'registry.example.com/devstack/image:latest',
						digest: 'sha256:deadbeef',
					},
				]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(layerRuntimeInvalidationTracker)),
	);

	it.effect('emits --label key=value flags before contextPath', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-build-labels-'));
			try {
				const bin = join(root, 'docker');
				const log = join(root, 'docker.log');
				writeShim(bin, log);

				yield* build({
					tag: 'devstack-build:abc123',
					contextPath: '/tmp/ctx',
					dockerfile: 'Dockerfile',
					labels: {
						'devstack.managed': 'true',
						'devstack.app': 'my-app',
						'devstack.stack': 'main',
					},
				}).pipe(Effect.provide(fakeDockerLayer(bin)));

				const batches = readArgvBatches(log);
				expect(batches.length).toBeGreaterThanOrEqual(1);
				const buildArgv = batches[0]!;
				// docker CLI subcommand + args. Our wrapper prepends
				// `build` as the subcommand.
				expect(buildArgv[0]).toBe('build');
				const labelFlags: Array<string> = [];
				for (let i = 1; i < buildArgv.length; i += 1) {
					if (buildArgv[i] === '--label') {
						labelFlags.push(buildArgv[i + 1] ?? '');
					}
				}
				expect(labelFlags).toEqual(
					expect.arrayContaining([
						'devstack.managed=true',
						'devstack.app=my-app',
						'devstack.stack=main',
					]),
				);
				// contextPath must be the last positional arg.
				expect(buildArgv[buildArgv.length - 1]).toBe('/tmp/ctx');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('omits --label flags when labels is unset', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-build-labels-empty-'));
			try {
				const bin = join(root, 'docker');
				const log = join(root, 'docker.log');
				writeShim(bin, log);

				yield* build({
					tag: 'devstack-build:abc123',
					contextPath: '/tmp/ctx',
				}).pipe(Effect.provide(fakeDockerLayer(bin)));

				const batches = readArgvBatches(log);
				const buildArgv = batches[0]!;
				expect(buildArgv).not.toContain('--label');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
