import { ENV_VARS } from './flags.ts';
import { exitCodeTable } from './sysexits.ts';

export interface CommandOption {
	readonly name: string;
	readonly value?: string;
	readonly description: string;
}

export interface CommandNode {
	readonly name: string;
	readonly summary: string;
	readonly usage: string;
	readonly description?: string;
	readonly arguments?: ReadonlyArray<string>;
	readonly options?: ReadonlyArray<CommandOption>;
	readonly subcommands?: ReadonlyArray<CommandNode>;
}

const globalOptions = [
	{ name: 'json', description: 'Emit JSON envelope output.' },
	{ name: 'app', value: 'name', description: 'Override app name.' },
	{ name: 'stack', value: 'name', description: 'Override stack name.' },
	{ name: 'state-dir', value: 'path', description: 'Override state directory.' },
	{ name: 'config', value: 'path', description: 'Override devstack.config.ts path.' },
	{
		name: 'network',
		value: 'name',
		description: 'Override network before config import.',
	},
	{
		name: 'renderer',
		value: 'tui|plain|silent',
		description: 'Select the `up` renderer.',
	},
	{ name: 'dry-run', description: 'Skip mutating effects.' },
	{ name: 'yes', description: 'Assume yes on prompts.' },
	{ name: 'no-input', description: 'Forbid prompts.' },
	{ name: 'verbose', description: 'Enable more verbose logging.' },
	{ name: 'schema', description: 'Emit the CLI schema and exit.' },
	{ name: 'version', description: 'Print version and exit.' },
	{ name: 'help', description: 'Print command help and exit.' },
] as const satisfies ReadonlyArray<CommandOption>;

const commands = [
	{
		name: 'up',
		summary: 'Boot a stack and stay attached until interrupted.',
		usage: 'devstack up [--global-flags]',
		description: 'Loads devstack.config.ts, starts the supervisor, and remains attached.',
	},
	{
		name: 'down',
		summary: 'Request graceful shutdown of the active stack.',
		usage: 'devstack down [--global-flags]',
	},
	{
		name: 'status',
		summary: 'Show the current stack projection.',
		usage: 'devstack status [--global-flags]',
	},
	{
		name: 'snapshot',
		summary: 'Capture, restore, list, or delete stack snapshots.',
		usage: 'devstack snapshot <command> [args...]',
		subcommands: [
			{
				name: 'save',
				summary: 'Capture a snapshot of the active stack.',
				usage: 'devstack snapshot save [--label <label>]',
				options: [{ name: 'label', value: 'label', description: 'Human-readable snapshot label.' }],
			},
			{
				name: 'restore',
				summary: 'Restore a snapshot by id or label.',
				usage: 'devstack snapshot restore <id-or-label>',
				arguments: ['id-or-label'],
			},
			{
				name: 'list',
				summary: 'List snapshots for the active stack.',
				usage: 'devstack snapshot list',
			},
			{
				name: 'delete',
				summary: 'Delete a snapshot by id or label.',
				usage: 'devstack snapshot delete <id-or-label>',
				arguments: ['id-or-label'],
			},
		],
	},
	{
		name: 'prune',
		summary: 'Run cross-stack orphan cleanup.',
		usage: 'devstack prune [--dry-run] [--yes]',
	},
	{
		name: 'logs',
		summary: "Tail a plugin's log stream.",
		usage: 'devstack logs <plugin> [--level <level>]',
		arguments: ['plugin'],
		options: [{ name: 'level', value: 'level', description: 'Filter by log level.' }],
	},
	{
		name: 'doctor',
		summary: 'Run health-check probes.',
		usage: 'devstack doctor [--global-flags]',
	},
	{
		name: 'codegen',
		summary: 'Force codegen re-emit on a live supervisor.',
		usage: 'devstack codegen [--global-flags]',
	},
	{
		name: 'config',
		summary: 'Print resolved config.',
		usage: 'devstack config [--global-flags]',
	},
	{
		name: 'apply',
		summary: 'Boot, reconcile, emit generated files, and exit cleanly.',
		usage: 'devstack apply [--global-flags]',
	},
	{
		name: 'wipe',
		summary: 'Destroy all state for the active stack.',
		usage: 'devstack wipe [--yes]',
	},
	{
		name: 'stack',
		summary: 'Manage named stack roots.',
		usage: 'devstack stack <command> [args...]',
		subcommands: [
			{ name: 'list', summary: 'List stack roots.', usage: 'devstack stack list' },
			{ name: 'new', summary: 'Create a stack root.', usage: 'devstack stack new <name>' },
			{ name: 'use', summary: 'Set the active stack.', usage: 'devstack stack use <name>' },
			{ name: 'drop', summary: 'Remove a stack root.', usage: 'devstack stack drop <name>' },
			{
				name: 'drop-fork',
				summary: 'Remove a fork stack root.',
				usage: 'devstack stack drop-fork <name>',
			},
		],
	},
	{
		name: 'fork',
		summary: 'Inspect or control fork-mode stacks.',
		usage: 'devstack fork <command> [args...]',
		subcommands: [
			{ name: 'status', summary: 'Show fork status.', usage: 'devstack fork status' },
			{
				name: 'advance',
				summary: 'Advance fork clock time.',
				usage: 'devstack fork advance --ms <milliseconds>',
				options: [{ name: 'ms', value: 'milliseconds', description: 'Milliseconds to advance.' }],
			},
			{ name: 'seed', summary: 'Inspect fork seed state.', usage: 'devstack fork seed [args...]' },
			{
				name: 'replay',
				summary: 'Replay fork state.',
				usage: 'devstack fork replay [args...]',
			},
			{
				name: 'cache',
				summary: 'Inspect fork cache state.',
				usage: 'devstack fork cache [args...]',
			},
		],
	},
] as const satisfies ReadonlyArray<CommandNode>;

export const COMMAND_TREE: CommandNode = {
	name: 'devstack',
	summary: 'Sui development stack CLI.',
	usage: 'devstack [--global-flags] <command> [args...]',
	description: 'Boot, inspect, snapshot, and manage local Sui development stacks.',
	options: globalOptions,
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

const commandPathFromRest = (rest: ReadonlyArray<string>): ReadonlyArray<string> => {
	const path: Array<string> = [];
	let current: CommandNode = COMMAND_TREE;
	for (const token of rest) {
		if (token.startsWith('-')) continue;
		const next = findSubcommand(current, token);
		if (next === undefined) break;
		path.push(next.name);
		current = next;
	}
	return path;
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

export const formatCommandHelp = (rest: ReadonlyArray<string>): string => {
	const path = commandPathFromRest(rest);
	const node = findCommandNode(path) ?? COMMAND_TREE;
	const lines: Array<string> = [
		path.length === 0
			? 'devstack - Sui development stack CLI'
			: `${path.join(' ')} - ${node.summary}`,
		'',
		`Usage: ${node.usage}`,
	];
	if (node.description !== undefined) {
		lines.push('', node.description);
	}
	if (node.arguments !== undefined && node.arguments.length > 0) {
		lines.push('', `Arguments: ${node.arguments.join(', ')}`);
	}
	pushCommandRows(lines, path.length === 0 ? 'Commands' : 'Subcommands', node.subcommands ?? []);
	pushOptionRows(lines, 'Options', node.options ?? []);
	if (path.length === 0) {
		pushOptionRows(lines, 'Global Flags', globalOptions);
	} else {
		lines.push('', 'Run `devstack --help` for global flags.');
	}
	return lines.join('\n');
};

export const commandSchema = () => ({
	schemaVersion: 1,
	verbs: VERBS,
	commands: COMMAND_TREE,
	exitCodes: exitCodeTable,
	envVars: Object.values(ENV_VARS),
});
