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
// at `apply --target` since the supervisor is localnet-only by
// construction (see Supervisor's constructor guard).
//
// `--once` runs one reconcile cycle and exits with shutdown hooks fired —
// the same shape Playwright's globalSetup uses. Equivalent to
// `devstack apply` plus the supervisor's HostProcess actions and
// shutdown discipline. Useful for `devstack up` style scripts that
// want to bring the chain to known state and return.

import { dirname, resolve } from 'node:path';
import type { Network } from '../core/types.js';
import { resolveStack } from '../runtime/active-stack.js';
import type { Renderer } from '../runtime/renderer.js';
import { PlainRenderer } from '../runtime/renderers/plain.js';
import { Supervisor } from '../runtime/supervisor.js';
import { SupervisorLockBusyError } from '../runtime/supervisor-lock.js';
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
		// `resolveTarget` may throw `MissingNetworkProfileError` for an
		// undeclared live-net `--target` — that's caught downstream by the
		// clean-startup-error path so the user sees the actionable
		// remediation, not a stack trace. Note `up` is localnet-only, so a
		// live-net target also surfaces an explicit reroute message below.
		let resolved: ReturnType<typeof resolveTarget>;
		try {
			resolved = resolveTarget({
				config,
				appDir,
				raw: flags.target,
				fallbackStack: flags.stack,
			});
		} catch (err) {
			if (err instanceof Error && isCleanStartupError(err.name)) {
				process.stderr.write(`devstack up: ${err.message}\n`);
				return 1;
			}
			throw err;
		}
		if (resolved.network !== 'localnet') {
			throw new Error(
				`devstack up: --target '${flags.target}' resolves to ${resolved.network}; ` +
					`the supervisor is localnet-only. ` +
					`Use \`devstack apply --target ${flags.target}\` instead.`,
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
		rpcUrl: config.networks?.[network],
		renderer,
	});
	for (const plugin of config.plugins) {
		if (plugin.name.endsWith('-setup') && plugin.description?.startsWith('auto-synthesized')) {
			process.stdout.write(
				`  ${plugin.description.replace('auto-synthesized', `synthesized '${plugin.name}'`)}\n`,
			);
		}
	}
	try {
		if (flags.once) {
			await supervisor.runOnce();
		} else {
			await supervisor.start();
		}
	} catch (err) {
		// `SupervisorLockBusyError`, `ManifestAppMismatchError`, and
		// `DockerDaemonError` get a clean stderr message instead of the
		// default Node stack trace — the user can act on each immediately.
		// Name-based check: the supervisor is bundled separately from the
		// CLI in some downstream consumers, so `instanceof` against the
		// exported class would silently fail on a duplicate-class identity
		// across bundles.
		if (err instanceof Error && err.name === 'SupervisorLockBusyError') {
			const pid = (err as SupervisorLockBusyError).holderPid;
			process.stderr.write(
				`devstack up: another devstack process is running on this stack (PID ${pid}). ` +
					`Stop it (Ctrl-C in its terminal, or kill ${pid}) before running \`devstack up\`.\n`,
			);
			return 1;
		}
		if (err instanceof Error && isCleanStartupError(err.name)) {
			process.stderr.write(`devstack up: ${err.message}\n`);
			return 1;
		}
		throw err;
	}
	return 0;
}

const CLEAN_STARTUP_ERROR_NAMES = new Set([
	'SupervisorLockBusyError',
	'ManifestAppMismatchError',
	'DockerDaemonError',
	'MissingNetworkProfileError',
]);

function isCleanStartupError(name: string): boolean {
	return CLEAN_STARTUP_ERROR_NAMES.has(name);
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
sources for changes. Localnet only — for a live-network apply, run
\`devstack apply --target testnet|mainnet\`.

Runs every action type: Build, Service, HostProcess, Publish, Register,
Seed, Emit, Verify.

Options:
  --target <localnet:stack>   Override the active stack
  --stack <name>              Override the active stack (alternative form)
  --config <path>             Override the config path
  --once                      Reconcile once and exit (fires shutdown
                              hooks on the way out). Equivalent to the
                              cycle Playwright globalSetup uses; \`devstack
                              up\` scripts wrap this.
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
