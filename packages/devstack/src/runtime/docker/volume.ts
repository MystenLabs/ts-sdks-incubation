// Docker volume lifecycle.
//
// Architecture invariant: PRE-CREATE labelled volumes BEFORE the run
// argv fires. Docker's lazy `-v <name>:<path>` produces UNLABELLED
// volumes that no inventory enumeration can find. Bind mounts pass
// through unchanged (host-owned paths).

import { Effect, Schema } from 'effect';

import type { ContainerLabelTuple } from '../../contracts/snapshotable.ts';
import { DockerHost, DockerSpawner, dockerRun, dockerRunOk } from './client.ts';
import {
	type DockerRuntimeError,
	ForeignDockerResource,
	VolumeOperationFailed,
} from './errors.ts';
import { dockerInspectAndDecode } from './inspect-and-decode.ts';
import {
	expectedVolumeOwnershipLabels,
	ownershipMismatchDetail,
	readLabels,
	renderVolumeLabels,
} from './labels.ts';
import { wrapVolumeError } from './wrap.ts';

interface VolumeInspectFacts {
	readonly name: string;
	readonly labels: Readonly<Record<string, string>>;
}

const VolumeInspectSchema = Schema.Struct({
	Name: Schema.String,
	Labels: Schema.optional(Schema.Unknown),
});

const isNoSuchVolumeStderr = (stderr: string): boolean => /no such volume/i.test(stderr);

const inspectVolume = (
	name: string,
): Effect.Effect<VolumeInspectFacts | null, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const decoded = yield* dockerInspectAndDecode({
			resourceKind: 'volume',
			name,
			op: 'docker.volume.inspect',
			inspectCommand: dockerRunOk('volume', ['inspect', name]).pipe(
				Effect.mapError(wrapVolumeError('inspect', name)),
			),
			schema: VolumeInspectSchema,
			isMissingStderr: isNoSuchVolumeStderr,
		});
		if (decoded === null) return null;
		return { name: decoded.Name, labels: readLabels(decoded.Labels) };
	});

const assertVolumeOwned = (
	name: string,
	facts: VolumeInspectFacts,
	tuple: ContainerLabelTuple,
): Effect.Effect<void, DockerRuntimeError> =>
	Effect.gen(function* () {
		const expected = expectedVolumeOwnershipLabels(tuple);
		const mismatch = ownershipMismatchDetail(expected, facts.labels);
		if (mismatch !== null) {
			return yield* Effect.fail(
				new ForeignDockerResource({
					resource: 'volume',
					name,
					expected,
					actual: facts.labels,
					detail: mismatch,
				}),
			);
		}
	});

/** Idempotent `docker volume create`. Stamps the canonical label set.
 *  Returns the volume name on success. */
export const ensureVolume = (
	name: string,
	tuple: ContainerLabelTuple,
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const probe = yield* inspectVolume(name);
		if (probe !== null) {
			yield* assertVolumeOwned(name, probe, tuple);
			return probe.name;
		}
		const labelArgs = renderVolumeLabels(name, tuple).flatMap((l) => ['--label', l]);
		yield* dockerRun('volume', ['create', ...labelArgs, name]).pipe(
			Effect.mapError(wrapVolumeError('create', name)),
		);
		return name;
	});

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
	});
