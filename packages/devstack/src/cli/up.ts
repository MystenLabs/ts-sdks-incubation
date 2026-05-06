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
import type { Renderer } from '../runtime/renderer.js';
import { PlainRenderer } from '../runtime/renderers/plain.js';
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

interface UpFlags {
	configPath: string;
	network: Network;
	once: boolean;
	/** Force the line-oriented PlainRenderer even on a TTY. Also activated
	 * by `DEVSTACK_NO_TUI=1`, `CI=*`, or a non-TTY stdout. */
	noTui: boolean;
	/** Override the active stack. When undefined, falls back to
	 * `DEVSTACK_STACK` env var, then `<appDir>/.devstack/active`, then 'main'. */
	stack?: string | undefined;
	/** Raw `--target` value, if set. Resolved to a localnet stack here;
	 * live-net targets are rejected. */
	target?: string | undefined;
}

async function runUp(flags: UpFlags): Promise<number> {
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

	const renderer = await selectRenderer(flags.noTui);
	const supervisor = new Supervisor({
		appName: config.app,
		appDir,
		stack,
		network,
		plugins: config.plugins,
		accounts: config.accounts,
		rpcUrl: config.networks?.[network]?.rpcUrl,
		renderer,
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
  --no-tui                    Force the line-oriented plain renderer
                              even on a TTY. Also activated by setting
                              \`DEVSTACK_NO_TUI\` or \`CI\` to a truthy
                              value (anything but '', '0', 'false', 'no').

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
		noTui: argv.includes('--no-tui'),
		stack: parseStackArg(argv),
		target: parseTargetArg(argv),
	};
}

/** Pick the right renderer for the current process environment. The
 * Ink TUI lives in `cli/tui/ink-renderer.tsx` and is dynamically
 * imported only when actually selected — keeps the React + ink runtime
 * cost off the plain CI path. */
async function selectRenderer(noTuiFlag: boolean): Promise<Renderer> {
	const tuiable =
		!noTuiFlag &&
		!isEnvFlagSet('DEVSTACK_NO_TUI') &&
		!isEnvFlagSet('CI') &&
		Boolean(process.stdout.isTTY);
	if (!tuiable) return new PlainRenderer();
	const mod = await import('./tui/ink-renderer.js');
	return new mod.InkRenderer();
}

/** True when an env var is set to a truthy value. Treats `''`, `'0'`,
 * `'false'`, and `'no'` as unset — common CI conventions where the
 * presence of the var with an empty/zero value should not enable a
 * flag. */
function isEnvFlagSet(name: string): boolean {
	const v = process.env[name];
	if (v === undefined) return false;
	const trimmed = v.trim().toLowerCase();
	if (trimmed === '' || trimmed === '0' || trimmed === 'false' || trimmed === 'no') return false;
	return true;
}

runIfMain(import.meta.url, main);
