// Unit coverage for the `dockerInspectAndDecode` helper.
//
// The helper centralises the post-`docker inspect` classifier ladder
// (missing → null, daemon-unreachable → DaemonUnreachable, other
// non-zero → DockerInspectFailed) and the JSON-array decode step
// (malformed → DockerInspectDecodeFailed, empty → "empty result"
// decode failure). These cases pin all four branches without needing
// a real docker binary — the helper takes a pre-built Effect so we
// hand it `Effect.succeed(<CaptureResult>)` directly.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Option, Schema } from 'effect';

import {
	DaemonUnreachable,
	DockerInspectDecodeFailed,
	DockerInspectFailed,
} from '../../../src/runtime/docker/errors.ts';
import { dockerInspectAndDecode } from '../../../src/runtime/docker/inspect-and-decode.ts';

const Sample = Schema.Struct({
	Id: Schema.String,
	Name: Schema.String,
});

const ok = (stdout: string) => Effect.succeed({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr: string, exitCode = 1) =>
	Effect.succeed({ exitCode, stdout: '', stderr });

const isMissingNetwork = (stderr: string): boolean =>
	/no such network/i.test(stderr);

describe('dockerInspectAndDecode', () => {
	it.effect('decodes a JSON-array element on exit 0', () =>
		Effect.gen(function* () {
			const result = yield* dockerInspectAndDecode({
				resourceKind: 'network',
				name: 'devstack',
				op: 'docker.network.inspect',
				inspectCommand: ok('[{"Id":"net-abc","Name":"devstack"}]'),
				schema: Sample,
				isMissingStderr: isMissingNetwork,
			});
			expect(result).toEqual({ Id: 'net-abc', Name: 'devstack' });
		}),
	);

	it.effect('returns null when the resource-missing classifier matches', () =>
		Effect.gen(function* () {
			const result = yield* dockerInspectAndDecode({
				resourceKind: 'network',
				name: 'gone',
				op: 'docker.network.inspect',
				inspectCommand: fail(
					'Error response from daemon: No such network: gone',
				),
				schema: Sample,
				isMissingStderr: isMissingNetwork,
			});
			expect(result).toBeNull();
		}),
	);

	it.effect('surfaces DaemonUnreachable on connect-refused stderr', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				dockerInspectAndDecode({
					resourceKind: 'network',
					name: 'devstack',
					op: 'docker.network.inspect',
					inspectCommand: fail(
						'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
					),
					schema: Sample,
					isMissingStderr: isMissingNetwork,
				}),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const err = Option.getOrUndefined(Exit.findErrorOption(exit));
				expect(err).toBeInstanceOf(DaemonUnreachable);
			}
		}),
	);

	it.effect(
		'surfaces DockerInspectFailed on non-zero exit that is neither missing nor daemon-down',
		() =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(
					dockerInspectAndDecode({
						resourceKind: 'network',
						name: 'devstack',
						op: 'docker.network.inspect',
						inspectCommand: fail('Error response from daemon: something else broke'),
						schema: Sample,
						isMissingStderr: isMissingNetwork,
					}),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					const err = Option.getOrUndefined(Exit.findErrorOption(exit));
					expect(err).toBeInstanceOf(DockerInspectFailed);
					if (err instanceof DockerInspectFailed) {
						expect(err.resource).toBe('network');
						expect(err.name).toBe('devstack');
						expect(err.stderr).toContain('something else broke');
					}
				}
			}),
	);

	it.effect('surfaces DockerInspectDecodeFailed on malformed JSON', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				dockerInspectAndDecode({
					resourceKind: 'network',
					name: 'devstack',
					op: 'docker.network.inspect',
					inspectCommand: ok('not json at all'),
					schema: Sample,
					isMissingStderr: isMissingNetwork,
				}),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const err = Option.getOrUndefined(Exit.findErrorOption(exit));
				expect(err).toBeInstanceOf(DockerInspectDecodeFailed);
				if (err instanceof DockerInspectDecodeFailed) {
					expect(err.resource).toBe('network');
					expect(err.name).toBe('devstack');
					expect(err.detail).toContain('malformed network JSON');
				}
			}
		}),
	);

	it.effect('surfaces DockerInspectDecodeFailed (empty-result detail) on []', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				dockerInspectAndDecode({
					resourceKind: 'container',
					name: 'devstack',
					op: 'docker.container.inspect',
					inspectCommand: ok('[]'),
					schema: Sample,
					isMissingStderr: () => false,
				}),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const err = Option.getOrUndefined(Exit.findErrorOption(exit));
				expect(err).toBeInstanceOf(DockerInspectDecodeFailed);
				if (err instanceof DockerInspectDecodeFailed) {
					expect(err.detail).toBe('inspect returned an empty result');
				}
			}
		}),
	);
});
