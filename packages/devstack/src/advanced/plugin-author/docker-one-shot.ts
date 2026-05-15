import { Effect, Option } from 'effect';
import * as crypto from 'node:crypto';
import { cacheGet, cachePut } from '../../engine/cache.js';
import * as Docker from '../../engine/docker.js';
import { DockerError } from '../../primitives/errors.js';
import { tag, type Ref } from '../tag.js';

export interface DockerOneShotResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly cached: boolean;
}

export interface DockerOneShotOptions<Name extends string, E, R> {
	readonly name: Name;
	readonly image: string;
	readonly args?: ReadonlyArray<string>;
	readonly env?: Record<string, string> | Effect.Effect<Record<string, string>, E, R>;
	readonly mounts?: ReadonlyArray<{ readonly host: string; readonly container: string }>;
	readonly network?: string;
	/** Override the image's `ENTRYPOINT`. Maps to `docker run --entrypoint`. */
	readonly entrypoint?: string;
	readonly captureStdout?: boolean;
	readonly dependsOn?: ReadonlyArray<Ref<any, any, any, any>>;
	readonly inputs?: unknown;
	/**
	 * Wall-clock budget for the underlying `docker run`. On expiry the
	 * container is SIGTERM'd, then SIGKILL'd after `gracePeriodMs`, and the
	 * plugin fails with a tagged `DockerError`. Defaults to 10 minutes,
	 * matching the v3 runner.
	 */
	readonly timeoutMs?: number;
	/**
	 * Grace period between SIGTERM and the fallback SIGKILL when the timeout
	 * fires. Defaults to 5_000 ms, matching v3.
	 */
	readonly gracePeriodMs?: number;
}

// BigInt-safe JSON replacer mirroring state-store.ts so cache keys are stable
// across runs even when `inputs` carries bigint values.
const jsonReplacer = (_key: string, value: unknown) =>
	typeof value === 'bigint' ? { __bigint: value.toString() } : value;

export const dockerOneShot = <const Name extends string, E = never, R = never>(
	options: DockerOneShotOptions<Name, E, R>,
) =>
	tag(
		options.name,
		Effect.gen(function* () {
			// 1. Resolve env: literal record, Effect, or undefined.
			const envOpt = options.env;
			const resolvedEnv: Record<string, string> =
				envOpt === undefined ? {} : Effect.isEffect(envOpt) ? yield* envOpt : envOpt;

			// 2. Resolve dependsOn — yield* each tag for ordering.
			for (const tag of options.dependsOn ?? []) {
				yield* tag;
			}

			// 3. Cache short-circuit. One-shots are non-idempotent (re-running
			//    keygen invalidates downstream public keys, etc.), so we stash
			//    a result keyed by the hash of all run-relevant inputs. If the
			//    hash matches, skip Docker entirely and return the prior result.
			const cacheKey = crypto
				.createHash('sha256')
				.update(
					JSON.stringify(
						{
							name: options.name,
							image: options.image,
							entrypoint: options.entrypoint,
							args: options.args,
							env: resolvedEnv,
							mounts: options.mounts,
							network: options.network,
							inputs: options.inputs,
						},
						jsonReplacer,
					),
				)
				.digest('hex');
			const stateKey = `dockerOneShot/${options.name}/${cacheKey}`;

			const cached = yield* cacheGet<DockerOneShotResult>(stateKey);
			if (Option.isSome(cached)) {
				return { ...cached.value, cached: true } satisfies DockerOneShotResult;
			}

			// 4. Run the container to completion. `Docker.runOneShot` uses
			//    `--rm` so cleanup is automatic. Re-wrap the internal
			//    DockerError (which carries `op`) as the public one (which
			//    carries just `message`/`cause`).
			const result = yield* Docker.runOneShot({
				name: options.name,
				image: options.image,
				args: options.args,
				env: resolvedEnv,
				mounts: options.mounts,
				network: options.network,
				...(options.entrypoint !== undefined ? { entrypoint: options.entrypoint } : {}),
				timeoutMs: options.timeoutMs,
				gracePeriodMs: options.gracePeriodMs,
			}).pipe(
				Effect.catchTag('DockerError', (cause) =>
					Effect.fail(
						new DockerError({
							op: 'dockerOneShot',
							message: `dockerOneShot '${options.name}'`,
							cause,
						}),
					),
				),
			);

			const out: DockerOneShotResult = {
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				cached: false,
			};
			yield* cachePut(stateKey, out);
			return out;
		}).pipe(Effect.withSpan(`dockerOneShot(${options.name})`)),
		{
			kind: 'action',
			displayTitle: options.name,
			display: (s) => ({
				title: options.name,
				primary: `exit ${s.exitCode}${s.cached ? ' (cached)' : ''}`,
			}),
		},
	);
