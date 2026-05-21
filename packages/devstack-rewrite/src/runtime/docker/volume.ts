// Docker volume lifecycle.
//
// Architecture invariant: PRE-CREATE labelled volumes BEFORE the run
// argv fires. Docker's lazy `-v <name>:<path>` produces UNLABELLED
// volumes that no inventory enumeration can find. Bind mounts pass
// through unchanged (host-owned paths).

import { Effect } from 'effect';

import type { ContainerLabelTuple } from '../../contracts/snapshotable.ts';
import { DockerHost, DockerSpawner, dockerRun, dockerRunOk } from './client.ts';
import { VolumeOperationFailed, type DockerRuntimeError } from './errors.ts';
import { renderVolumeLabels } from './labels.ts';
import { wrapVolumeError } from './wrap.ts';

/** Idempotent `docker volume create`. Stamps the canonical label set.
 *  Returns the volume name on success. */
export const ensureVolume = (
	name: string,
	tuple: ContainerLabelTuple,
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		// Probe — if labelled volume exists we keep it.
		const probe = yield* dockerRunOk('volume', ['inspect', '--format', '{{.Name}}', name]).pipe(
			Effect.mapError(wrapVolumeError('inspect', name)),
		);
		if (probe.exitCode === 0) {
			return probe.stdout.trim();
		}
		const labelArgs = renderVolumeLabels(name, tuple).flatMap((l) => ['--label', l]);
		yield* dockerRun('volume', ['create', ...labelArgs, name]).pipe(
			Effect.mapError(wrapVolumeError('create', name)),
		);
		return name;
	}).pipe(Effect.withSpan('runtime.docker.volume.ensure'));

export const removeVolume = (
	name: string,
): Effect.Effect<void, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('volume', ['rm', '--force', name]).pipe(
			Effect.mapError(wrapVolumeError('remove', name)),
		);
		// "no such volume" is idempotent success.
		if (res.exitCode !== 0 && !/no such volume/i.test(res.stderr)) {
			return yield* Effect.fail(
				new VolumeOperationFailed({ op: 'remove', volume: name, stderr: res.stderr }),
			);
		}
	}).pipe(Effect.withSpan('runtime.docker.volume.remove'));
