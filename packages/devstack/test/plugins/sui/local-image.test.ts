import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from '@effect/vitest';

import type { ContainerBuildContext, ImageRef } from '../../../src/contracts/container-runtime.ts';
import { resolveImage } from '../../../src/plugins/sui/mode/local.ts';
import { SUI_TOOLS_REF_ENV_VAR, suiToolsImage } from '../../../src/plugins/sui/move/index.ts';
import { appName, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import { makeContainerRuntimeStub } from '../../helpers/container-runtime-stub.ts';

const TEST_IDENTITY: Identity = {
	app: appName('test-app'),
	stack: stackName('test-stack'),
	network: 'localnet',
};

// Per-arch sui-tools pin (the tag is not a multi-arch manifest list).
const EXPECTED_SUI_TOOLS_IMAGE = `mysten/sui-tools:eced02468444d429a4e9a2b9622b7bd30a1710d4${
	process.arch === 'arm64' ? '-arm64' : ''
}`;

const OWNER = { app: 'test-app', stack: 'test-stack', plugin: 'sui', role: 'validator' };

const recordingBuilds = () => {
	const builds: Array<ContainerBuildContext> = [];
	const runtime = makeContainerRuntimeStub({
		ensureImage: (build) =>
			Effect.sync(() => {
				builds.push(build);
				return { digest: 'sha256:built', tag: 'built' };
			}),
	});
	return { runtime, builds };
};

// The resolver reads DEVSTACK_SUI_TOOLS_REF; a developer who exported it
// (the documented CI use) must not see the bundled-pin assertions fail.
beforeEach(() => {
	vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, '');
});
afterEach(() => {
	vi.unstubAllEnvs();
});

describe('Sui local image resolution', () => {
	it.effect('uses the runtime pullImage path for image.pull', () =>
		Effect.gen(function* () {
			const calls: string[] = [];
			const ref: ImageRef = { digest: 'sha256:pulled', tag: 'mysten/sui:devnet' };
			const runtime = makeContainerRuntimeStub({
				pullImage: (image) =>
					Effect.sync(() => {
						calls.push(image);
						return ref;
					}),
			});

			const resolved = yield* resolveImage(runtime, TEST_IDENTITY, {
				mode: 'local',
				image: { pull: 'mysten/sui:devnet' },
			});

			expect(calls).toEqual(['mysten/sui:devnet']);
			expect(resolved).toEqual(ref);
		}),
	);

	it.effect('uses ensureImage for explicit build contexts and stamps owner labels', () =>
		Effect.gen(function* () {
			const { runtime, builds } = recordingBuilds();

			const resolved = yield* resolveImage(runtime, TEST_IDENTITY, {
				mode: 'local',
				image: { build: { context: '/tmp/sui', dockerfile: 'Dockerfile.sui' } },
			});

			expect(builds).toEqual([
				{
					contextPath: '/tmp/sui',
					dockerfile: 'Dockerfile.sui',
					buildArgs: { SUI_TOOLS_IMAGE: EXPECTED_SUI_TOOLS_IMAGE },
					owner: OWNER,
				},
			]);
			expect(resolved.digest).toBe('sha256:built');
		}),
	);

	it.effect(
		'fingerprints only Sui image inputs for the vendored image context and stamps owner',
		() =>
			Effect.gen(function* () {
				const { runtime, builds } = recordingBuilds();

				yield* resolveImage(runtime, TEST_IDENTITY, { mode: 'local' });

				expect(builds).toEqual([
					expect.objectContaining({
						dockerfile: 'sui/Dockerfile',
						fingerprintPaths: [
							'sui/Dockerfile',
							'sui/entrypoint.sh',
							'sui-fork/entrypoint.sh',
							'_shared/signal-forward.sh',
						],
						buildArgs: { SUI_TOOLS_IMAGE: EXPECTED_SUI_TOOLS_IMAGE },
						owner: OWNER,
					}),
				]);
			}),
	);

	it.effect('bases the image on the configured suiToolsRef instead of the bundled pin', () =>
		Effect.gen(function* () {
			const { runtime, builds } = recordingBuilds();

			yield* resolveImage(runtime, TEST_IDENTITY, {
				mode: 'local',
				suiToolsRef: 'testnet-v1.80.0',
			});

			expect(builds).toEqual([
				expect.objectContaining({
					dockerfile: 'sui/Dockerfile',
					buildArgs: { SUI_TOOLS_IMAGE: suiToolsImage('testnet-v1.80.0') },
				}),
			]);
		}),
	);

	it.effect('passes the suiToolsRef through to a caller-supplied build context', () =>
		Effect.gen(function* () {
			const { runtime, builds } = recordingBuilds();

			yield* resolveImage(runtime, TEST_IDENTITY, {
				mode: 'local',
				suiToolsRef: 'abc123',
				image: { build: { context: '/tmp/sui' } },
			});

			expect(builds).toEqual([
				expect.objectContaining({
					contextPath: '/tmp/sui',
					buildArgs: { SUI_TOOLS_IMAGE: suiToolsImage('abc123') },
				}),
			]);
		}),
	);

	it.effect('reads DEVSTACK_SUI_TOOLS_REF when the config names no ref, and lets config win', () =>
		Effect.gen(function* () {
			vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env');
			const { runtime, builds } = recordingBuilds();

			yield* resolveImage(runtime, TEST_IDENTITY, { mode: 'local' });
			yield* resolveImage(runtime, TEST_IDENTITY, { mode: 'local', suiToolsRef: 'from-config' });

			expect(builds.map((build) => build.buildArgs?.SUI_TOOLS_IMAGE)).toEqual([
				suiToolsImage('from-env'),
				suiToolsImage('from-config'),
			]);
		}),
	);

	it.effect('rejects suiToolsRef alongside image.pull, as the shared option doc promises', () =>
		Effect.gen(function* () {
			const runtime = makeContainerRuntimeStub({});

			const error = yield* resolveImage(runtime, TEST_IDENTITY, {
				mode: 'local',
				suiToolsRef: 'r',
				image: { pull: 'mysten/sui:devnet' },
			}).pipe(Effect.flip);

			expect(error._tag).toBe('SuiConfigError');
			expect(error.message).toContain('image.pull');
		}),
	);
});
