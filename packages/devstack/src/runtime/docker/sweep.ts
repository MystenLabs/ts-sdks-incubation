// Orphan sweep.
//
// Architecture § Container runtime § Sweep timing:
//   The supervisor invokes `sweepOrphans` AT BOOT, BEFORE any plugin
//   acquire fires. Sweep finds containers stamped with the engine's
//   label tuple but with no live process holder, and reclaims them
//   (force-remove) under `stack.lock`.
//
// Orphan = labelled with `(app, stack)` AND NOT in the active
// container-claim ledger AND NOT held by any live peer.
//
// "Live peer" = roster holder whose PID+startTime liveness check
// succeeds. The cross-process roster + claim-ledger is the authority;
// we never use docker labels alone (a peer's container counts as
// claimed even if our claim ledger is empty for it).

import { Effect } from 'effect';

import type { ContainerLabelTuple } from '../../contracts/snapshotable.ts';
import { readClaims, type ContainerClaim } from '../../substrate/runtime/cross-process/roster.ts';
import { acquireStackLock } from '../../substrate/runtime/cross-process/stack-lock.ts';
import { StackPathsService } from '../../substrate/runtime/paths.ts';
import { DockerHost, DockerSpawner, dockerRunOk } from './client.ts';
import {
	ContainerRemoveFailed,
	DaemonUnreachable,
	ImageRemoveFailed,
	NetworkOperationFailed,
	type DockerRuntimeError,
} from './errors.ts';
import {
	listContainers,
	listDevstackContainers,
	listDevstackImages,
	listDevstackNetworks,
	listDevstackRouterContainers,
	listDevstackVolumes,
	listImages,
	listNetworks,
	listVolumes,
} from './inventory.ts';
import { LabelKey } from './labels.ts';
import { removeVolume } from './volume.ts';
import { isNoSuchContainerStderr, wrapGeneric } from './wrap.ts';

/** Sweep orphan containers matching the partial label tuple. Returns
 *  the number of containers removed.
 *
 *  The sweep:
 *
 *    1. Lists all containers with the canonical `devstack.managed=true`
 *       + caller-supplied partial tuple (typically `{app, stack}`).
 *    2. Reads the container-claim ledger (the file held alongside
 *       roster.json; mutated only under stack.lock).
 *    3. Under stack.lock, removes any container whose name is NOT in
 *       the ledger.
 *
 *  Concurrent sweepers are serialized by stack.lock. The architecture
 *  says briefly here — we hold the lock only across the read + the
 *  remove decision; we DON'T hold it across the individual `docker
 *  rm` calls (which can be slow). The cost: a peer that registered a
 *  claim between our decision and our rm gets its container rm'd
 *  anyway. The mitigation: this only fires on the BOOT path before
 *  any plugin acquires, so the steady-state "peer just claimed" race
 *  is not in the picture. */
export const sweepOrphans = (
	labelMatch: Partial<ContainerLabelTuple>,
): Effect.Effect<number, DockerRuntimeError, DockerHost | DockerSpawner | StackPathsService> =>
	Effect.gen(function* () {
		const paths = yield* StackPathsService;
		const containers = yield* listContainers(labelMatch);
		if (containers.length === 0) return 0;

		// Under stack.lock, snapshot the claim ledger. The decision
		// (which to remove) happens here; the rm calls happen outside
		// the lock.
		const mapSubstrateError = (cause: unknown): DockerRuntimeError =>
			new DaemonUnreachable({
				op: 'cross-process.sweep',
				detail: `sweep substrate read failed: ${String(cause)}`,
				cause,
			});
		const claimNames = yield* Effect.scoped(
			Effect.gen(function* () {
				yield* acquireStackLock(paths.stackLockFile).pipe(Effect.mapError(mapSubstrateError));
				const doc = yield* readClaims({
					stackLockFile: paths.stackLockFile,
					rosterFile: paths.rosterFile,
				}).pipe(Effect.mapError(mapSubstrateError));
				return new Set(doc.claims.map((c: ContainerClaim) => c.containerKey));
			}),
		);

		// Sweep — best-effort per container. Individual rm failures
		// don't poison the whole sweep.
		let removed = 0;
		for (const c of containers) {
			if (claimNames.has(c.name)) continue;
			const res = yield* dockerRunOk('rm', ['-f', c.name]).pipe(
				Effect.catch(() =>
					Effect.succeed({ exitCode: 1, stdout: '', stderr: 'sweep rm spawn failed' }),
				),
			);
			if (res.exitCode === 0) removed += 1;
		}
		return removed;
	}).pipe(Effect.withSpan('runtime.docker.sweep'));

const removeManagedContainer = (
	name: string,
): Effect.Effect<boolean, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('rm', ['-f', name]).pipe(
			Effect.mapError(wrapGeneric('docker.rm')),
		);
		if (res.exitCode === 0) return true;
		if (isNoSuchContainerStderr(res.stderr)) return false;
		return yield* Effect.fail(
			new ContainerRemoveFailed({
				name,
				stderr: res.stderr,
				exitCode: res.exitCode,
			}),
		);
	});

/** Explicit teardown. Unlike `sweepOrphans`, this does not consult the
 *  claim ledger; wipe/restore are intentional destructive operations. */
export const removeManagedContainers = (
	labelMatch: Partial<ContainerLabelTuple>,
): Effect.Effect<number, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const containers = yield* listContainers(labelMatch);
		let removed = 0;
		for (const c of containers) {
			const didRemove = yield* removeManagedContainer(c.name);
			if (didRemove) removed += 1;
		}
		return removed;
	}).pipe(Effect.withSpan('runtime.docker.removeManagedContainers'));

const labelsMatchAppStack = (
	labels: Readonly<Record<string, string>>,
	match: Pick<ContainerLabelTuple, 'app' | 'stack'>,
): boolean => labels[LabelKey.app] === match.app && labels[LabelKey.stack] === match.stack;

export const removeDevstackContainers = (
	labelMatch: Pick<ContainerLabelTuple, 'app' | 'stack'>,
): Effect.Effect<number, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const containers = yield* listDevstackContainers();
		let removed = 0;
		for (const c of containers) {
			if (!labelsMatchAppStack(c.labels, labelMatch)) continue;
			const didRemove = yield* removeManagedContainer(c.name);
			if (didRemove) removed += 1;
		}
		return removed;
	}).pipe(Effect.withSpan('runtime.docker.removeDevstackContainers'));

export const removeDevstackRouterContainers = (
	containerName: string,
): Effect.Effect<number, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const containers = yield* listDevstackRouterContainers();
		let removed = 0;
		for (const c of containers) {
			if (c.name !== containerName) continue;
			const didRemove = yield* removeManagedContainer(c.name);
			if (didRemove) removed += 1;
		}
		return removed;
	}).pipe(Effect.withSpan('runtime.docker.removeDevstackRouterContainers'));

const isMissingImageStderr = (stderr: string): boolean =>
	/no such image|not found|reference does not exist/i.test(stderr);

const removeManagedImage = (
	ref: string,
): Effect.Effect<boolean, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('image', ['rm', '-f', ref]).pipe(
			Effect.mapError(wrapGeneric('docker.image.rm')),
		);
		if (res.exitCode === 0) return true;
		if (isMissingImageStderr(res.stderr)) return false;
		return yield* Effect.fail(
			new ImageRemoveFailed({
				ref,
				stderr: res.stderr,
				exitCode: res.exitCode,
			}),
		);
	});

export const removeManagedImages = (
	labelMatch: Partial<ContainerLabelTuple>,
): Effect.Effect<number, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const images = yield* listImages(labelMatch);
		let removed = 0;
		const seen = new Set<string>();
		for (const image of images) {
			const ref = image.tag;
			if (seen.has(ref)) continue;
			seen.add(ref);
			const didRemove = yield* removeManagedImage(ref);
			if (didRemove) removed += 1;
		}
		return removed;
	}).pipe(Effect.withSpan('runtime.docker.removeManagedImages'));

export const removeDevstackImages = (
	labelMatch: Pick<ContainerLabelTuple, 'app' | 'stack'>,
): Effect.Effect<number, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const images = yield* listDevstackImages();
		let removed = 0;
		const seen = new Set<string>();
		for (const image of images) {
			if (!labelsMatchAppStack(image.labels, labelMatch)) continue;
			const ref = image.tag;
			if (ref.endsWith(':<none>')) continue;
			if (seen.has(ref)) continue;
			seen.add(ref);
			const didRemove = yield* removeManagedImage(ref);
			if (didRemove) removed += 1;
		}
		return removed;
	}).pipe(Effect.withSpan('runtime.docker.removeDevstackImages'));

const isMissingNetworkStderr = (stderr: string): boolean =>
	/no such network|network .* not found|not found/i.test(stderr);

const removeManagedNetwork = (
	name: string,
): Effect.Effect<boolean, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('network', ['rm', name]).pipe(
			Effect.mapError(wrapGeneric('docker.network.rm')),
		);
		if (res.exitCode === 0) return true;
		if (isMissingNetworkStderr(res.stderr)) return false;
		return yield* Effect.fail(
			new NetworkOperationFailed({ op: 'remove', network: name, stderr: res.stderr }),
		);
	});

export const removeManagedNetworks = (
	labelMatch: Partial<ContainerLabelTuple>,
): Effect.Effect<number, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const networks = yield* listNetworks(labelMatch);
		let removed = 0;
		for (const network of networks) {
			if (network.labels[LabelKey.networkMarker] !== 'true') continue;
			const didRemove = yield* removeManagedNetwork(network.name);
			if (didRemove) removed += 1;
		}
		return removed;
	}).pipe(Effect.withSpan('runtime.docker.removeManagedNetworks'));

const isNetworkInUseStderr = (stderr: string): boolean =>
	/active endpoints|has active endpoint|network .* is in use/i.test(stderr);

type NetworkRemoveOutcome = 'removed' | 'missing' | 'in-use';

export interface DevstackNetworkRemovalSummary {
	readonly removed: number;
	readonly skippedInUse: number;
}

interface DevstackNetworkRemovalOptions {
	readonly retryAttempts?: number;
	readonly retryDelayMillis?: number;
}

const removeManagedNetworkOnce = (
	name: string,
): Effect.Effect<NetworkRemoveOutcome, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('network', ['rm', name]).pipe(
			Effect.mapError(wrapGeneric('docker.network.rm')),
		);
		if (res.exitCode === 0) return 'removed' as const;
		if (isMissingNetworkStderr(res.stderr)) return 'missing' as const;
		if (isNetworkInUseStderr(res.stderr)) return 'in-use' as const;
		return yield* Effect.fail(
			new NetworkOperationFailed({ op: 'remove', network: name, stderr: res.stderr }),
		);
	});

const removeManagedNetworkBestEffort = (
	name: string,
	options: Required<DevstackNetworkRemovalOptions>,
): Effect.Effect<NetworkRemoveOutcome, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < options.retryAttempts; attempt += 1) {
			const outcome = yield* removeManagedNetworkOnce(name);
			if (outcome !== 'in-use') return outcome;
			if (attempt < options.retryAttempts - 1) {
				yield* Effect.sleep(`${options.retryDelayMillis} millis`);
			}
		}
		return 'in-use' as const;
	});

export const removeDevstackNetworks = (
	labelMatch: Pick<ContainerLabelTuple, 'app' | 'stack'>,
): Effect.Effect<number, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const networks = yield* listDevstackNetworks();
		let removed = 0;
		for (const network of networks) {
			if (!labelsMatchAppStack(network.labels, labelMatch)) continue;
			const didRemove = yield* removeManagedNetwork(network.name);
			if (didRemove) removed += 1;
		}
		return removed;
	}).pipe(Effect.withSpan('runtime.docker.removeDevstackNetworks'));

export const removeDevstackNetworksBestEffort = (
	labelMatch: Pick<ContainerLabelTuple, 'app' | 'stack'>,
	options: DevstackNetworkRemovalOptions = {},
): Effect.Effect<DevstackNetworkRemovalSummary, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const networks = yield* listDevstackNetworks();
		const retryOptions = {
			retryAttempts: options.retryAttempts ?? 6,
			retryDelayMillis: options.retryDelayMillis ?? 250,
		};
		let removed = 0;
		let skippedInUse = 0;
		for (const network of networks) {
			if (!labelsMatchAppStack(network.labels, labelMatch)) continue;
			const outcome = yield* removeManagedNetworkBestEffort(network.name, retryOptions);
			if (outcome === 'removed') removed += 1;
			if (outcome === 'in-use') skippedInUse += 1;
		}
		return { removed, skippedInUse };
	}).pipe(Effect.withSpan('runtime.docker.removeDevstackNetworksBestEffort'));

export const removeManagedVolumes = (
	labelMatch: Partial<ContainerLabelTuple>,
): Effect.Effect<number, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const volumes = yield* listVolumes(labelMatch);
		let removed = 0;
		for (const volume of volumes) {
			if (volume.labels[LabelKey.volumeMarker] !== 'true') continue;
			yield* removeVolume(volume.name);
			removed += 1;
		}
		return removed;
	}).pipe(Effect.withSpan('runtime.docker.removeManagedVolumes'));

export const removeDevstackVolumes = (
	labelMatch: Pick<ContainerLabelTuple, 'app' | 'stack'>,
): Effect.Effect<number, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const volumes = yield* listDevstackVolumes();
		let removed = 0;
		for (const volume of volumes) {
			if (!labelsMatchAppStack(volume.labels, labelMatch)) continue;
			yield* removeVolume(volume.name);
			removed += 1;
		}
		return removed;
	}).pipe(Effect.withSpan('runtime.docker.removeDevstackVolumes'));
