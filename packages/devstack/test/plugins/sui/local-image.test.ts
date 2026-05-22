import { Effect, Stream } from 'effect';
import { describe, expect, it } from 'vitest';

import type { ContainerRuntime, ImageRef } from '../../../src/contracts/container-runtime.ts';
import { resolveImage } from '../../../src/plugins/sui/mode/local.ts';

const unusedRuntime = (overrides: Partial<ContainerRuntime> = {}): ContainerRuntime => ({
	ensureImage: () => Effect.die('ensureImage not used'),
	ensureNetwork: () => Effect.die('ensureNetwork not used'),
	ensureContainer: () => Effect.die('ensureContainer not used'),
	exec: () => Effect.die('exec not used'),
	runOneShot: () => Effect.die('runOneShot not used'),
	inspectByLabels: () => Effect.die('inspectByLabels not used'),
	followLogs: () => Stream.die('followLogs not used'),
	pause: () => Effect.die('pause not used'),
	pauseAndCommit: () => Effect.die('pauseAndCommit not used'),
	saveImage: () => Stream.die('saveImage not used'),
	saveImages: () => Stream.die('saveImages not used'),
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
	...overrides,
});

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
			resolveImage(runtime, { mode: 'local', image: { pull: 'mysten/sui:devnet' } }),
		);

		expect(calls).toEqual(['mysten/sui:devnet']);
		expect(resolved).toEqual(ref);
	});

	it('uses ensureImage for explicit build contexts', async () => {
		const calls: unknown[] = [];
		const runtime = unusedRuntime({
			ensureImage: (build) =>
				Effect.sync(() => {
					calls.push(build);
					return { digest: 'sha256:built', tag: 'built' };
				}),
		});

		const resolved = await Effect.runPromise(
			resolveImage(runtime, {
				mode: 'local',
				image: { build: { context: '/tmp/sui', dockerfile: 'Dockerfile.sui' } },
				version: 'v1',
			}),
		);

		expect(calls).toEqual([
			{
				contextPath: '/tmp/sui',
				dockerfile: 'Dockerfile.sui',
				buildArgs: { SUI_VERSION: 'v1' },
			},
		]);
		expect(resolved.digest).toBe('sha256:built');
	});
});
