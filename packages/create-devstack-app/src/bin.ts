#!/usr/bin/env node
// `pnpm create @mysten-incubation/devstack-app <name>` →
// pnpm/npm look up `@mysten-incubation/create-devstack-app` and run this
// bin with `<name>` as the first positional argument.
//
// `bin.ts` owns all interactivity (flag parsing + the @clack/prompts plugin
// picker); `scaffold()` in `index.ts` stays prompt-free/pure so it remains
// unit-testable. The picker resolves to a plugin Set that ALWAYS contains
// `core`, then hands it to `scaffold({ plugins })`.

import { isCancel, multiselect, outro } from '@clack/prompts';

import { scaffold } from './index.js';
import { OPTIONAL_PLUGINS, type PluginId } from './plugin-manifest.js';

const USAGE = `Usage: pnpm create @mysten-incubation/devstack-app <name> [options]

Arguments:
  <name>              App name. Lowercase, dash-separated, starts with a letter.

Options:
  --target-dir <dir>  Where to create the app directory. Default: current working directory.
  --plugins <list>    Comma-separated plugins to include (core,walrus,seal,deepbook).
                      'core' is always included. Skips the interactive picker.
  --all               Include every plugin (default in non-interactive mode).
  --minimal           Core only (no walrus/seal/deepbook).
  --yes               Non-interactive: accept defaults (all plugins).
  --no-install        Skip pnpm install.
  --no-git            Skip git init + initial commit.
  -h, --help          Show this help.
`;

/** Human-readable labels for the interactive multiselect. */
const PLUGIN_LABELS: Record<PluginId, { label: string; hint: string }> = {
	core: { label: 'core', hint: 'on-chain counter' },
	walrus: { label: 'walrus', hint: 'upload & read a blob' },
	seal: { label: 'seal', hint: 'encrypt & decrypt a secret' },
	deepbook: { label: 'deepbook', hint: 'view a pool & place an order' },
};

const VALID_PLUGINS = new Set<string>(['core', ...OPTIONAL_PLUGINS]);

/** Parse a `--plugins core,seal` value into a Set (always incl. `core`). */
function parsePluginList(value: string): Set<PluginId> {
	const selected = new Set<PluginId>(['core']);
	for (const raw of value.split(',')) {
		const id = raw.trim();
		if (id === '') continue;
		if (!VALID_PLUGINS.has(id)) {
			throw new Error(
				`unknown plugin '${id}'. Valid: core, ${OPTIONAL_PLUGINS.join(', ')}.`,
			);
		}
		selected.add(id as PluginId);
	}
	return selected;
}

/** Interactive multiselect picker. `core` is shown pre-checked and is forced
 *  into the result regardless of selection (it isn't togglable in spirit —
 *  clack can't lock a single option, so we re-add it after). Returns the
 *  resolved Set, or undefined if the user cancelled. */
async function promptPlugins(): Promise<Set<PluginId> | undefined> {
	const all: PluginId[] = ['core', ...OPTIONAL_PLUGINS];
	const result = await multiselect({
		message: 'Which demo panels should the app include? (core is always included)',
		options: all.map((id) => ({
			value: id,
			label: PLUGIN_LABELS[id].label,
			hint: PLUGIN_LABELS[id].hint,
		})),
		initialValues: all,
		required: false,
	});
	if (isCancel(result)) return undefined;
	const selected = new Set<PluginId>(result as PluginId[]);
	selected.add('core');
	return selected;
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(USAGE);
		return argv.length === 0 ? 1 : 0;
	}

	let name: string | undefined;
	let targetDir: string | undefined;
	let skipInstall = false;
	let skipGit = false;
	let pluginsFlag: string | undefined;
	let all = false;
	let minimal = false;
	let yes = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--target-dir') {
			i += 1;
			targetDir = argv[i];
			if (targetDir === undefined) {
				process.stderr.write('--target-dir requires a value\n');
				return 2;
			}
		} else if (arg === '--plugins') {
			i += 1;
			pluginsFlag = argv[i];
			if (pluginsFlag === undefined) {
				process.stderr.write('--plugins requires a value\n');
				return 2;
			}
		} else if (arg !== undefined && arg.startsWith('--plugins=')) {
			pluginsFlag = arg.slice('--plugins='.length);
		} else if (arg === '--all') {
			all = true;
		} else if (arg === '--minimal') {
			minimal = true;
		} else if (arg === '--yes') {
			yes = true;
		} else if (arg === '--no-install') {
			skipInstall = true;
		} else if (arg === '--no-git') {
			skipGit = true;
		} else if (arg !== undefined && arg.startsWith('--')) {
			process.stderr.write(`unknown option: ${arg}\n`);
			return 2;
		} else if (arg !== undefined) {
			if (name !== undefined) {
				process.stderr.write(`unexpected positional argument: ${arg}\n`);
				return 2;
			}
			name = arg;
		}
	}

	if (name === undefined) {
		process.stderr.write('app name is required\n');
		process.stdout.write(USAGE);
		return 2;
	}

	if (minimal && all) {
		process.stderr.write('--minimal and --all are mutually exclusive\n');
		return 2;
	}

	// Resolve the plugin set. Precedence: explicit --plugins > --minimal >
	// --all > interactive (TTY, no flag) > default-all (non-TTY / --yes).
	let plugins: Set<PluginId>;
	if (pluginsFlag !== undefined) {
		try {
			plugins = parsePluginList(pluginsFlag);
		} catch (e) {
			process.stderr.write(`${(e as Error).message}\n`);
			return 2;
		}
	} else if (minimal) {
		plugins = new Set<PluginId>(['core']);
	} else if (all || yes || !process.stdin.isTTY) {
		plugins = new Set<PluginId>(['core', ...OPTIONAL_PLUGINS]);
	} else {
		const picked = await promptPlugins();
		if (picked === undefined) {
			outro('Cancelled.');
			return 1;
		}
		plugins = picked;
	}

	try {
		await scaffold({ name, targetDir, skipInstall, skipGit, plugins: [...plugins] });
		return 0;
	} catch (e) {
		process.stderr.write(`${(e as Error).message}\n`);
		return 1;
	}
}

main().then((code) => {
	process.exit(code);
});
