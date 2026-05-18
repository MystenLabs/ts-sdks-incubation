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

import { Console, Effect, Layer, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { causeToJson, prettyError } from '../../engine/pretty-error.js';
import { AlreadyReportedError } from '../already-reported.js';
import { applyNetworkOverride, networkFlag } from '../flags.js';
import { loadConfigModule, requireLayer } from '../loaders.js';

export const applyCommand = Command.make(
	'apply',
	{
		configPath: Argument.string('config-path').pipe(Argument.optional),
		json: Flag.boolean('json'),
		network: networkFlag,
	},
	({ configPath, json, network }) =>
		Effect.gen(function* () {
			applyNetworkOverride(network);
			const resolved = Option.getOrElse(configPath, () => './devstack.config.ts');
			const devstack = yield* loadConfigModule(resolved, requireLayer);

			// `Layer.build` inside `Effect.scoped` acquires every primitive,
			// then closes the scope on exit — that's what fires the manifest
			// finalizer (and every other teardown registered during acquire).
			const buildEffect = Effect.gen(function* () {
				yield* Layer.build(devstack.layer);
			}).pipe(Effect.scoped) as Effect.Effect<void, unknown, never>;

			// Render success/failure ourselves so `--json` can emit a
			// structured summary instead of letting the CLI runtime swallow
			// the error through its default handler. The Effect still fails
			// at the end on error so the process exits non-zero — but we
			// raise `AlreadyReportedError` instead of re-failing with the
			// raw cause so the top-level `tapCause` doesn't double-print.
			const reportAndRethrow = (cause: unknown) =>
				Effect.gen(function* () {
					if (json) {
						// Structured JSON cause tree so a stderr-bearing
						// `DockerError` nested under a `SuiError` rides through
						// with `_tag` / `stderr` / `exitCode` / `phase`
						// preserved as fields — consumers can match on them
						// without parsing a multi-line string.
						yield* Console.log(
							JSON.stringify({
								ok: false,
								command: 'apply',
								configPath: resolved,
								error: causeToJson(cause),
							}),
						);
					} else {
						yield* Console.error(`apply failed:\n${prettyError(cause)}`);
					}
					return yield* Effect.fail(new AlreadyReportedError({ cause }));
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
