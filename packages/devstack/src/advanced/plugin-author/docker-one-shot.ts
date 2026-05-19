import { Effect, Option } from 'effect';
import { contentHash } from '../../engine/content-hash.js';
import * as Docker from '../../engine/docker.js';
import { DockerError } from '../../engine/errors.js';
import { StateStore } from '../../engine/state-store.js';
import { StateStoreKeys } from '../../engine/state-store-keys.js';
import { tag, type LayeredTag } from '../tag.js';

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
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
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

/**
 * Run a Docker container to completion as a one-shot action. Caches the
 * stdout/stderr/exit-code keyed by a content hash of the run-relevant
 * inputs (image, args, env, mounts, network, caller-supplied `inputs`)
 * so re-running an unchanged spec is a noop after the first success.
 *
 * **Public escape hatch for plugin authors.** Zero in-tree callers as
 * of Wave 6.8 — `dockerImage`, `gitFetch`, and `hostScript` cover the
 * common shapes (build-an-image / clone-a-repo / spawn-a-host-process);
 * this primitive is the "I need to run a one-off container action and
 * capture its output" hatch.
 *
 * **Sunset 2026-11-19.** Six months from Wave 6.8 (`packages/devstack/notes/review-followups.md`
 * §8.8 + §10.4). If no in-tree or out-of-tree caller appears by the
 * sunset date, this primitive will be re-evaluated for removal. Out-of-tree
 * plugin authors using `dockerOneShot` should track this note and file
 * an issue against the devstack repo with their use case so the sunset
 * can be cancelled.
 */
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
			// Pre-stringify with the bigint-safe replacer; pass the result as
			// a string to `contentHash` since its object overload uses plain
			// JSON.stringify and would throw on bigint values in `inputs`.
			const cacheKey = contentHash(
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
			);
			const stateKey = StateStoreKeys.dockerOneShot({
				name: options.name,
				inputsHash: cacheKey,
			});

			const store = yield* StateStore;
			const cached = yield* store.get<DockerOneShotResult>(stateKey);
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
							phase: 'dockerOneShot',
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
			yield* store.put(stateKey, out);
			return out;
		}).pipe(Effect.withSpan(`DockerOneShot(${options.name})`)),
		{
			kind: 'action',
			displayTitle: options.name,
			display: (s) => ({
				title: options.name,
				primary: `exit ${s.exitCode}${s.cached ? ' (cached)' : ''}`,
			}),
			// Forward `dependsOn:` into the dep graph as `__upstreamKeys`.
			upstreamKeys: options.dependsOn ?? [],
		},
	);
