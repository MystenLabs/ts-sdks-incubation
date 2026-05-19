// `runCli(cwd, env, args, opts?)` — extracted from
// `engine/snapshot.docker.test.ts:70-93`. Spawns `pnpm devstack <args>`
// from `cwd`, captures stdout/stderr to memory, returns the typed
// `CliResult`.
//
// All real-Docker tests use this helper so their stdout assertions are
// uniform and the spawn options stay consistent.

import { spawn } from 'node:child_process';

export interface CliResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface RunCliOptions {
	/** Override the binary. Defaults to `'pnpm'`; tests that need to
	 *  invoke a different CLI (e.g. `npx devstack`) can pass it. */
	readonly bin?: string;
	/** Override the arg prefix. Defaults to `['devstack']`. */
	readonly leadingArgs?: ReadonlyArray<string>;
}

export const runCli = async (
	cwd: string,
	env: NodeJS.ProcessEnv,
	args: ReadonlyArray<string>,
	opts: RunCliOptions = {},
): Promise<CliResult> => {
	const bin = opts.bin ?? 'pnpm';
	const leading = opts.leadingArgs ?? ['devstack'];
	return new Promise((resolve) => {
		const child = spawn(bin, [...leading, ...args], {
			cwd,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on('close', (code) => {
			resolve({ exitCode: code ?? -1, stdout, stderr });
		});
	});
};
