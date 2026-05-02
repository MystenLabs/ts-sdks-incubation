// `devstack up` — long-running supervisor entry. Takes a config file path
// (defaults to ./devstack.config.ts), loads it via dynamic import
// (tsx-friendly), constructs a Supervisor, and starts.
//
// Per-app scripts run this via `tsx ../../packages/devstack/src/cli/up.ts
// ./devstack.config.ts`.
//
// `--target` resolution: localnet-only. A bare value names a stack
// (`--target scratch` → localnet/scratch); `localnet:<stack>` is the
// long form. Live-net targets (`--target testnet`) error with a pointer
// at `apply` / `deploy` since the supervisor is localnet-only by
// construction (see Supervisor's constructor guard).
//
// `runUp({ once: true })` is the programmatic shape used by playwright's
// globalSetup: reconcile once + fire shutdown hooks. End users want
// `devstack apply` for the equivalent CLI behavior — `--once` is
// intentionally not advertised on the CLI to keep the matrix honest
// (the user-visible verbs are `up` for keepalive, `apply` for one-shot).

import { dirname, resolve } from 'node:path';
import type { Network } from '../core/types.js';
import { resolveStack } from '../runtime/active-stack.js';
import { Supervisor } from '../runtime/supervisor.js';
import {
	loadConfig,
	parseConfigArg,
	parseNetworkArg,
	parseStackArg,
	parseTargetArg,
	runIfMain,
} from './args.js';
import { resolveTarget } from './target.js';

export interface UpFlags {
	configPath: string;
	network: Network;
	once: boolean;
	/** Override the active stack. When undefined, falls back to
	 * `DEVSTACK_STACK` env var, then `<appDir>/.devstack/active`, then 'main'. */
	stack?: string | undefined;
	/** Raw `--target` value, if set. Resolved to a localnet stack here;
	 * live-net targets are rejected. */
	target?: string | undefined;
}

export async function runUp(flags: UpFlags): Promise<number> {
	const abs = resolve(flags.configPath);
	const config = await loadConfig(abs);
	const appDir = dirname(abs);

	let stack: string;
	let network: Network = flags.network;
	if (flags.target !== undefined) {
		const resolved = resolveTarget({
			config,
			appDir,
			raw: flags.target,
			fallbackStack: flags.stack,
		});
		if (resolved.network !== 'localnet') {
			throw new Error(
				`devstack up: --target '${flags.target}' resolves to ${resolved.network}; ` +
					`the supervisor is localnet-only. ` +
					`Use \`devstack apply --target ${flags.target}\` or ` +
					`\`devstack deploy --network ${resolved.network}\` instead.`,
			);
		}
		stack = resolved.stack;
		network = 'localnet';
	} else {
		stack = resolveStack({ appDir, flag: flags.stack });
	}

	const supervisor = new Supervisor({
		appName: config.app,
		appDir,
		stack,
		network,
		plugins: config.plugins,
		accounts: config.accounts,
		rpcUrl: config.networks?.[network]?.rpcUrl,
	});
	if (flags.once) {
		await supervisor.runOnce();
	} else {
		await supervisor.start();
	}
	return 0;
}

export async function main(argv: string[]): Promise<number> {
	if (argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(USAGE);
		return 0;
	}
	return runUp(parseArgs(argv));
}

const USAGE = `devstack up [config] [options]

Long-running supervisor: brings the localnet stack up and watches Move
sources for changes. Localnet only — use \`devstack deploy --network
testnet\` for live-network deploys, or \`devstack apply --target ...\`
for a single-cycle reconcile.

Runs every action type: Build, Service, Publish, Register, Seed, Emit,
Verify.

Options:
  --target <localnet:stack>   Override the active stack
  --stack <name>              Override the active stack (alternative form)
  --config <path>             Override the config path

Examples:
  devstack up
  devstack up --target scratch
  devstack up ./custom.config.ts
`;

function parseArgs(argv: string[]): UpFlags {
	return {
		configPath: parseConfigArg(argv),
		network: parseNetworkArg(argv) ?? 'localnet',
		once: false,
		stack: parseStackArg(argv),
		target: parseTargetArg(argv),
	};
}

runIfMain(import.meta.url, main);
