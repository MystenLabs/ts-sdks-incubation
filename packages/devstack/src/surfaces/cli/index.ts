// CLI surface — top-level entry point.
//
// The public CLI is intentionally small: `up` is the attached operator
// surface, `apply` is the one-shot CI path, and every other command is
// offline/direct. There is no public peer-command model for talking to
// an already-running `up` process.

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
import { Effect } from 'effect';

import { commandSchema } from './command-tree.ts';
import { type CliError, CliInternalError, CliUsageError, exitCodeFor } from './errors.ts';
import { type CliRendererMode, ENV_VARS, type GlobalFlags, type OutputMode } from './flags.ts';
import { parseDevstackNetworkName } from '../../api/inference-network.ts';
import { type CliIO, emitFailure, nodeProcessIO } from './output.ts';
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
		dryRun: flags.dryRun === true,
		confirm: {
			assumeYes: flags.yes === true,
			forbidPrompt: flags.noInput === true || ctx.env[ENV_VARS.NO_INPUT] === '1',
			stdinIsTty: ctx.stdinIsTty,
		},
		schemaEmit: false,
		verbose: flags.verbose === true,
		help: false,
		version: false,
		rest,
	};
};

const setNetworkEnv = (flags: GlobalFlags): Effect.Effect<void> =>
	flags.network === undefined
		? Effect.void
		: Effect.sync(() => {
				process.env[ENV_VARS.NETWORK] = flags.network;
			});

// -----------------------------------------------------------------------------
// Command execution helpers
// -----------------------------------------------------------------------------

const runCommandEffect = async (
	ctx: DevstackCliContext,
	command: string,
	flags: GlobalFlags,
	effect: Effect.Effect<CommandResult, CliError>,
): Promise<void> => {
	const program = setNetworkEnv(flags).pipe(
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
			}).pipe(Effect.as({ exitCode: 70 })),
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
		brief: 'Boot, reconcile, emit generated files, and exit',
	},
	func: function (flags) {
		return runWithFlags(this, 'apply', flags, [], (global) => this.deps.apply.run(global));
	},
});

const statusCommand = buildCommand<IdentityFlags, [], DevstackCliContext>({
	parameters: { flags: identityFlagParams },
	docs: { brief: 'Show the persisted stack projection' },
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
		const mode = outputModeFrom(flags, this.env);
		return Effect.runPromise(
			this.io
				.writeStdout(JSON.stringify({ ...commandSchema(), outputMode: mode }))
				.pipe(Effect.andThen(this.io.setExitCode(0))),
		);
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
	versionInfo: { currentVersion: '0.0.0' },
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

const normalizeStricliExitCode = (code: number | string | null | undefined): number => {
	if (typeof code === 'number' && code !== 0) return 64;
	return 0;
};

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
export {
	COMMAND_TREE,
	commandSchema,
	formatCommandHelp,
	VERBS,
	type Verb,
} from './command-tree.ts';
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
