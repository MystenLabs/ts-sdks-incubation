// `devstack apply` — one-shot reconcile.
//
// Boots the user's devstack config exactly like `up`, but instead of
// `Layer.launch`-ing into a long-running fiber, we acquire the layer via
// `Layer.build` inside `Effect.scoped`. That builds every primitive
// (state.json is repopulated, manifest finalizer is registered), then
// the surrounding scope closes which fires the manifest finalizer and
// tears everything down. The CLI exits.
//
// Useful for CI: bring the stack up, write state + manifest, exit clean.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Console, Effect, Layer, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prettyError } from '../../internal/pretty-error.js';

// Preserve the underlying cause on `Error.cause` so the CLI's top-level
// `tapCause` renderer can walk the full chain instead of collapsing to the
// outer `Error.toString()`. The single-line summary keeps the legacy
// `Error.message` shape that callers and the JSON path read.
const wrapCause = (message: string, cause: unknown): Error => {
	const err = new Error(`${message}: ${prettyError(cause).split('\n')[0]}`);
	(err as Error & { cause?: unknown }).cause = cause;
	return err;
};

interface DevstackLike {
	readonly layer: Layer.Layer<any, any, any>;
}

const loadDevstack = (configPath: string) =>
	Effect.gen(function* () {
		const absolute = resolvePath(process.cwd(), configPath);
		const url = pathToFileURL(absolute).href;
		const mod = yield* Effect.tryPromise({
			try: () => import(url) as Promise<{ default?: unknown }>,
			catch: (cause) => wrapCause(`failed to load ${configPath}`, cause),
		});
		const devstack = mod.default as Partial<DevstackLike> | undefined;
		if (!devstack || typeof devstack.layer === 'undefined') {
			return yield* Effect.fail(
				new Error(`${configPath} must default-export a Devstack (from defineDevstack)`),
			);
		}
		return devstack as DevstackLike;
	});

export const applyCommand = Command.make(
	'apply',
	{
		configPath: Argument.string('config-path').pipe(Argument.optional),
		json: Flag.boolean('json'),
	},
	({ configPath, json }) =>
		Effect.gen(function* () {
			const resolved = Option.getOrElse(configPath, () => './devstack.config.ts');
			const devstack = yield* loadDevstack(resolved);

			// `Layer.build` inside `Effect.scoped` acquires every primitive,
			// then closes the scope on exit — that's what fires the manifest
			// finalizer (and every other teardown registered during acquire).
			const buildEffect = Effect.gen(function* () {
				yield* Layer.build(devstack.layer);
			}).pipe(Effect.scoped) as Effect.Effect<void, unknown, never>;

			// Render success/failure ourselves so `--json` can emit a
			// structured summary instead of letting the CLI runtime swallow
			// the error through its default handler. The Effect still fails
			// at the end on error so the process exits non-zero.
			const reportAndRethrow = (cause: unknown) =>
				Effect.gen(function* () {
					if (json) {
						// Multi-line cause tree per-entry so a stderr-bearing
						// `DockerError` nested under a `SuiError` lands in the
						// CLI's `--json` output without being collapsed to a
						// single class name.
						yield* Console.log(
							JSON.stringify({
								ok: false,
								command: 'apply',
								configPath: resolved,
								errors: [prettyError(cause)],
							}),
						);
					} else {
						yield* Console.error(`apply failed:\n${prettyError(cause)}`);
					}
					return yield* Effect.fail(cause as Error);
				});

			yield* buildEffect.pipe(Effect.catch(reportAndRethrow));

			if (json) {
				yield* Console.log(
					JSON.stringify({
						ok: true,
						command: 'apply',
						configPath: resolved,
					}),
				);
			} else {
				yield* Console.log(`apply ok — state + manifest written for ${resolved}`);
			}
		}),
).pipe(
	Command.withDescription(
		'One-shot reconcile: build the stack, write state.json + manifest.json, exit',
	),
);
