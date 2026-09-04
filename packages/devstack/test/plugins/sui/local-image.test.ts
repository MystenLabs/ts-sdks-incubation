import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import type { ImageRef } from '../../../src/contracts/container-runtime.ts';
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

const unusedRuntime = makeContainerRuntimeStub;

describe('Sui local image resolution', () => {
	it('uses the runtime pullImage path for image.pull', async () => {
		const calls: string[] = [];
		const ref: ImageRef = { digest: 'sha256:pulled', tag: 'mysten/sui:devnet' };
		const runtime = unusedRuntime({
			pullImage: (image) =>
				Effect.sync(() => {
					calls.push(image);
					return ref;
				}),
		});

		const resolved = await Effect.runPromise(
			resolveImage(runtime, TEST_IDENTITY, {
				mode: 'local',
				image: { pull: 'mysten/sui:devnet' },
			}),
		);

		expect(calls).toEqual(['mysten/sui:devnet']);
		expect(resolved).toEqual(ref);
	});

	it('uses ensureImage for explicit build contexts and stamps owner labels', async () => {
		const calls: unknown[] = [];
		const runtime = unusedRuntime({
			ensureImage: (build) =>
				Effect.sync(() => {
					calls.push(build);
					return { digest: 'sha256:built', tag: 'built' };
				}),
		});

		const resolved = await Effect.runPromise(
			resolveImage(runtime, TEST_IDENTITY, {
				mode: 'local',
				image: { build: { context: '/tmp/sui', dockerfile: 'Dockerfile.sui' } },
			}),
		);

		expect(calls).toEqual([
			{
				contextPath: '/tmp/sui',
				dockerfile: 'Dockerfile.sui',
				buildArgs: { SUI_TOOLS_IMAGE: EXPECTED_SUI_TOOLS_IMAGE },
				owner: { app: 'test-app', stack: 'test-stack', plugin: 'sui', role: 'validator' },
			},
		]);
		expect(resolved.digest).toBe('sha256:built');
	});

	it('fingerprints only Sui image inputs for the vendored image context and stamps owner', async () => {
		const calls: unknown[] = [];
		const runtime = unusedRuntime({
			ensureImage: (build) =>
				Effect.sync(() => {
					calls.push(build);
					return { digest: 'sha256:built', tag: 'built' };
				}),
		});

		await Effect.runPromise(resolveImage(runtime, TEST_IDENTITY, { mode: 'local' }));

		expect(calls).toEqual([
			expect.objectContaining({
				dockerfile: 'sui/Dockerfile',
				fingerprintPaths: [
					'sui/Dockerfile',
					'sui/entrypoint.sh',
					'sui-fork/entrypoint.sh',
					'_shared/signal-forward.sh',
				],
				buildArgs: { SUI_TOOLS_IMAGE: EXPECTED_SUI_TOOLS_IMAGE },
				owner: { app: 'test-app', stack: 'test-stack', plugin: 'sui', role: 'validator' },
			}),
		]);
	});

	it('bases the image on the configured suiToolsRef instead of the bundled pin', async () => {
		const calls: unknown[] = [];
		const runtime = unusedRuntime({
			ensureImage: (build) =>
				Effect.sync(() => {
					calls.push(build);
					return { digest: 'sha256:built', tag: 'built' };
				}),
		});

		await Effect.runPromise(
			resolveImage(runtime, TEST_IDENTITY, { mode: 'local', suiToolsRef: 'testnet-v1.80.0' }),
		);

		expect(calls).toEqual([
			expect.objectContaining({
				dockerfile: 'sui/Dockerfile',
				buildArgs: { SUI_TOOLS_IMAGE: suiToolsImage('testnet-v1.80.0') },
			}),
		]);
	});

	it('passes the suiToolsRef through to a caller-supplied build context', async () => {
		const calls: unknown[] = [];
		const runtime = unusedRuntime({
			ensureImage: (build) =>
				Effect.sync(() => {
					calls.push(build);
					return { digest: 'sha256:built', tag: 'built' };
				}),
		});

		await Effect.runPromise(
			resolveImage(runtime, TEST_IDENTITY, {
				mode: 'local',
				suiToolsRef: 'abc123',
				image: { build: { context: '/tmp/sui' } },
			}),
		);

		expect(calls).toEqual([
			expect.objectContaining({
				contextPath: '/tmp/sui',
				buildArgs: { SUI_TOOLS_IMAGE: suiToolsImage('abc123') },
			}),
		]);
	});

	it('reads DEVSTACK_SUI_TOOLS_REF when the config names no ref, and lets config win', async () => {
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env');
		try {
			const calls: Array<{ buildArgs?: Readonly<Record<string, string>> }> = [];
			const runtime = unusedRuntime({
				ensureImage: (build) =>
					Effect.sync(() => {
						calls.push(build);
						return { digest: 'sha256:built', tag: 'built' };
					}),
			});

			await Effect.runPromise(resolveImage(runtime, TEST_IDENTITY, { mode: 'local' }));
			await Effect.runPromise(
				resolveImage(runtime, TEST_IDENTITY, { mode: 'local', suiToolsRef: 'from-config' }),
			);

			expect(calls.map((call) => call.buildArgs?.SUI_TOOLS_IMAGE)).toEqual([
				suiToolsImage('from-env'),
				suiToolsImage('from-config'),
			]);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
