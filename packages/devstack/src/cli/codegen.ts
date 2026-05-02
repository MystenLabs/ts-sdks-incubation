// `devstack codegen` — read-only re-emit. Resolves the target's prior
// manifest, runs only Emit actions through `runOneShot`, and skips the
// post-cycle manifest write. Useful when:
//
//   - You've edited a Move package's interface and want to regenerate TS
//     bindings without re-publishing or kicking the supervisor.
//   - You want to regenerate against `testnet` or `mainnet` from the
//     manifest produced by an earlier `devstack deploy`.
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
import { loadConfig, parseConfigArg, parseTargetArg, runIfMain } from './args.js';
import { emitOnlyFilter } from './filters.js';
import { resolveTarget } from './target.js';

export interface CodegenFlags {
	configPath: string;
	target?: string | undefined;
}

export async function runCodegen(flags: CodegenFlags): Promise<number> {
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
		actionFilter: emitOnlyFilter,
		readOnly: true,
	});

	const label =
		target.network === 'localnet' ? `${target.network} stack=${target.stack}` : target.network;
	process.stdout.write(`devstack codegen → ${label} (read-only; manifest untouched)\n`);
	if (!result.hydrated) {
		process.stderr.write(
			`devstack codegen: no prior manifest at ${result.manifestPath} — run \`devstack apply\` (localnet) or \`devstack deploy --network ${target.network}\` first\n`,
		);
		return 1;
	}
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
	return runCodegen(parseArgs(argv));
}

const USAGE = `devstack codegen [config] [options]

Re-emit codegen against the prior manifest. Read-only — manifest is not
rewritten. Useful for regenerating TS bindings after editing a Move
package's interface, or for regenerating against a live-net manifest
produced by an earlier \`devstack deploy\`.

Runs: Emit only.
Skips: everything else (Build, Service, Publish, Register, Seed, Verify).

Options:
  --target <network[:stack]>   Override the active target
  --config <path>              Override the config path

Examples:
  devstack codegen
  devstack codegen --target testnet
`;

function parseArgs(argv: string[]): CodegenFlags {
	return {
		configPath: parseConfigArg(argv),
		target: parseTargetArg(argv),
	};
}

runIfMain(import.meta.url, main);
