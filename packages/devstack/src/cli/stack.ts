// `devstack stack` — manage per-app named environments. Each stack maps to
// an isolated set of docker containers/networks/volumes (named with the
// stack as a suffix) and a host-side state dir at
// `<appDir>/.devstack/stacks/<stack>/`.
//
// Subcommands (all per-app, resolve config from ./devstack.config.ts unless
// --config points elsewhere):
//
//   list                    Show all stacks, mark active, show running.
//   new <name>              Create an empty stack dir. Does not switch.
//   use <name>              Switch active. Stops the previously-active
//                           stack's containers (volumes preserved); does
//                           not bring the new one up — run `localnet:up`.
//   down [<name>]           Stop the stack's containers (volumes AND
//                           containers preserved → resumable on next
//                           `up`). Defaults to active stack. Use `drop`
//                           to remove containers + volumes.
//   drop <name> [--yes]     Stop+remove containers AND volumes AND the
//                           host-side `stacks/<name>/` dir. Refuses on
//                           `main` and on the active stack.
//
// Stack switches don't copy chain state. Each stack is self-contained; a
// dormant stack's data sits in named docker volumes (`<app>-<stack>-...`)
// until `drop` is called.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DevstackConfig } from '../core/types.js';
import { dockerRun, removeContainer, removeNetwork, stopContainer } from '../plugins/sui/docker.js';
import {
	DEFAULT_STACK,
	readActiveStack,
	stackDir,
	writeActiveStack,
} from '../runtime/active-stack.js';
import { runIfMain } from './args.js';

export interface StackFlags {
	configPath: string;
	subcommand: 'list' | 'new' | 'use' | 'down' | 'drop';
	stackName?: string;
	yes: boolean;
	/** When true, `drop` ignores the "refuses to drop the active stack"
	 * guard. Used by the top-level `devstack reset` shortcut, where the
	 * intent is "wipe state for the active stack and start over". */
	force?: boolean;
	/** When true, `drop` lists the containers/volumes/host dir it would
	 * remove and exits without modifying anything. Pairs with the active-
	 * stack guard so users can confirm what `drop` is about to do. */
	dryRun?: boolean;
}

export async function runStack(flags: StackFlags): Promise<number> {
	const abs = resolve(flags.configPath);
	const config = await loadConfig(abs);
	const appDir = dirname(abs);

	switch (flags.subcommand) {
		case 'list':
			return listStacks({ appName: config.app, appDir });
		case 'new':
			return newStack({ appDir, name: requireName(flags) });
		case 'use':
			return useStack({ appName: config.app, appDir, name: requireName(flags) });
		case 'down':
			return downStack({
				appName: config.app,
				appDir,
				name: flags.stackName ?? readActiveStack(appDir),
			});
		case 'drop':
			return dropStack({
				appName: config.app,
				appDir,
				// `devstack reset --yes` rewrites to `stack drop --force --yes` with
				// no positional. Fall back to the active stack when --force is set
				// so the top-level USAGE ("Wipe the active stack") matches behavior.
				name: flags.stackName ?? (flags.force ? readActiveStack(appDir) : requireName(flags)),
				yes: flags.yes,
				force: flags.force,
				dryRun: flags.dryRun,
			});
	}
}

function requireName(flags: StackFlags): string {
	if (flags.stackName === undefined || flags.stackName.length === 0) {
		throw new Error(`devstack stack ${flags.subcommand} requires a <name> argument`);
	}
	return flags.stackName;
}

interface AppCtx {
	appName: string;
	appDir: string;
}

async function listStacks(ctx: AppCtx): Promise<number> {
	const active = readActiveStack(ctx.appDir);
	const stacks = listStackDirs(ctx.appDir);
	if (stacks.length === 0) {
		process.stdout.write(
			`no stacks yet — run \`pnpm localnet:up\` to create the default stack '${DEFAULT_STACK}'\n`,
		);
		return 0;
	}
	const byStack = await runningContainersByStack(ctx.appName);
	process.stdout.write(`stacks for ${ctx.appName} (active=${active}):\n`);
	for (const name of stacks) {
		const marker = name === active ? '*' : ' ';
		const containers = byStack.get(name) ?? [];
		const status = containers.length > 0 ? `${containers.length} container(s) up` : 'stopped';
		process.stdout.write(`  ${marker} ${name.padEnd(20)} ${status}\n`);
	}
	return 0;
}

function listStackDirs(appDir: string): string[] {
	const root = resolve(appDir, '.devstack', 'stacks');
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.filter((name) => {
			try {
				return statSync(resolve(root, name)).isDirectory();
			} catch {
				return false;
			}
		})
		.sort();
}

async function runningContainersByStack(appName: string): Promise<Map<string, string[]>> {
	const result = await dockerRun({
		command: [
			'ps',
			'--format',
			'{{.Names}}\t{{.Label "devstack.stack"}}',
			'--filter',
			`label=devstack.app=${appName}`,
		],
	});
	const out = new Map<string, string[]>();
	if (result.code !== 0) return out;
	for (const line of result.stdout.split('\n')) {
		const [name, stack] = line.split('\t');
		if (!name?.trim() || !stack?.trim()) continue;
		const list = out.get(stack.trim()) ?? [];
		list.push(name.trim());
		out.set(stack.trim(), list);
	}
	return out;
}

async function newStack(opts: { appDir: string; name: string }): Promise<number> {
	validateStackName(opts.name);
	const dir = stackDir(opts.appDir, opts.name);
	if (existsSync(dir)) {
		process.stderr.write(`stack '${opts.name}' already exists at ${dir}\n`);
		return 1;
	}
	mkdirSync(dir, { recursive: true });
	process.stdout.write(`created stack '${opts.name}' at ${dir}\n`);
	process.stdout.write(`  switch with: pnpm devstack stack use ${opts.name}\n`);
	return 0;
}

async function useStack(opts: { appName: string; appDir: string; name: string }): Promise<number> {
	validateStackName(opts.name);
	const dir = stackDir(opts.appDir, opts.name);
	if (!existsSync(dir)) {
		// Allow auto-create on `use`: convenient when bootstrapping a new
		// stack you intend to immediately bring up.
		mkdirSync(dir, { recursive: true });
	}
	const current = readActiveStack(opts.appDir);
	if (current === opts.name) {
		process.stdout.write(`already on stack '${opts.name}'\n`);
		return 0;
	}
	await stopStackContainers({ appName: opts.appName, stack: current });
	writeActiveStack(opts.appDir, opts.name);
	process.stdout.write(`switched ${current} → ${opts.name}\n`);
	process.stdout.write('  bring up with: pnpm localnet:up\n');
	return 0;
}

async function downStack(opts: { appName: string; appDir: string; name: string }): Promise<number> {
	await stopStackContainers({ appName: opts.appName, stack: opts.name });
	process.stdout.write(
		`stopped containers for stack '${opts.name}' (containers + volumes preserved → resumable on next \`localnet:up\`)\n`,
	);
	return 0;
}

async function dropStack(opts: {
	appName: string;
	appDir: string;
	name: string;
	yes: boolean;
	force?: boolean;
	dryRun?: boolean;
}): Promise<number> {
	validateStackName(opts.name);
	if (opts.name === DEFAULT_STACK && opts.force !== true) {
		process.stderr.write(`refusing to drop the default stack '${DEFAULT_STACK}'\n`);
		return 1;
	}
	const active = readActiveStack(opts.appDir);
	if (opts.name === active && opts.force !== true) {
		process.stderr.write(
			`refusing to drop the active stack '${opts.name}' — switch with \`devstack stack use <other>\` first\n`,
		);
		return 1;
	}
	const containerNames = await stackContainerNames(opts.appName, opts.name);
	const volumeNames = await stackVolumeNames({ appName: opts.appName, stack: opts.name });
	const dir = stackDir(opts.appDir, opts.name);
	const dirExists = existsSync(dir);
	if (opts.dryRun) {
		process.stdout.write(`drop --dry-run for stack '${opts.name}':\n`);
		process.stdout.write(
			`  containers (${containerNames.length}): ${containerNames.join(', ') || '(none)'}\n`,
		);
		process.stdout.write(
			`  volumes (${volumeNames.length}): ${volumeNames.join(', ') || '(none)'}\n`,
		);
		process.stdout.write(`  host dir: ${dirExists ? dir : '(none)'}\n`);
		process.stdout.write('  Re-run without --dry-run + with --yes to actually drop.\n');
		return 0;
	}
	if (!opts.yes) {
		process.stderr.write(
			`drop will remove docker volumes AND host state for stack '${opts.name}'. ` +
				`Use \`devstack stack drop ${opts.name} --dry-run\` to see exactly what would be deleted, ` +
				`then re-run with --yes to confirm.\n`,
		);
		return 1;
	}
	await removeStackContainers({ appName: opts.appName, stack: opts.name });
	await removeStackVolumes({ appName: opts.appName, stack: opts.name });
	await removeNetwork(`${opts.appName}-${opts.name}-net`).catch(() => undefined);
	if (dirExists) rmSync(dir, { recursive: true, force: true });
	process.stdout.write(`dropped stack '${opts.name}'\n`);
	return 0;
}

/** List a stack's container names (running or stopped). Filters by
 * `devstack.app` + `devstack.stack` labels — robust against name-prefix
 * collisions and against renaming conventions in the future. */
async function stackContainerNames(appName: string, stack: string): Promise<string[]> {
	const result = await dockerRun({
		command: [
			'ps',
			'-a',
			'--format',
			'{{.Names}}',
			'--filter',
			`label=devstack.app=${appName}`,
			'--filter',
			`label=devstack.stack=${stack}`,
		],
	});
	if (result.code !== 0) return [];
	return result.stdout
		.split('\n')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** Stop containers without removing them. Preserves docker-internal state
 * (chain data, etc.) so a subsequent `localnet:up` resumes via `docker start`
 * without firing the sui plugin's `--force-regenesis`. Use when switching
 * stacks or for `down`. */
async function stopStackContainers(opts: { appName: string; stack: string }): Promise<void> {
	const names = await stackContainerNames(opts.appName, opts.stack);
	for (const name of names) {
		await stopContainer(name).catch(() => undefined);
	}
}

/** Stop AND remove containers. Used by `drop`, where we're tearing the
 * stack down for good and the volumes are about to be deleted too. */
async function removeStackContainers(opts: { appName: string; stack: string }): Promise<void> {
	const names = await stackContainerNames(opts.appName, opts.stack);
	for (const name of names) {
		await stopContainer(name).catch(() => undefined);
		await removeContainer(name).catch(() => undefined);
	}
}

/** List a stack's named volumes by `devstack.app` + `devstack.stack`
 * labels. Falls back to name-prefix matching for legacy volumes that
 * predate label assignment (created before docker.ts started labeling
 * volumes at run time). */
async function stackVolumeNames(opts: {
	appName: string;
	stack: string;
}): Promise<string[]> {
	const labeled = await dockerRun({
		command: [
			'volume',
			'ls',
			'--format',
			'{{.Name}}',
			'--filter',
			`label=devstack.app=${opts.appName}`,
			'--filter',
			`label=devstack.stack=${opts.stack}`,
		],
	});
	const fromLabel = labeled.code === 0
		? labeled.stdout
				.split('\n')
				.map((s) => s.trim())
				.filter((s) => s.length > 0)
		: [];
	// Legacy fallback: anything that prefix-matches and isn't already in
	// the labeled set. Older devstack versions created volumes without
	// labels; this lets `stack drop` clean them up the first time.
	const prefix = `${opts.appName}-${opts.stack}-`;
	const byName = await dockerRun({
		command: ['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=${prefix}`],
	});
	const fromPrefix = byName.code === 0
		? byName.stdout
				.split('\n')
				.map((s) => s.trim())
				.filter((s) => s.length > 0 && s.startsWith(prefix))
		: [];
	const set = new Set([...fromLabel, ...fromPrefix]);
	return [...set];
}

async function removeStackVolumes(opts: { appName: string; stack: string }): Promise<void> {
	const names = await stackVolumeNames(opts);
	for (const name of names) {
		await dockerRun({ command: ['volume', 'rm', '-f', name] }).catch(() => undefined);
	}
}

const STACK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
function validateStackName(name: string): void {
	if (!STACK_NAME_RE.test(name)) {
		throw new Error(
			`stack name '${name}' must match ${STACK_NAME_RE} — lowercase letters, digits, dashes; up to 31 chars; no leading dash`,
		);
	}
}

async function loadConfig(abs: string): Promise<DevstackConfig> {
	const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
	const cfg = (mod.default ?? mod.config) as DevstackConfig | undefined;
	if (cfg === undefined || typeof cfg !== 'object') {
		throw new Error(`config at ${abs} did not export a default DevstackConfig`);
	}
	if (typeof cfg.app !== 'string') {
		throw new Error(`config at ${abs} is missing required field { app }`);
	}
	return cfg;
}

export async function main(argv: string[]): Promise<number> {
	return runStack(parseArgs(argv));
}

function parseArgs(argv: string[]): StackFlags {
	const flags: StackFlags = {
		configPath: './devstack.config.ts',
		subcommand: 'list',
		yes: false,
	};
	let positional = 0;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (arg === '--config') {
			const next = argv[++i];
			if (next !== undefined) flags.configPath = next;
		} else if (arg === '--yes' || arg === '-y') {
			flags.yes = true;
		} else if (arg === '--force') {
			flags.force = true;
		} else if (arg === '--dry-run' || arg === '-n') {
			flags.dryRun = true;
		} else if (!arg.startsWith('--')) {
			if (positional === 0) {
				if (arg !== 'list' && arg !== 'new' && arg !== 'use' && arg !== 'down' && arg !== 'drop') {
					throw new Error(
						`devstack stack: unknown subcommand '${arg}' — expected list|new|use|down|drop`,
					);
				}
				flags.subcommand = arg;
			} else if (positional === 1) {
				flags.stackName = arg;
			}
			positional++;
		}
	}
	return flags;
}

runIfMain(import.meta.url, main);
