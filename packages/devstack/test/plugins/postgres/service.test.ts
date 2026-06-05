import { describe, expect, it } from '@effect/vitest';
import { Effect, Stream } from 'effect';

import type {
	ContainerRuntime,
	EnsureContainerSpec,
} from '../../../src/contracts/container-runtime.ts';
import { bootPostgresService } from '../../../src/plugins/postgres/service.ts';
import { appName, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';

const identity: Identity = {
	app: appName('private-content'),
	stack: stackName('main'),
	chain: 'sui:local',
};

const FAKE_STACK_ROOT = '/tmp/fake-test-stack-root';

const runtimeCapturingPostgresSpec = (specs: EnsureContainerSpec[]): ContainerRuntime => ({
	ensureImage: () => Effect.succeed({ digest: 'sha256:postgres', tag: 'devstack-postgres:test' }),
	ensureNetwork: () => Effect.succeed('postgres-net'),
	ensureContainer: (spec) =>
		Effect.sync(() => {
			specs.push(spec);
			return {
				id: 'postgres-container-id',
				name: spec.name,
				imageName: spec.image.tag ?? spec.image.digest,
				status: 'running' as const,
				ips: [],
				labels: spec.labels,
			};
		}),
	exec: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
	runOneShot: () => Effect.die('runOneShot not used'),
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

describe('bootPostgresService', () => {
	it.effect('threads the default WAL-flush grace into the Docker container spec', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const specs: EnsureContainerSpec[] = [];
				yield* bootPostgresService(runtimeCapturingPostgresSpec(specs), identity, FAKE_STACK_ROOT, {});

				expect(specs[0]?.stopGraceSeconds).toBe(20);
			}),
		),
	);

	it.effect('threads caller stop-grace overrides into the Docker container spec', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const specs: EnsureContainerSpec[] = [];
				yield* bootPostgresService(runtimeCapturingPostgresSpec(specs), identity, FAKE_STACK_ROOT, {
					stopGraceSeconds: 45,
				});

				expect(specs[0]?.stopGraceSeconds).toBe(45);
			}),
		),
	);
});
