// `devstack apply` — single-cycle reconcile against the active or named
// target. Runs every action kind on localnet (Service+Build included);
// skips Service+Build on live nets. Seed actions are gated by network
// per `seedRunsOn`.
//
// Differs from `devstack up --once`:
//   - No supervisor wrapper; no key handlers, no file watcher, no shutdown
//     hooks. One walk, exit.
//   - Localnet `apply` reuses the same `runOneShot` engine the live-net
//     path uses, so the cycle semantics (skip predicates, dirty cascade)
//     are identical across networks.

import { dirname, resolve } from 'node:path';

import { runOneShot } from '../runtime/one-shot.js';
import {
	type SupervisorLockHandle,
	SupervisorLockBusyError,
	acquireSupervisorLock,
} from '../runtime/supervisor-lock.js';
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

	// `resolveTarget` itself can throw `MissingNetworkProfileError` for an
	// undeclared live-net target — surface that with the clean shape too.
	let target: ReturnType<typeof resolveTarget>;
	try {
		target = resolveTarget({ config, appDir, raw: flags.target });
	} catch (err) {
		if (err instanceof Error && isCleanStartupError(err.name)) {
			process.stderr.write(`devstack apply: ${err.message}\n`);
			return 1;
		}
		throw err;
	}

	// Localnet `apply` races with a running `devstack up` supervisor on
	// manifest writes / container names / port-allocator state. Acquire
	// the per-stack supervisor lock for the duration of the cycle (mirror
	// of `cli/snapshot.ts`'s save path). Live-net targets don't have a
	// supervisor — skip the lock there.
	let lock: SupervisorLockHandle | undefined;
	let result: Awaited<ReturnType<typeof runOneShot>>;
	try {
		if (target.network === 'localnet') {
			lock = await acquireSupervisorLock({ appDir, stack: target.stack });
		}

		result = await runOneShot({
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
	} catch (err) {
		// `ManifestAppMismatchError`, `DockerDaemonError`,
		// `SupervisorLockBusyError`, and `MissingNetworkProfileError` get a
		// clean stderr message — the user can act on each immediately
		// without parsing a stack trace. Name-based check (not instanceof)
		// because downstream consumers may bundle the runtime separately
		// from the CLI; class identity would diverge across bundles.
		if (err instanceof Error && err.name === 'SupervisorLockBusyError') {
			const pid = (err as SupervisorLockBusyError).holderPid;
			process.stderr.write(
				`devstack apply: another devstack process is running on this stack (PID ${pid}). ` +
					`Stop it (Ctrl-C in its terminal, or kill ${pid}) before running \`devstack apply\`.\n`,
			);
			return 1;
		}
		if (err instanceof Error && isCleanStartupError(err.name)) {
			process.stderr.write(`devstack apply: ${err.message}\n`);
			return 1;
		}
		throw err;
	} finally {
		lock?.release();
	}

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
		for (const plugin of config.plugins) {
			if (plugin.name.endsWith('-setup') && plugin.description?.startsWith('auto-synthesized')) {
				process.stdout.write(
					`  ${plugin.description.replace('auto-synthesized', `synthesized '${plugin.name}'`)}\n`,
				);
			}
		}
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

On localnet: runs every action type (Build, Service, HostProcess,
Publish, Register, Seed, Emit, Verify). Differs from \`devstack up\`
only in that there's no file watcher and the supervisor doesn't stay
resident — the cycle settles, then exits.

On live nets (testnet, mainnet): skips Service, HostProcess, and Build
(no docker assumed). Runs Publish/Register/Seed/Emit/Verify against the
configured RPC.

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

const CLEAN_STARTUP_ERROR_NAMES = new Set([
	'ManifestAppMismatchError',
	'DockerDaemonError',
	'SupervisorLockBusyError',
	'MissingNetworkProfileError',
]);

function isCleanStartupError(name: string): boolean {
	return CLEAN_STARTUP_ERROR_NAMES.has(name);
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
