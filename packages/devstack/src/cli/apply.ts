// `devstack apply` — single-cycle reconcile against the active or named
// target. Runs every action kind on localnet (Service+Build included);
// skips Service+Build on live nets. Seed actions are gated by network
// per `seedRunsOn`.
//
// Differs from `devstack up --once`:
//   - No supervisor wrapper; no key handlers, no file watcher, no shutdown
//     hooks. One walk, exit.
//   - Localnet `apply` reuses the same `runOneShot` engine the live-net
//     `deploy` path uses, so the cycle semantics (skip predicates, dirty
//     cascade) are identical across networks.
//
// Differs from `devstack deploy`:
//   - `apply` runs Service+Build on localnet so it can stand up containers
//     from cold; `deploy` is a live-net slice (skip Service; keep Build).
//   - `apply` accepts a localnet stack via `--target <stack>` or
//     `<network>:<stack>` (per `resolveTarget`).

import { dirname, resolve } from 'node:path';

import { runOneShot } from '../runtime/one-shot.js';
import { loadConfig, parseConfigArg, parseTargetArg, runIfMain } from './args.js';
import { applyFilter } from './filters.js';
import { resolveTarget } from './target.js';

export interface ApplyFlags {
	configPath: string;
	/** Raw `--target` value (network, stack, or `<network>:<stack>`). */
	target?: string | undefined;
	/** Restrict the cycle to these action names + their transitive deps +
	 * downstream Emit cascades. Each entry is an action's full name
	 * (e.g. `wallet.usdc`, `imports.deepbook`). Empty/undefined runs the
	 * full graph. CLI parses `--actions a,b,c` (comma-separated). */
	actions?: string[];
	/** Emit a single-line JSON summary on stdout instead of the human
	 * status table. Per-action diagnostic logs still go to stderr (one
	 * `[<action>] <line>` per event). Useful for CI consumers that need
	 * structured output without regex-parsing. */
	json?: boolean;
}

export async function runApply(flags: ApplyFlags): Promise<number> {
	const abs = resolve(flags.configPath);
	const config = await loadConfig(abs);
	const appDir = dirname(abs);
	const target = resolveTarget({ config, appDir, raw: flags.target });

	const result = await runOneShot({
		appName: config.app,
		appDir,
		network: target.network,
		stack: target.stack,
		rpcUrl: target.rpcUrl,
		plugins: config.plugins,
		accounts: config.accounts,
		actionFilter: applyFilter,
		actionScope: flags.actions,
	});

	if (flags.json === true) {
		const summary = {
			kind: 'summary' as const,
			command: 'apply',
			network: target.network,
			stack: target.stack,
			hydrated: result.hydrated,
			manifestPath: result.manifestPath,
			actions: [...result.statuses].map(([name, status]) => {
				const failure = result.failures.get(name);
				return failure === undefined
					? { name, status }
					: { name, status, error: failure.message };
			}),
			failureCount: result.failures.size,
		};
		process.stdout.write(`${JSON.stringify(summary)}\n`);
	} else {
		const label =
			target.network === 'localnet'
				? `${target.network} stack=${target.stack}`
				: `${target.network} (${target.rpcUrl})`;
		process.stdout.write(`devstack apply → ${label}\n`);
		if (result.hydrated) process.stdout.write('  hydrated registry from prior manifest\n');
		for (const [name, status] of result.statuses) {
			const failure = result.failures.get(name);
			const detail = failure !== undefined ? ` — ${failure.message}` : '';
			process.stdout.write(`  ${name.padEnd(36)} ${status}${detail}\n`);
		}
		process.stdout.write(`manifest: ${result.manifestPath}\n`);
	}

	return result.failures.size === 0 ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
	if (argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(USAGE);
		return 0;
	}
	return runApply(parseArgs(argv));
}

const USAGE = `devstack apply [config] [options]

Single-cycle reconcile against the active stack (or --target). Runs the
full action graph once and exits.

Runs: Build, Publish, Register, Seed, Emit, Verify
Skips: Service (containers stay running across cycles)

On live nets: also skips Build (no docker assumed).

Options:
  --target <network[:stack]>  Override the active target
  --actions <a,b,c>           Restrict to these action names + their deps
  --config <path>             Override the config path
  --json                      Emit a single-line JSON summary on stdout
                              (per-action logs still go to stderr)

Examples:
  devstack apply
  devstack apply --target testnet
  devstack apply --target localnet:scratch
  devstack apply --actions arena.connect_four
  devstack apply --json | jq '.failureCount'
`;

function parseArgs(argv: string[]): ApplyFlags {
	return {
		configPath: parseConfigArg(argv),
		target: parseTargetArg(argv),
		actions: parseActionsArg(argv),
		json: argv.includes('--json'),
	};
}

function parseActionsArg(argv: string[]): string[] | undefined {
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--actions' || argv[i] === '--scope') {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) return undefined;
			return next
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
		}
	}
	return undefined;
}

runIfMain(import.meta.url, main);
