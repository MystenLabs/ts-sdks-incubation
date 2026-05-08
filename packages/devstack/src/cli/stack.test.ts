// `cli/stack.ts` regression tests. The supervisor-lock guard in
// `dropStack` mirrors the one in `useStack`: `devstack stack drop
// --force --yes` (or `devstack wipe --yes`, which rewrites to the
// same) while a supervisor is mid-cycle would yank containers out
// from under it, log `docker stop` failures, and orphan the
// lockfile. The guard refuses with an actionable message instead.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stackDir } from '../runtime/active-stack.js';
import { writeStaleLockForTesting } from '../runtime/supervisor-lock.js';
import { runStack } from './stack.js';

let appDirs: string[] = [];

function newAppDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-stack-cli-'));
	appDirs.push(dir);
	return dir;
}

function writeFixtureConfig(appDir: string, app: string): string {
	const cfgPath = join(appDir, 'devstack.config.ts');
	writeFileSync(
		cfgPath,
		`export default { app: ${JSON.stringify(app)}, plugins: [] };\n`,
		'utf8',
	);
	return cfgPath;
}

async function captureStderrAsync<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
	const lines: string[] = [];
	const orig = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((line: string) => {
		lines.push(typeof line === 'string' ? line : String(line));
		return true;
	}) as typeof process.stderr.write;
	try {
		const result = await fn();
		return { result, lines };
	} finally {
		process.stderr.write = orig;
	}
}

beforeEach(() => {
	appDirs = [];
});

afterEach(() => {
	for (const d of appDirs) rmSync(d, { recursive: true, force: true });
});

describe('runStack drop — supervisor-lock guard', () => {
	it('refuses to drop a stack with a live supervisor (--force --yes does NOT bypass)', async () => {
		const appDir = newAppDir();
		const cfgPath = writeFixtureConfig(appDir, 'fixture-app');
		// Ensure the stack dir exists so the lockfile can be seeded.
		mkdirSync(stackDir(appDir, 'main'), { recursive: true });
		// Seed a "live" lockfile by recording our own PID — `pidAlive`
		// reports it as alive, which is the condition the guard refuses
		// on. The drop call would otherwise reach the docker code path;
		// the guard fires first and returns 1 before we get there.
		writeStaleLockForTesting({ appDir, stack: 'main' }, process.pid);

		const { result, lines } = await captureStderrAsync(() =>
			runStack({
				configPath: cfgPath,
				subcommand: 'drop',
				stackName: 'main',
				yes: true,
				force: true,
			}),
		);

		expect(result).toBe(1);
		const joined = lines.join('');
		expect(joined).toContain(`refusing to drop stack 'main'`);
		expect(joined).toContain(`supervisor is running`);
		expect(joined).toContain(`PID ${process.pid}`);
		expect(joined).toContain(`Stop it (Ctrl-C, or kill ${process.pid})`);
	});

	it('routes `wipe`-style (--force --yes) through the same guard', async () => {
		// `devstack wipe --yes` rewrites to `stack drop --force --yes` in
		// cli/index.ts; this test mirrors that exact shape and confirms
		// the guard fires for it too.
		const appDir = newAppDir();
		const cfgPath = writeFixtureConfig(appDir, 'fixture-app');
		mkdirSync(stackDir(appDir, 'main'), { recursive: true });
		writeStaleLockForTesting({ appDir, stack: 'main' }, process.pid);

		const { result, lines } = await captureStderrAsync(() =>
			runStack({
				configPath: cfgPath,
				subcommand: 'drop',
				// no stackName set; runStack falls back to active stack
				// when --force is true (the wipe path).
				yes: true,
				force: true,
			}),
		);

		expect(result).toBe(1);
		expect(lines.join('')).toContain(`refusing to drop stack 'main'`);
	});
});
