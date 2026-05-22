import { ENV_VARS } from './flags.ts';
import { exitCodeTable } from './sysexits.ts';

export type CommandLifecycle = 'attached' | 'one-shot' | 'offline';

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
		],
	},
	{
		name: 'apply',
		summary: 'Boot, reconcile, emit generated files, and exit.',
		usage: 'devstack apply [options]',
		lifecycle: 'one-shot',
		sideEffects: 'write',
		requiresDocker: true,
		options: configOptions,
	},
	{
		name: 'status',
		summary: 'Show the persisted stack projection.',
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
				usage: 'devstack snapshot save [id] [--label <label>] [options]',
				lifecycle: 'one-shot',
				sideEffects: 'write',
				requiresDocker: true,
				arguments: ['id'],
				options: [
					...configOptions,
					{ name: 'label', value: 'label', description: 'Human-readable snapshot label.' },
				],
			},
			{
				name: 'restore',
				summary: 'Restore a snapshot by id or label.',
				usage: 'devstack snapshot restore <id-or-label> [options]',
				lifecycle: 'offline',
				sideEffects: 'destructive',
				requiresDocker: true,
				arguments: ['id-or-label'],
				options: identityOptions,
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
				summary: 'Delete a snapshot by id or label.',
				usage: 'devstack snapshot delete <id-or-label> [options]',
				lifecycle: 'offline',
				sideEffects: 'destructive',
				requiresDocker: false,
				arguments: ['id-or-label'],
				options: identityOptions,
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
			...identityOptions,
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

export const isVerb = (value: string): value is Verb =>
	(VERBS as ReadonlyArray<string>).includes(value);

const findSubcommand = (node: CommandNode, name: string): CommandNode | undefined =>
	node.subcommands?.find((candidate) => candidate.name === name);

export const findCommandNode = (path: ReadonlyArray<string>): CommandNode | null => {
	let current: CommandNode = COMMAND_TREE;
	for (const segment of path) {
		const next = findSubcommand(current, segment);
		if (next === undefined) return null;
		current = next;
	}
	return current;
};

const formatOption = (option: CommandOption): string =>
	`--${option.name}${option.value ? ` <${option.value}>` : ''}`;

const pad = (values: ReadonlyArray<string>): number =>
	values.reduce((max, value) => Math.max(max, value.length), 0);

const pushCommandRows = (
	lines: Array<string>,
	title: string,
	commandsToRender: ReadonlyArray<CommandNode>,
) => {
	if (commandsToRender.length === 0) return;
	const names = commandsToRender.map((command) => command.name);
	const width = pad(names);
	lines.push('', `${title}:`);
	for (const command of commandsToRender) {
		lines.push(`  ${command.name.padEnd(width, ' ')}  ${command.summary}`);
	}
};

const pushOptionRows = (
	lines: Array<string>,
	title: string,
	options: ReadonlyArray<CommandOption>,
) => {
	if (options.length === 0) return;
	const rendered = options.map(formatOption);
	const width = pad(rendered);
	lines.push('', `${title}:`);
	for (let i = 0; i < options.length; i += 1) {
		lines.push(`  ${rendered[i]!.padEnd(width, ' ')}  ${options[i]!.description}`);
	}
};

export const formatCommandHelp = (path: ReadonlyArray<string>): string => {
	const node = findCommandNode(path) ?? COMMAND_TREE;
	const lines: Array<string> = [
		path.length === 0
			? 'devstack - Sui development stack CLI'
			: `${path.join(' ')} - ${node.summary}`,
		'',
		`Usage: ${node.usage}`,
	];
	if (node.description !== undefined) lines.push('', node.description);
	if (node.arguments !== undefined && node.arguments.length > 0) {
		lines.push('', `Arguments: ${node.arguments.join(', ')}`);
	}
	pushCommandRows(lines, path.length === 0 ? 'Commands' : 'Subcommands', node.subcommands ?? []);
	pushOptionRows(lines, 'Options', node.options ?? []);
	return lines.join('\n');
};

export const commandSchema = () => ({
	schemaVersion: 1,
	verbs: VERBS,
	commands: COMMAND_TREE,
	exitCodes: exitCodeTable,
	envVars: Object.values(ENV_VARS),
});
