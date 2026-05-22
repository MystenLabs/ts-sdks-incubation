// Docker volume lifecycle.
//
// Architecture invariant: PRE-CREATE labelled volumes BEFORE the run
// argv fires. Docker's lazy `-v <name>:<path>` produces UNLABELLED
// volumes that no inventory enumeration can find. Bind mounts pass
// through unchanged (host-owned paths).

import { Effect, Schema } from 'effect';

import type { ContainerLabelTuple } from '../../contracts/snapshotable.ts';
import { decodeJsonArrayElementSync } from '../../substrate/runtime/runtime-decode.ts';
import { DockerHost, DockerSpawner, dockerRun, dockerRunOk } from './client.ts';
import {
	DockerInspectDecodeFailed,
	DockerInspectFailed,
	DaemonUnreachable,
	type DockerRuntimeError,
	ForeignDockerResource,
	VolumeOperationFailed,
} from './errors.ts';
import {
	expectedVolumeOwnershipLabels,
	ownershipMismatchDetail,
	renderVolumeLabels,
} from './labels.ts';
import { isDaemonUnreachableStderr, wrapVolumeError } from './wrap.ts';

interface VolumeInspectFacts {
	readonly name: string;
	readonly labels: Readonly<Record<string, string>>;
}

const VolumeInspectSchema = Schema.Struct({
	Name: Schema.String,
	Labels: Schema.optional(Schema.Unknown),
});

const readLabels = (raw: unknown): Readonly<Record<string, string>> => {
	if (raw === null || typeof raw !== 'object') return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === 'string') out[key] = value;
	}
	return out;
};

const isNoSuchVolumeStderr = (stderr: string): boolean => /no such volume/i.test(stderr);

const inspectVolume = (
	name: string,
): Effect.Effect<VolumeInspectFacts | null, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('volume', ['inspect', name]).pipe(
			Effect.mapError(wrapVolumeError('inspect', name)),
		);
		if (res.exitCode !== 0) {
			if (isNoSuchVolumeStderr(res.stderr)) return null;
			if (isDaemonUnreachableStderr(res.stderr)) {
				return yield* Effect.fail(
					new DaemonUnreachable({
						op: 'docker.volume.inspect',
						detail: 'docker daemon unreachable',
					}),
				);
			}
			return yield* Effect.fail(
				new DockerInspectFailed({
					resource: 'volume',
					name,
					stderr: res.stderr,
					exitCode: res.exitCode,
				}),
			);
		}
		try {
			const decoded = decodeJsonArrayElementSync(VolumeInspectSchema, res.stdout, {
				source: `docker volume inspect ${name}`,
				missingMessage: 'inspect returned an empty result',
				mkError: (issue) =>
					new DockerInspectDecodeFailed({
						resource: 'volume',
						name,
						detail:
							issue.message === 'inspect returned an empty result'
								? issue.message
								: 'inspect returned malformed volume JSON',
						cause: issue.cause,
					}),
			});
			return { name: decoded.Name, labels: readLabels(decoded.Labels) };
		} catch (cause) {
			return yield* Effect.fail(cause as DockerRuntimeError);
		}
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
