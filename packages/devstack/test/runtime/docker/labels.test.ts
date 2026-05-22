import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import type { ContainerLabelTuple } from '../../../src/contracts/snapshotable.ts';
import {
	DockerSpawner,
	ensureNetwork,
	layerDockerHost,
	type DockerHost,
} from '../../../src/runtime/docker/index.ts';
import {
	COMPOSE_UI_VERSION,
	ComposeLabelKey,
	LabelKey,
	composeProjectId,
	composeServiceId,
	renderContainerLabels,
	renderNetworkLabels,
	renderVolumeLabels,
} from '../../../src/runtime/docker/labels.ts';

const tuple: ContainerLabelTuple = {
	app: 'token-studio',
	stack: 'main',
	plugin: 'postgres',
	role: 'db',
};

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
		[
			'#!/bin/sh',
			`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
			'if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then',
			'  echo "No such network" >&2',
			'  exit 1',
			'fi',
			'if [ "$1" = "network" ] && [ "$2" = "create" ]; then',
			'  printf "network-id\\n"',
			'  exit 0',
			'fi',
			'exit 1',
			'',
		].join('\n'),
	);
	chmodSync(bin, 0o755);
	return { bin, log };
};

describe('Docker Desktop grouping labels', () => {
	it('renders Compose-style labels alongside devstack ownership labels for containers', () => {
		expect(renderContainerLabels(tuple, 42)).toEqual([
			`${LabelKey.managed}=true`,
			`${LabelKey.app}=token-studio`,
			`${LabelKey.stack}=main`,
			`${LabelKey.plugin}=postgres`,
			`${LabelKey.role}=db`,
			`${LabelKey.cycle}=42`,
			`${ComposeLabelKey.project}=token-studio-main`,
			`${ComposeLabelKey.service}=postgres.db`,
			`${ComposeLabelKey.containerNumber}=1`,
			`${ComposeLabelKey.version}=${COMPOSE_UI_VERSION}`,
			`${ComposeLabelKey.oneoff}=False`,
		]);
	});

	it('renders optional container config hash labels', () => {
		expect(renderContainerLabels(tuple, 42, { [LabelKey.configHash]: 'abc123' })).toContain(
			`${LabelKey.configHash}=abc123`,
		);
	});

	it('renders Compose-style labels for managed networks and volumes', () => {
		expect(renderNetworkLabels('devstack-token-studio-main', tuple.app, tuple.stack)).toEqual([
			`${LabelKey.managed}=true`,
			`${LabelKey.networkMarker}=true`,
			`${LabelKey.app}=token-studio`,
			`${LabelKey.stack}=main`,
			`${ComposeLabelKey.project}=token-studio-main`,
			`${ComposeLabelKey.network}=devstack-token-studio-main`,
			`${ComposeLabelKey.version}=${COMPOSE_UI_VERSION}`,
		]);

		expect(renderVolumeLabels('devstack-token-studio-main-postgres-db', tuple)).toEqual([
			`${LabelKey.managed}=true`,
			`${LabelKey.volumeMarker}=true`,
			`${LabelKey.app}=token-studio`,
			`${LabelKey.stack}=main`,
			`${LabelKey.plugin}=postgres`,
			`${LabelKey.role}=db`,
			`${ComposeLabelKey.project}=token-studio-main`,
			`${ComposeLabelKey.volume}=devstack-token-studio-main-postgres-db`,
			`${ComposeLabelKey.version}=${COMPOSE_UI_VERSION}`,
		]);
	});

	it('sanitizes Compose project and service ids without changing devstack labels', () => {
		const dirtyTuple: ContainerLabelTuple = {
			app: 'My App',
			stack: 'local/test',
			plugin: 'seal:key-server',
			role: 'key server',
		};
		expect(composeProjectId(dirtyTuple.app, dirtyTuple.stack)).toBe('My-App-local-test');
		expect(composeServiceId(dirtyTuple)).toBe('seal-key-server.key-server');
		expect(renderContainerLabels(dirtyTuple, 1)).toContain(`${LabelKey.app}=My App`);
	});

	it('can intentionally omit Compose labels for router-profile networks', () => {
		expect(
			renderNetworkLabels('devstack-router-profile', 'devstack-router', 'profile', {
				composeUi: false,
			}),
		).toEqual([
			`${LabelKey.managed}=true`,
			`${LabelKey.networkMarker}=true`,
			`${LabelKey.app}=devstack-router`,
			`${LabelKey.stack}=profile`,
		]);
	});

	it.effect('passes Compose labels to docker network create for managed app networks', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-labels-test-'));
			try {
				const { bin, log } = createFakeDocker(root);
				const networkId = yield* ensureNetwork('devstack-token-studio-main', {
					app: 'token-studio',
					stack: 'main',
				}).pipe(Effect.provide(fakeDockerLayer(bin)));
				const lines = readFileSync(log, 'utf8').trim().split('\n');

				expect(networkId).toBe('network-id');
				expect(lines).toContain(
					[
						'network create',
						'--label devstack.managed=true',
						'--label devstack.network=true',
						'--label devstack.app=token-studio',
						'--label devstack.stack=main',
						'--label com.docker.compose.project=token-studio-main',
						'--label com.docker.compose.network=devstack-token-studio-main',
						'--label com.docker.compose.version=2.0.0',
						'devstack-token-studio-main',
					].join(' '),
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
