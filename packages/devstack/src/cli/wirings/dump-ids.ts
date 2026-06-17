// `devstack dump-ids` verb wiring.
//
// Emits the stack's `devstack-ids.json` id-config — the single source of
// on-chain ids (see `orchestrators/codegen/id-config.ts`). This is the
// supported way to obtain a committed id-config file for a real-network
// deploy (docs' "Deploy to a real network / Option A"), replacing the
// manual `cp .devstack/stacks/<stack>/devstack-ids.json …`.
//
// Live-aware, mirroring `apply.ts` / `snapshot.ts`:
//   - If a supervisor owns the selected stack (roster probe), the
//     id-config already exists on disk — boot's post-acquire hook wrote
//     it (`boot.ts buildProductionPostAcquireHook`). Read + emit it; NO
//     re-boot.
//   - Otherwise, run the SAME one-shot boot `apply` runs when no
//     supervisor is live (`runApplyLive` → `superviseStackWithProductionBoot`
//     with `lifetime: 'one-shot'`). That boots, writes the id-config to
//     `<stackRoot>/devstack-ids.json`, and tears down. We then read the
//     freshly-written file and emit it.
//
// The on-disk file is already pretty-printed by `writeIdConfig`
// (`JSON.stringify(config, null, 2)\n`), so `--out` copies its bytes
// verbatim and stdout prints them verbatim — the format matches the
// boot-written file exactly.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { Effect, Exit } from 'effect';

import type { SupervisedStack } from '../../substrate/runtime/index.ts';
import { decodeIdConfig, ID_CONFIG_FILENAME } from '../../orchestrators/codegen/id-config.ts';
import { type CliError, CliInternalError } from '../../surfaces/cli/errors.ts';
import { type CommandResult } from '../../surfaces/cli/commands/index.ts';
import { probeSupervisorPresence } from '../../surfaces/cli/commands/index.ts';
import { ExitCode } from '../../surfaces/cli/sysexits.ts';
import { type CliIO, emitSuccess } from '../../surfaces/cli/output.ts';
import type { OutputMode } from '../../surfaces/cli/flags.ts';
import type { LoadedConfig } from '../../surfaces/cli/commands/config-loader.ts';

import { cliErrorFromConfigExit } from '../bail.ts';
import { makeConfigLoader } from './config-loader.ts';
import { resolvedIdentityForStack, type ResolvedIdentity } from './identity.ts';
import { runApplyLive } from './apply.ts';

export interface DumpIdsOptions {
	readonly configPath: string | undefined;
	/** Destination for the pretty id-config JSON. When omitted, the JSON
	 *  is printed to stdout. */
	readonly out: string | undefined;
	readonly io: CliIO;
	readonly outputMode: OutputMode;
}

/** Read the on-disk id-config as raw text. The file is written by boot's
 *  post-acquire hook (`writeIdConfig`) at `<stackRoot>/devstack-ids.json`;
 *  a miss here means the boot never produced it (or a hand-removal), which
 *  is an internal inconsistency the operator can't act on directly. */
const readIdConfigText = (idsFile: string): Effect.Effect<string, CliError> =>
	Effect.try({
		try: () => readFileSync(idsFile, 'utf8'),
		catch: (cause) =>
			new CliInternalError({
				message: `failed to read id-config at ${idsFile}`,
				cause,
			}),
	});

const writeOutFile = (out: string, text: string): Effect.Effect<void, CliError> =>
	Effect.try({
		try: () => writeFileSync(out, text, 'utf8'),
		catch: (cause) =>
			new CliInternalError({ message: `failed to write id-config to ${out}`, cause }),
	});

/** Decode the id-config text for the JSON envelope `data`, routed through
 *  the shared {@link decodeIdConfig} so the parse-and-validate decision is
 *  centralized (same seam the Vite plugin and codegen verb use). A failure
 *  here means the on-disk file is corrupt — bad JSON OR a shape that
 *  violates `IdConfigSchema` — so surface it rather than emit a bad
 *  envelope. (The file is written by `writeIdConfig` from the same schema,
 *  so a conforming boot-written file always decodes; only a corrupt or
 *  hand-edited file trips the stricter validation.) */
const parseIdConfig = (text: string, idsFile: string): Effect.Effect<unknown, CliError> =>
	Effect.try({
		try: () => decodeIdConfig(text),
		catch: (cause) =>
			new CliInternalError({ message: `id-config at ${idsFile} is not valid JSON`, cause }),
	});

export const runDumpIds = (
	identity: ResolvedIdentity,
	opts: DumpIdsOptions,
): Effect.Effect<CommandResult, CliError> => {
	const loader = makeConfigLoader();
	return Effect.gen(function* () {
		const started = Date.now();

		// Resolve identity against the EFFECTIVE stack (explicit
		// `--stack`/env > `config.stackName` > inferred), matching `apply` /
		// `snapshot`, so the roster probe + id-config path target the same
		// stack the operator selected.
		const loadExit = yield* Effect.exit(loader.load(opts.configPath));
		if (Exit.isFailure(loadExit)) {
			return yield* Effect.fail(cliErrorFromConfigExit(loadExit));
		}
		const stack = (loadExit.value as LoadedConfig & { readonly engine: SupervisedStack }).engine;
		const effectiveIdentity = resolvedIdentityForStack(identity, stack);
		const idsFile = resolvePath(effectiveIdentity.stackRoot, ID_CONFIG_FILENAME);

		// Live supervisor? The id-config already exists on disk (boot wrote
		// it). Otherwise run the one-shot boot `apply` runs when nothing is
		// live — it writes the id-config to `idsFile` and tears down — then
		// read the file it produced.
		const presence = yield* probeSupervisorPresence(effectiveIdentity.rosterFile).pipe(
			Effect.catch(() => Effect.succeed({ live: false, pid: null, hostname: null })),
		);
		if (!presence.live) {
			// `runApplyLive` re-probes (sees no live supervisor) and runs the
			// one-shot boot; its config-load / boot failures already surface as
			// typed `CliError`s. We pass the ORIGINAL identity — `runApplyLive`
			// re-derives the effective stack from the same config internally.
			yield* runApplyLive(opts.configPath, identity);
		}

		const text = yield* readIdConfigText(idsFile);
		const data = yield* parseIdConfig(text, idsFile);

		if (opts.out !== undefined) {
			yield* writeOutFile(opts.out, text);
			yield* emitSuccess(opts.io, opts.outputMode, {
				command: 'dump-ids',
				elapsedMs: Date.now() - started,
				data,
				humanLines: [`wrote id-config to ${opts.out}`],
			});
			return { exitCode: ExitCode.OK };
		}

		// No `--out`: print the id-config JSON to stdout. In human mode the
		// raw pretty JSON IS the output (trailing newline trimmed by the IO
		// layer); in JSON mode the same object rides the success envelope's
		// `data`.
		yield* emitSuccess(opts.io, opts.outputMode, {
			command: 'dump-ids',
			elapsedMs: Date.now() - started,
			data,
			humanLines: [text.endsWith('\n') ? text.slice(0, -1) : text],
		});
		return { exitCode: ExitCode.OK };
	});
};
