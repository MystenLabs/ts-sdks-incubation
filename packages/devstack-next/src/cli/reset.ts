import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import type { Env, SnapshotRecord } from '../engine/types.js';
import { devstackDir, snapshotPathFor, tryReadSnapshot } from '../persistence/index.js';
import { hasFlag, parseCommonFlags } from './args.js';
import { resolveEnvOnly } from './env.js';

const exec = promisify(execFile);

export const RESET_USAGE = `devstack-next reset [options]

Tear down anything the prior snapshot is still running and remove the
per-stack on-disk state. Snapshot-managed runners (docker containers,
host processes) are best-effort killed by their recorded id/pid before
the state directory is removed. Localnet only.

Use \`devstack-next snapshot save <label>\` first if you want to keep
a copy of the current state.

Options:
  --config <path>     Override the config path
  --stack <name>      Per-stack name (default: 'main')
  --keep-snapshots    Don't delete labeled snapshots under snapshots/
  --no-stop           Skip the kill pass — only remove on-disk state
  --json              Emit a single-line JSON summary on stdout
  -h, --help          Show this help

Examples:
  devstack-next reset
  devstack-next reset --keep-snapshots
  devstack-next reset --json | jq .killed
`;

export interface RunResetOptions {
	env: Env;
	out?: NodeJS.WriteStream;
	json?: boolean;
	noStop?: boolean;
	keepSnapshots?: boolean;
}

export interface RunResetResult {
	exitCode: number;
	killed: { name: string; kind: 'docker' | 'process'; ref: string }[];
	removedPaths: string[];
}

// `reset` walks the on-disk snapshot looking for runner-shaped states
// (DockerContainerState, HostProcessState) and kills them by their
// recorded id/pid — best-effort so a missing container or already-dead
// process doesn't fail the reset. Then drops the per-stack state dir.
//
// We don't construct an Engine because hydrating + running a cycle would
// fall through to spawning new containers for any whose prior is dead —
// the opposite of what reset wants. Walking the snapshot directly avoids
// that and keeps reset independent of the user's config (which may
// itself be broken or removed).
export async function runReset(opts: RunResetOptions): Promise<RunResetResult> {
	const out = opts.out ?? process.stdout;
	requireLocalnet(opts.env);

	const killed: RunResetResult['killed'] = [];
	if (opts.noStop !== true) {
		const snapshot = await tryReadSnapshot(opts.env);
		if (snapshot !== undefined) {
			killed.push(...(await killFromSnapshot(snapshot, out, opts.json === true)));
		}
	}

	const removedPaths = await removeStackContents(opts.env, opts.keepSnapshots === true);

	if (opts.json === true) {
		out.write(
			`${JSON.stringify({
				command: 'reset',
				stack: opts.env.stack,
				killed,
				removedPaths,
			})}\n`,
		);
	} else {
		if (killed.length === 0 && opts.noStop !== true) {
			out.write(`nothing running to stop.\n`);
		}
		for (const path of removedPaths) {
			out.write(`removed ${path}\n`);
		}
		if (removedPaths.length === 0) {
			out.write(`nothing on disk to remove.\n`);
		}
	}

	return { exitCode: 0, killed, removedPaths };
}

async function killFromSnapshot(
	snapshot: SnapshotRecord,
	out: NodeJS.WriteStream,
	json: boolean,
): Promise<RunResetResult['killed']> {
	const killed: RunResetResult['killed'] = [];
	for (const [name, nodeState] of Object.entries(snapshot.nodeStates)) {
		const state = nodeState.state;
		if (!isPlainObject(state)) continue;
		if (looksLikeDockerContainerState(state)) {
			const containerId = state.containerId as string;
			if (await dockerContainerExists(containerId)) {
				if (!json) out.write(`stopping container ${containerId.slice(0, 12)} (${name})\n`);
				try {
					await exec('docker', ['rm', '-f', containerId]);
					killed.push({ name, kind: 'docker', ref: containerId });
				} catch (err) {
					if (!json) {
						out.write(
							`  ! docker rm -f ${containerId.slice(0, 12)} failed: ${asMessage(err)}\n`,
						);
					}
				}
			}
		} else if (looksLikeHostProcessState(state)) {
			const pid = state.pid as number;
			if (isAlive(pid)) {
				if (!json) out.write(`stopping process pid=${pid} (${name})\n`);
				try {
					process.kill(pid, 'SIGTERM');
					killed.push({ name, kind: 'process', ref: String(pid) });
				} catch (err) {
					if (!json) out.write(`  ! kill ${pid} failed: ${asMessage(err)}\n`);
				}
			}
		}
	}
	return killed;
}

async function removeStackContents(env: Env, keepSnapshots: boolean): Promise<string[]> {
	const removed: string[] = [];
	const snapshotPath = snapshotPathFor(env);
	if (await pathExists(snapshotPath)) {
		await rm(snapshotPath, { force: true });
		removed.push(snapshotPath);
	}
	const stackDir = join(devstackDir(env), 'stacks', env.stack ?? 'main');
	if (keepSnapshots) {
		// Drop everything in the stack dir except `snapshots/`.
		for (const sub of await readDirSafe(stackDir)) {
			if (sub === 'snapshots') continue;
			const full = join(stackDir, sub);
			await rm(full, { recursive: true, force: true });
			removed.push(full);
		}
	} else if (await pathExists(stackDir)) {
		await rm(stackDir, { recursive: true, force: true });
		// snapshotPath is inside stackDir; report the directory but de-dup.
		if (!removed.includes(stackDir)) removed.push(stackDir);
		const i = removed.indexOf(snapshotPath);
		if (i >= 0) removed.splice(i, 1);
	}
	return removed;
}

async function readDirSafe(dir: string): Promise<string[]> {
	try {
		const { readdir } = await import('node:fs/promises');
		return await readdir(dir);
	} catch (err) {
		if ((err as { code?: string }).code === 'ENOENT') return [];
		throw err;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		const { stat } = await import('node:fs/promises');
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function looksLikeDockerContainerState(s: Record<string, unknown>): boolean {
	return (
		typeof s.containerId === 'string' &&
		typeof s.image === 'string' &&
		typeof s.hostPorts === 'object' &&
		s.hostPorts !== null
	);
}

function looksLikeHostProcessState(s: Record<string, unknown>): boolean {
	return typeof s.pid === 'number' && typeof s.command === 'string' && Array.isArray(s.args);
}

async function dockerContainerExists(id: string): Promise<boolean> {
	try {
		await exec('docker', ['inspect', id]);
		return true;
	} catch {
		return false;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function requireLocalnet(env: Env): void {
	if (env.network !== 'localnet') {
		throw new Error(
			`reset: only localnet has per-stack state to remove (got '${env.network}'). ` +
				`Live-net snapshots live at .devstack/networks/${env.network}.json — remove it manually if needed.`,
		);
	}
}

function asMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function main(argv: string[]): Promise<number> {
	const flags = parseCommonFlags(argv);
	if (flags.help === true) {
		process.stdout.write(RESET_USAGE);
		return 0;
	}
	const { env } = await resolveEnvOnly({
		cwd: process.cwd(),
		network: flags.network ?? 'localnet',
		...(flags.configPath !== undefined ? { configPath: flags.configPath } : {}),
		...(flags.stack !== undefined ? { stack: flags.stack } : {}),
	});
	const result = await runReset({
		env,
		...(flags.json === true ? { json: true } : {}),
		...(hasFlag(argv, '--no-stop') ? { noStop: true } : {}),
		...(hasFlag(argv, '--keep-snapshots') ? { keepSnapshots: true } : {}),
	});
	return result.exitCode;
}
