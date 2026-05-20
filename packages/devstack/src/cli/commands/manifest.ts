// `devstack manifest` — print the current devstack manifest.json.
// Default: human-readable summary (endpoints / packages / accounts / coins
// / extras), mirroring the `status` command's shape via the shared
// `renderManifestBody` helper. `--json` emits the canonical envelope
// wrapping the parsed manifest. `--path` overrides the discovered path.
//
// Read-only — does NOT build any layers, so it's safe against a live stack.
//
// Path resolution: routes through `discoverManifestPath()` so the
// `DEVSTACK_MANIFEST_PATH` env var, `DEVSTACK_STACK`, and walk-up from cwd
// are all honored — matching how the runtime / playwright fixtures find
// the same file. The supervisor writes to
// `<stateDir>/stacks/<stack>/manifest.json`.

import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { readStackContext } from '../../runtime/read-stack-context.js';
import { failAlreadyReported } from '../already-reported.js';
import { emitEnvelope, jsonModeEnabled, successEnvelope } from '../envelope.js';
import { renderManifestBody } from './_manifest-render.js';

export const manifestCommand = Command.make(
	'manifest',
	{
		path: Argument.string('path').pipe(Argument.optional),
		json: Flag.boolean('json').pipe(
			Flag.withDescription('Print raw manifest JSON instead of a human-readable summary'),
		),
	},
	({ path, json }) =>
		readStackContext({ manifestPath: Option.getOrUndefined(path) }).pipe(
			Effect.flatMap((ctx) =>
				Effect.gen(function* () {
					const startedAt = Date.now();
					const useJson = jsonModeEnabled(json);
					if (useJson) {
						// Wrap the parsed manifest in the canonical envelope.
						// Pre-Phase A, `manifest --json` emitted the raw bytes;
						// the data field now carries the parsed manifest
						// (typed via Schema in readStackContext) plus the path,
						// matching every other envelope-aware command.
						yield* emitEnvelope(
							successEnvelope({
								command: 'manifest',
								data: {
									path: ctx.manifestPath,
									manifest: ctx.manifest,
								},
								elapsedMs: Date.now() - startedAt,
							}),
						);
						return;
					}

					yield* Console.log(`devstack manifest`);
					yield* Console.log(`  path: ${ctx.manifestPath}`);

					const bodyLines = renderManifestBody(ctx.manifest, true);
					for (const line of bodyLines) {
						yield* Console.log(line);
					}
					if (bodyLines.length === 0) {
						yield* Console.log(`  (empty)`);
					}
				}),
			),
			Effect.catchTags({
				ManifestDiscoveryError: (cause) => failAlreadyReported(cause.message),
				ManifestShapeError: (cause) => failAlreadyReported(cause.message),
			}),
		),
).pipe(Command.withDescription('Print the current `.devstack/manifest.json`'));
