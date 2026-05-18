// Stack-resolution precedence — mirrors `engine/supervisor.ts:567`
// (override > DEVSTACK_STACK env > active file > 'main'). Pinning the
// precedence here so a future env-var refactor can't silently shadow
// the wipe / snapshot / stack subcommands' boundary.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Effect, FileSystem, Option, Path } from 'effect';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStack, resolveStackFromEnv } from './stack-resolution.js';

const runResolve = (override: Option.Option<string>): Promise<string> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			return yield* resolveStack(fs, path, override);
		}).pipe(Effect.provide(NodeServicesLayer)),
	);

const fixture = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-stack-'));
	mkdirSync(join(dir, '.devstack'), { recursive: true });
	return dir;
};

describe('resolveStackFromEnv (env-only)', () => {
	const savedEnv = { ...process.env };
	beforeEach(() => {
		delete process.env.DEVSTACK_STACK;
	});
	afterEach(() => {
		process.env = { ...savedEnv };
	});

	it('explicit override wins over env', () => {
		process.env.DEVSTACK_STACK = 'fromenv';
		expect(resolveStackFromEnv('explicit')).toBe('explicit');
	});

	it('falls through to DEVSTACK_STACK env when no override', () => {
		process.env.DEVSTACK_STACK = 'fromenv';
		expect(resolveStackFromEnv(undefined)).toBe('fromenv');
	});

	it('falls through to "main" when nothing set', () => {
		expect(resolveStackFromEnv(undefined)).toBe('main');
	});

	it('treats empty string env as absent', () => {
		process.env.DEVSTACK_STACK = '';
		expect(resolveStackFromEnv(undefined)).toBe('main');
	});
});

describe('resolveStack (fs-aware)', () => {
	const savedEnv = { ...process.env };
	beforeEach(() => {
		delete process.env.DEVSTACK_STACK;
		delete process.env.DEVSTACK_STATE_DIR;
	});
	afterEach(() => {
		process.env = { ...savedEnv };
	});

	it('explicit override wins over env and active file', async () => {
		const dir = fixture();
		writeFileSync(join(dir, '.devstack', 'active'), 'fromactive');
		process.env.DEVSTACK_STATE_DIR = join(dir, '.devstack');
		process.env.DEVSTACK_STACK = 'fromenv';
		expect(await runResolve(Option.some('explicit'))).toBe('explicit');
	});

	it('env wins over active file when no override', async () => {
		const dir = fixture();
		writeFileSync(join(dir, '.devstack', 'active'), 'fromactive');
		process.env.DEVSTACK_STATE_DIR = join(dir, '.devstack');
		process.env.DEVSTACK_STACK = 'fromenv';
		expect(await runResolve(Option.none<string>())).toBe('fromenv');
	});

	it('active file wins when no override and no env', async () => {
		const dir = fixture();
		writeFileSync(join(dir, '.devstack', 'active'), 'fromactive');
		process.env.DEVSTACK_STATE_DIR = join(dir, '.devstack');
		expect(await runResolve(Option.none<string>())).toBe('fromactive');
	});

	it('falls through to "main" when nothing is set', async () => {
		const dir = fixture();
		process.env.DEVSTACK_STATE_DIR = join(dir, '.devstack');
		expect(await runResolve(Option.none<string>())).toBe('main');
	});
});
