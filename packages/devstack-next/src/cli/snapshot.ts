import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Env, SnapshotRecord } from '../engine/types.js';
import {
	labeledSnapshotPath,
	labeledSnapshotsDir,
	snapshotPathFor,
	tryReadSnapshot,
	writeJsonAtomic,
} from '../persistence/index.js';
import { hasFlag, parseCommonFlags, readPositionals } from './args.js';
import { resolveEnvOnly } from './env.js';

export const SNAPSHOT_USAGE = `devstack-next snapshot <subcommand> [options]

Capture / restore labeled snapshots of the current stack. Snapshots are
JSON SnapshotRecord files copied to/from
\`<appDir>/.devstack/stacks/<stack>/snapshots/<id>[-<label>].json\`.
Localnet only — labeled snapshots make no sense on shared remote nets.

Subcommands:
  save [label]            Capture the current snapshot.json into a labeled
                          file. id is derived from the snapshot's
                          createdAt — saving twice from the same snapshot
                          is idempotent.
  restore <label|id>      Copy a labeled snapshot back onto snapshot.json.
                          Run \`devstack-next up\` afterwards to reconcile.
  list                    List all labeled snapshots, newest first.
  delete <label|id>       Remove one labeled snapshot.

Options:
  --config <path>         Override the config path (default: walk up from
                          cwd looking for devstack.config.ts)
  --stack <name>          Per-stack name (default: 'main')
  --json                  Emit single-line JSON on stdout
  -h, --help              Show this help

Examples:
  devstack-next snapshot save baseline
  devstack-next snapshot list
  devstack-next snapshot list --json | jq '.snapshots[].label'
  devstack-next snapshot restore baseline
  devstack-next snapshot delete baseline
`;

export interface SnapshotEntry {
	id: string;
	label?: string;
	path: string;
	createdAt: number;
}

export interface RunSnapshotSaveOptions {
	env: Env;
	label?: string;
	out?: NodeJS.WriteStream;
	json?: boolean;
}

export interface RunSnapshotSaveResult {
	exitCode: number;
	path?: string;
	id?: string;
	label?: string;
}

// `snapshot save` — copy the canonical snapshot.json to a labeled file.
// id is derived from the snapshot's `createdAt` so saving twice from the
// same canonical snapshot is idempotent (same target path).
export async function runSnapshotSave(
	opts: RunSnapshotSaveOptions,
): Promise<RunSnapshotSaveResult> {
	const out = opts.out ?? process.stdout;
	requireLocalnet(opts.env, 'save');
	if (opts.label !== undefined) validateLabel(opts.label);
	const snapshot = await tryReadSnapshot(opts.env);
	if (snapshot === undefined) {
		const canonical = snapshotPathFor(opts.env);
		writeError(out, opts.json === true, 'snapshot save', {
			error: `no snapshot at ${canonical} — run \`devstack-next apply\` first`,
		});
		return { exitCode: 1 };
	}
	const id = idFromCreatedAt(snapshot.createdAt);
	const path = labeledSnapshotPath(opts.env, id, opts.label);
	await writeJsonAtomic(path, snapshot);
	if (opts.json === true) {
		out.write(
			`${JSON.stringify({
				command: 'snapshot save',
				stack: opts.env.stack,
				id,
				label: opts.label,
				path,
			})}\n`,
		);
	} else {
		const aliasTag = opts.label ? ` (label='${opts.label}')` : '';
		out.write(`saved snapshot ${id}${aliasTag}\n  → ${path}\n`);
	}
	return { exitCode: 0, path, id, label: opts.label };
}

export interface RunSnapshotRestoreOptions {
	env: Env;
	ref: string;
	out?: NodeJS.WriteStream;
	json?: boolean;
}

export interface RunSnapshotRestoreResult {
	exitCode: number;
	source?: string;
	target?: string;
}

// `snapshot restore` — locate the labeled snapshot by label or id-prefix
// and copy it onto snapshot.json. The user runs `up`/`apply` next to
// reconcile against the restored state.
export async function runSnapshotRestore(
	opts: RunSnapshotRestoreOptions,
): Promise<RunSnapshotRestoreResult> {
	const out = opts.out ?? process.stdout;
	requireLocalnet(opts.env, 'restore');
	const entries = await listEntries(opts.env);
	const match = findMatch(entries, opts.ref);
	if (match === undefined) {
		writeError(out, opts.json === true, 'snapshot restore', {
			error: `no snapshot matching '${opts.ref}'`,
		});
		return { exitCode: 1 };
	}
	const raw = await readFile(match.path, 'utf8');
	const parsed = JSON.parse(raw) as SnapshotRecord;
	const target = snapshotPathFor(opts.env);
	await writeJsonAtomic(target, parsed);
	if (opts.json === true) {
		out.write(
			`${JSON.stringify({
				command: 'snapshot restore',
				stack: opts.env.stack,
				id: match.id,
				label: match.label,
				source: match.path,
				target,
			})}\n`,
		);
	} else {
		out.write(`restored snapshot ${match.id}${match.label ? ` (label='${match.label}')` : ''}\n`);
		out.write(`  ${match.path}\n  → ${target}\n`);
		out.write(`run \`devstack-next up\` to reconcile against the restored state.\n`);
	}
	return { exitCode: 0, source: match.path, target };
}

export interface RunSnapshotListOptions {
	env: Env;
	out?: NodeJS.WriteStream;
	json?: boolean;
}

export interface RunSnapshotListResult {
	exitCode: number;
	entries: SnapshotEntry[];
}

export async function runSnapshotList(
	opts: RunSnapshotListOptions,
): Promise<RunSnapshotListResult> {
	const out = opts.out ?? process.stdout;
	requireLocalnet(opts.env, 'list');
	const entries = await listEntries(opts.env);
	if (opts.json === true) {
		out.write(
			`${JSON.stringify({
				command: 'snapshot list',
				stack: opts.env.stack,
				snapshots: entries.map((e) => ({
					id: e.id,
					label: e.label,
					path: e.path,
					createdAt: e.createdAt,
				})),
			})}\n`,
		);
		return { exitCode: 0, entries };
	}
	if (entries.length === 0) {
		out.write(`no snapshots for stack '${opts.env.stack ?? 'main'}'\n`);
		return { exitCode: 0, entries };
	}
	out.write(`snapshots for stack '${opts.env.stack ?? 'main'}' (newest first):\n`);
	for (const e of entries) {
		const labelTag = e.label ? `  ${e.label}` : '';
		out.write(`  ${e.id}${labelTag}\n    ${e.path}\n`);
	}
	return { exitCode: 0, entries };
}

export interface RunSnapshotDeleteOptions {
	env: Env;
	ref: string;
	out?: NodeJS.WriteStream;
	json?: boolean;
}

export interface RunSnapshotDeleteResult {
	exitCode: number;
	path?: string;
}

export async function runSnapshotDelete(
	opts: RunSnapshotDeleteOptions,
): Promise<RunSnapshotDeleteResult> {
	const out = opts.out ?? process.stdout;
	requireLocalnet(opts.env, 'delete');
	const entries = await listEntries(opts.env);
	const match = findMatch(entries, opts.ref);
	if (match === undefined) {
		writeError(out, opts.json === true, 'snapshot delete', {
			error: `no snapshot matching '${opts.ref}'`,
		});
		return { exitCode: 1 };
	}
	await rm(match.path);
	if (opts.json === true) {
		out.write(
			`${JSON.stringify({
				command: 'snapshot delete',
				stack: opts.env.stack,
				id: match.id,
				label: match.label,
				path: match.path,
			})}\n`,
		);
	} else {
		out.write(`deleted snapshot ${match.id}${match.label ? ` (label='${match.label}')` : ''}\n`);
	}
	return { exitCode: 0, path: match.path };
}

// Read every `<id>[-<label>].json` from the labeled snapshots dir and
// parse out (id, label?, createdAt). Returns newest-first by id (which is
// chronological because id derives from a UTC timestamp).
async function listEntries(env: Env): Promise<SnapshotEntry[]> {
	const dir = labeledSnapshotsDir(env);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (err) {
		if ((err as { code?: string }).code === 'ENOENT') return [];
		throw err;
	}
	const out: SnapshotEntry[] = [];
	for (const name of names) {
		if (!name.endsWith('.json')) continue;
		const stem = name.slice(0, -5);
		// Split on the FIRST '-' so labels can themselves contain hyphens.
		const dash = stem.indexOf('-');
		const id = dash === -1 ? stem : stem.slice(0, dash);
		const label = dash === -1 ? undefined : stem.slice(dash + 1);
		const path = join(dir, name);
		// Read createdAt for the JSON summary. Tolerate parse failures —
		// list shouldn't crash on a single corrupt entry.
		let createdAt = 0;
		try {
			const raw = await readFile(path, 'utf8');
			const parsed = JSON.parse(raw) as { createdAt?: number };
			if (typeof parsed.createdAt === 'number') createdAt = parsed.createdAt;
		} catch {
			// leave createdAt at 0; sorts to bottom
		}
		const entry: SnapshotEntry = { id, path, createdAt };
		if (label !== undefined) entry.label = label;
		out.push(entry);
	}
	out.sort((a, b) => (b.id > a.id ? 1 : b.id < a.id ? -1 : 0));
	return out;
}

// Match a user-supplied ref against the entry list. Resolution order:
//   1. exact label match (most natural — user types the label they saved)
//   2. exact id match
//   3. id prefix match (must be unambiguous)
function findMatch(entries: SnapshotEntry[], ref: string): SnapshotEntry | undefined {
	const byLabel = entries.filter((e) => e.label === ref);
	if (byLabel.length > 0) return byLabel[0];
	const byId = entries.find((e) => e.id === ref);
	if (byId) return byId;
	const prefix = entries.filter((e) => e.id.startsWith(ref));
	if (prefix.length === 1) return prefix[0];
	return undefined;
}

function idFromCreatedAt(createdAt: number): string {
	const d = new Date(createdAt);
	const pad = (n: number, w = 2) => String(n).padStart(w, '0');
	return (
		`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
		`T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
	);
}

const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
function validateLabel(label: string): void {
	if (!LABEL_RE.test(label)) {
		throw new Error(
			`snapshot label '${label}' must match ${LABEL_RE} (alnum + . _ -, 1–64 chars)`,
		);
	}
}

function requireLocalnet(env: Env, sub: string): void {
	if (env.network !== 'localnet') {
		throw new Error(
			`snapshot ${sub}: labeled snapshots are only supported on localnet (got '${env.network}')`,
		);
	}
}

function writeError(
	out: NodeJS.WriteStream,
	json: boolean,
	command: string,
	body: { error: string },
): void {
	if (json) {
		out.write(`${JSON.stringify({ command, ...body })}\n`);
	} else {
		out.write(`${body.error}\n`);
	}
}

export async function main(argv: string[]): Promise<number> {
	if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
		process.stdout.write(SNAPSHOT_USAGE);
		return 0;
	}
	const positionals = readPositionals(argv);
	const sub = positionals[0];
	if (sub === undefined) {
		process.stderr.write(`devstack-next snapshot: subcommand required\n${SNAPSHOT_USAGE}`);
		return 1;
	}
	const flags = parseCommonFlags(argv);
	const { env } = await resolveEnvOnly({
		cwd: process.cwd(),
		// Default to localnet — labeled snapshots are localnet-only and the
		// common-flags parser leaves --network unset when not provided.
		network: flags.network ?? 'localnet',
		...(flags.configPath !== undefined ? { configPath: flags.configPath } : {}),
		...(flags.stack !== undefined ? { stack: flags.stack } : {}),
	});
	const json = flags.json === true;
	switch (sub) {
		case 'save': {
			const label = positionals[1];
			const result = await runSnapshotSave({
				env,
				...(label !== undefined ? { label } : {}),
				...(json ? { json: true } : {}),
			});
			return result.exitCode;
		}
		case 'restore': {
			const ref = positionals[1];
			if (ref === undefined) {
				process.stderr.write(`devstack-next snapshot restore: <label|id> required\n`);
				return 1;
			}
			const result = await runSnapshotRestore({ env, ref, ...(json ? { json: true } : {}) });
			return result.exitCode;
		}
		case 'list': {
			const result = await runSnapshotList({ env, ...(json ? { json: true } : {}) });
			return result.exitCode;
		}
		case 'delete': {
			const ref = positionals[1];
			if (ref === undefined) {
				process.stderr.write(`devstack-next snapshot delete: <label|id> required\n`);
				return 1;
			}
			const result = await runSnapshotDelete({ env, ref, ...(json ? { json: true } : {}) });
			return result.exitCode;
		}
		default:
			process.stderr.write(
				`devstack-next snapshot: unknown subcommand '${sub}'\n${SNAPSHOT_USAGE}`,
			);
			return 1;
	}
}
