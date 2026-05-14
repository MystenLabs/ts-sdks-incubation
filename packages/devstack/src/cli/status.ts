import type { Env, NodeState, SnapshotRecord } from '../engine/types.js';
import { snapshotPathFor, tryReadSnapshot } from '../persistence/index.js';
import { parseCommonFlags } from './args.js';
import { resolveEnvOnly } from './env.js';

export const STATUS_USAGE = `devstack status [options]

Read-only print of the on-disk snapshot for the current stack. Doesn't
construct an engine — just reads <appDir>/.devstack/.../snapshot.json.

Options:
  --config <path>             Override the config path (default: walk up
                              from cwd looking for devstack.config.ts)
  --network <net>             Network: localnet | testnet | mainnet | devnet
                              (default: localnet)
  --stack <name>              Per-stack name (default: 'main', localnet only)
  --json                      Emit a single-line JSON summary on stdout
  -h, --help                  Show this help
`;

export interface RunStatusOptions {
	env: Env;
	out?: NodeJS.WriteStream;
	json?: boolean;
}

export interface RunStatusResult {
	exitCode: number;
	snapshot: SnapshotRecord | undefined;
	snapshotPath: string;
}

export async function runStatus(opts: RunStatusOptions): Promise<RunStatusResult> {
	const out = opts.out ?? process.stdout;
	const path = snapshotPathFor(opts.env);
	const snapshot = await tryReadSnapshot(opts.env);

	if (snapshot === undefined) {
		if (opts.json === true) {
			out.write(
				`${JSON.stringify({
					command: 'status',
					network: opts.env.network,
					stack: opts.env.stack,
					snapshotPath: path,
					exists: false,
					nodes: [],
				})}\n`,
			);
		} else {
			out.write(`no snapshot at ${path} — run \`devstack apply\` first\n`);
		}
		return { exitCode: 1, snapshot: undefined, snapshotPath: path };
	}

	const entries = Object.entries(snapshot.nodeStates);

	if (opts.json === true) {
		out.write(
			`${JSON.stringify({
				command: 'status',
				network: opts.env.network,
				stack: opts.env.stack,
				snapshotPath: path,
				exists: true,
				createdAt: snapshot.createdAt,
				nodes: entries.map(([name, state]) => ({
					name,
					status: deriveStatus(state),
					...(state.lastInputHash !== undefined ? { lastInputHash: state.lastInputHash } : {}),
					...(state.lastRunAt !== undefined ? { lastRunAt: state.lastRunAt } : {}),
					...(state.error !== undefined ? { error: state.error.message } : {}),
				})),
			})}\n`,
		);
	} else {
		out.write(`devstack status → ${describeTarget(opts.env)}\n`);
		out.write(`snapshot: ${path}\n`);
		out.write(`captured: ${new Date(snapshot.createdAt).toISOString()}\n`);
		for (const [name, state] of entries) {
			const status = deriveStatus(state);
			const hash = state.lastInputHash ? `${state.lastInputHash.slice(0, 8)}…` : '-';
			const ran = state.lastRunAt
				? new Date(state.lastRunAt).toISOString().replace('T', ' ').slice(0, 19)
				: '-';
			out.write(`  ${name.padEnd(30)} ${status.padEnd(10)} hash=${hash}  ran ${ran}\n`);
			if (state.error !== undefined) {
				out.write(`    ! ${state.error.message}\n`);
			}
		}
	}

	return { exitCode: 0, snapshot, snapshotPath: path };
}

function deriveStatus(state: NodeState): string {
	if (state.error !== undefined) return 'errored';
	if (state.lastInputHash !== undefined) return 'satisfied';
	return 'idle';
}

function describeTarget(env: Env): string {
	if (env.network === 'localnet') return `${env.network} (stack=${env.stack ?? 'main'})`;
	return env.network;
}

export async function main(argv: string[]): Promise<number> {
	const flags = parseCommonFlags(argv);
	if (flags.help === true) {
		process.stdout.write(STATUS_USAGE);
		return 0;
	}
	const { env } = await resolveEnvOnly({
		cwd: process.cwd(),
		...(flags.configPath !== undefined ? { configPath: flags.configPath } : {}),
		...(flags.network !== undefined ? { network: flags.network } : {}),
		...(flags.stack !== undefined ? { stack: flags.stack } : {}),
	});
	const result = await runStatus({
		env,
		...(flags.json === true ? { json: true } : {}),
	});
	return result.exitCode;
}
