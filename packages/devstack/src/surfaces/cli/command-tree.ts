import { ENV_VARS } from './flags.ts';
import { exitCodeTable } from './sysexits.ts';

export type CommandLifecycle = 'attached' | 'live-aware' | 'one-shot' | 'offline';

export interface CommandOption {
	readonly name: string;
	readonly value?: string;
	readonly description: string;
}

export interface CommandNode {
	readonly name: string;
	readonly summary: string;
	readonly usage: string;
	readonly lifecycle: CommandLifecycle;
	readonly sideEffects: 'none' | 'read' | 'write' | 'destructive';
	readonly requiresDocker: boolean;
	readonly description?: string;
	readonly arguments?: ReadonlyArray<string>;
	readonly options?: ReadonlyArray<CommandOption>;
	readonly subcommands?: ReadonlyArray<CommandNode>;
}

const identityOptions = [
	{ name: 'json', description: 'Emit JSON envelope output.' },
	{ name: 'app', value: 'name', description: 'Override app name.' },
	{ name: 'stack', value: 'name', description: 'Override stack name.' },
	{ name: 'state-dir', value: 'path', description: 'Override state directory.' },
	{ name: 'verbose', description: 'Enable more verbose logging.' },
] as const satisfies ReadonlyArray<CommandOption>;

const configOptions = [
	...identityOptions,
	{ name: 'config', value: 'path', description: 'Override devstack.config.ts path.' },
	{ name: 'network', value: 'name', description: 'Override network before config import.' },
] as const satisfies ReadonlyArray<CommandOption>;

const confirmOptions = [
	...identityOptions,
	{ name: 'yes', description: 'Assume yes on prompts.' },
	{ name: 'no-input', description: 'Forbid prompts.' },
] as const satisfies ReadonlyArray<CommandOption>;

const globalMaintenanceOptions = [
	{ name: 'json', description: 'Emit JSON envelope output.' },
	{ name: 'state-dir', value: 'path', description: 'Override state directory.' },
	{ name: 'verbose', description: 'Enable more verbose logging.' },
] as const satisfies ReadonlyArray<CommandOption>;

const commands = [
	{
		name: 'up',
		summary: 'Boot a stack and stay attached until interrupted.',
		usage: 'devstack up [options]',
		lifecycle: 'attached',
		sideEffects: 'write',
		requiresDocker: true,
		description: 'Starts the supervisor and renders the attached operator surface.',
		options: [
			...configOptions,
			{
				name: 'renderer',
				value: 'tui|plain|silent',
				description: 'Select the attached renderer.',
			},
			{
				name: 'from-snapshot',
				value: 'name-or-id',
				description: 'Start by restoring a snapshot before the initial acquire.',
			},
			{
				name: 'snapshot-cache',
				value: 'name',
				description: 'Use a named snapshot as a startup cache and refresh it when stale.',
			},
			{
				name: 'snapshot-stale',
				value: 'warn|block|clean-start',
				description: 'Policy when --from-snapshot inputs differ from the current stack.',
			},
		],
	},
	{
		name: 'apply',
		summary: 'Re-emit the per-stack ids file and dev extras from a live or one-shot stack.',
		usage: 'devstack apply [options]',
		lifecycle: 'live-aware',
		sideEffects: 'write',
		requiresDocker: true,
		options: configOptions,
	},
	{
		name: 'codegen',
		summary: 'Regenerate committed bindings from Move source (no stack boot).',
		usage: 'devstack codegen [options]',
		lifecycle: 'one-shot',
		sideEffects: 'write',
		requiresDocker: false,
		description:
			'Move-compiles local package sources and emits the committed src/generated tree (type bindings + sentinel-id config stubs) without booting a stack.',
		options: configOptions,
	},
	{
		name: 'dump-deployment',
		summary: 'Emit the stack deployment (deployment.json) for a real-network deploy.',
		usage: 'devstack dump-deployment [options]',
		lifecycle: 'live-aware',
		sideEffects: 'write',
		requiresDocker: true,
		description:
			'Emits the stack deployment.json deployment to --out (or stdout). Reads the existing file when a supervisor is live; otherwise runs a one-shot boot to produce it, then tears down. With --network <net>, instead emits a typed deployments/<net>.ts (satisfies AppNetworkDeployment) from that network entry. The supported way to obtain a committed deployment file for a real-network deploy.',
		options: [
			...configOptions,
			{
				name: 'out',
				value: 'path',
				description: 'Write the deployment JSON to this file instead of stdout.',
			},
		],
	},
	{
		name: 'status',
		summary: 'Show the current stack projection (offline: from the manifest).',
		usage: 'devstack status [options]',
		lifecycle: 'offline',
		sideEffects: 'read',
		requiresDocker: false,
		options: identityOptions,
	},
	{
		name: 'doctor',
		summary: 'Run host and stack preflight checks.',
		usage: 'devstack doctor [options]',
		lifecycle: 'offline',
		sideEffects: 'read',
		requiresDocker: true,
		options: identityOptions,
	},
	{
		name: 'config',
		summary: 'Print resolved config inputs.',
		usage: 'devstack config [options]',
		lifecycle: 'offline',
		sideEffects: 'read',
		requiresDocker: false,
		options: configOptions,
	},
	{
		name: 'schema',
		summary: 'Emit the CLI schema.',
		usage: 'devstack schema --json',
		lifecycle: 'offline',
		sideEffects: 'none',
		requiresDocker: false,
		options: [{ name: 'json', description: 'Emit JSON schema output.' }],
	},
	{
		name: 'snapshot',
		summary: 'Capture, restore, list, or delete stack snapshots.',
		usage: 'devstack snapshot <command> [options]',
		lifecycle: 'offline',
		sideEffects: 'write',
		requiresDocker: true,
		subcommands: [
			{
				name: 'save',
				summary: 'Capture a snapshot through a one-shot stack boot.',
				usage: 'devstack snapshot save [name] [options]',
				lifecycle: 'one-shot',
				sideEffects: 'write',
				requiresDocker: true,
				arguments: ['name'],
				options: [
					...configOptions,
					{ name: 'name', value: 'name', description: 'Human-readable snapshot name.' },
				],
			},
			{
				name: 'restore',
				summary: 'Restore a snapshot by name or id.',
				usage: 'devstack snapshot restore <name-or-id> [options]',
				lifecycle: 'offline',
				sideEffects: 'destructive',
				requiresDocker: true,
				arguments: ['name-or-id'],
				options: confirmOptions,
			},
			{
				name: 'list',
				summary: 'List snapshots for the selected stack.',
				usage: 'devstack snapshot list [options]',
				lifecycle: 'offline',
				sideEffects: 'read',
				requiresDocker: false,
				options: identityOptions,
			},
			{
				name: 'delete',
				summary: 'Delete a snapshot by name or id.',
				usage: 'devstack snapshot delete <name-or-id> [options]',
				lifecycle: 'offline',
				sideEffects: 'destructive',
				requiresDocker: false,
				arguments: ['name-or-id'],
				options: confirmOptions,
			},
		],
	},
	{
		name: 'prune',
		summary: 'Inventory and prune devstack-labelled Docker resources.',
		usage: 'devstack prune [--list | --dry-run | --all --yes] [options]',
		lifecycle: 'offline',
		sideEffects: 'destructive',
		requiresDocker: true,
		options: [
			...globalMaintenanceOptions,
			{ name: 'list', description: 'List resource groups without pruning.' },
			{ name: 'all', description: 'Prune every idle non-shared resource group.' },
			{ name: 'no-containers', description: 'Do not remove containers.' },
			{ name: 'no-networks', description: 'Do not remove networks.' },
			{ name: 'no-volumes', description: 'Do not remove volumes.' },
			{ name: 'include-images', description: 'Also remove devstack-labelled images.' },
			{ name: 'dry-run', description: 'Skip mutating effects.' },
			{ name: 'yes', description: 'Assume yes on prompts.' },
			{ name: 'no-input', description: 'Forbid prompts.' },
		],
	},
	{
		name: 'wipe',
		summary: 'Destroy all state for the selected stack.',
		usage: 'devstack wipe [--dry-run] [--yes] [options]',
		lifecycle: 'offline',
		sideEffects: 'destructive',
		requiresDocker: true,
		options: [
			...identityOptions,
			{ name: 'dry-run', description: 'Skip mutating effects.' },
			{ name: 'yes', description: 'Assume yes on prompts.' },
			{ name: 'no-input', description: 'Forbid prompts.' },
		],
	},
] as const satisfies ReadonlyArray<CommandNode>;

export const COMMAND_TREE: CommandNode = {
	name: 'devstack',
	summary: 'Sui development stack CLI.',
	usage: 'devstack <command> [options]',
	lifecycle: 'offline',
	sideEffects: 'none',
	requiresDocker: false,
	description: 'Boot, inspect, snapshot, and manage local Sui development stacks.',
	subcommands: commands,
};

export type Verb = (typeof commands)[number]['name'];

export const VERBS: ReadonlyArray<Verb> = commands.map((command) => command.name);

export const commandSchema = () => ({
	schemaVersion: 1,
	verbs: VERBS,
	commands: COMMAND_TREE,
	exitCodes: exitCodeTable,
	envVars: Object.values(ENV_VARS),
});
