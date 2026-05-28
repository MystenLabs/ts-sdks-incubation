// Regression test for the storage-nodes parallel-stop scope cascade
// (review fix phase 22a, finding 2).
//
// `startStorageNodes` forks a parallel-strategy child scope off the
// caller's scope and acquires each `ensureContainer` under it via
// `Scope.provide(ensureNode, nodeStopScope)`. The per-node ready
// probe runs under the OUTER scope (not the child). The concern was
// whether a ready-probe failure on node i would actually trigger the
// child scope's stop finalizers — i.e. whether outer-scope close
// cascades to the parallel child.
//
// Verified against `.repos/effect-v4/packages/effect/src/Scope.ts`
// `fork` docs: "Closing the parent closes the child with the same
// exit value". This test pins that behavior end-to-end: on probe
// failure, every already-acquired container's stop finalizer runs.

import { Effect, Stream } from 'effect';
import { describe, expect, it } from 'vitest';

import type {
	ContainerHandle,
	ContainerRuntime,
	EnsureContainerSpec,
} from '../../../src/contracts/container-runtime.ts';
import {
	DEFAULT_NODE_READY_TIMEOUT_MS,
	WALRUS_ROUTER_PORT,
	startStorageNodes,
} from '../../../src/plugins/walrus/storage-nodes.ts';

interface StopRecorder {
	readonly started: EnsureContainerSpec[];
	readonly stopped: string[];
}

const buildRecorderRuntime = (recorder: StopRecorder, probeFails: boolean): ContainerRuntime => ({
	ensureImage: () => Effect.die('ensureImage not used'),
	ensureNetwork: () => Effect.die('ensureNetwork not used'),
	ensureContainer: (spec) =>
		Effect.acquireRelease(
			Effect.sync((): ContainerHandle => {
				recorder.started.push(spec);
				return {
					id: `container-${spec.name}`,
					name: spec.name,
					imageName: spec.image.tag ?? spec.image.digest,
					status: 'running' as const,
					ips: [],
					labels: spec.labels,
				};
			}),
			(handle) =>
				Effect.sync(() => {
					recorder.stopped.push(handle.name);
				}),
		),
	// `exec` is what the storage-node ready probe uses. Returning a
	// non-zero exit code simulates "container created but not yet
	// listening"; the probe's bounded retry then exhausts and the
	// caller surfaces a ProbeTimeoutError → walrusPluginError.
	exec: () =>
		Effect.succeed({
			exitCode: probeFails ? 1 : 0,
			stdout: '',
			stderr: probeFails ? 'connection refused' : '',
		}),
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

const baseSpec = {
	app: 'private-content',
	stack: 'main',
	walrusName: 'walrus',
	image: { digest: 'sha256:walrus', tag: 'devstack-walrus:test' },
	nodeCount: 2,
	subnetPrefix: '10.64.1',
	containerApiPort: WALRUS_ROUTER_PORT,
	walrusNetworkName: 'walrus-net',
	suiNetworkName: 'sui-net',
	deployHostMountPath: '/tmp/devstack/walrus/walrus/deploy',
	stackRoot: '/tmp/devstack',
	deployConfigHash: 'deploy-hash',
};

describe('startStorageNodes — parallel stop-scope cascade', () => {
	it('happy path: outer scope close runs every per-node stop finalizer', async () => {
		const recorder: StopRecorder = { started: [], stopped: [] };
		const runtime = buildRecorderRuntime(recorder, false);

		await Effect.runPromise(Effect.scoped(startStorageNodes(runtime, baseSpec)));

		expect(recorder.started.length).toBe(2);
		expect(recorder.stopped.length).toBe(2);
		expect(new Set(recorder.stopped)).toEqual(new Set(recorder.started.map((s) => s.name)));
	});

	it('ready-probe failure cascades to the parallel stop scope and runs container finalizers', async () => {
		// Effect.v4: when `bootOne` fails (probe timeout), `Effect.all`
		// interrupts siblings and the failure surfaces past the
		// encompassing `Effect.scoped` boundary, which closes the outer
		// scope. The forked-parallel child scope (`nodeStopScope`)
		// cascade-closes per the `fork` semantics documented in
		// effect-v4/packages/effect/src/Scope.ts.
		const recorder: StopRecorder = { started: [], stopped: [] };
		const runtime = buildRecorderRuntime(recorder, /* probeFails */ true);

		// Drop the timeout aggressively so the test runs fast.
		const exit = await Effect.runPromiseExit(
			Effect.scoped(startStorageNodes(runtime, { ...baseSpec, readyTimeoutMs: 50 })),
		);

		expect(exit._tag).toBe('Failure');
		// Every container the runtime accepted must have its stop
		// finalizer invoked — proving the cascade. (`Effect.all` with
		// `concurrency: 'unbounded'` may interrupt some `bootOne`s
		// before they start, so we assert: stopped count equals started
		// count, and every started container is stopped exactly once.)
		expect(recorder.stopped.length).toBe(recorder.started.length);
		expect(recorder.started.length).toBeGreaterThan(0);
		expect(new Set(recorder.stopped)).toEqual(new Set(recorder.started.map((s) => s.name)));
		// Sanity: the suite uses a TINY probe timeout, not the default
		// 60 s. Drift here would silently re-introduce 60 s test latency.
		expect(DEFAULT_NODE_READY_TIMEOUT_MS).toBe(60_000);
	});
});
