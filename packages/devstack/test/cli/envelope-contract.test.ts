// Regression coverage for Phase-4 CLI envelope/exit-code contract fixes.
//
// 1. `identityInputsFromArgv` errors must flow through `emitFailure` so
//    the exit code is `ExitCode.USAGE` (64) and `--json` mode emits the
//    envelope shape (rather than a bare "error: …" stderr line + exit 1).
// 2. `devstack schema` must always go through `emitSuccess` so the
//    envelope contract is honored in both `--json` and human modes
//    (previously dumped raw `JSON.stringify(...)` to stdout in both).
// 3. Phase-22b: verbs that hit a typed terminal failure
//    (`CliSupervisorLiveError`, `CliConfigNotFoundError`, etc.) must
//    flow through the dispatcher's envelope renderer — NOT raw
//    `process.stderr.write` + `process.exitCode = ...` shortcuts.
// 4. Phase-22b: duplicate identity flags (`--app a --app b`) are
//    rejected by the argv pre-parser so the pre-parser's value and the
//    Stricli-resolved value cannot disagree.

import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/cli/main.ts';
import { dispatch, type CliDeps } from '../../src/surfaces/cli/index.ts';
import {
	type CliError,
	CliConfigNotFoundError,
	CliSupervisorLiveError,
} from '../../src/surfaces/cli/errors.ts';
import type { CliIO } from '../../src/surfaces/cli/output.ts';
import { ExitCode } from '../../src/surfaces/cli/sysexits.ts';

const captureProcessWrite =
	(bucket: Array<string>): typeof process.stdout.write =>
	(chunk, encodingOrCallback?, callback?) => {
		bucket.push(String(chunk));
		if (typeof encodingOrCallback === 'function') {
			encodingOrCallback();
		}
		if (typeof callback === 'function') {
			callback();
		}
		return true;
	};

describe('cli envelope contract', () => {
	const previousExitCode = process.exitCode;

	afterEach(() => {
		process.exitCode = previousExitCode;
	});

	it('argv pre-parser rejection emits a JSON envelope with EX_USAGE under --json', async () => {
		const stdout: Array<string> = [];
		const stderr: Array<string> = [];
		const stdoutSpy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(captureProcessWrite(stdout));
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(captureProcessWrite(stderr));

		try {
			process.exitCode = undefined;
			// `--app` is followed by another flag, which the pre-parser
			// rejects as a typo to avoid silently demoting `--stack`.
			await runCli(['up', '--json', '--app', '--stack', 'main']);

			expect(process.exitCode).toBe(ExitCode.USAGE);
			expect(stderr.join('')).toBe('');
			const envelope = JSON.parse(stdout.join('')) as {
				readonly ok: false;
				readonly command: string;
				readonly error: {
					readonly exitCode: number;
					readonly code: string;
					readonly summary: string;
				};
			};
			expect(envelope.ok).toBe(false);
			expect(envelope.command).toBe('(parse-argv)');
			expect(envelope.error.exitCode).toBe(ExitCode.USAGE);
			expect(envelope.error.code).toBe('USAGE');
			expect(envelope.error.summary).toMatch(/flag --app requires a value/);
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it('argv pre-parser rejection emits "error: …" to stderr in human mode with EX_USAGE', async () => {
		const stdout: Array<string> = [];
		const stderr: Array<string> = [];
		const stdoutSpy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(captureProcessWrite(stdout));
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(captureProcessWrite(stderr));

		try {
			process.exitCode = undefined;
			await runCli(['up', '--app']);

			expect(process.exitCode).toBe(ExitCode.USAGE);
			expect(stdout.join('')).toBe('');
			expect(stderr.join('')).toMatch(/error: flag --app requires a value/);
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it('schema --json emits a success envelope whose data carries the command schema', async () => {
		const stdout: Array<string> = [];
		const stderr: Array<string> = [];
		const stdoutSpy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(captureProcessWrite(stdout));
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(captureProcessWrite(stderr));

		try {
			process.exitCode = undefined;
			await runCli(['schema', '--json']);

			expect(process.exitCode).toBe(0);
			expect(stderr.join('')).toBe('');
			const envelope = JSON.parse(stdout.join('')) as {
				readonly ok: true;
				readonly schemaVersion: number;
				readonly command: string;
				readonly data: {
					readonly schemaVersion: number;
					readonly verbs: ReadonlyArray<string>;
					readonly exitCodes: ReadonlyArray<{ readonly code: number; readonly name: string }>;
					readonly outputMode: string;
				};
			};
			expect(envelope.ok).toBe(true);
			expect(envelope.command).toBe('schema');
			expect(envelope.data.schemaVersion).toBe(1);
			expect(envelope.data.outputMode).toBe('json');
			expect(Array.isArray(envelope.data.verbs)).toBe(true);
			expect(envelope.data.verbs.length).toBeGreaterThan(0);
			expect(envelope.data.exitCodes.find((entry) => entry.name === 'USAGE')?.code).toBe(
				ExitCode.USAGE,
			);
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it('duplicate identity flag is rejected by the argv pre-parser as a usage envelope', async () => {
		const stdout: Array<string> = [];
		const stderr: Array<string> = [];
		const stdoutSpy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(captureProcessWrite(stdout));
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(captureProcessWrite(stderr));

		try {
			process.exitCode = undefined;
			await runCli(['--json', 'up', '--app', 'a', '--app', 'b']);

			expect(process.exitCode).toBe(ExitCode.USAGE);
			expect(stderr.join('')).toBe('');
			const envelope = JSON.parse(stdout.join('')) as {
				readonly ok: false;
				readonly error: { readonly code: string; readonly summary: string };
			};
			expect(envelope.ok).toBe(false);
			expect(envelope.error.code).toBe('USAGE');
			expect(envelope.error.summary).toMatch(/--app given more than once/);
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it('two sequential runCli calls do not leak exit code from the first to the second', async () => {
		const stdout: Array<string> = [];
		const stderr: Array<string> = [];
		const stdoutSpy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(captureProcessWrite(stdout));
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(captureProcessWrite(stderr));

		try {
			process.exitCode = undefined;
			// First call: a duplicate-flag rejection sets exitCode = 64.
			await runCli(['--json', 'up', '--app', 'a', '--app', 'b']);
			expect(process.exitCode).toBe(ExitCode.USAGE);

			// Second call: `schema --json` succeeds. The OS exit code must
			// reflect the second outcome (0), not the first (64).
			await runCli(['schema', '--json']);
			expect(process.exitCode).toBe(ExitCode.OK);
			expect(stderr.join('')).toBe('');
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});

	it('schema (human mode) emits the schema payload through emitSuccess, not raw writeStdout', async () => {
		const stdout: Array<string> = [];
		const stderr: Array<string> = [];
		const stdoutSpy = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(captureProcessWrite(stdout));
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(captureProcessWrite(stderr));

		try {
			process.exitCode = undefined;
			await runCli(['schema']);

			expect(process.exitCode).toBe(0);
			expect(stderr.join('')).toBe('');
			// Human mode emits the JSON payload via emitSuccess's humanLines
			// branch — still parseable, with the outputMode field reflecting
			// the resolved mode.
			const payload = JSON.parse(stdout.join('')) as {
				readonly schemaVersion: number;
				readonly verbs: ReadonlyArray<string>;
				readonly outputMode: string;
			};
			expect(payload.schemaVersion).toBe(1);
			expect(payload.outputMode).toBe('human');
			expect(Array.isArray(payload.verbs)).toBe(true);
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});
});

// -----------------------------------------------------------------------------
// Typed verb failures must flow through the dispatcher's envelope renderer.
// -----------------------------------------------------------------------------
//
// These tests dispatch directly (no `runCli`) so the harness can inject a
// failing verb without touching the real config loader / Docker / runtime.

interface DispatchHarness {
	readonly io: CliIO;
	readonly stdout: ReadonlyArray<string>;
	readonly stderr: ReadonlyArray<string>;
	readonly exitCode: () => number | null;
}

const makeFailingUpDeps = (
	error: CliError,
): {
	deps: CliDeps;
	harness: DispatchHarness;
} => {
	const stdout: Array<string> = [];
	const stderr: Array<string> = [];
	let exitCode: number | null = null;
	const io: CliIO = {
		writeStdout: (line) => Effect.sync(() => void stdout.push(line)),
		writeStderr: (line) => Effect.sync(() => void stderr.push(line)),
		setExitCode: (code) =>
			Effect.sync(() => {
				exitCode = code;
			}),
	};
	const deps: CliDeps = {
		up: { run: () => Effect.fail(error) },
		apply: { run: () => Effect.sync(() => ({ exitCode: 0 })) },
		codegen: { run: () => Effect.sync(() => ({ exitCode: 0 })) },
		status: { reader: { readState: () => Effect.succeed(null) } },
		snapshot: {
			reader: {
				list: () => Effect.succeed([]),
				resolve: () => Effect.succeed({ tag: 'not-found' }),
			},
			capture: () => Effect.succeed({ snapshotId: 'x', name: 'x' }),
			restore: () => Effect.succeed(undefined),
			delete: () => Effect.succeed(undefined),
			confirm: () => Effect.succeed(true),
		},
		prune: {
			inventory: () =>
				Effect.succeed({
					groups: [],
					totals: {
						groups: 0,
						liveGroups: 0,
						sharedGroups: 0,
						containers: 0,
						runningContainers: 0,
						networks: 0,
						volumes: 0,
						images: 0,
					},
				}),
			prune: () =>
				Effect.succeed({
					kind: 'completed' as const,
					summary: {
						inspectedGroups: 0,
						selectedGroups: 0,
						skippedLiveGroups: 0,
						containersRemoved: 0,
						networksRemoved: 0,
						networksSkipped: 0,
						volumesRemoved: 0,
						imagesRemoved: 0,
						foreignNetworkHolders: [],
						staleNetworkEndpoints: [],
					},
				}),
			select: (_inventory, resources) => Effect.succeed({ groupKeys: [], resources }),
		},
		doctor: { probes: [] },
		config: {
			loader: {
				load: () =>
					Effect.succeed({
						stack: { _tag: 'Stack' },
						resolvedConfigPath: '/tmp/devstack.config.ts',
					} as never),
			},
		},
		wipe: {
			wipe: () => Effect.succeed(undefined),
			confirm: () => Effect.succeed(true),
		},
	};
	return {
		deps,
		harness: { io, stdout, stderr, exitCode: () => exitCode },
	};
};

describe('typed verb failures route through the envelope renderer', () => {
	it('CliSupervisorLiveError on `up --json` emits a SUPERVISOR_LIVE envelope (not raw stderr)', async () => {
		const { deps, harness } = makeFailingUpDeps(
			new CliSupervisorLiveError({
				app: 'devstack',
				stack: 'main',
				hint: 'use `devstack apply` from another shell',
			}),
		);
		await Effect.runPromise(
			dispatch(deps, { argv: ['up', '--json'], env: {}, stdinIsTty: true, io: harness.io }),
		);
		expect(harness.exitCode()).toBe(ExitCode.SUPERVISOR_LIVE);
		expect(harness.stderr).toHaveLength(0);
		expect(harness.stdout).toHaveLength(1);
		const env = JSON.parse(harness.stdout[0]!) as {
			readonly ok: false;
			readonly error: { readonly code: string; readonly summary: string; readonly hint?: string };
		};
		expect(env.ok).toBe(false);
		expect(env.error.code).toBe('SUPERVISOR_LIVE');
		expect(env.error.summary).toContain('supervisor live for devstack/main');
		expect(env.error.hint).toContain('devstack apply');
	});

	it('CliConfigNotFoundError on `up --json` emits a NO_INPUT envelope', async () => {
		const { deps, harness } = makeFailingUpDeps(
			new CliConfigNotFoundError({
				message: 'devstack config not found at /tmp/nope/devstack.config.ts',
				searchedPaths: ['/tmp/nope/devstack.config.ts'],
			}),
		);
		await Effect.runPromise(
			dispatch(deps, { argv: ['up', '--json'], env: {}, stdinIsTty: true, io: harness.io }),
		);
		expect(harness.exitCode()).toBe(ExitCode.NO_INPUT);
		expect(harness.stderr).toHaveLength(0);
		expect(harness.stdout).toHaveLength(1);
		const env = JSON.parse(harness.stdout[0]!) as {
			readonly ok: false;
			readonly error: { readonly code: string; readonly summary: string };
		};
		expect(env.error.code).toBe('NO_INPUT');
		expect(env.error.summary).toContain('devstack config not found');
	});

	it('CliSupervisorLiveError in human mode renders the typed summary, not a raw "supervisor live for …" stderr line', async () => {
		const { deps, harness } = makeFailingUpDeps(
			new CliSupervisorLiveError({
				app: 'devstack',
				stack: 'main',
				hint: 'use `devstack apply` from another shell',
			}),
		);
		await Effect.runPromise(
			dispatch(deps, { argv: ['up'], env: {}, stdinIsTty: true, io: harness.io }),
		);
		expect(harness.exitCode()).toBe(ExitCode.SUPERVISOR_LIVE);
		expect(harness.stdout).toHaveLength(0);
		// The dispatcher's `emitFailure` writes a single "error: …" line +
		// "hint: …" line — both via the typed projection. There should be
		// NO line of the form "error: supervisor live for devstack/main"
		// AHEAD of any envelope handling (the old raw-stderr shortcut).
		const stderr = harness.stderr.join('\n');
		expect(stderr).toContain('error: supervisor live for devstack/main');
		expect(stderr).toContain('hint: use `devstack apply`');
		// The typed renderer emits exactly two distinct calls (one
		// summary, one hint). The raw shortcut emitted them as separate
		// `process.stderr.write` calls each terminated with `\n` — the
		// typed renderer normalizes the trailing newline. Either way, no
		// duplicate.
		expect(harness.stderr.filter((line) => line.startsWith('error:'))).toHaveLength(1);
	});
});
