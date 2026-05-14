import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import type { Env, SnapshotRecord } from '../engine/types.js';
import { tryReadSnapshot } from '../persistence/index.js';
import { hasFlag, parseCommonFlags } from './args.js';
import { resolveEnvOnly } from './env.js';

const exec = promisify(execFile);

export const DOCTOR_USAGE = `devstack doctor [options]

Run preflight checks before bringing a stack up. Reports on:
  - docker daemon reachable
  - sui CLI on PATH (best-effort: --version)
  - host ports recorded in the prior snapshot — bound or free

Doesn't construct an engine. Safe to run any time.

Options:
  --config <path>     Override the config path
  --stack <name>      Per-stack name (default: 'main')
  --json              Emit a single-line JSON summary on stdout
  -h, --help          Show this help

Exit codes:
  0  all required checks pass
  1  one or more required checks failed (docker, sui)
`;

export interface DoctorCheck {
	name: string;
	ok: boolean;
	required: boolean;
	detail?: string;
}

export interface RunDoctorOptions {
	env: Env;
	out?: NodeJS.WriteStream;
	json?: boolean;
}

export interface RunDoctorResult {
	exitCode: number;
	checks: DoctorCheck[];
}

export async function runDoctor(opts: RunDoctorOptions): Promise<RunDoctorResult> {
	const out = opts.out ?? process.stdout;
	const checks: DoctorCheck[] = [];

	checks.push(await checkDocker());
	checks.push(await checkSuiCli());
	checks.push(...(await checkPorts(opts.env)));

	const failedRequired = checks.filter((c) => c.required && !c.ok);
	const exitCode = failedRequired.length === 0 ? 0 : 1;

	if (opts.json === true) {
		out.write(
			`${JSON.stringify({
				command: 'doctor',
				stack: opts.env.stack,
				network: opts.env.network,
				checks: checks.map((c) => ({
					name: c.name,
					ok: c.ok,
					required: c.required,
					...(c.detail !== undefined ? { detail: c.detail } : {}),
				})),
			})}\n`,
		);
	} else {
		for (const c of checks) {
			const tag = c.ok ? '✓' : c.required ? '✗' : '!';
			const reqTag = c.required ? '' : ' (informational)';
			const detail = c.detail !== undefined ? ` — ${c.detail}` : '';
			out.write(`  ${tag} ${c.name}${reqTag}${detail}\n`);
		}
		if (exitCode !== 0) {
			out.write(`\n${failedRequired.length} required check(s) failed.\n`);
		}
	}

	return { exitCode, checks };
}

async function checkDocker(): Promise<DoctorCheck> {
	try {
		const { stdout } = await exec('docker', ['version', '--format', '{{.Server.Version}}']);
		const version = stdout.trim();
		if (version.length === 0) {
			return { name: 'docker daemon', ok: false, required: true, detail: 'no server version' };
		}
		return { name: 'docker daemon', ok: true, required: true, detail: `server ${version}` };
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === 'ENOENT') {
			return {
				name: 'docker daemon',
				ok: false,
				required: true,
				detail: 'docker not found on PATH',
			};
		}
		return {
			name: 'docker daemon',
			ok: false,
			required: true,
			detail: `\`docker version\` failed: ${asMessage(err)}`,
		};
	}
}

async function checkSuiCli(): Promise<DoctorCheck> {
	try {
		const { stdout } = await exec('sui', ['--version']);
		return { name: 'sui CLI', ok: true, required: true, detail: stdout.trim() };
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === 'ENOENT') {
			return {
				name: 'sui CLI',
				ok: false,
				required: true,
				detail:
					'sui not found on PATH — install from https://docs.sui.io/guides/developer/getting-started/sui-install',
			};
		}
		return {
			name: 'sui CLI',
			ok: false,
			required: true,
			detail: `\`sui --version\` failed: ${asMessage(err)}`,
		};
	}
}

async function checkPorts(env: Env): Promise<DoctorCheck[]> {
	const snapshot = await tryReadSnapshot(env);
	if (snapshot === undefined) {
		return [
			{
				name: 'host ports',
				ok: true,
				required: false,
				detail: 'no prior snapshot — nothing to check',
			},
		];
	}
	const allocated = collectAllocatedPorts(snapshot);
	if (allocated.size === 0) {
		return [
			{
				name: 'host ports',
				ok: true,
				required: false,
				detail: 'snapshot records no allocated ports',
			},
		];
	}
	const out: DoctorCheck[] = [];
	for (const [port, slots] of allocated) {
		const bound = await isPortBound(port);
		const slotList = [...slots].sort().join(', ');
		out.push({
			name: `port ${port}`,
			ok: true,
			required: false,
			detail: bound
				? `bound (allocated to ${slotList}; in use — likely by your stack)`
				: `free (allocated to ${slotList})`,
		});
	}
	return out;
}

// Walk every nodeState looking for two patterns:
//   - PortsState ({ map: Record<slot, port> }) — primary source
//   - DockerContainerState ({ hostPorts: Record<slot, port> }) — secondary
// Aggregate slot names per port so the report names what was using it.
function collectAllocatedPorts(snapshot: SnapshotRecord): Map<number, Set<string>> {
	const out = new Map<number, Set<string>>();
	const add = (port: number, slot: string) => {
		if (!Number.isInteger(port) || port <= 0) return;
		const slots = out.get(port) ?? new Set<string>();
		slots.add(slot);
		out.set(port, slots);
	};
	for (const [name, nodeState] of Object.entries(snapshot.nodeStates)) {
		const state = nodeState.state;
		if (typeof state !== 'object' || state === null) continue;
		const s = state as Record<string, unknown>;
		if (typeof s.map === 'object' && s.map !== null && name === 'ports') {
			for (const [slot, port] of Object.entries(s.map as Record<string, unknown>)) {
				if (typeof port === 'number') add(port, slot);
			}
		}
		if (typeof s.hostPorts === 'object' && s.hostPorts !== null) {
			for (const [slot, port] of Object.entries(s.hostPorts as Record<string, unknown>)) {
				if (typeof port === 'number') add(port, slot);
			}
		}
	}
	return out;
}

// Try to bind 127.0.0.1:port. EADDRINUSE → bound; clean close → free.
function isPortBound(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.unref();
		server.once('error', (err) => {
			const code = (err as { code?: string }).code;
			resolve(code === 'EADDRINUSE');
		});
		server.listen(port, '127.0.0.1', () => {
			server.close(() => resolve(false));
		});
	});
}

function asMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function main(argv: string[]): Promise<number> {
	const flags = parseCommonFlags(argv);
	if (flags.help === true || hasFlag(argv, '-h')) {
		process.stdout.write(DOCTOR_USAGE);
		return 0;
	}
	const { env } = await resolveEnvOnly({
		cwd: process.cwd(),
		network: flags.network ?? 'localnet',
		...(flags.configPath !== undefined ? { configPath: flags.configPath } : {}),
		...(flags.stack !== undefined ? { stack: flags.stack } : {}),
	});
	const result = await runDoctor({
		env,
		...(flags.json === true ? { json: true } : {}),
	});
	return result.exitCode;
}
