// `docker <resource> inspect` shared decode pipeline.
//
// Three Docker subsystem files (`container.ts`, `network.ts`) inline the
// SAME post-`docker inspect` shape:
//
//   1. examine `CaptureResult.exitCode`
//   2. on non-zero stderr, classify into `<missing>` (caller-specific),
//      `DaemonUnreachable`, or `DockerInspectFailed`
//   3. on zero exit, decode the JSON-array element via
//      `decodeJsonArrayElementSync`, wrapping decode issues in
//      `DockerInspectDecodeFailed`
//
// This module centralises that ladder so the three sites stay byte-
// identical and new resource kinds get the same treatment for free.
//
// Image inspect is intentionally NOT a consumer: `imageExists` uses
// `docker inspect --format '{{.Id}}'` (plain stdout, no JSON array),
// so it never enters this pipeline.

import { Effect, Schema } from 'effect';

import { decodeJsonArrayElementSync } from '../../substrate/runtime/runtime-decode.ts';
import type { CaptureResult } from '../../substrate/runtime/observability/subprocess-capture.ts';
import {
	DaemonUnreachable,
	DockerInspectDecodeFailed,
	DockerInspectFailed,
	type DockerResourceKind,
	type DockerRuntimeError,
} from './errors.ts';
import { isDaemonUnreachableStderr } from './wrap.ts';

export interface DockerInspectAndDecodeOptions<S extends Schema.Decoder<unknown>, R> {
	/** Resource kind, threaded into `DockerInspectFailed` /
	 *  `DockerInspectDecodeFailed` error envelopes. */
	readonly resourceKind: DockerResourceKind;
	/** Resource name (container, network, volume) being inspected.
	 *  Threaded into the error envelopes and the decode `source`. */
	readonly name: string;
	/** Op label for the `DaemonUnreachable` envelope.
	 *  e.g. `'docker.network.inspect'`. */
	readonly op: string;
	/** Pre-wrapped `docker <resource> inspect <name>` invocation. The
	 *  caller is responsible for the `mapError` step (each site has its
	 *  own wrap.ts classifier) so this Effect already produces typed
	 *  `DockerRuntimeError`s for spawn-side failures. */
	readonly inspectCommand: Effect.Effect<CaptureResult, DockerRuntimeError, R>;
	/** Schema for the JSON-array element returned by `docker inspect`. */
	readonly schema: S;
	/** Stderr classifier for the resource-specific "missing" case (e.g.
	 *  `No such container`). When this returns true on a non-zero exit,
	 *  the helper returns `null` to the caller; the caller decides what
	 *  the contract-level missing return value should be (`null`, `[]`,
	 *  …). */
	readonly isMissingStderr: (stderr: string) => boolean;
	/** Optional override for the malformed-JSON decode error detail.
	 *  Sites use slightly different wording (e.g. "malformed container
	 *  JSON" vs "malformed network JSON"); defaults to a generic
	 *  resource-kind-derived string. */
	readonly malformedDetail?: string;
	/** Optional array index; the universal pattern is `0` (single-
	 *  element array from `docker inspect`). */
	readonly index?: number;
}

/** Run `docker inspect`, classify the exit code, and decode the
 *  JSON-array element. Returns `null` when the resource is missing
 *  per the caller-supplied stderr classifier; otherwise returns the
 *  decoded schema value. All failure modes surface as
 *  `DockerRuntimeError` (`DaemonUnreachable`, `DockerInspectFailed`,
 *  or `DockerInspectDecodeFailed`). */
export const dockerInspectAndDecode = <S extends Schema.Decoder<unknown>, R>(
	options: DockerInspectAndDecodeOptions<S, R>,
): Effect.Effect<S['Type'] | null, DockerRuntimeError, R> =>
	Effect.gen(function* () {
		const res = yield* options.inspectCommand;
		if (res.exitCode !== 0) {
			if (options.isMissingStderr(res.stderr)) return null;
			if (isDaemonUnreachableStderr(res.stderr)) {
				return yield* Effect.fail(
					new DaemonUnreachable({
						op: options.op,
						detail: 'docker daemon unreachable',
					}),
				);
			}
			return yield* Effect.fail(
				new DockerInspectFailed({
					resource: options.resourceKind,
					name: options.name,
					stderr: res.stderr,
					exitCode: res.exitCode,
				}),
			);
		}
		// `decodeJsonArrayElementSync`'s `mkError` produces a typed
		// `DockerInspectDecodeFailed`; we route it through `Effect.try`
		// so the error channel stays typed. The `catch` narrows on
		// `instanceof` so that any UNEXPECTED sync defect thrown from
		// inside the decode body (e.g. a reader helper bug) is wrapped
		// in a fresh envelope rather than cast-lied as the wrong type.
		const malformedDetail =
			options.malformedDetail ?? `inspect returned malformed ${options.resourceKind} JSON`;
		return yield* Effect.try({
			try: (): S['Type'] =>
				decodeJsonArrayElementSync(options.schema, res.stdout, {
					source: `docker ${options.resourceKind} inspect ${options.name}`,
					missingMessage: 'inspect returned an empty result',
					index: options.index,
					mkError: (issue) =>
						new DockerInspectDecodeFailed({
							resource: options.resourceKind,
							name: options.name,
							detail:
								issue.message === 'inspect returned an empty result'
									? issue.message
									: malformedDetail,
							cause: issue.cause,
						}),
				}),
			catch: (cause): DockerInspectDecodeFailed =>
				cause instanceof DockerInspectDecodeFailed
					? cause
					: new DockerInspectDecodeFailed({
							resource: options.resourceKind,
							name: options.name,
							detail: `unexpected defect while decoding ${options.resourceKind} inspect`,
							cause,
						}),
		});
	});
