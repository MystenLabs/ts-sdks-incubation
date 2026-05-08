// `devstack doctor` — preflight environment check. Each check returns
// OK / WARN / FAIL with a remediation tip; exits non-zero when any check
// fails. WARNs don't fail. Run before `devstack up` if something is off
// and you'd rather know up front than discover it mid-cycle.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { dockerRun } from '../runtime/docker/run.js';
import { manifestPath } from '../runtime/manifest-writer.js';
import { loadConfig, parseConfigArg, parseTargetArg, runIfMain } from './args.js';
import { resolveTarget } from './target.js';

export interface DoctorFlags {
	configPath: string;
	target?: string | undefined;
	json?: boolean;
}

type CheckStatus = 'ok' | 'warn' | 'fail';

interface CheckResult {
	name: string;
	status: CheckStatus;
	detail: string;
}

async function checkDocker(): Promise<CheckResult> {
	try {
		const result = await dockerRun({ command: ['info'] });
		if (result.code === 0) {
			return { name: 'docker', status: 'ok', detail: 'docker daemon reachable' };
		}
		return {
			name: 'docker',
			status: 'fail',
			detail: 'docker daemon not reachable — start Docker Desktop or `dockerd` and re-run',
		};
	} catch {
		return {
			name: 'docker',
			status: 'fail',
			detail: 'docker daemon not reachable — start Docker Desktop or `dockerd` and re-run',
		};
	}
}

function checkSuiCli(): Promise<CheckResult> {
	return new Promise((resolveCheck) => {
		const child = spawn('sui', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (b: Buffer) => {
			stdout += b.toString();
		});
		child.stderr.on('data', (b: Buffer) => {
			stderr += b.toString();
		});
		child.on('error', () => {
			resolveCheck({
				name: 'sui-cli',
				status: 'fail',
				detail:
					'sui CLI not found — install per https://docs.sui.io/guides/developer/getting-started/sui-install',
			});
		});
		child.on('close', (code) => {
			if (code === 0) {
				const version = (stdout.trim().length > 0 ? stdout.trim() : stderr.trim()) || 'unknown';
				resolveCheck({
					name: 'sui-cli',
					status: 'ok',
					detail: `sui CLI on PATH (${version})`,
				});
			} else {
				resolveCheck({
					name: 'sui-cli',
					status: 'fail',
					detail:
						'sui CLI not found — install per https://docs.sui.io/guides/developer/getting-started/sui-install',
				});
			}
		});
	});
}

function checkNode(): CheckResult {
	const v = process.versions.node;
	const major = Number.parseInt(v.split('.')[0] ?? '0', 10);
	if (major >= 24) {
		return { name: 'node', status: 'ok', detail: `node v${v}` };
	}
	return {
		name: 'node',
		status: 'fail',
		detail: `node ${v} — devstack requires >= 24`,
	};
}

function checkInotify(): CheckResult | null {
	if (process.platform !== 'linux') return null;
	const path = '/proc/sys/fs/inotify/max_user_watches';
	try {
		const raw = readFileSync(path, 'utf8').trim();
		const n = Number.parseInt(raw, 10);
		if (Number.isNaN(n)) {
			return {
				name: 'inotify',
				status: 'warn',
				detail: `inotify max_user_watches unreadable (${raw}); large monorepos may silently miss file events. Bump via \`sudo sysctl fs.inotify.max_user_watches=524288\``,
			};
		}
		if (n > 524288) {
			return { name: 'inotify', status: 'ok', detail: `inotify max_user_watches=${n}` };
		}
		return {
			name: 'inotify',
			status: 'warn',
			detail: `inotify max_user_watches=${n}; large monorepos may silently miss file events. Bump via \`sudo sysctl fs.inotify.max_user_watches=524288\``,
		};
	} catch {
		return {
			name: 'inotify',
			status: 'warn',
			detail:
				'inotify max_user_watches unreadable; large monorepos may silently miss file events. Bump via `sudo sysctl fs.inotify.max_user_watches=524288`',
		};
	}
}

async function checkManifest(flags: DoctorFlags): Promise<CheckResult> {
	try {
		const abs = resolve(flags.configPath);
		const config = await loadConfig(abs);
		const appDir = dirname(abs);
		const target = resolveTarget({ config, appDir, raw: flags.target });
		const path = manifestPath({ appDir, stack: target.stack, network: target.network });
		if (!existsSync(path)) {
			return {
				name: 'manifest',
				status: 'warn',
				detail: 'no manifest yet — run `devstack apply` to create one',
			};
		}
		const stat = statSync(path);
		const lastApply = stat.mtime.toISOString().replace('T', ' ').slice(0, 19);
		return {
			name: 'manifest',
			status: 'ok',
			detail: `active manifest at ${path} (last apply: ${lastApply})`,
		};
	} catch (err) {
		return {
			name: 'manifest',
			status: 'warn',
			detail: `could not resolve manifest path (${err instanceof Error ? err.message : String(err)})`,
		};
	}
}

export async function runDoctor(flags: DoctorFlags): Promise<number> {
	const checks: CheckResult[] = [];
	checks.push(await checkDocker());
	checks.push(await checkSuiCli());
	checks.push(checkNode());
	const inotify = checkInotify();
	if (inotify !== null) checks.push(inotify);
	checks.push(await checkManifest(flags));

	if (flags.json === true) {
		process.stdout.write(
			`${JSON.stringify({
				kind: 'summary' as const,
				command: 'doctor',
				checks: checks.map((c) => ({ name: c.name, status: c.status, detail: c.detail })),
			})}\n`,
		);
	} else {
		process.stdout.write('devstack doctor — preflight environment check\n\n');
		for (const c of checks) {
			const tag = c.status === 'ok' ? 'OK   ' : c.status === 'warn' ? 'WARN ' : 'FAIL ';
			process.stdout.write(`  ${tag} ${c.detail}\n`);
		}
	}

	return checks.some((c) => c.status === 'fail') ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
	if (argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(USAGE);
		return 0;
	}
	return runDoctor(parseArgs(argv));
}

const USAGE = `devstack doctor [options]

Preflight environment check. Each check returns OK / WARN / FAIL with
a remediation tip. Exits 0 when no checks fail (WARNs don't fail);
exits 1 when at least one check fails.

Checks:
  - docker daemon reachable
  - sui CLI on PATH
  - node version >= 22
  - inotify watch limit (Linux only)
  - active stack manifest

Options:
  --target <network[:stack]>  Override the active target (manifest check)
  --config <path>             Override the config path
  --json                      Emit a structured JSON summary on stdout

Examples:
  devstack doctor
  devstack doctor --json | jq '.checks[] | select(.status != "ok")'
`;

function parseArgs(argv: string[]): DoctorFlags {
	return {
		configPath: parseConfigArg(argv),
		target: parseTargetArg(argv),
		json: argv.includes('--json'),
	};
}

runIfMain(import.meta.url, main);
