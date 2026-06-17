import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Layer, Option } from 'effect';

import type { ContainerRuntime } from '../../../src/contracts/container-runtime.ts';
import { makeContainerRuntimeStub } from '../../helpers/container-runtime-stub.ts';
import type {
	ArtifactPublisher,
	ArtifactSpec,
} from '../../../src/primitives/artifact-publisher.ts';
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

const runtimeStub = (events: string[]): ContainerRuntime =>
	makeContainerRuntimeStub({
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
	chainId: 'sui:localnet',
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
				// Width-valid BLS12-381 fixtures: master = 64 hex chars
				// (32 bytes), public = 192 hex chars (96-byte G2). The
				// boot pipeline now enforces these widths as a
				// stricter-than-Schema decode (see
				// `validatePersistedKeyMaterialShape`).
				const masterHex = 'a'.repeat(64);
				const publicHex = 'b'.repeat(192);
				writeFileSync(join(servicePath, MASTER_KEY_ENVFILE_BASENAME), `MASTER_KEY=${masterHex}\n`);
				writeFileSync(
					join(servicePath, 'local-keygen-state.v1.json'),
					JSON.stringify({ version: 1, publicKey: publicHex }),
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

	// Bug 5 (review fix phase 22e): a corrupt persisted state whose
	// publicKey decodes as a string but has the wrong width would
	// previously be silently reused on boot. The ArtifactPublisher
	// cache might happily return a stale on-chain KeyServer registered
	// with a public key that doesn't match the master key the daemon
	// loads — a silent divergence with no operator-visible signal. The
	// fix is a width invariant on the persisted state (192 hex chars
	// for the BLS12-381 G2 publicKey, 64 hex chars for the master
	// key). Corruption → typed SealError({phase: 'config-render'})
	// with operator-facing remediation guidance.
	it.effect('refuses to boot with a wrong-width persisted publicKey', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			const events: string[] = [];
			const previousOverride = process.env.SEAL_CARGO_IMAGE_OVERRIDE;
			try {
				process.env.SEAL_CARGO_IMAGE_OVERRIDE = 'seal-test:latest';
				const servicePath = join(root, 'seal', 'seal');
				mkdirSync(servicePath, { recursive: true });
				// Width-VALID master key (64 hex chars) ...
				writeFileSync(
					join(servicePath, MASTER_KEY_ENVFILE_BASENAME),
					`MASTER_KEY=${'a'.repeat(64)}\n`,
				);
				// ... but a width-INVALID publicKey (8 chars, far from the
				// 192-char BLS12-381 G2 width). The Schema-level decode
				// alone accepts any string; the new defensive width
				// invariant catches the divergence and refuses to boot.
				writeFileSync(
					join(servicePath, 'local-keygen-state.v1.json'),
					JSON.stringify({ version: 1, publicKey: 'deadbeef' }),
				);

				const exit = yield* Effect.scoped(
					bootLocalKeygen(deps(root, events), {
						name: 'seal',
						version: 'seal-v0.test',
						readyTimeoutMs: 10,
						keyServerName: 'devstack-local',
						movePackagePath: writeMovePackage(root),
					}),
				).pipe(Effect.provide(nodePlatformLayer), Effect.exit);

				expect(Exit.isFailure(exit)).toBe(true);
				const errOpt = Exit.findErrorOption(exit);
				expect(Option.isSome(errOpt)).toBe(true);
				if (Option.isSome(errOpt)) {
					const err = errOpt.value;
					expect(err._tag).toBe('SealError');
					if (err._tag === 'SealError') {
						expect(err.phase).toBe('config-render');
						expect(err.message).toMatch(/publicKey/);
						expect(err.message).toMatch(/192-char/);
					}
				}
				// CRITICAL: no on-chain artifacts should have been
				// published. The validator runs before
				// `ensureLocalKeygenArtifacts`, so the cache-reuse path
				// is short-circuited before touching the publisher.
				expect(events).not.toContain(`publish:${SEAL_PACKAGE_NAMESPACE}`);
				expect(events).not.toContain(`publish:${SEAL_KEY_SERVER_NAMESPACE}`);
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

	it.effect('refuses to boot with a wrong-width persisted master key', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			const events: string[] = [];
			const previousOverride = process.env.SEAL_CARGO_IMAGE_OVERRIDE;
			try {
				process.env.SEAL_CARGO_IMAGE_OVERRIDE = 'seal-test:latest';
				const servicePath = join(root, 'seal', 'seal');
				mkdirSync(servicePath, { recursive: true });
				// Width-INVALID master key (only 4 hex chars). The env-file
				// parser accepts any 1+ hex chars, so the file decodes
				// successfully but the width invariant rejects it.
				writeFileSync(join(servicePath, MASTER_KEY_ENVFILE_BASENAME), 'MASTER_KEY=abcd\n');
				// Width-valid publicKey ...
				writeFileSync(
					join(servicePath, 'local-keygen-state.v1.json'),
					JSON.stringify({ version: 1, publicKey: 'b'.repeat(192) }),
				);

				const exit = yield* Effect.scoped(
					bootLocalKeygen(deps(root, events), {
						name: 'seal',
						version: 'seal-v0.test',
						readyTimeoutMs: 10,
						keyServerName: 'devstack-local',
						movePackagePath: writeMovePackage(root),
					}),
				).pipe(Effect.provide(nodePlatformLayer), Effect.exit);

				expect(Exit.isFailure(exit)).toBe(true);
				const errOpt = Exit.findErrorOption(exit);
				expect(Option.isSome(errOpt)).toBe(true);
				if (Option.isSome(errOpt)) {
					const err = errOpt.value;
					expect(err._tag).toBe('SealError');
					if (err._tag === 'SealError') {
						expect(err.phase).toBe('config-render');
						expect(err.message).toMatch(/master key/);
						expect(err.message).toMatch(/64-char/);
					}
				}
				expect(events).not.toContain(`publish:${SEAL_PACKAGE_NAMESPACE}`);
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
