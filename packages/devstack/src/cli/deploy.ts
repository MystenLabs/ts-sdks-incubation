// `devstack deploy` — one-shot live-network deploy entry. Loads the app's
// devstack.config.ts, resolves the requested `networks[network].rpcUrl`,
// and runs the parallel one-shot reconciler. Account signers come from
// `config.accounts` (resolved per the active network); plugins call
// `ctx.accounts.get(name)` rather than reaching for a top-level signer.
// Prints a per-action summary and the manifest path; exits non-zero if
// any action failed.
//
// `--target` is an alias for `--network` and additionally accepts the
// `<network>:<stack>` form. A bare-stack `--target` (e.g. `scratch`)
// resolves to localnet/scratch — useful for running the deploy slice
// (skip Service; keep Build) against a localnet stack.

import { dirname, resolve } from 'node:path';
import type { Network } from '../core/types.js';
import { runOneShot } from '../runtime/one-shot.js';
import { loadConfig, parseConfigArg, parseNetworkArg, parseTargetArg, runIfMain } from './args.js';
import { resolveNetworkProfile } from './network-profile.js';
import { resolveTarget } from './target.js';

export interface DeployFlags {
	configPath: string;
	/** Live-network selector. Mutually exclusive with `target`; one of the
	 * two must be set. */
	network?: Network;
	/** Raw `--target` value (network, stack, or `<network>:<stack>`). */
	target?: string | undefined;
}

export async function runDeploy(flags: DeployFlags): Promise<number> {
	const abs = resolve(flags.configPath);
	const config = await loadConfig(abs);
	const appDir = dirname(abs);

	let network: Network;
	let stack: string | undefined;
	let rpcUrl: string;
	if (flags.target !== undefined) {
		const resolved = resolveTarget({ config, appDir, raw: flags.target });
		network = resolved.network;
		stack = resolved.stack;
		rpcUrl = resolved.rpcUrl;
	} else if (flags.network !== undefined) {
		network = flags.network;
		stack = undefined;
		rpcUrl = resolveNetworkProfile(config, flags.network).rpcUrl;
	} else {
		throw new Error(
			'devstack deploy requires --network <localnet|testnet|mainnet> or --target <network|stack>',
		);
	}

	const result = await runOneShot({
		appName: config.app,
		appDir,
		network,
		stack,
		rpcUrl,
		plugins: config.plugins,
		accounts: config.accounts,
	});

	const label = network === 'localnet' ? `${network} stack=${stack}` : `${network} (${rpcUrl})`;
	process.stdout.write(`devstack deploy → ${label}\n`);
	if (result.hydrated) process.stdout.write('  hydrated registry from prior manifest\n');
	for (const [name, status] of result.statuses) {
		const failure = result.failures.get(name);
		const detail = failure !== undefined ? ` — ${failure.message}` : '';
		process.stdout.write(`  ${name.padEnd(36)} ${status}${detail}\n`);
	}
	process.stdout.write(`manifest: ${result.manifestPath}\n`);

	return result.failures.size === 0 ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
	if (argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(USAGE);
		return 0;
	}
	return runDeploy(parseArgs(argv));
}

const USAGE = `devstack deploy <config> --network <localnet|testnet|mainnet>

Live-network deploy slice. Skips Service actions (no docker on prod);
runs Build (for source artifacts), Publish, Register, Seed (live-net
gated), Emit.

Runs: Build, Publish, Register, Seed (live-net gated), Emit
Skips: Service

Options:
  --network <network>          Required if --target is not set
  --target <network[:stack]>   Alias for --network; also accepts a stack
  --config <path>              Override the config path

Examples:
  devstack deploy --network testnet
  devstack deploy --target mainnet
`;

function parseArgs(argv: string[]): DeployFlags {
	return {
		configPath: parseConfigArg(argv),
		network: parseNetworkArg(argv),
		target: parseTargetArg(argv),
	};
}

runIfMain(import.meta.url, main);
