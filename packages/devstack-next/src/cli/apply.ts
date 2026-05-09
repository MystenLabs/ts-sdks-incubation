import { Engine } from '../engine/class.js';
import type { CycleResult, DevstackConfig, Env } from '../engine/types.js';
import { tryReadSnapshot, writeSnapshot } from '../persistence/index.js';
import { hasFlag, parseCommonFlags } from './args.js';
import { loadConfigAndEnv } from './env.js';
import { attachPlainRenderer } from './output.js';

export const APPLY_USAGE = `devstack-next apply [options]

Single-cycle reconcile against the current stack. Reads the prior
snapshot if one exists, runs one engine cycle, writes the new snapshot,
and exits. Use \`up\` for the long-running variant.

Options:
  --config <path>             Override the config path (default: walk up
                              from cwd looking for devstack.config.ts)
  --network <net>             Network: localnet | testnet | mainnet | devnet
                              (default: localnet)
  --stack <name>              Per-stack name (default: 'main', localnet only)
  --json                      Emit a single-line JSON summary on stdout;
                              per-node events still go to stderr.
  -h, --help                  Show this help

Examples:
  devstack-next apply
  devstack-next apply --network testnet
  devstack-next apply --json | jq '.errored'
`;

export interface RunApplyOptions {
	config: DevstackConfig;
	env: Env;
	/** Where to write per-event progress lines. Defaults to process.stderr. */
	out?: NodeJS.WriteStream;
	/** Where to write the structured `--json` summary. Defaults to
	 * process.stdout — separate from `out` so callers (and tests) can
	 * route human progress and machine-parseable output independently. */
	summaryOut?: NodeJS.WriteStream;
	json?: boolean;
}

export interface RunApplyResult {
	exitCode: number;
	cycle: CycleResult;
	snapshotPath: string;
}

// Programmatic entry point. Tests call this directly with a synthetic
// config so they don't have to set up a temp dir + dynamic-import a TS
// config file. The argv-driven `main` below just builds RunApplyOptions
// from argv and delegates.
export async function runApply(opts: RunApplyOptions): Promise<RunApplyResult> {
	const out = opts.out ?? process.stderr;
	const summaryOut = opts.summaryOut ?? process.stdout;
	const initial = await tryReadSnapshot(opts.env);
	const engine = new Engine(opts.config, {
		env: opts.env,
		...(initial !== undefined ? { initialSnapshot: initial } : {}),
	});
	const detach = attachPlainRenderer(engine, { out, quietLogs: opts.json === true });
	let cycle: CycleResult;
	try {
		cycle = await engine.runOnce();
		const snapshot = await engine.saveSnapshot();
		const snapshotPath = await writeSnapshot(opts.env, snapshot);
		const exitCode = cycle.errored.length > 0 ? 1 : 0;
		if (opts.json === true) {
			summaryOut.write(
				`${JSON.stringify({
					command: 'apply',
					network: opts.env.network,
					stack: opts.env.stack,
					ran: cycle.ran.map((n) => n.name),
					skipped: cycle.skipped.map((n) => ({ name: n.name, reason: n.reason })),
					errored: cycle.errored.map((n) => ({ name: n.name, message: n.error.message })),
					snapshotPath,
				})}\n`,
			);
		} else {
			out.write(`snapshot: ${snapshotPath}\n`);
			if (cycle.errored.length > 0) {
				for (const e of cycle.errored) {
					out.write(`  ! ${e.name}: ${e.error.message}\n`);
				}
			}
		}
		return { exitCode, cycle, snapshotPath };
	} finally {
		detach();
		await engine.stop();
	}
}

export async function main(argv: string[]): Promise<number> {
	const flags = parseCommonFlags(argv);
	if (flags.help === true || hasFlag(argv, 'help')) {
		process.stdout.write(APPLY_USAGE);
		return 0;
	}
	const loaded = await loadConfigAndEnv({
		cwd: process.cwd(),
		...(flags.configPath !== undefined ? { configPath: flags.configPath } : {}),
		...(flags.network !== undefined ? { network: flags.network } : {}),
		...(flags.stack !== undefined ? { stack: flags.stack } : {}),
	});
	const result = await runApply({
		config: loaded.config,
		env: loaded.env,
		...(flags.json === true ? { json: true } : {}),
	});
	return result.exitCode;
}
