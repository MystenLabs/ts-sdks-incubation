// `devstack snapshot` — capture / restore named snapshots of a stack.
//
// Subcommands:
//
//   save <alias> [--stack <name>]
//     Quiesce containers labeled for the stack, `docker commit` each into
//     a fresh seed image, copy `<stackDir>` into the snapshot bundle.
//
//   restore <alias|id> [--stack <name>] [--force-arch]
//     Re-tag each seed image to its original tag (so the plugin's
//     `docker run` picks up the seeded layer), restore `<stackDir>`.
//     Refuses if any labeled container is still running.
//
//   list [--stack <name>]
//     Show all on-disk snapshots; mark aliased ones.
//
//   rm <alias|id>
//     Drop the on-disk bundle + the seed images. Removes any aliases
//     pointing at the id.
//
//   hash [--stack <name>]
//     Print the content-addressed `<sha-id>` for the active config —
//     used by CI cache keys.
//
// Snapshots live under `<appDir>/.devstack/snapshots/<sha-id>/`. See
// runtime/snapshot.ts for the on-disk layout.

import { dirname, resolve } from 'node:path';

import { SUI_DEFAULT_VERSION } from '../plugins/sui/index.js';
import { resolveStack } from '../runtime/active-stack.js';
import {
	captureSnapshot,
	listSnapshots,
	loadSnapshot,
	removeSnapshot,
	snapshotIdFromConfig,
} from '../runtime/snapshot.js';
import { loadConfig, parseConfigArg, parseStackArg, runIfMain } from './args.js';

export interface SnapshotFlags {
	configPath: string;
	subcommand: 'save' | 'restore' | 'list' | 'rm' | 'hash';
	ref?: string;
	stack?: string;
	forceArch?: boolean;
	pushTo?: string;
	/** Emit JSON on stdout for any read-only subcommand
	 * (`hash`, `list`, `save` summary). */
	json?: boolean;
}

export async function runSnapshot(flags: SnapshotFlags): Promise<number> {
	const abs = resolve(flags.configPath);
	const config = await loadConfig(abs);
	const appDir = dirname(abs);
	const stack = resolveStack({ appDir, flag: flags.stack });
	const id = snapshotIdFromConfig({
		appName: config.app,
		stack,
		plugins: config.plugins.map((p) => ({
			name: p.name,
			version: p.version,
			inputs: p.inputs,
		})),
		accountNames: Object.keys(config.accounts ?? {}).sort(),
		// Best-effort sui image hint for the hash. Plugin authors may pin a
		// different version; the snapshot id will still differ when they do
		// because each plugin's `inputs` field is also part of the hash.
		suiImage: `dev-examples/sui-localnet:${SUI_DEFAULT_VERSION}-r7`,
	});

	switch (flags.subcommand) {
		case 'save':
			return saveCmd({
				appName: config.app,
				appDir,
				stack,
				id,
				alias: flags.ref,
				pushTo: flags.pushTo,
				json: flags.json,
			});
		case 'restore':
			return restoreCmd({
				appName: config.app,
				appDir,
				stack,
				ref: requireRef(flags),
				forceArch: flags.forceArch,
				json: flags.json,
			});
		case 'list':
			return listCmd({ appDir, stack, json: flags.json });
		case 'rm':
			return rmCmd({ appDir, ref: requireRef(flags) });
		case 'hash':
			return hashCmd(id, flags.json);
	}
}

async function saveCmd(opts: {
	appName: string;
	appDir: string;
	stack: string;
	id: string;
	alias?: string;
	pushTo?: string;
	json?: boolean;
}): Promise<number> {
	if (opts.json !== true) {
		process.stdout.write(
			`devstack snapshot save → ${opts.id}${opts.alias ? ` (alias='${opts.alias}')` : ''}\n`,
		);
		if (opts.pushTo !== undefined) {
			process.stdout.write(`  pushing seed images to ${opts.pushTo}…\n`);
		}
	}
	const entry = await captureSnapshot(opts);
	if (opts.json === true) {
		process.stdout.write(
			`${JSON.stringify({
				kind: 'summary' as const,
				command: 'snapshot save',
				id: entry.id,
				alias: entry.alias,
				stack: entry.stack,
				platform: entry.platform,
				bundlePath: snapshotBundlePath(opts.appDir, opts.id),
				containers: entry.containers.map((c) => ({
					containerName: c.containerName,
					originalImage: c.originalImage,
					seedImage: c.seedImage,
					registryImage: c.registryImage,
				})),
			})}\n`,
		);
	} else {
		process.stdout.write(`captured ${entry.containers.length} container(s):\n`);
		for (const c of entry.containers) {
			const pushed = c.registryImage !== undefined ? ` (pushed: ${c.registryImage})` : '';
			process.stdout.write(
				`  ${c.containerName}\n    ${c.originalImage} → ${c.seedImage}${pushed}\n`,
			);
		}
		process.stdout.write(`bundle: ${snapshotBundlePath(opts.appDir, opts.id)}\n`);
	}
	return 0;
}

async function restoreCmd(opts: {
	appName: string;
	appDir: string;
	stack: string;
	ref: string;
	forceArch?: boolean;
	json?: boolean;
}): Promise<number> {
	const entry = await loadSnapshot(opts);
	if (opts.json === true) {
		process.stdout.write(
			`${JSON.stringify({
				kind: 'summary' as const,
				command: 'snapshot restore',
				id: entry.id,
				alias: entry.alias,
				stack: opts.stack,
				containerCount: entry.containers.length,
			})}\n`,
		);
	} else {
		process.stdout.write(`devstack snapshot restore ${opts.ref}\n`);
		process.stdout.write(
			`restored ${entry.containers.length} container image tag(s) + host state for stack '${opts.stack}'.\n`,
		);
		process.stdout.write(`run \`devstack up\` to bring the stack up against the restored state.\n`);
	}
	return 0;
}

async function listCmd(opts: { appDir: string; stack: string; json?: boolean }): Promise<number> {
	const all = await listSnapshots(opts.appDir);
	const filtered = all.filter((e) => e.stack === opts.stack);
	if (opts.json === true) {
		process.stdout.write(
			`${JSON.stringify({
				kind: 'summary' as const,
				command: 'snapshot list',
				stack: opts.stack,
				snapshots: filtered.map((e) => ({
					id: e.id,
					alias: e.alias,
					platform: e.platform,
					createdAt: e.createdAt,
				})),
			})}\n`,
		);
		return 0;
	}
	if (filtered.length === 0) {
		process.stdout.write(`no snapshots for stack '${opts.stack}'.\n`);
		return 0;
	}
	process.stdout.write(`snapshots for stack '${opts.stack}':\n`);
	for (const e of filtered) {
		const aliasTag = e.alias ? ` ${e.alias}` : '';
		process.stdout.write(
			`  ${e.id.slice(0, 12)}…  ${e.platform.padEnd(15)}  ${e.createdAt}${aliasTag}\n`,
		);
	}
	return 0;
}

async function rmCmd(opts: { appDir: string; ref: string }): Promise<number> {
	const removed = await removeSnapshot(opts);
	process.stdout.write(
		removed ? `removed snapshot '${opts.ref}'\n` : `no snapshot '${opts.ref}'\n`,
	);
	return removed ? 0 : 1;
}

function hashCmd(id: string, json?: boolean): number {
	if (json === true) {
		process.stdout.write(`${JSON.stringify({ kind: 'summary', command: 'snapshot hash', id })}\n`);
	} else {
		process.stdout.write(`${id}\n`);
	}
	return 0;
}

function requireRef(flags: SnapshotFlags): string {
	if (flags.ref === undefined || flags.ref.length === 0) {
		throw new Error(
			`devstack snapshot ${flags.subcommand} requires <alias|id> as a positional argument`,
		);
	}
	return flags.ref;
}

function snapshotBundlePath(appDir: string, id: string): string {
	return resolve(appDir, '.devstack', 'snapshots', id);
}

export async function main(argv: string[]): Promise<number> {
	if (argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(USAGE);
		return 0;
	}
	return runSnapshot(parseArgs(argv));
}

const USAGE = `devstack snapshot <subcommand> [options]

Capture / restore named snapshots of a stack. State is captured as
\`docker commit\`'d images plus a copy of <stackDir>; restore re-tags the
seed images back to their original names so the plugin's next \`docker
run\` picks up the seeded layer.

Subcommands:
  save <alias>            Capture the current state of the active stack.
  restore <alias|id>      Restore a saved snapshot. Refuses if containers
                          are running — \`devstack stack down\` first.
  list                    Show snapshots for the active stack.
  rm <alias|id>           Drop a snapshot bundle + its seed images.
  hash                    Print the content-addressed id for the active
                          config (used by CI cache keys).

Options:
  --stack <name>          Override the active stack
  --config <path>         Override the config path
  --force-arch            (restore) Allow cross-arch restore (RocksDB
                          binary format may corrupt; use with care)
  --push <registry>       (save) Also tag each seed image as
                          \`<registry>/<container>:<alias>\` and docker
                          push. Restore will pull from the registry on
                          machines where the local seed image is absent
                          (CI / cross-host snapshot sharing).
  --json                  Emit a single-line JSON summary on stdout
                          (save / restore / list / hash).

Examples:
  devstack snapshot save baseline
  devstack snapshot save baseline --push ghcr.io/myorg/snapshots
  devstack snapshot list
  devstack snapshot restore baseline
  devstack snapshot rm baseline
  devstack snapshot hash
  devstack snapshot hash --json | jq -r .id    # CI cache key
`;

function parseArgs(argv: string[]): SnapshotFlags {
	const flags: SnapshotFlags = {
		configPath: parseConfigArg(argv),
		subcommand: 'list',
	};
	const stack = parseStackArg(argv);
	if (stack !== undefined) flags.stack = stack;
	let positional = 0;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (arg === '--config' || arg === '--stack') {
			i++; // consume value
			continue;
		}
		if (arg === '--force-arch') {
			flags.forceArch = true;
			continue;
		}
		if (arg === '--json') {
			flags.json = true;
			continue;
		}
		if (arg === '--push') {
			const next = argv[++i];
			if (next === undefined || next.startsWith('--')) {
				throw new Error('devstack snapshot --push requires a <registry> argument');
			}
			flags.pushTo = next;
			continue;
		}
		if (arg.startsWith('--')) continue;
		if (positional === 0) {
			if (arg !== 'save' && arg !== 'restore' && arg !== 'list' && arg !== 'rm' && arg !== 'hash') {
				throw new Error(
					`devstack snapshot: unknown subcommand '${arg}' — expected save|restore|list|rm|hash`,
				);
			}
			flags.subcommand = arg;
		} else if (positional === 1) {
			flags.ref = arg;
		}
		positional++;
	}
	return flags;
}

runIfMain(import.meta.url, main);
