// CLI surface — top-level entry point.
//
// The public CLI is intentionally small: `up` is the attached operator
// surface, `apply` is live-aware reconcile (publish to `up` when it is
// running, one-shot otherwise), and every other command is offline/direct.

import {
	buildApplication,
	buildChoiceParser,
	buildCommand,
	buildRouteMap,
	run as runStricli,
	text_en,
	type CommandContext as StricliCommandContext,
	type StricliProcess,
} from '@stricli/core';
import { Effect, type Scope } from 'effect';
import { readFileSync } from 'node:fs';

import { commandSchema } from './command-tree.ts';
import { type CliError, CliInternalError, CliUsageError, exitCodeFor } from './errors.ts';
import {
	type CliRendererMode,
	ENV_VARS,
	type GlobalFlags,
	type OutputMode,
	type SnapshotStalePolicy,
} from './flags.ts';
import { ExitCode } from './sysexits.ts';
import { parseDevstackNetworkName } from '../../api/inference-network.ts';
import { type CliIO, emitFailure, emitSuccess, nodeProcessIO } from './output.ts';
import {
	type CommandResult,
	type ConfigDeps,
	type DoctorDeps,
	type PruneDeps,
	type PruneResourceScope,
	type SnapshotDeps,
	type StatusDeps,
	type WipeDeps,
	runConfig,
	runDoctor,
	runPrune,
	runSnapshot,
	runStatus,
	runWipe,
} from './commands/index.ts';

const readPackageVersion = (): string => {
	const raw = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
	const pkg = JSON.parse(raw) as { readonly version?: unknown };
	if (typeof pkg.version !== 'string') {
		throw new Error('devstack package.json is missing a string version');
	}
	return pkg.version;
};

// -----------------------------------------------------------------------------
// Deps bundle
// -----------------------------------------------------------------------------

export interface LifecycleCommandDeps {
	readonly run: (flags: GlobalFlags) => Effect.Effect<CommandResult, CliError>;
}

export interface CliDeps {
	readonly up: LifecycleCommandDeps;
	readonly apply: LifecycleCommandDeps;
	readonly status: StatusDeps;
	readonly snapshot: SnapshotDeps;
	readonly prune: PruneDeps;
	readonly doctor: DoctorDeps;
	readonly config: ConfigDeps;
	readonly wipe: WipeDeps;
}

export interface DispatchEnv {
	readonly argv: ReadonlyArray<string>;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdinIsTty: boolean;
	readonly io?: CliIO;
}

// -----------------------------------------------------------------------------
// Stricli context + buffered process
// -----------------------------------------------------------------------------

interface BufferedProcess extends StricliProcess {
	readonly stdoutBuffer: Array<string>;
	readonly stderrBuffer: Array<string>;
	exitCode?: number | string | null;
}

interface TrackedIO extends CliIO {
	readonly touched: () => boolean;
	readonly lastExitCode: () => number | null;
}

interface DevstackCliContext extends StricliCommandContext {
	readonly deps: CliDeps;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdinIsTty: boolean;
	readonly io: TrackedIO;
	readonly process: BufferedProcess;
}

const makeBufferedProcess = (
	env: Readonly<Record<string, string | undefined>>,
): BufferedProcess => {
	const stdoutBuffer: Array<string> = [];
	const stderrBuffer: Array<string> = [];
	return {
		stdoutBuffer,
		stderrBuffer,
		env,
		stdout: {
			write: (str) => {
				stdoutBuffer.push(str);
			},
		},
		stderr: {
			write: (str) => {
				stderrBuffer.push(str);
			},
		},
	};
};

const trackIO = (io: CliIO): TrackedIO => {
	let touched = false;
	let lastExitCode: number | null = null;
	return {
		touched: () => touched,
		lastExitCode: () => lastExitCode,
		writeStdout: (line) =>
			io.writeStdout(line).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						touched = true;
					}),
				),
			),
		writeStderr: (line) =>
			io.writeStderr(line).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						touched = true;
					}),
				),
			),
		setExitCode: (code) =>
			io.setExitCode(code).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						touched = true;
						lastExitCode = code;
					}),
				),
			),
	};
};

// -----------------------------------------------------------------------------
// Flag models
// -----------------------------------------------------------------------------

interface IdentityFlags {
	readonly json?: boolean;
	readonly app?: string;
	readonly stack?: string;
	readonly stateDir?: string;
	readonly verbose?: boolean;
}

interface ConfigFlags extends IdentityFlags {
	readonly config?: string;
	readonly network?: string;
}

interface UpFlags extends ConfigFlags {
	readonly renderer?: CliRendererMode;
	readonly fromSnapshot?: string;
	readonly snapshotCache?: string;
	readonly snapshotStale?: SnapshotStalePolicy;
}

interface DestructiveFlags extends IdentityFlags {
	readonly dryRun?: boolean;
	readonly yes?: boolean;
	readonly noInput?: boolean;
}

interface ConfirmFlags extends IdentityFlags {
	readonly yes?: boolean;
	readonly noInput?: boolean;
}

interface PruneFlags {
	readonly json?: boolean;
	readonly stateDir?: string;
	readonly verbose?: boolean;
	readonly dryRun?: boolean;
	readonly yes?: boolean;
	readonly noInput?: boolean;
	readonly list?: boolean;
	readonly all?: boolean;
	readonly noContainers?: boolean;
	readonly noNetworks?: boolean;
	readonly noVolumes?: boolean;
	readonly includeImages?: boolean;
}

interface SnapshotSaveFlags extends ConfigFlags {
	readonly name?: string;
}

const textParser = (input: string): string => input;

const stringFlag = (brief: string, placeholder: string) =>
	({
		kind: 'parsed',
		parse: textParser,
		optional: true,
		placeholder,
		brief,
	}) as const;

const boolFlag = (brief: string) =>
	({
		kind: 'boolean',
		optional: true,
		brief,
	}) as const;

const identityFlagParams = {
	json: boolFlag('Emit JSON envelope output'),
	app: stringFlag('Override app name', 'name'),
	stack: stringFlag('Override stack name', 'name'),
	stateDir: stringFlag('Override state directory', 'path'),
	verbose: boolFlag('Enable more verbose logging'),
} as const;

const configFlagParams = {
	...identityFlagParams,
	config: stringFlag('Override devstack.config.ts path', 'path'),
	network: stringFlag('Override network before config import', 'name'),
} as const;

const destructiveFlagParams = {
	...identityFlagParams,
	dryRun: boolFlag('Skip mutating effects'),
	yes: boolFlag('Assume yes on prompts'),
	noInput: boolFlag('Forbid prompts'),
} as const;

const globalMaintenanceFlagParams = {
	json: identityFlagParams.json,
	stateDir: identityFlagParams.stateDir,
	verbose: identityFlagParams.verbose,
} as const;

const confirmFlagParams = {
	...identityFlagParams,
	yes: boolFlag('Assume yes on prompts'),
	noInput: boolFlag('Forbid prompts'),
} as const;

const pruneFlagParams = {
	...globalMaintenanceFlagParams,
	dryRun: destructiveFlagParams.dryRun,
	yes: destructiveFlagParams.yes,
	noInput: destructiveFlagParams.noInput,
	list: boolFlag('List devstack-labelled Docker resources without pruning'),
	all: boolFlag('Prune every idle non-shared resource group'),
	noContainers: boolFlag('Do not remove containers'),
	noNetworks: boolFlag('Do not remove networks'),
	noVolumes: boolFlag('Do not remove volumes'),
	includeImages: boolFlag('Also remove devstack-labelled images for selected groups'),
} as const;

const rendererParser = buildChoiceParser(['tui', 'plain', 'silent'] as const);
const snapshotStaleParser = buildChoiceParser(['warn', 'block', 'clean-start'] as const);

const outputModeFrom = (
	flags: Pick<IdentityFlags, 'json'>,
	env: Readonly<Record<string, string | undefined>>,
): OutputMode => (flags.json === true || env[ENV_VARS.JSON] === '1' ? 'json' : 'human');

const pruneResourcesFromFlags = (flags: PruneFlags): PruneResourceScope => ({
	containers: flags.noContainers !== true,
	networks: flags.noNetworks !== true,
	volumes: flags.noVolumes !== true,
	images: flags.includeImages === true,
});

const optionalEnv = (
	value: string | undefined,
	env: Readonly<Record<string, string | undefined>>,
	key: string,
): string | undefined => value ?? env[key];

const makeGlobalFlags = (
	ctx: DevstackCliContext,
	flags: IdentityFlags & Partial<ConfigFlags & UpFlags & DestructiveFlags>,
	rest: ReadonlyArray<string>,
): GlobalFlags => {
	const networkRaw = optionalEnv(flags.network, ctx.env, ENV_VARS.NETWORK);
	let network: string | undefined;
	if (networkRaw !== undefined) {
		try {
			network = parseDevstackNetworkName(
				networkRaw,
				flags.network === undefined ? ENV_VARS.NETWORK : '--network',
			);
		} catch (cause) {
			throw cause instanceof Error
				? new CliUsageError({ message: cause.message })
				: new CliInternalError({ message: 'failed to parse network flag', cause });
		}
	}
	return {
		outputMode: outputModeFrom(flags, ctx.env),
		app: optionalEnv(flags.app, ctx.env, ENV_VARS.APP),
		stack: optionalEnv(flags.stack, ctx.env, ENV_VARS.STACK),
		stateDir: optionalEnv(flags.stateDir, ctx.env, ENV_VARS.STATE_DIR),
		configPath: optionalEnv(flags.config, ctx.env, ENV_VARS.CONFIG_PATH),
		network,
		renderer: flags.renderer,
		fromSnapshot: flags.fromSnapshot,
		snapshotCache: flags.snapshotCache,
		snapshotStalePolicy: flags.snapshotStale,
		dryRun: flags.dryRun === true,
		confirm: {
			assumeYes: flags.yes === true,
			forbidPrompt: flags.noInput === true || ctx.env[ENV_VARS.NO_INPUT] === '1',
			stdinIsTty: ctx.stdinIsTty,
		},
		verbose: flags.verbose === true,
		rest,
	};
};

/**
 * Bridge the CLI `--network` flag through `process.env` so config-load-time
 * factory reads pick it up. This indirection is deliberate, not a leak.
 *
 * Why the mutation exists:
 *   The `deepbook()` factory (`plugins/deepbook/index.ts`) defaults its mode
 *   by reading `process.env.DEVSTACK_NETWORK` at config import time — before
 *   any flag value has reached the orchestrator. To make `--network` affect
 *   the same default, we must mutate the env BEFORE the user's
 *   `devstack.config.ts` is loaded. The chain is:
 *     `--network=<net>` flag  →  setNetworkEnv  →  `process.env.DEVSTACK_NETWORK`
 *                              →  `deepbook()` factory's env read at import.
 *
 * Why save/restore (and a scoped finalizer) matters:
 *   The CLI is also invoked from tests and embedded harnesses inside a single
 *   process. An unscoped mutation leaks across invocations: a test that runs
 *   `dispatch(['up','--network=testnet'])` followed by `dispatch(['up'])`
 *   would see the second call inherit `testnet` from the first. The
 *   finalizer restores the prior value (or deletes the key if it was unset)
 *   on success, failure, AND interrupt — `Effect.addFinalizer` guarantees
 *   the cleanup runs regardless of how the scope closes.
 */
const setNetworkEnv = (flags: GlobalFlags): Effect.Effect<void, never, Scope.Scope> => {
	if (flags.network === undefined) return Effect.void;
	const next = flags.network;
	return Effect.gen(function* () {
		const prior = process.env[ENV_VARS.NETWORK];
		process.env[ENV_VARS.NETWORK] = next;
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				if (prior === undefined) {
					delete process.env[ENV_VARS.NETWORK];
				} else {
					process.env[ENV_VARS.NETWORK] = prior;
				}
			}),
		);
	});
};

// -----------------------------------------------------------------------------
// Command execution helpers
// -----------------------------------------------------------------------------

const runCommandEffect = async (
	ctx: DevstackCliContext,
	command: string,
	flags: GlobalFlags,
	effect: Effect.Effect<CommandResult, CliError>,
): Promise<void> => {
	// `setNetworkEnv` registers a `process.env[ENV_VARS.NETWORK]` restore as a
	// scope finalizer; the outer `Effect.scoped` closes that scope after the
	// command completes (success, failure, or interrupt), preventing env leaks
	// between concurrent CLI invocations in the same process.
	const program = Effect.scoped(
		setNetworkEnv(flags).pipe(
			Effect.andThen(effect),
			Effect.catch((error: CliError) =>
				emitFailure(ctx.io, flags.outputMode, {
					command,
					elapsedMs: 0,
					error,
				}).pipe(Effect.as({ exitCode: exitCodeFor(error) })),
			),
			Effect.catchCause((cause) =>
				emitFailure(ctx.io, flags.outputMode, {
					command,
					elapsedMs: 0,
					error: new CliInternalError({ message: 'unexpected internal failure' }),
					cause,
				}).pipe(Effect.as({ exitCode: ExitCode.SOFTWARE })),
			),
		),
	);
	const result = await Effect.runPromise(program);
	if (ctx.io.lastExitCode() === null) {
		await Effect.runPromise(ctx.io.setExitCode(result.exitCode));
	}
};

const runWithFlags = async (
	ctx: DevstackCliContext,
	command: string,
	rawFlags: IdentityFlags & Partial<ConfigFlags & UpFlags & DestructiveFlags>,
	rest: ReadonlyArray<string>,
	effect: (flags: GlobalFlags) => Effect.Effect<CommandResult, CliError>,
): Promise<void> => {
	let flags: GlobalFlags;
	try {
		flags = makeGlobalFlags(ctx, rawFlags, rest);
	} catch (cause) {
		const error =
			cause instanceof CliUsageError
				? cause
				: new CliInternalError({ message: 'failed to resolve CLI flags', cause });
		const mode = outputModeFrom(rawFlags, ctx.env);
		await Effect.runPromise(
			emitFailure(ctx.io, mode, {
				command,
				elapsedMs: 0,
				error,
			}),
		);
		return;
	}
	await runCommandEffect(ctx, command, flags, effect(flags));
};

const requiredPositional = (placeholder: string, brief: string) =>
	({
		parse: textParser,
		placeholder,
		brief,
	}) as const;

const optionalPositional = (placeholder: string, brief: string) =>
	({
		parse: textParser,
		placeholder,
		brief,
		optional: true as const,
	}) as const;

// -----------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------

const upCommand = buildCommand<UpFlags, [], DevstackCliContext>({
	parameters: {
		flags: {
			...configFlagParams,
			renderer: {
				kind: 'parsed',
				parse: rendererParser,
				optional: true,
				placeholder: 'tui|plain|silent',
				brief: 'Select the attached renderer',
			},
			fromSnapshot: stringFlag('Start by restoring a named snapshot before acquire', 'name-or-id'),
			snapshotCache: stringFlag(
				'Use a named snapshot as a startup cache and refresh it when stale',
				'name',
			),
			snapshotStale: {
				kind: 'parsed',
				parse: snapshotStaleParser,
				optional: true,
				placeholder: 'warn|block|clean-start',
				brief: 'Policy when --from-snapshot inputs differ from the current stack',
			},
		},
	},
	docs: {
		brief: 'Boot a stack and stay attached until interrupted',
	},
	func: function (flags) {
		return runWithFlags(this, 'up', flags, [], (global) => this.deps.up.run(global));
	},
});

const applyCommand = buildCommand<ConfigFlags, [], DevstackCliContext>({
	parameters: { flags: configFlagParams },
	docs: {
		brief: 'Reconcile a live stack or run one-shot setup',
	},
	func: function (flags) {
		return runWithFlags(this, 'apply', flags, [], (global) => this.deps.apply.run(global));
	},
});

const statusCommand = buildCommand<IdentityFlags, [], DevstackCliContext>({
	parameters: { flags: identityFlagParams },
	docs: { brief: 'Show the current stack projection (offline: from the manifest)' },
	func: function (flags) {
		return runWithFlags(this, 'status', flags, [], (global) =>
			runStatus(this.deps.status, { flags: global, io: this.io }),
		);
	},
});

const doctorCommand = buildCommand<IdentityFlags, [], DevstackCliContext>({
	parameters: { flags: identityFlagParams },
	docs: { brief: 'Run host and stack preflight checks' },
	func: function (flags) {
		return runWithFlags(this, 'doctor', flags, [], (global) =>
			runDoctor(this.deps.doctor, { flags: global, io: this.io }),
		);
	},
});

const configCommand = buildCommand<ConfigFlags, [], DevstackCliContext>({
	parameters: { flags: configFlagParams },
	docs: { brief: 'Print resolved config inputs' },
	func: function (flags) {
		return runWithFlags(this, 'config', flags, [], (global) =>
			runConfig(this.deps.config, { flags: global, io: this.io }),
		);
	},
});

const schemaCommand = buildCommand<Pick<IdentityFlags, 'json'>, [], DevstackCliContext>({
	parameters: { flags: { json: identityFlagParams.json } },
	docs: { brief: 'Emit the CLI schema' },
	func: function (flags) {
		return runWithFlags(this, 'schema', flags, [], (global) => {
			const data = { ...commandSchema(), outputMode: global.outputMode };
			return emitSuccess(this.io, global.outputMode, {
				command: 'schema',
				elapsedMs: 0,
				data,
				humanLines: [JSON.stringify(data, null, 2)],
			}).pipe(Effect.as({ exitCode: 0 }));
		});
	},
});

const snapshotSaveCommand = buildCommand<
	SnapshotSaveFlags,
	[string | undefined],
	DevstackCliContext
>({
	parameters: {
		flags: {
			...configFlagParams,
			name: stringFlag('Human-readable snapshot name', 'name'),
		},
		positional: { kind: 'tuple', parameters: [optionalPositional('name', 'snapshot name')] },
	},
	docs: { brief: 'Capture a snapshot' },
	func: function (flags, snapshotName) {
		const rest = [
			'save',
			...(snapshotName === undefined ? [] : [snapshotName]),
			...(flags.name === undefined ? [] : ['--name', flags.name]),
		];
		return runWithFlags(this, 'snapshot save', flags, rest, (global) =>
			runSnapshot(this.deps.snapshot, { flags: global, io: this.io }),
		);
	},
});

const snapshotRestoreCommand = buildCommand<ConfirmFlags, [string], DevstackCliContext>({
	parameters: {
		flags: confirmFlagParams,
		positional: {
			kind: 'tuple',
			parameters: [requiredPositional('name-or-id', 'snapshot name or id')],
		},
	},
	docs: { brief: 'Restore a snapshot' },
	func: function (flags, snapshotRef) {
		return runWithFlags(this, 'snapshot restore', flags, ['restore', snapshotRef], (global) =>
			runSnapshot(this.deps.snapshot, { flags: global, io: this.io }),
		);
	},
});

const snapshotListCommand = buildCommand<IdentityFlags, [], DevstackCliContext>({
	parameters: { flags: identityFlagParams },
	docs: { brief: 'List snapshots' },
	func: function (flags) {
		return runWithFlags(this, 'snapshot list', flags, ['list'], (global) =>
			runSnapshot(this.deps.snapshot, { flags: global, io: this.io }),
		);
	},
});

const snapshotDeleteCommand = buildCommand<ConfirmFlags, [string], DevstackCliContext>({
	parameters: {
		flags: confirmFlagParams,
		positional: {
			kind: 'tuple',
			parameters: [requiredPositional('name-or-id', 'snapshot name or id')],
		},
	},
	docs: { brief: 'Delete a snapshot' },
	func: function (flags, snapshotRef) {
		return runWithFlags(this, 'snapshot delete', flags, ['delete', snapshotRef], (global) =>
			runSnapshot(this.deps.snapshot, { flags: global, io: this.io }),
		);
	},
});

const snapshotCommands = buildRouteMap({
	routes: {
		save: snapshotSaveCommand,
		restore: snapshotRestoreCommand,
		list: snapshotListCommand,
		delete: snapshotDeleteCommand,
	},
	docs: { brief: 'Capture, restore, list, or delete stack snapshots' },
});

const pruneCommand = buildCommand<PruneFlags, [], DevstackCliContext>({
	parameters: { flags: pruneFlagParams },
	docs: { brief: 'Inventory and prune devstack-labelled Docker resources' },
	func: function (flags) {
		return runWithFlags(this, 'prune', flags, [], (global) =>
			runPrune(
				this.deps.prune,
				{ flags: global, io: this.io },
				{
					mode: flags.list === true ? 'list' : flags.all === true ? 'all' : 'auto',
					resources: pruneResourcesFromFlags(flags),
				},
			),
		);
	},
});

const wipeCommand = buildCommand<DestructiveFlags, [], DevstackCliContext>({
	parameters: { flags: destructiveFlagParams },
	docs: { brief: 'Destroy all state for the selected stack' },
	func: function (flags) {
		return runWithFlags(this, 'wipe', flags, [], (global) =>
			runWipe(this.deps.wipe, { flags: global, io: this.io }),
		);
	},
});

const root = buildRouteMap({
	routes: {
		up: upCommand,
		apply: applyCommand,
		status: statusCommand,
		doctor: doctorCommand,
		config: configCommand,
		schema: schemaCommand,
		snapshot: snapshotCommands,
		prune: pruneCommand,
		wipe: wipeCommand,
	},
	docs: {
		brief: 'Sui development stack CLI',
	},
});

const app = buildApplication(root, {
	name: 'devstack',
	versionInfo: { currentVersion: readPackageVersion() },
	scanner: { caseStyle: 'allow-kebab-for-camel' },
	documentation: {
		caseStyle: 'convert-camel-to-kebab',
		disableAnsiColor: true,
		onlyRequiredInUsageLine: true,
	},
	localization: {
		loadText: () => ({
			...text_en,
			exceptionWhileParsingArguments: (error) =>
				error instanceof Error ? error.message : String(error),
		}),
	},
});

const jsonRequested = (
	argv: ReadonlyArray<string>,
	env: Readonly<Record<string, string | undefined>>,
): boolean => env[ENV_VARS.JSON] === '1' || argv.includes('--json');

/**
 * Project a `BufferedProcess.exitCode` to a sysexit code AT THE
 * STRICLI-PARSE BOUNDARY ONLY.
 *
 * Contract: `BufferedProcess.exitCode` is mutated ONLY by Stricli's
 * argv-parser when an argv parse step fails (unknown subcommand,
 * malformed flag value, missing required positional). Verbs route
 * their own outcomes through `ctx.io.setExitCode`, which marks
 * `io.touched()` and short-circuits this projection in `dispatch`
 * before `flushBufferedProcess` is reached.
 *
 * A non-zero value here means Stricli rejected argv before any verb
 * ran, so mapping to `USAGE` holds by construction. Kept as a named
 * function so the invariant is documented at the call site.
 */
const normalizeStricliExitCode = (code: number | string | null | undefined): number => {
	if (typeof code === 'number' && code !== 0) return ExitCode.USAGE;
	return ExitCode.OK;
};

/**
 * Bridge Stricli's synchronous `StricliProcess.{stdout,stderr}.write`
 * shape to our async (Effect-based) `CliIO` surface.
 *
 * The indirection is load-bearing for the JSON-envelope contract:
 * Stricli writes argv-parse errors to stderr the moment the parser
 * trips, but `--json` mode demands the failure be EMITTED as a
 * structured envelope on stdout (not raw text on stderr) with exit
 * code `EX_USAGE`. We can't wire Stricli's `stderr.write` directly to
 * `nodeProcessIO.writeStderr` because:
 *
 *   1. The stderr bytes are the raw parser error text; in `--json`
 *      mode we need to transform them into a failure envelope.
 *   2. We don't know whether the verb handler "touched" the IO
 *      (rendered its own envelope) until after Stricli returns.
 *
 * Buffering lets us delay the decision until both signals are
 * available. Tests substitute a `BufferedProcess` whose buffers are
 * later inspected, mirroring the prod flush behavior.
 */
const flushBufferedProcess = (
	process: BufferedProcess,
	io: CliIO,
	argv: ReadonlyArray<string>,
	env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const exitCode = normalizeStricliExitCode(process.exitCode);
		const stdout = process.stdoutBuffer.join('');
		const stderr = process.stderrBuffer.join('').trim();
		if (exitCode !== 0 && jsonRequested(argv, env)) {
			yield* emitFailure(io, 'json', {
				command: '(parse)',
				elapsedMs: 0,
				error: new CliUsageError({
					message: stderr.length > 0 ? stderr : 'invalid command line',
				}),
			});
			return;
		}
		if (stdout.length > 0)
			yield* io.writeStdout(stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout);
		if (stderr.length > 0) yield* io.writeStderr(stderr);
		yield* io.setExitCode(exitCode);
	});

export const dispatch = (deps: CliDeps, dispatchEnv: DispatchEnv): Effect.Effect<void> =>
	Effect.gen(function* () {
		const io = trackIO(dispatchEnv.io ?? nodeProcessIO);
		const process = makeBufferedProcess(dispatchEnv.env);
		const ctx: DevstackCliContext = {
			process,
			deps,
			env: dispatchEnv.env,
			stdinIsTty: dispatchEnv.stdinIsTty,
			io,
		};
		yield* Effect.tryPromise({
			try: () => runStricli(app, dispatchEnv.argv, ctx),
			catch: (cause) => new CliInternalError({ message: 'CLI dispatcher failed', cause }),
		}).pipe(
			Effect.catch((error: CliError) =>
				emitFailure(io, jsonRequested(dispatchEnv.argv, dispatchEnv.env) ? 'json' : 'human', {
					command: '(dispatch)',
					elapsedMs: 0,
					error,
				}),
			),
		);
		if (!io.touched()) {
			yield* flushBufferedProcess(process, io, dispatchEnv.argv, dispatchEnv.env);
		}
	});

// -----------------------------------------------------------------------------
// Re-exports
// -----------------------------------------------------------------------------

export type { CliIO } from './output.ts';
export type { GlobalFlags } from './flags.ts';
export { COMMAND_TREE, commandSchema, VERBS, type Verb } from './command-tree.ts';
export type { Envelope, EnvelopeError } from './envelope.ts';
export {
	ENVELOPE_SCHEMA_VERSION,
	failureEnvelope,
	streamingEvent,
	successEnvelope,
	type StreamingEvent,
} from './envelope.ts';
export { ExitCode, exitCodeName } from './sysexits.ts';
export {
	type CliError,
	CliAlreadyReportedError,
	CliConfigInvalidError,
	CliConfigNotFoundError,
	CliConfirmDeclinedError,
	CliConfirmRequiredError,
	CliInternalError,
	CliSnapshotNotFoundError,
	CliSupervisorLiveError,
	CliUnavailableError,
	CliUsageError,
} from './errors.ts';
