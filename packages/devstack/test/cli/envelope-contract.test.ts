// Regression coverage for Phase-4 CLI envelope/exit-code contract fixes.
//
// 1. `identityInputsFromArgv` errors must flow through `emitFailure` so
//    the exit code is `ExitCode.USAGE` (64) and `--json` mode emits the
//    envelope shape (rather than a bare "error: …" stderr line + exit 1).
// 2. `devstack schema` must always go through `emitSuccess` so the
//    envelope contract is honored in both `--json` and human modes
//    (previously dumped raw `JSON.stringify(...)` to stdout in both).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/cli/main.ts';
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
				readonly error: { readonly exitCode: number; readonly code: string; readonly summary: string };
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
