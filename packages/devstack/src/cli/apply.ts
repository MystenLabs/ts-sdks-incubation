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

	return result.failures.size === 0 ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
	return runApply(parseArgs(argv));
}

function parseArgs(argv: string[]): ApplyFlags {
	return {
		configPath: parseConfigArg(argv),
		target: parseTargetArg(argv),
		actions: parseActionsArg(argv),
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
