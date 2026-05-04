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
// `--once` runs one reconcile cycle and exits with shutdown hooks fired —
// the same shape Playwright's globalSetup uses. Equivalent to
// `devstack apply` plus the supervisor's HostProcess actions and
// shutdown discipline. Useful for `pnpm localnet:up` style scripts that
// want to bring the chain to known state and return.

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
	try {
		if (flags.once) {
			await supervisor.runOnce();
		} else {
			await supervisor.start();
		}
	} catch (err) {
		// `SupervisorLockBusyError` (and any other startup error) gets a
		// clean stderr message instead of the default Node stack trace —
		// the user can act on it immediately.
		if (err instanceof Error && err.name === 'SupervisorLockBusyError') {
			process.stderr.write(`devstack up: ${err.message}\n`);
			return 1;
		}
		throw err;
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

Runs every action type: Build, Service, HostProcess, Publish, Register,
Seed, Emit, Verify.

Options:
  --target <localnet:stack>   Override the active stack
  --stack <name>              Override the active stack (alternative form)
  --config <path>             Override the config path
  --once                      Reconcile once and exit (fires shutdown
                              hooks on the way out). Equivalent to the
                              cycle Playwright globalSetup uses; \`pnpm
                              localnet:up\` scripts wrap this.

Examples:
  devstack up
  devstack up --once
  devstack up --target scratch
  devstack up ./custom.config.ts
`;

function parseArgs(argv: string[]): UpFlags {
	return {
		configPath: parseConfigArg(argv),
		network: parseNetworkArg(argv) ?? 'localnet',
		once: argv.includes('--once'),
		stack: parseStackArg(argv),
		target: parseTargetArg(argv),
	};
}

runIfMain(import.meta.url, main);
