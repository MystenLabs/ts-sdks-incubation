// `stack` verb subcommands.

import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { runStack } from '../../../../src/surfaces/cli/commands/stack.ts';
import type { CliIO } from '../../../../src/surfaces/cli/output.ts';

const makeIo = () => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	let exitCode: number | null = null;
	const io: CliIO = {
		writeStdout: (l) => Effect.sync(() => void stdout.push(l)),
		writeStderr: (l) => Effect.sync(() => void stderr.push(l)),
		setExitCode: (code) =>
			Effect.sync(() => {
				exitCode = code;
			}),
	};
	return { io, stdout, stderr, getExitCode: () => exitCode };
};

const baseFlags = {
	outputMode: 'human' as const,
	app: undefined,
	stack: undefined,
	stateDir: undefined,
	configPath: undefined,
	network: undefined,
	renderer: undefined,
	dryRun: false,
	confirm: { assumeYes: true, forbidPrompt: false, stdinIsTty: true },
	schemaEmit: false,
	verbose: false,
	help: false,
	version: false,
	rest: [] as ReadonlyArray<string>,
};

const fresh = () => mkdtempSync(join(tmpdir(), 'stack-verb-test-'));

describe('stack verb', () => {
	it('new creates a stack root', async () => {
		const root = fresh();
		try {
			const { io } = makeIo();
			await Effect.runPromise(
				runStack(
					{ resolveAppRoot: () => Effect.succeed(root) },
					{ flags: { ...baseFlags, rest: ['new', 'alpha'] }, io },
				),
			);
			expect(existsSync(join(root, 'alpha'))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('use writes the active-stack file', async () => {
		const root = fresh();
		try {
			const { io } = makeIo();
			await Effect.runPromise(
				runStack(
					{ resolveAppRoot: () => Effect.succeed(root) },
					{ flags: { ...baseFlags, rest: ['use', 'beta'] }, io },
				),
			);
			expect(readFileSync(join(root, '.active'), 'utf8')).toBe('beta');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('list enumerates stack directories with active marker', async () => {
		const root = fresh();
		try {
			mkdirSync(join(root, 'alpha'));
			mkdirSync(join(root, 'beta'));
			writeFileSync(join(root, '.active'), 'beta');
			const { io, stdout } = makeIo();
			await Effect.runPromise(
				runStack(
					{ resolveAppRoot: () => Effect.succeed(root) },
					{ flags: { ...baseFlags, rest: ['list'] }, io },
				),
			);
			const joined = stdout.join('\n');
			expect(joined).toContain('alpha');
			expect(joined).toContain('beta');
			expect(joined).toContain('* beta');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('drop removes the stack root (no live supervisor)', async () => {
		const root = fresh();
		try {
			mkdirSync(join(root, 'alpha'));
			const { io } = makeIo();
			await Effect.runPromise(
				runStack(
					{ resolveAppRoot: () => Effect.succeed(root) },
					{ flags: { ...baseFlags, rest: ['drop', 'alpha'] }, io },
				),
			);
			expect(existsSync(join(root, 'alpha'))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
