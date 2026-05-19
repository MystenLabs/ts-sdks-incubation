// `devstack wipe` Phase A envelope + dry-run integration test.
//
// Verifies that `wipe --dry-run --json` emits the canonical envelope
// shape on stdout (one JSON line) with `ok: true`, `dryRun: true`, and
// a `data.wouldRemove` block — without mutating disk or invoking
// docker. The point is that an agent can safely call this on a fresh
// repo and get the structured preview back, parseable with JSON.parse.

import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { Command } from 'effect/unstable/cli';
import { RegistryLive } from '../../engine/registry.js';
import { wipeCommand } from './wipe.js';

const captureStdout = async <A>(fn: () => Promise<A>): Promise<{ result: A; lines: string[] }> => {
	const lines: string[] = [];
	const originalLog = console.log;
	console.log = (msg: unknown) => {
		lines.push(String(msg));
	};
	try {
		const result = await fn();
		return { result, lines };
	} finally {
		console.log = originalLog;
	}
};

describe('cli/commands/wipe — Phase A envelope', () => {
	it('--dry-run --json emits the canonical envelope with dryRun=true', async () => {
		const prevApp = process.env.DEVSTACK_APP_DIR;
		const prevStack = process.env.DEVSTACK_STACK;
		process.env.DEVSTACK_APP_DIR = '/tmp/devstack-test-wipe';
		process.env.DEVSTACK_STACK = 'test-envelope';
		try {
			const program = Command.runWith(wipeCommand, { version: '0.0.0' })([
				'--dry-run',
				'--json',
				'--app',
				'test-app',
			]).pipe(Effect.provide(RegistryLive), Effect.provide(NodeServicesLayer));

			const { lines } = await captureStdout(() => Effect.runPromise(program));
			// Exactly one JSON line.
			expect(lines.length).toBe(1);
			const parsed = JSON.parse(lines[0]!) as {
				schemaVersion: number;
				ok: boolean;
				command: string;
				dryRun: boolean;
				data: {
					app: string;
					stack: string;
					wouldRemove: Record<string, unknown>;
				};
				elapsedMs: number;
			};
			expect(parsed.schemaVersion).toBe(1);
			expect(parsed.ok).toBe(true);
			expect(parsed.command).toBe('wipe');
			expect(parsed.dryRun).toBe(true);
			expect(parsed.data.app).toBe('test-app');
			expect(parsed.data.stack).toBe('test-envelope');
			expect(typeof parsed.data.wouldRemove.stateDir).toBe('string');
			// `--also-upstream-cache` not passed, so no upstreamCache field.
			expect('upstreamCache' in parsed.data.wouldRemove).toBe(false);
			expect(typeof parsed.elapsedMs).toBe('number');
		} finally {
			if (prevApp === undefined) delete process.env.DEVSTACK_APP_DIR;
			else process.env.DEVSTACK_APP_DIR = prevApp;
			if (prevStack === undefined) delete process.env.DEVSTACK_STACK;
			else process.env.DEVSTACK_STACK = prevStack;
		}
	});

	it('--dry-run --also-upstream-cache --json surfaces the upstream cache path', async () => {
		const prevApp = process.env.DEVSTACK_APP_DIR;
		const prevStack = process.env.DEVSTACK_STACK;
		process.env.DEVSTACK_APP_DIR = '/tmp/devstack-test-wipe';
		process.env.DEVSTACK_STACK = 'cache-test';
		try {
			const program = Command.runWith(wipeCommand, { version: '0.0.0' })([
				'--dry-run',
				'--also-upstream-cache',
				'--json',
				'--app',
				'arena',
			]).pipe(Effect.provide(RegistryLive), Effect.provide(NodeServicesLayer));
			const { lines } = await captureStdout(() => Effect.runPromise(program));
			expect(lines.length).toBe(1);
			const parsed = JSON.parse(lines[0]!) as {
				dryRun: boolean;
				data: { wouldRemove: { upstreamCache?: string } };
			};
			expect(parsed.dryRun).toBe(true);
			expect(parsed.data.wouldRemove.upstreamCache).toBeDefined();
			expect(typeof parsed.data.wouldRemove.upstreamCache).toBe('string');
		} finally {
			if (prevApp === undefined) delete process.env.DEVSTACK_APP_DIR;
			else process.env.DEVSTACK_APP_DIR = prevApp;
			if (prevStack === undefined) delete process.env.DEVSTACK_STACK;
			else process.env.DEVSTACK_STACK = prevStack;
		}
	});

	it('--no-input without --yes fails with the CONFIRM_REQUIRED envelope under --json', async () => {
		const prevApp = process.env.DEVSTACK_APP_DIR;
		const prevStack = process.env.DEVSTACK_STACK;
		process.env.DEVSTACK_APP_DIR = '/tmp/devstack-test-wipe';
		process.env.DEVSTACK_STACK = 'noinput-test';
		try {
			const program = Command.runWith(wipeCommand, { version: '0.0.0' })([
				'--no-input',
				'--json',
				'--app',
				'arena',
			]).pipe(Effect.provide(RegistryLive), Effect.provide(NodeServicesLayer));
			const { lines } = await captureStdout(() =>
				Effect.runPromiseExit(program).then(() => undefined),
			);
			expect(lines.length).toBe(1);
			const parsed = JSON.parse(lines[0]!) as {
				ok: boolean;
				error: { code: string; exitCode: number };
			};
			expect(parsed.ok).toBe(false);
			expect(parsed.error.code).toBe('CONFIRM_REQUIRED');
			// EX_CONFIRM_REQUIRED = 43 per exit-codes.ts
			expect(parsed.error.exitCode).toBe(43);
		} finally {
			if (prevApp === undefined) delete process.env.DEVSTACK_APP_DIR;
			else process.env.DEVSTACK_APP_DIR = prevApp;
			if (prevStack === undefined) delete process.env.DEVSTACK_STACK;
			else process.env.DEVSTACK_STACK = prevStack;
		}
	});
});
