// `devstack stack` — manage per-app named environments. Each stack maps
// to an isolated set of docker containers + a docker network + a host-
// side state dir at `<appDir>/.devstack/stacks/<stack>/`. State lives
// either in the container's writable layer (chain ledger, blob store)
// or in the host dir (manifest, keys, ports.json, setup markers); no
// named volumes.
//
// Subcommands (all per-app, resolve config from ./devstack.config.ts
// unless --config points elsewhere):
//
//   list                    Show all stacks, mark active, show running.
//   new <name>              Create an empty stack dir. Does not switch.
//   use <name>              Switch active. Stops the previously-active
//                           stack's containers (writable layer
//                           preserved); does not bring the new one up
//                           — run `devstack up`.
//   down [<name>]           Stop the stack's containers (writable layer
//                           preserved → resumable on next `up`). Defaults
//                           to active stack. Use `drop` to delete
//                           containers + host state entirely.
//   drop <name> [--yes]     Stop+remove containers, remove the network,
//                           and delete the host-side `stacks/<name>/`
//                           dir. Refuses on `main` and on the active
//                           stack unless --force.
//
// Stack switches don't copy chain state. Each stack is self-contained;
// a dormant stack's chain ledger sits in its container's writable
// layer (preserved across `docker stop`/`docker start`) until `drop`
// removes the container.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DevstackConfig } from '../core/types.js';
import {
	buildCacheSize,
	dockerRun,
	listImagesByLabel,
	pruneBuildCache,
	pruneDanglingDevstackImages,
	removeContainer,
	removeImage,
	removeNetwork,
	stopContainer,
} from '../plugins/sui/docker.js';
import {
	DEFAULT_STACK,
	readActiveStack,
	stackDir,
	writeActiveStack,
} from '../runtime/active-stack.js';
import { inspectSupervisorLock } from '../runtime/supervisor-lock.js';
import { runIfMain } from './args.js';

interface StackFlags {
	configPath: string;
	subcommand: 'list' | 'new' | 'use' | 'down' | 'drop';
	stackName?: string;
	yes: boolean;
	/** When true, `drop` ignores the "refuses to drop the active stack"
	 * guard. Used by the top-level `devstack reset` shortcut, where the
	 * intent is "wipe state for the active stack and start over". */
	force?: boolean;
	/** When true, `drop` lists the containers + host dir it would
	 * remove and exits without modifying anything. Pairs with the active-
	 * stack guard so users can confirm what `drop` is about to do. */
	dryRun?: boolean;
	/** When true, `drop` ALSO removes every devstack-built image
	 * (anything carrying a `devstack.cache=*` label) — sui-localnet,
	 * walrus upstream + wrapper, seal, upstream-source. Used to force
	 * a full first-build re-test from scratch. Images are global, not
	 * per-stack — so other apps sharing the same cached image will
	 * pay the rebuild cost on their next `up`. Best-effort: tags in
	 * use by a running container are kept. */
	images?: boolean;
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
				images: flags.images,
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
	// Refuse the switch when a supervisor is running on the current
	// stack — switching while a supervisor is alive causes it to
	// resurrect containers in a tight loop because its in-memory stack
	// pointer doesn't re-read the active-stack file.
	const lockState = inspectSupervisorLock({ appDir: opts.appDir, stack: current });
	if (lockState !== null && lockState.alive) {
		process.stderr.write(
			`refusing to switch from active stack '${current}' — a supervisor is running ` +
				`(PID ${lockState.pid}). Stop it (Ctrl-C, or kill ${lockState.pid}) before switching.\n`,
		);
		return 1;
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
		`stopped containers for stack '${opts.name}' (writable layer preserved → resumable on next \`devstack up\`)\n`,
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
	images?: boolean;
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
	const dir = stackDir(opts.appDir, opts.name);
	const dirExists = existsSync(dir);
	// Cached devstack-built images carry `devstack.cache=<kind>` —
	// listing them with no value matches every kind (sui-localnet,
	// walrus-upstream, walrus-service, seal, upstream-source). Only
	// queried when `--images` is set; otherwise we skip the docker call.
	const cachedImages =
		opts.images === true ? await listImagesByLabel({ 'devstack.cache': '' }) : [];
	if (opts.dryRun) {
		process.stdout.write(`drop --dry-run for stack '${opts.name}':\n`);
		process.stdout.write(
			`  containers (${containerNames.length}): ${containerNames.join(', ') || '(none)'}\n`,
		);
		process.stdout.write(`  host dir: ${dirExists ? dir : '(none)'}\n`);
		if (opts.images === true) {
			process.stdout.write(
				`  cached images (${cachedImages.length}, GLOBAL — affects every app on this host):\n`,
			);
			for (const img of cachedImages) {
				process.stdout.write(`    ${img.ref}\n`);
			}
			if (cachedImages.length === 0) {
				process.stdout.write('    (none)\n');
			}
			// Image-rm leaves layers + BuildKit cache behind. Without
			// also pruning those, a rebuild after `--images` short-
			// circuits through cache and doesn't actually re-exercise
			// the build path the operator is trying to retest. Show
			// the reclaim estimate so the user sees what `--images`
			// will free.
			const reclaimable = await buildCacheSize();
			process.stdout.write(
				`  dangling layers + BuildKit cache: would run ` +
					`\`docker image prune -f --filter label=devstack.cache\` + ` +
					`\`docker builder prune -f\`` +
					(reclaimable !== undefined ? ` (currently ${reclaimable} reclaimable)` : '') +
					'\n',
			);
		}
		process.stdout.write('  Re-run without --dry-run + with --yes to actually drop.\n');
		return 0;
	}
	if (!opts.yes) {
		const imagesNote =
			opts.images === true ? ' AND every cached devstack image (GLOBAL — all apps)' : '';
		process.stderr.write(
			`drop will remove containers AND host state for stack '${opts.name}'${imagesNote}. ` +
				`Use \`devstack stack drop ${opts.name}${opts.images === true ? ' --images' : ''} --dry-run\` ` +
				'to see exactly what would be deleted, then re-run with --yes to confirm.\n',
		);
		return 1;
	}
	await removeStackContainers({ appName: opts.appName, stack: opts.name });
	await removeNetwork(`${opts.appName}-${opts.name}-net`).catch(() => undefined);
	if (dirExists) rmSync(dir, { recursive: true, force: true });
	if (opts.images === true) {
		let removed = 0;
		let kept = 0;
		for (const img of cachedImages) {
			if (await removeImage(img.ref)) {
				removed++;
			} else {
				kept++;
				process.stdout.write(`  kept ${img.ref} (in use or has dependents)\n`);
			}
		}
		process.stdout.write(
			`removed ${removed} cached image${removed === 1 ? '' : 's'}` +
				(kept > 0 ? ` (${kept} skipped)` : '') +
				'\n',
		);
		// `removeImage` only drops tags. Untagged layer manifests stay
		// in `docker image ls`, and the BuildKit layer cache that backed
		// each build stays in BuildKit's separate store — so a rebuild
		// would short-circuit through cache instead of actually
		// re-running. Prune both for a real "first build from scratch"
		// re-test.
		const dangling = await pruneDanglingDevstackImages();
		const danglingMatch = dangling.output.match(/Total reclaimed space:\s*(\S+)/);
		process.stdout.write(
			`pruned dangling image layers (${danglingMatch?.[1] ?? '0B'} reclaimed)\n`,
		);
		const cache = await pruneBuildCache();
		const cacheMatch = cache.output.match(/Total:\s*(\S+)|Total reclaimed space:\s*(\S+)/);
		const cacheFreed = cacheMatch?.[1] ?? cacheMatch?.[2] ?? '0B';
		process.stdout.write(`pruned BuildKit cache (${cacheFreed} reclaimed)\n`);
	}
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
 * stack down for good — host state dir gets deleted next. */
async function removeStackContainers(opts: { appName: string; stack: string }): Promise<void> {
	const names = await stackContainerNames(opts.appName, opts.stack);
	for (const name of names) {
		await stopContainer(name).catch(() => undefined);
		await removeContainer(name).catch(() => undefined);
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
	if (argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(USAGE);
		return 0;
	}
	return runStack(parseArgs(argv));
}

const USAGE = `devstack stack <subcommand> [options]

Manage per-app named stacks. Each stack is an isolated set of containers
+ docker network + host-side state dir. Default stack is 'main'.

Subcommands:
  list                          Show all stacks; mark active.
  new <name>                    Create a stack dir (does not switch).
  use <name>                    Switch active. Stops the previous
                                stack's containers (writable layer
                                preserved). Run \`devstack up\` to bring
                                the new stack up.
  down [<name>]                 Stop containers, preserve writable
                                layer. Defaults to active stack.
  drop <name> [--yes] [--force] Stop+remove containers, network, and
                                host state dir. Refuses on 'main' and
                                on the active stack without --force.
                                --dry-run / -n previews without acting.
                                --images additionally drops every
                                cached devstack-built image (GLOBAL —
                                affects all apps on this host).

Options:
  --config <path>               Override the config path
  --yes, -y                     Skip the drop confirmation prompt
  --force                       Allow drop on the active stack
  --dry-run, -n                 Print what drop would do; no changes
  --images                      Also remove every devstack.cache=*
                                image. Affects all apps on the host.
`;

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
		} else if (arg === '--images') {
			flags.images = true;
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
