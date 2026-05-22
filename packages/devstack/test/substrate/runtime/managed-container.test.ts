import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Option, Stream } from 'effect';

import type {
	ContainerRuntime,
	EnsureContainerSpec,
} from '../../../src/contracts/container-runtime.ts';
import {
	ensureManagedContainer,
	managedContainerLabels,
} from '../../../src/substrate/runtime/managed-container.ts';

const runtimeFromEnsure = (
	ensureContainer: ContainerRuntime['ensureContainer'],
): ContainerRuntime => ({
	ensureImage: () => Effect.die('unused'),
	ensureNetwork: () => Effect.die('unused'),
	ensureContainer,
	exec: () => Effect.die('unused'),
	runOneShot: () => Effect.die('unused'),
	inspectByLabels: () => Effect.die('unused'),
	followLogs: () => Stream.die('unused'),
	pauseAndCommit: () => Effect.die('unused'),
	saveImage: () => Stream.die('unused'),
	saveImages: () => Stream.die('unused'),
	loadImage: () => Effect.die('unused'),
	tagImage: () => Effect.die('unused'),
	removeImage: () => Effect.die('unused'),
	unpause: () => Effect.die('unused'),
	stop: () => Effect.die('unused'),
	sweepOrphans: () => Effect.die('unused'),
	removeManagedContainers: () => Effect.die('unused'),
	removeManagedImages: () => Effect.die('unused'),
	removeManagedNetworks: () => Effect.die('unused'),
	removeManagedVolumes: () => Effect.die('unused'),
});

describe('managed container helper', () => {
	it('builds the standard ownership label tuple', () => {
		expect(
			managedContainerLabels({
				identity: { app: 'app' as never, stack: 'stack' as never },
				plugin: 'postgres',
				role: 'main',
			}),
		).toEqual({
			app: 'app',
			stack: 'stack',
			plugin: 'postgres',
			role: 'main',
		});
	});

	it('injects labels into ensureContainer and maps runtime errors once', async () => {
		let seen: EnsureContainerSpec | undefined;
		const runtime = runtimeFromEnsure((spec) =>
			Effect.sync(() => {
				seen = spec;
				return {
					id: 'id',
					name: spec.name,
					labels: spec.labels,
					imageName: 'image',
					status: 'running' as const,
					ips: [],
				};
			}),
		);

		await Effect.runPromise(
			Effect.scoped(
				ensureManagedContainer({
					runtime,
					identity: { app: 'app' as never, stack: 'stack' as never },
					plugin: 'sui',
					role: 'validator',
					spec: {
						name: 'validator',
						image: { digest: 'sha256:abc' },
						recreate: 'on-failure',
					},
					mapError: (cause) => cause,
				}),
			),
		);

		expect(seen?.labels).toEqual({
			app: 'app',
			stack: 'stack',
			plugin: 'sui',
			role: 'validator',
		});
	});

	it('projects runtime errors through the plugin mapper', async () => {
		const runtime = runtimeFromEnsure(() =>
			Effect.fail({
				_tag: 'ContainerRuntimeError' as const,
				reason: 'daemon-unreachable' as const,
				detail: 'no daemon',
			}),
		);

		const exit = await Effect.runPromiseExit(
			Effect.scoped(
				ensureManagedContainer({
					runtime,
					identity: { app: 'app' as never, stack: 'stack' as never },
					plugin: 'postgres',
					role: 'main',
					spec: {
						name: 'postgres',
						image: { digest: 'sha256:abc' },
						recreate: 'on-config-change',
					},
					mapError: (cause) => ({ _tag: 'PluginContainerError' as const, cause }),
				}),
			),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		const error = Exit.findErrorOption(exit);
		expect(Option.isSome(error)).toBe(true);
		if (Option.isSome(error)) {
			expect(error.value).toMatchObject({
				_tag: 'PluginContainerError',
				cause: { reason: 'daemon-unreachable' },
			});
		}
	});
});
