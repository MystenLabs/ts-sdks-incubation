import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Stream } from 'effect';

import type { ContainerRuntime } from '../../../src/contracts/container-runtime.ts';
import type {
	ArtifactPublisher,
	ArtifactSpec,
} from '../../../src/primitives/artifact-publisher.ts';
import { chainId } from '../../../src/substrate/brand.ts';
import { MASTER_KEY_ENVFILE_BASENAME } from '../../../src/plugins/seal/keygen.ts';
import {
	bootLocalKeygen,
	type LocalKeygenDeps,
} from '../../../src/plugins/seal/mode/local-keygen.ts';
import {
	SEAL_KEY_SERVER_NAMESPACE,
	SEAL_PACKAGE_NAMESPACE,
} from '../../../src/plugins/seal/deploy.ts';
import type { AccountValue } from '../../../src/plugins/account/service.ts';

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'seal-local-keygen-test-'));

const writeMovePackage = (root: string): string => {
	const sourcePath = join(root, 'seal-move');
	mkdirSync(join(sourcePath, 'sources'), { recursive: true });
	writeFileSync(join(sourcePath, 'Move.toml'), '[package]\nname = "seal"\n');
	writeFileSync(join(sourcePath, 'sources', 'seal.move'), 'module seal::seal {}\n');
	return sourcePath;
};

const signer: AccountValue = {
	name: 'publisher',
	address: '0xpublisher',
	scheme: 'ed25519',
	source: 'real',
	publicKey: new Uint8Array(),
	funding: { requested: [], applied: [] },
	signAndExecute: () => Effect.die('signAndExecute not used'),
	signTransaction: () => Effect.die('signTransaction not used'),
	signPersonalMessage: () => Effect.die('signPersonalMessage not used'),
	withTransactionSigner: () => Effect.die('withTransactionSigner not used'),
};

const runtimeStub = (events: string[]): ContainerRuntime => ({
	ensureImage: () => Effect.die('ensureImage not used'),
	ensureNetwork: () => Effect.die('ensureNetwork not used'),
	ensureContainer: (spec) =>
		Effect.sync(() => {
			events.push(`ensure:${spec.configHash ?? ''}`);
			return {
				id: 'container-id',
				name: spec.name,
				labels: spec.labels,
				imageName: spec.image.tag ?? spec.image.digest,
				status: 'running' as const,
				ips: [],
			};
		}),
	exec: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
	runOneShot: () =>
		Effect.sync(() => {
			events.push('keygen');
			return {
				exitCode: 0,
				stdout:
					// 64-char hex (BLS12-381 master key) and 192-char hex
					// (BLS12-381 public key) — matches the bounded patterns in
					// `parseSealKeygenOutput`.
					`Master key: ${'1'.repeat(64)}\nPublic key: ${'3'.repeat(192)}\n`,
				stderr: '',
			};
		}),
	inspectByLabels: () => Effect.die('inspectByLabels not used'),
	followLogs: () => Stream.empty,
	pause: () => Effect.die('pause not used'),
	pauseAndCommit: () => Effect.die('pauseAndCommit not used'),
	saveImage: () => Stream.empty,
	saveImages: () => Stream.empty,
	loadImage: () => Effect.die('loadImage not used'),
	tagImage: () => Effect.die('tagImage not used'),
	removeImage: () => Effect.die('removeImage not used'),
	unpause: () => Effect.die('unpause not used'),
	stop: () => Effect.die('stop not used'),
	sweepOrphans: () => Effect.die('sweepOrphans not used'),
	removeManagedContainers: () => Effect.die('removeManagedContainers not used'),
	removeManagedImages: () => Effect.die('removeManagedImages not used'),
	removeManagedNetworks: () => Effect.die('removeManagedNetworks not used'),
	removeManagedVolumes: () => Effect.die('removeManagedVolumes not used'),
});

const publisherStub = (events: string[]): ArtifactPublisher => ({
	publish: <Produced, Verified>(spec: ArtifactSpec<Produced, Verified>) =>
		Effect.sync((): Produced => {
			events.push(`publish:${spec.namespace}`);
			if (spec.namespace === SEAL_PACKAGE_NAMESPACE) {
				return { packageId: '0xnewpackage' } as Produced;
			}
			if (spec.namespace === SEAL_KEY_SERVER_NAMESPACE) {
				return { objectId: '0xnewkeyserver' } as Produced;
			}
			throw new Error(`unexpected namespace ${spec.namespace}`);
		}),
});

const nodePlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const deps = (root: string, events: string[]): LocalKeygenDeps => ({
	runtime: runtimeStub(events),
	publisher: publisherStub(events),
	signer,
	sdk: { client: {} as never },
	chainProbe: {
		get: () => Effect.succeed(null),
	},
	chain: chainId('sui:local'),
	servicePath: join(root, 'seal', 'seal'),
	containerName: 'devstack-app-main-seal-seal-key-server',
	labels: { app: 'app', stack: 'main', plugin: 'seal', role: 'key-server' },
	suiNetworkName: 'sui-net',
	suiRpcUrlInNetwork: 'http://sui:9000',
	routedHostname: 'key-server.app.main.localhost',
	routedUrl: 'http://key-server.app.main.localhost:2024',
});

describe('seal local-keygen persistence', () => {
	it.effect('revalidates persisted key material through normal artifact publishing', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			const events: string[] = [];
			const previousOverride = process.env.SEAL_CARGO_IMAGE_OVERRIDE;
			try {
				process.env.SEAL_CARGO_IMAGE_OVERRIDE = 'seal-test:latest';
				const servicePath = join(root, 'seal', 'seal');
				mkdirSync(servicePath, { recursive: true });
				writeFileSync(join(servicePath, MASTER_KEY_ENVFILE_BASENAME), 'MASTER_KEY=aaaa\n');
				writeFileSync(
					join(servicePath, 'local-keygen-state.v1.json'),
					JSON.stringify({ version: 1, publicKey: 'bbbb' }),
				);

				const result = yield* Effect.scoped(
					bootLocalKeygen(deps(root, events), {
						name: 'seal',
						version: 'seal-v0.test',
						readyTimeoutMs: 10,
						keyServerName: 'devstack-local',
						movePackagePath: writeMovePackage(root),
					}),
				).pipe(Effect.provide(nodePlatformLayer));

				expect(result.keyServer.objectId).toBe('0xnewkeyserver');
				expect(result.packageId).toBe('0xnewpackage');
				expect(events).not.toContain('keygen');
				expect(events).toContain(`publish:${SEAL_PACKAGE_NAMESPACE}`);
				expect(events).toContain(`publish:${SEAL_KEY_SERVER_NAMESPACE}`);
				expect(readFileSync(join(servicePath, 'key-server-config.yaml'), 'utf8')).toContain(
					'0xnewkeyserver',
				);
			} finally {
				if (previousOverride === undefined) {
					delete process.env.SEAL_CARGO_IMAGE_OVERRIDE;
				} else {
					process.env.SEAL_CARGO_IMAGE_OVERRIDE = previousOverride;
				}
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('treats old persisted state without metadata as a miss', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			const events: string[] = [];
			const previousOverride = process.env.SEAL_CARGO_IMAGE_OVERRIDE;
			try {
				process.env.SEAL_CARGO_IMAGE_OVERRIDE = 'seal-test:latest';
				const servicePath = join(root, 'seal', 'seal');
				mkdirSync(servicePath, { recursive: true });
				writeFileSync(join(servicePath, MASTER_KEY_ENVFILE_BASENAME), 'MASTER_KEY=aaaa\n');

				yield* Effect.scoped(
					bootLocalKeygen(deps(root, events), {
						name: 'seal',
						version: 'seal-v0.test',
						readyTimeoutMs: 10,
						keyServerName: 'devstack-local',
						movePackagePath: writeMovePackage(root),
					}),
				).pipe(Effect.provide(nodePlatformLayer));

				expect(events).toContain('keygen');
				expect(existsSync(join(servicePath, 'local-keygen-state.v1.json'))).toBe(true);
			} finally {
				if (previousOverride === undefined) {
					delete process.env.SEAL_CARGO_IMAGE_OVERRIDE;
				} else {
					process.env.SEAL_CARGO_IMAGE_OVERRIDE = previousOverride;
				}
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
