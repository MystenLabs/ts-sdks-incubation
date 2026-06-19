// `devstack dump-deployment` verb wiring.
//
// Emits the stack's `deployment.json` deployment — the single source of
// on-chain ids (see `orchestrators/codegen/deployment.ts`). This is the
// supported way to obtain a committed deployment file for a real-network
// deploy (docs' "Deploy to a real network / Option A"), replacing the
// manual `cp .devstack/stacks/<stack>/deployment.json …`.
//
// Live-aware, mirroring `apply.ts` / `snapshot.ts`:
//   - If a supervisor owns the selected stack (roster probe), the
//     deployment already exists on disk — boot's post-acquire hook wrote
//     it (`boot.ts buildProductionPostAcquireHook`). Read + emit it; NO
//     re-boot.
//   - Otherwise, run the SAME one-shot boot `apply` runs when no
//     supervisor is live (`runApplyLive` → `superviseStackWithProductionBoot`
//     with `lifetime: 'one-shot'`). That boots, writes the deployment to
//     `<stackRoot>/deployment.json`, and tears down. We then read the
//     freshly-written file and emit it.
//
// The on-disk file is already pretty-printed by `writeDeployment`
// (`JSON.stringify(config, null, 2)\n`), so `--out` copies its bytes
// verbatim and stdout prints them verbatim — the format matches the
// boot-written file exactly.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

import { Effect, Exit } from 'effect';

import type { SupervisedStack } from '../../substrate/runtime/index.ts';
import {
	decodeDeployment,
	DEPLOYMENT_FILENAME,
	type DevstackDeployment,
} from '../../orchestrators/codegen/deployment.ts';
import {
	deploymentBody,
	DEPLOYMENTS_DIRNAME,
	renderNetworkDeploymentFile,
} from '../../orchestrators/codegen/deployment-network-file.ts';
import { LOCAL_NETWORK_NAME } from '../../api/inference-network.ts';
import { type CliError, CliInternalError, CliUsageError } from '../../surfaces/cli/errors.ts';
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

export interface DumpDeploymentOptions {
	readonly configPath: string | undefined;
	/** Destination for the pretty deployment JSON. When omitted (and no
	 *  `--network`), the JSON is printed to stdout. */
	readonly out: string | undefined;
	/** When set, write a TYPED single-network `deployments/<network>.ts`
	 *  (`export const deployment = {…} satisfies AppNetworkDeployment`) sourced
	 *  from the resolved envelope's `networks.<network>` entry, instead of
	 *  dumping the raw envelope JSON. The committed, `tsc`-checked authoring
	 *  surface for a real-network deploy. */
	readonly network: string | undefined;
	readonly io: CliIO;
	readonly outputMode: OutputMode;
}

/** Read the on-disk deployment as raw text. The file is written by boot's
 *  post-acquire hook (`writeDeployment`) at `<stackRoot>/deployment.json`;
 *  a miss here means the boot never produced it (or a hand-removal), which
 *  is an internal inconsistency the operator can't act on directly. */
const readDeploymentText = (deploymentFile: string): Effect.Effect<string, CliError> =>
	Effect.try({
		try: () => readFileSync(deploymentFile, 'utf8'),
		catch: (cause) =>
			new CliInternalError({
				message: `failed to read deployment at ${deploymentFile}`,
				cause,
			}),
	});

const writeOutFile = (out: string, text: string): Effect.Effect<void, CliError> =>
	Effect.try({
		try: () => writeFileSync(out, text, 'utf8'),
		catch: (cause) =>
			new CliInternalError({ message: `failed to write deployment to ${out}`, cause }),
	});

/** Decode the deployment text for the JSON envelope `data`, routed through
 *  the shared {@link decodeDeployment} so the parse-and-validate decision is
 *  centralized (same seam the Vite plugin and codegen verb use). A failure
 *  here means the on-disk file is corrupt — bad JSON OR a shape that
 *  violates `DeploymentSchema` — so surface it rather than emit a bad
 *  envelope. (The file is written by `writeDeployment` from the same schema,
 *  so a conforming boot-written file always decodes; only a corrupt or
 *  hand-edited file trips the stricter validation.) */
const parseDeployment = (
	text: string,
	deploymentFile: string,
): Effect.Effect<DevstackDeployment, CliError> =>
	Effect.try({
		try: () => decodeDeployment(text),
		catch: (cause) =>
			new CliInternalError({
				// `decodeDeployment` throws on BOTH malformed JSON AND a shape that
				// violates `DeploymentSchema`, so the message must cover both causes.
				message: `could not decode deployment at ${deploymentFile} (malformed JSON or invalid shape)`,
				cause,
			}),
	});

/** The project root the `deployments/<net>.ts` file is written relative to:
 *  the directory of the resolved `devstack.config.ts` (so a `--config` in a
 *  subdir still lands `deployments/` next to that app's `src/`), else the
 *  process cwd. */
const projectRootOf = (configPath: string | undefined): string =>
	configPath === undefined ? process.cwd() : dirname(resolvePath(configPath));

/** Render + write the typed `deployments/<network>.ts` for `network` from the
 *  resolved envelope, creating the `deployments/` dir if absent. Loud-fails
 *  (usage error) when the envelope carries no such network — listing the ones
 *  it does, so the operator can pick a valid name. */
const writeNetworkDeploymentFile = (
	envelope: DevstackDeployment,
	network: string,
	projectRoot: string,
): Effect.Effect<string, CliError> =>
	Effect.gen(function* () {
		const unit = envelope.networks[network];
		if (unit === undefined) {
			const available = Object.keys(envelope.networks).sort().join(', ');
			return yield* Effect.fail(
				new CliUsageError({
					message: `the resolved deployment has no network "${network}"`,
					hint:
						available.length > 0
							? `available networks: ${available}`
							: 'the deployment carries no networks',
				}),
			);
		}
		// A committed `deployments/<net>.ts` is non-local by definition
		// (deployment-network-file.ts header) — it is the authoring surface for a
		// REAL-network deploy. The live local stack's envelope is keyed under
		// `localnet` with `local: true`, so `--network localnet` (or any unit
		// flagged `local`) must be rejected rather than write a committed file
		// that captures the throwaway dev stack.
		if (network === LOCAL_NETWORK_NAME || unit.local === true) {
			return yield* Effect.fail(
				new CliUsageError({
					message: `cannot dump the live local network "${network}" as a committed deployment`,
					hint: 'committed deployments are for real networks; pick a non-local --network (e.g. testnet, mainnet)',
				}),
			);
		}
		const rendered = renderNetworkDeploymentFile(network, unit);
		if (!rendered.ok) {
			return yield* Effect.fail(
				new CliInternalError({
					message: `failed to render deployments/${network}.ts`,
					cause: rendered.error,
				}),
			);
		}
		const dir = resolvePath(projectRoot, DEPLOYMENTS_DIRNAME);
		const outFile = resolvePath(dir, `${network}.ts`);
		yield* Effect.try({
			try: () => {
				mkdirSync(dir, { recursive: true });
				writeFileSync(outFile, rendered.text, 'utf8');
			},
			catch: (cause) => new CliInternalError({ message: `failed to write ${outFile}`, cause }),
		});
		return outFile;
	});

export const runDumpDeployment = (
	identity: ResolvedIdentity,
	opts: DumpDeploymentOptions,
): Effect.Effect<CommandResult, CliError> => {
	const loader = makeConfigLoader();
	return Effect.gen(function* () {
		const started = Date.now();

		// Resolve identity against the EFFECTIVE stack (explicit
		// `--stack`/env > `config.stackName` > inferred), matching `apply` /
		// `snapshot`, so the roster probe + deployment path target the same
		// stack the operator selected.
		const loadExit = yield* Effect.exit(loader.load(opts.configPath));
		if (Exit.isFailure(loadExit)) {
			return yield* Effect.fail(cliErrorFromConfigExit(loadExit));
		}
		const stack = (loadExit.value as LoadedConfig & { readonly engine: SupervisedStack }).engine;
		const effectiveIdentity = resolvedIdentityForStack(identity, stack);
		const deploymentFile = resolvePath(effectiveIdentity.stackRoot, DEPLOYMENT_FILENAME);

		// Live supervisor? The deployment already exists on disk (boot wrote
		// it). Otherwise run the one-shot boot `apply` runs when nothing is
		// live — it writes the deployment to `deploymentFile` and tears down — then
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

		const text = yield* readDeploymentText(deploymentFile);
		const data = yield* parseDeployment(text, deploymentFile);

		// `--network <net>`: emit a TYPED single-network `deployments/<net>.ts`
		// (`satisfies AppNetworkDeployment`) instead of the raw envelope. Sourced
		// from the resolved envelope's `networks.<net>` entry — the same data
		// `assembleDeployment` produced — written next to the app's `src/`.
		if (opts.network !== undefined) {
			const projectRoot = projectRootOf(opts.configPath);
			const outFile = yield* writeNetworkDeploymentFile(data, opts.network, projectRoot);
			// The JSON `data` must mirror the file actually written — the NORMALIZED
			// body (network re-derived from the arg, dev-only `local` dropped), NOT
			// the raw envelope unit (which still carries `local` + the boot-written
			// `network`). `writeNetworkDeploymentFile` already guaranteed the unit
			// exists, so the lookup here is non-undefined.
			const writtenUnit = data.networks[opts.network]!;
			yield* emitSuccess(opts.io, opts.outputMode, {
				command: 'dump-deployment',
				elapsedMs: Date.now() - started,
				data: deploymentBody(opts.network, writtenUnit),
				humanLines: [`wrote ${outFile}`],
			});
			return { exitCode: ExitCode.OK };
		}

		if (opts.out !== undefined) {
			yield* writeOutFile(opts.out, text);
			yield* emitSuccess(opts.io, opts.outputMode, {
				command: 'dump-deployment',
				elapsedMs: Date.now() - started,
				data,
				humanLines: [`wrote deployment to ${opts.out}`],
			});
			return { exitCode: ExitCode.OK };
		}

		// No `--out`: print the deployment JSON to stdout. In human mode the
		// raw pretty JSON IS the output (trailing newline trimmed by the IO
		// layer); in JSON mode the same object rides the success envelope's
		// `data`.
		yield* emitSuccess(opts.io, opts.outputMode, {
			command: 'dump-deployment',
			elapsedMs: Date.now() - started,
			data,
			humanLines: [text.endsWith('\n') ? text.slice(0, -1) : text],
		});
		return { exitCode: ExitCode.OK };
	});
};
