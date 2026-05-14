import { Engine } from '../engine/class.js';
import type { CycleResult, DevstackConfig, Env } from '../engine/types.js';
import { tryReadSnapshot, withStackLock, writeSnapshot } from '../persistence/index.js';
import { hasFlag, parseCommonFlags } from './args.js';
import { loadConfigAndEnv } from './env.js';
import { attachPlainRenderer } from './output.js';

export const APPLY_USAGE = `devstack apply [options]

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
  devstack apply
  devstack apply --network testnet
  devstack apply --json | jq '.errored'
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
//
// Wraps the run in `withStackLock` so two `devstack apply` invocations
// against the same stack don't fight; the second sees a clean
// `StackLockBusyError`. Calls `engine.settle()` rather than a single
// `runOnce()` so cold-cold starts that need a cascade (publish →
// bindings → manifest) finish in one CLI invocation.
export async function runApply(opts: RunApplyOptions): Promise<RunApplyResult> {
	const out = opts.out ?? process.stderr;
	const summaryOut = opts.summaryOut ?? process.stdout;
	return withStackLock(opts.env, async () => {
		const initial = await tryReadSnapshot(opts.env);
		const engine = new Engine(opts.config, {
			env: opts.env,
			...(initial !== undefined ? { initialSnapshot: initial } : {}),
		});
		const detach = attachPlainRenderer(engine, { out, quietLogs: opts.json === true });
		try {
			const cycles = await engine.settle();
			// Aggregate ran/skipped/errored across all cycles so the
			// summary reflects the full settle pass, not just the last
			// cycle. Final state of each node is what counts; we de-dup
			// by name preferring the latest cycle's classification.
			const cycle: CycleResult = aggregateCycles(cycles);
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
						cyclesRan: cycles.length,
					})}\n`,
				);
			} else {
				out.write(`snapshot: ${snapshotPath}\n`);
				if (cycles.length > 1) {
					out.write(`settled in ${cycles.length} cycles\n`);
				}
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
	});
}

// Fold the per-cycle results into a single summary keyed by node name —
// final classification wins (e.g. a node that errored in cycle 1 then
// ran clean in cycle 2 is reported as ran).
function aggregateCycles(cycles: CycleResult[]): CycleResult {
	const byName = new Map<string, { id: symbol; classification: 'ran' | 'skipped' | 'errored'; reason?: 'satisfied' | 'upstream_errored'; error?: Error }>();
	for (const cycle of cycles) {
		for (const r of cycle.ran) byName.set(r.name, { id: r.id, classification: 'ran' });
		for (const s of cycle.skipped) byName.set(s.name, { id: s.id, classification: 'skipped', reason: s.reason });
		for (const e of cycle.errored) byName.set(e.name, { id: e.id, classification: 'errored', error: e.error });
	}
	const out: CycleResult = { ran: [], skipped: [], errored: [] };
	for (const [name, entry] of byName) {
		if (entry.classification === 'ran') out.ran.push({ id: entry.id, name });
		else if (entry.classification === 'skipped') out.skipped.push({ id: entry.id, name, reason: entry.reason! });
		else out.errored.push({ id: entry.id, name, error: entry.error! });
	}
	return out;
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
