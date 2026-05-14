import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Env } from '../engine/types.js';
import { devstackDir, snapshotPathFor, tryReadSnapshot, withStackLock } from '../persistence/index.js';
import { hasFlag, parseCommonFlags } from './args.js';
import { resolveEnvOnly } from './env.js';
import { killFromSnapshot, type KilledEntry } from './runner-state.js';

const exec = promisify(execFile);

export const WIPE_USAGE = `devstack wipe [options]

Tear down anything the prior snapshot is still running and remove the
per-stack on-disk state. Snapshot-managed runners (docker containers,
host processes) are best-effort killed by their recorded id/pid before
the state directory is removed. Localnet only.

Confirmation: \`--yes\` is required. The flag is intentionally manual
so accidental \`devstack wipe\` invocations from shell history don't
nuke a stack. Use \`devstack snapshot save <label>\` first if you want
to keep a copy of the current state.

Options:
  --yes               Required. Confirms the wipe.
  --config <path>     Override the config path
  --stack <name>      Per-stack name (default: 'main')
  --images            After wipe, run \`docker image prune -f\` to drop
                      dangling images. Frees disk on CI nodes that
                      accumulate them across runs.
  --keep-snapshots    Don't delete labeled snapshots under snapshots/
  --no-stop           Skip the kill pass — only remove on-disk state
  --json              Emit a single-line JSON summary on stdout
  -h, --help          Show this help

Examples:
  devstack wipe --yes
  devstack wipe --yes --keep-snapshots
  devstack wipe --yes --images
  devstack wipe --yes --json | jq .killed
`;

export interface RunWipeOptions {
	env: Env;
	out?: NodeJS.WriteStream;
	json?: boolean;
	noStop?: boolean;
	keepSnapshots?: boolean;
	/** After wipe, run `docker image prune -f` to drop dangling images. */
	pruneImages?: boolean;
}

export interface RunWipeResult {
	exitCode: number;
	killed: KilledEntry[];
	removedPaths: string[];
	prunedImages?: boolean;
}

// `wipe` walks the on-disk snapshot looking for runner-shaped states
// (DockerContainerState, HostProcessState) and kills them by their
// recorded id/pid — best-effort so a missing container or already-dead
// process doesn't fail the wipe. Then drops the per-stack state dir.
//
// We don't construct an Engine because hydrating + running a cycle would
// fall through to spawning new containers for any whose prior is dead —
// the opposite of what wipe wants. Walking the snapshot directly avoids
// that and keeps wipe independent of the user's config (which may
// itself be broken or removed).
export async function runWipe(opts: RunWipeOptions): Promise<RunWipeResult> {
	return withStackLock(opts.env, () => runWipeLocked(opts));
}

async function runWipeLocked(opts: RunWipeOptions): Promise<RunWipeResult> {
	const out = opts.out ?? process.stdout;
	requireLocalnet(opts.env);

	const killed: RunWipeResult['killed'] = [];
	if (opts.noStop !== true) {
		const snapshot = await tryReadSnapshot(opts.env);
		if (snapshot !== undefined) {
			killed.push(
				...(await killFromSnapshot(snapshot, {
					out,
					...(opts.json === true ? { json: true } : {}),
				})),
			);
		}
	}

	const removedPaths = await removeStackContents(opts.env, opts.keepSnapshots === true);

	let prunedImages = false;
	if (opts.pruneImages === true) {
		try {
			await exec('docker', ['image', 'prune', '-f'], { timeout: 30_000 });
			prunedImages = true;
		} catch (err) {
			if (opts.json !== true) {
				out.write(
					`  ! docker image prune failed: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
		}
	}

	if (opts.json === true) {
		out.write(
			`${JSON.stringify({
				command: 'wipe',
				stack: opts.env.stack,
				killed,
				removedPaths,
				...(opts.pruneImages === true ? { prunedImages } : {}),
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
		if (opts.pruneImages === true) {
			out.write(prunedImages ? `pruned dangling docker images.\n` : `  ! image prune skipped\n`);
		}
	}

	const result: RunWipeResult = { exitCode: 0, killed, removedPaths };
	if (opts.pruneImages === true) result.prunedImages = prunedImages;
	return result;
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

function requireLocalnet(env: Env): void {
	if (env.network !== 'localnet') {
		throw new Error(
			`wipe: only localnet has per-stack state to remove (got '${env.network}'). ` +
				`Live-net snapshots live at .devstack/networks/${env.network}.json — remove it manually if needed.`,
		);
	}
}

export async function main(argv: string[]): Promise<number> {
	const flags = parseCommonFlags(argv);
	if (flags.help === true) {
		process.stdout.write(WIPE_USAGE);
		return 0;
	}
	if (!hasFlag(argv, '--yes')) {
		process.stderr.write(
			`devstack wipe: --yes is required (refusing to wipe without explicit confirmation)\n`,
		);
		return 1;
	}
	const { env } = await resolveEnvOnly({
		cwd: process.cwd(),
		network: flags.network ?? 'localnet',
		...(flags.configPath !== undefined ? { configPath: flags.configPath } : {}),
		...(flags.stack !== undefined ? { stack: flags.stack } : {}),
	});
	const result = await runWipe({
		env,
		...(flags.json === true ? { json: true } : {}),
		...(hasFlag(argv, '--no-stop') ? { noStop: true } : {}),
		...(hasFlag(argv, '--keep-snapshots') ? { keepSnapshots: true } : {}),
		...(hasFlag(argv, '--images') ? { pruneImages: true } : {}),
	});
	return result.exitCode;
}
