// `devstack codegen` — read-only re-emit. Resolves the target's prior
// manifest, runs only Emit actions through `runOneShot`, and skips the
// post-cycle manifest write. Useful when:
//
//   - You've edited a Move package's interface and want to regenerate TS
//     bindings without re-publishing or kicking the supervisor.
//   - You want to regenerate against `testnet` or `mainnet` from the
//     manifest produced by an earlier `devstack apply --target testnet`.
//
// `--target` resolution mirrors `apply`. The cycle hydrates the prior
// manifest into the registry so Emit's `dependsOnKind` predicates see
// the live state, then walks only Emit actions; non-Emit dirty cascade
// triggers are absent (no Publish/Register run, so nothing fresh to
// dirty). Net effect: every Emit re-runs unconditionally — exactly what
// `pnpm codegen` users want.
//
// Manifest write is gated off via `runOneShot`'s `readOnly: true` so the
// codegen run is idempotent: re-running against the same target leaves
// the on-disk manifest untouched.

import { dirname, resolve } from 'node:path';

import { runOneShot } from '../runtime/one-shot.js';
import {
	type SupervisorLockHandle,
	SupervisorLockBusyError,
	acquireSupervisorLock,
} from '../runtime/supervisor-lock.js';
import { loadConfig, parseConfigArg, parseTargetArg, runIfMain } from './args.js';
import { emitOnlyFilter } from './filters.js';
import { resolveTarget } from './target.js';

export interface CodegenFlags {
	configPath: string;
	target?: string | undefined;
	/** Emit a single-line JSON summary on stdout instead of the human
	 * status table. Per-action diagnostic logs still go to stderr.
	 * Mirrors `apply --json` so CI consumers get a structured shape
	 * across both commands without regex-parsing. */
	json?: boolean;
}

export async function runCodegen(flags: CodegenFlags): Promise<number> {
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
			process.stderr.write(`devstack codegen: ${err.message}\n`);
			return 1;
		}
		throw err;
	}

	// Localnet `codegen` reads the manifest the supervisor may be
	// rewriting — acquire the per-stack supervisor lock to coordinate
	// (mirror of `cli/snapshot.ts` and `cli/apply.ts`). Live-net targets
	// don't have a supervisor; skip the lock.
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
			actionFilter: emitOnlyFilter,
			readOnly: true,
		});
	} catch (err) {
		// `ManifestAppMismatchError`, `DockerDaemonError`,
		// `SupervisorLockBusyError`, and `MissingNetworkProfileError` get a
		// clean stderr message rather than a stack trace. Name-based check
		// (not instanceof) for the same reason as `cli/up.ts`.
		if (err instanceof Error && err.name === 'SupervisorLockBusyError') {
			const pid = (err as SupervisorLockBusyError).holderPid;
			process.stderr.write(
				`devstack codegen: another devstack process is running on this stack (PID ${pid}). ` +
					`Stop it (Ctrl-C in its terminal, or kill ${pid}) before running \`devstack codegen\`.\n`,
			);
			return 1;
		}
		if (err instanceof Error && isCleanStartupError(err.name)) {
			process.stderr.write(`devstack codegen: ${err.message}\n`);
			return 1;
		}
		throw err;
	} finally {
		lock?.release();
	}

	if (flags.json === true) {
		// The "no prior manifest" case is still a hard failure, but the
		// JSON consumer wants one shape always — encode `hydrated: false`
		// in the summary and exit 1. Per-action statuses will be empty
		// when codegen short-circuits on a missing manifest.
		const summary = {
			kind: 'summary' as const,
			command: 'codegen',
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
		if (!result.hydrated) {
			process.stderr.write(
				`devstack codegen: no prior manifest at ${result.manifestPath} — run \`devstack apply\` (localnet) or \`devstack apply --target ${target.network}\` first\n`,
			);
			return 1;
		}
	} else {
		const label =
			target.network === 'localnet'
				? `${target.network} stack=${target.stack}`
				: target.network;
		process.stdout.write(`devstack codegen → ${label} (read-only; manifest untouched)\n`);
		if (!result.hydrated) {
			process.stderr.write(
				`devstack codegen: no prior manifest at ${result.manifestPath} — run \`devstack apply\` (localnet) or \`devstack apply --target ${target.network}\` first\n`,
			);
			return 1;
		}
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
	return runCodegen(parseArgs(argv));
}

const USAGE = `devstack codegen [config] [options]

Re-emit codegen against the prior manifest. Read-only — manifest is not
rewritten. Useful for regenerating TS bindings after editing a Move
package's interface, or for regenerating against a live-net manifest
produced by an earlier \`devstack apply --target <network>\`.

Runs: Emit only.
Skips: everything else (Build, Service, Publish, Register, Seed, Verify).

Options:
  --target <network[:stack]>   Override the active target
  --config <path>              Override the config path
  --json                       Emit a single-line JSON summary on stdout
                               (per-action logs still go to stderr)

Examples:
  devstack codegen
  devstack codegen --target testnet
  devstack codegen --json | jq '.actions'
`;

const CLEAN_STARTUP_ERROR_NAMES = new Set([
	'ManifestAppMismatchError',
	'DockerDaemonError',
	'SupervisorLockBusyError',
	'MissingNetworkProfileError',
]);

function isCleanStartupError(name: string): boolean {
	return CLEAN_STARTUP_ERROR_NAMES.has(name);
}

function parseArgs(argv: string[]): CodegenFlags {
	return {
		configPath: parseConfigArg(argv),
		target: parseTargetArg(argv),
		json: argv.includes('--json'),
	};
}

runIfMain(import.meta.url, main);
