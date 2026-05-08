// `devstack status` — read-only print of the action-graph state from the
// prior manifest. No side effects; mirrors `devstack apply` output without
// running a cycle. Useful for quickly seeing which actions ran when, and
// what their last input hash was, without reconciling.

import { dirname, resolve } from 'node:path';

import { readManifest } from '../runtime/manifest-reader.js';
import { manifestPath } from '../runtime/manifest-writer.js';
import { loadConfig, parseConfigArg, parseTargetArg, runIfMain } from './args.js';
import { resolveTarget } from './target.js';

export interface StatusFlags {
	configPath: string;
	target?: string | undefined;
	json?: boolean;
}

export async function runStatus(flags: StatusFlags): Promise<number> {
	const abs = resolve(flags.configPath);
	const config = await loadConfig(abs);
	const appDir = dirname(abs);
	const target = resolveTarget({ config, appDir, raw: flags.target });

	const manifest = readManifest({ appDir, stack: target.stack, network: target.network });
	const path = manifestPath({ appDir, stack: target.stack, network: target.network });

	if (manifest === null) {
		if (flags.json === true) {
			process.stdout.write(
				`${JSON.stringify({
					kind: 'summary' as const,
					command: 'status',
					network: target.network,
					stack: target.stack,
					manifestPath: path,
					actions: [],
				})}\n`,
			);
		} else {
			process.stdout.write(`no manifest at ${path} — run \`devstack apply\` first\n`);
		}
		return 1;
	}

	const states = manifest.actionStates ?? {};
	const entries = Object.entries(states);

	if (flags.json === true) {
		const summary = {
			kind: 'summary' as const,
			command: 'status',
			network: target.network,
			stack: target.stack,
			manifestPath: path,
			actions: entries.map(([name, state]) => ({
				name,
				lastInputHash: state.lastInputHash,
				...(state.lastRunAt !== undefined ? { lastRunAt: state.lastRunAt } : {}),
				...(state.identity !== undefined ? { identity: state.identity } : {}),
			})),
		};
		process.stdout.write(`${JSON.stringify(summary)}\n`);
	} else {
		process.stdout.write(`devstack status → ${target.stack} (${target.network})\n`);
		for (const [name, state] of entries) {
			const hashTrunc = `${state.lastInputHash.slice(0, 6)}…`;
			if (state.lastRunAt === undefined) {
				process.stdout.write(`  ${name.padEnd(22)} hash=${hashTrunc} (not yet run)\n`);
			} else {
				const ran = new Date(state.lastRunAt).toISOString().replace('T', ' ').slice(0, 19);
				process.stdout.write(`  ${name.padEnd(22)} hash=${hashTrunc}  ran ${ran}\n`);
			}
		}
		process.stdout.write(`manifest: ${path}\n`);
	}

	return 0;
}

export async function main(argv: string[]): Promise<number> {
	if (argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(USAGE);
		return 0;
	}
	return runStatus(parseArgs(argv));
}

const USAGE = `devstack status [config] [options]

Read-only print of the action-graph state from the prior manifest.
No side effects — mirrors \`devstack apply\` output without running
a cycle.

Each action's last input hash and last successful run timestamp are
read from the manifest's \`actionStates\` map. Use this to quickly see
which actions ran when without reconciling.

Options:
  --target <network[:stack]>  Override the active target
  --config <path>             Override the config path
  --json                      Emit a single-line JSON summary on stdout

Examples:
  devstack status
  devstack status --target testnet
  devstack status --target localnet:scratch
  devstack status --json | jq '.actions[].name'
`;

function parseArgs(argv: string[]): StatusFlags {
	return {
		configPath: parseConfigArg(argv),
		target: parseTargetArg(argv),
		json: argv.includes('--json'),
	};
}

runIfMain(import.meta.url, main);
