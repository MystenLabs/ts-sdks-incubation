import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Env, SnapshotRecord } from '../engine/types.js';
import { devstackDir, snapshotPathFor, tryReadSnapshot } from '../persistence/index.js';
import { hasFlag, parseCommonFlags, readPositionals } from './args.js';
import { isValidStackName, readActiveStack, resolveEnvOnly, writeActiveStack } from './env.js';
import {
	dockerContainerExists,
	isAlive,
	isPlainObject,
	killFromSnapshot,
	looksLikeDockerContainerState,
	looksLikeHostProcessState,
	type KilledEntry,
} from './runner-state.js';

export const STACK_USAGE = `devstack-next stack <subcommand> [options]

Manage per-app stacks. A stack is a named, isolated set of state under
\`<appDir>/.devstack/stacks/<name>/\` — its own snapshot, account keys,
labeled snapshots. Stacks let multiple devstack runs coexist on one
host (e.g. \`main\` for dev, \`test\` for vitest, \`e2e-N\` for parallel
playwright workers). Localnet only.

Subcommands:
  list                    Show every stack on disk for this app, with
                          a count of running runners (containers,
                          processes) recorded in each snapshot.
  new <name>              Create the per-stack state directory at
                          <appDir>/.devstack/stacks/<name>/. Idempotent.
                          Does not start anything — pair with \`up\` or
                          \`stack use\`.
  use <name>              Write <appDir>/.devstack/active so unflagged
                          commands default to <name>. Equivalent to
                          passing --stack <name> on every command.
  down [<name>]           Stop the stack's recorded runners but keep
                          state on disk so a follow-up \`up\` resumes.
                          Sister to \`reset\`, which clears state. The
                          positional defaults to --stack flag (or
                          'main' if neither is given).

Options:
  --config <path>         Override the config path
  --stack <name>          Per-stack name (used as default for \`down\`)
  --json                  Emit a single-line JSON summary on stdout
  -h, --help              Show this help

Examples:
  devstack-next stack list
  devstack-next stack list --json | jq '.stacks[] | select(.running > 0)'
  devstack-next stack down test
`;

export interface StackEntry {
	name: string;
	hasSnapshot: boolean;
	running: number;
	createdAt?: number;
	snapshotPath: string;
}

export interface RunStackListOptions {
	env: Env;
	out?: NodeJS.WriteStream;
	json?: boolean;
}

export interface RunStackListResult {
	exitCode: number;
	stacks: StackEntry[];
}

// `stack list` — read-only walk of `<appDir>/.devstack/stacks/`.
// For each stack, read the snapshot if present and tally how many
// recorded runners (DockerContainer/HostProcess) are currently alive.
// No engine construction — the user can run this when nothing is
// loaded.
export async function runStackList(opts: RunStackListOptions): Promise<RunStackListResult> {
	const out = opts.out ?? process.stdout;
	requireLocalnet(opts.env, 'list');

	const stacksRoot = join(devstackDir(opts.env), 'stacks');
	let names: string[];
	try {
		names = await readdir(stacksRoot);
	} catch (err) {
		if ((err as { code?: string }).code === 'ENOENT') names = [];
		else throw err;
	}
	const visible: string[] = [];
	for (const name of names) {
		try {
			const st = await stat(join(stacksRoot, name));
			if (st.isDirectory()) visible.push(name);
		} catch {
			// skip
		}
	}
	visible.sort();

	const stacks: StackEntry[] = [];
	for (const name of visible) {
		const stackEnv: Env = { ...opts.env, stack: name };
		const snapshotPath = snapshotPathFor(stackEnv);
		const snapshot = await tryReadSnapshot(stackEnv);
		if (snapshot === undefined) {
			stacks.push({ name, hasSnapshot: false, running: 0, snapshotPath });
			continue;
		}
		const running = await countRunning(snapshot);
		stacks.push({
			name,
			hasSnapshot: true,
			running,
			createdAt: snapshot.createdAt,
			snapshotPath,
		});
	}

	if (opts.json === true) {
		out.write(
			`${JSON.stringify({
				command: 'stack list',
				appName: opts.env.appName,
				stacks: stacks.map((s) => ({
					name: s.name,
					hasSnapshot: s.hasSnapshot,
					running: s.running,
					...(s.createdAt !== undefined ? { createdAt: s.createdAt } : {}),
				})),
			})}\n`,
		);
		return { exitCode: 0, stacks };
	}

	if (stacks.length === 0) {
		out.write(`no stacks for app '${opts.env.appName}' yet — run \`devstack-next up\` first\n`);
		return { exitCode: 0, stacks };
	}
	out.write(`stacks for app '${opts.env.appName}':\n`);
	for (const s of stacks) {
		const tag = s.hasSnapshot
			? `${s.running} running runner${s.running === 1 ? '' : 's'}`
			: 'no snapshot';
		out.write(`  ${s.name.padEnd(20)}${tag}\n`);
	}
	return { exitCode: 0, stacks };
}

export interface RunStackDownOptions {
	env: Env;
	out?: NodeJS.WriteStream;
	json?: boolean;
}

export interface RunStackDownResult {
	exitCode: number;
	killed: KilledEntry[];
}

// `stack down` — best-effort stop snapshot-recorded runners; preserve
// on-disk state so a follow-up `up` resumes from the same snapshot.
// The complement of `reset` (which removes state). Localnet only.
export async function runStackDown(opts: RunStackDownOptions): Promise<RunStackDownResult> {
	const out = opts.out ?? process.stdout;
	requireLocalnet(opts.env, 'down');
	const snapshot = await tryReadSnapshot(opts.env);
	if (snapshot === undefined) {
		const path = snapshotPathFor(opts.env);
		if (opts.json === true) {
			out.write(
				`${JSON.stringify({
					command: 'stack down',
					stack: opts.env.stack,
					snapshotPath: path,
					killed: [],
				})}\n`,
			);
		} else {
			out.write(`stack '${opts.env.stack ?? 'main'}': no snapshot at ${path} — nothing to stop\n`);
		}
		return { exitCode: 0, killed: [] };
	}

	const killed = await killFromSnapshot(snapshot, {
		out,
		...(opts.json === true ? { json: true } : {}),
	});

	if (opts.json === true) {
		out.write(
			`${JSON.stringify({
				command: 'stack down',
				stack: opts.env.stack,
				killed,
			})}\n`,
		);
	} else if (killed.length === 0) {
		out.write(`stack '${opts.env.stack ?? 'main'}': nothing running to stop\n`);
	} else {
		out.write(`stopped ${killed.length} runner${killed.length === 1 ? '' : 's'}\n`);
		out.write(`(state kept; run \`devstack-next up\` to resume, or \`reset\` to clear)\n`);
	}
	return { exitCode: 0, killed };
}

export interface RunStackNewOptions {
	env: Env;
	name: string;
	out?: NodeJS.WriteStream;
	json?: boolean;
}

export interface RunStackNewResult {
	exitCode: number;
	stackDir: string;
	created: boolean;
}

// `stack new <name>` — mkdir-p the per-stack state dir. Idempotent
// (already-exists isn't an error). Localnet only.
export async function runStackNew(opts: RunStackNewOptions): Promise<RunStackNewResult> {
	const out = opts.out ?? process.stdout;
	requireLocalnet(opts.env, 'new');
	if (!isValidStackName(opts.name)) {
		throw new Error(
			`stack new: name '${opts.name}' is invalid (must be lowercase + digits + ._-, 1-64 chars)`,
		);
	}
	const stackDir = join(devstackDir(opts.env), 'stacks', opts.name);
	let created: boolean;
	try {
		await stat(stackDir);
		created = false;
	} catch {
		created = true;
	}
	await mkdir(stackDir, { recursive: true });
	if (opts.json === true) {
		out.write(
			`${JSON.stringify({ command: 'stack new', stack: opts.name, stackDir, created })}\n`,
		);
	} else if (created) {
		out.write(`stack '${opts.name}': created at ${stackDir}\n`);
	} else {
		out.write(`stack '${opts.name}': already exists at ${stackDir}\n`);
	}
	return { exitCode: 0, stackDir, created };
}

export interface RunStackUseOptions {
	env: Env;
	name: string;
	out?: NodeJS.WriteStream;
	json?: boolean;
}

export interface RunStackUseResult {
	exitCode: number;
	previous?: string;
	active: string;
}

// `stack use <name>` — write `<appDir>/.devstack/active` so unflagged
// commands default to <name>. The corresponding stack dir is created
// if missing (mkdir-p) so `use` followed by `up` doesn't trip on a
// stack that was never explicitly `new`-ed.
export async function runStackUse(opts: RunStackUseOptions): Promise<RunStackUseResult> {
	const out = opts.out ?? process.stdout;
	requireLocalnet(opts.env, 'use');
	if (!isValidStackName(opts.name)) {
		throw new Error(
			`stack use: name '${opts.name}' is invalid (must be lowercase + digits + ._-, 1-64 chars)`,
		);
	}
	const previous = await readActiveStack(opts.env.appDir);
	await mkdir(join(devstackDir(opts.env), 'stacks', opts.name), { recursive: true });
	await writeActiveStack(opts.env.appDir, opts.name);

	if (opts.json === true) {
		out.write(
			`${JSON.stringify({
				command: 'stack use',
				active: opts.name,
				...(previous !== undefined ? { previous } : {}),
			})}\n`,
		);
	} else if (previous === opts.name) {
		out.write(`stack '${opts.name}': already active\n`);
	} else if (previous === undefined) {
		out.write(`stack '${opts.name}': now active (no prior default)\n`);
	} else {
		out.write(`stack '${opts.name}': now active (was '${previous}')\n`);
	}
	const result: RunStackUseResult = { exitCode: 0, active: opts.name };
	if (previous !== undefined) result.previous = previous;
	return result;
}

async function countRunning(snapshot: SnapshotRecord): Promise<number> {
	let running = 0;
	for (const nodeState of Object.values(snapshot.nodeStates)) {
		const state = nodeState.state;
		if (!isPlainObject(state)) continue;
		if (looksLikeDockerContainerState(state)) {
			if (await dockerContainerExists(state.containerId as string)) running += 1;
		} else if (looksLikeHostProcessState(state)) {
			if (isAlive(state.pid as number)) running += 1;
		}
	}
	return running;
}

function requireLocalnet(env: Env, sub: string): void {
	if (env.network !== 'localnet') {
		throw new Error(
			`stack ${sub}: stacks are a localnet-only concept (got '${env.network}'). ` +
				`Live-net snapshots are keyed by network alone — see .devstack/networks/.`,
		);
	}
}

export async function main(argv: string[]): Promise<number> {
	if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
		process.stdout.write(STACK_USAGE);
		return 0;
	}
	const positionals = readPositionals(argv);
	const sub = positionals[0];
	if (sub === undefined) {
		process.stderr.write(`devstack-next stack: subcommand required\n${STACK_USAGE}`);
		return 1;
	}
	const flags = parseCommonFlags(argv);
	const baseEnv = await resolveEnvOnly({
		cwd: process.cwd(),
		network: flags.network ?? 'localnet',
		...(flags.configPath !== undefined ? { configPath: flags.configPath } : {}),
		...(flags.stack !== undefined ? { stack: flags.stack } : {}),
	});
	const json = flags.json === true;

	switch (sub) {
		case 'list': {
			const result = await runStackList({
				env: baseEnv.env,
				...(json ? { json: true } : {}),
			});
			return result.exitCode;
		}
		case 'new': {
			const name = positionals[1];
			if (name === undefined) {
				process.stderr.write(`devstack-next stack new: <name> required\n`);
				return 1;
			}
			const result = await runStackNew({
				env: baseEnv.env,
				name,
				...(json ? { json: true } : {}),
			});
			return result.exitCode;
		}
		case 'use': {
			const name = positionals[1];
			if (name === undefined) {
				process.stderr.write(`devstack-next stack use: <name> required\n`);
				return 1;
			}
			const result = await runStackUse({
				env: baseEnv.env,
				name,
				...(json ? { json: true } : {}),
			});
			return result.exitCode;
		}
		case 'down': {
			// Positional `name` overrides --stack flag. Default to 'main'.
			const target = positionals[1] ?? baseEnv.env.stack ?? 'main';
			const env: Env = { ...baseEnv.env, stack: target };
			const result = await runStackDown({
				env,
				...(json ? { json: true } : {}),
			});
			return result.exitCode;
		}
		default:
			process.stderr.write(`devstack-next stack: unknown subcommand '${sub}'\n${STACK_USAGE}`);
			return 1;
	}
}
