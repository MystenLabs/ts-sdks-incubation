// Envelope shape tests — Phase A invariants for the canonical
// `--json` body. Production-readiness wants:
//
//   1. `schemaVersion` pinned at 1 (bump intentionally on breaking
//      shape changes; this test fails LOUDLY when someone forgets).
//   2. `ok` reflects success/failure correctly.
//   3. `elapsedMs` is always present (agents track wall-clock budget).
//   4. `dryRun` shows up only when explicitly set true (saves bytes on
//      every non-dry envelope).
//   5. `data` is omitted when absent (no `"data":undefined` in stdout).
//   6. `error` carries the documented sub-fields and a known
//      `exitCode` value from the `ExitCode` union.

import { describe, expect, it } from 'vitest';
import {
	ENVELOPE_SCHEMA_VERSION,
	emitEnvelope,
	errorEnvelope,
	inputDisabled,
	jsonModeEnabled,
	successEnvelope,
} from './envelope.js';
import { ALL_EXIT_CODES, EX_OK, EX_USAGE, exitCodeDescription, exitCodeName } from './exit-codes.js';

describe('cli/envelope', () => {
	it('schemaVersion is pinned at 1 (bump intentionally on breaking changes)', () => {
		expect(ENVELOPE_SCHEMA_VERSION).toBe(1);
	});

	it('successEnvelope omits absent fields', () => {
		const env = successEnvelope({ command: 'manifest', elapsedMs: 14 });
		expect(env).toEqual({
			schemaVersion: 1,
			ok: true,
			command: 'manifest',
			elapsedMs: 14,
		});
		expect('data' in env).toBe(false);
		expect('dryRun' in env).toBe(false);
		expect('hints' in env).toBe(false);
	});

	it('successEnvelope includes data + dryRun when supplied', () => {
		const env = successEnvelope({
			command: 'wipe',
			data: { app: 'arena', stack: 'main' },
			elapsedMs: 4,
			dryRun: true,
		});
		expect(env.dryRun).toBe(true);
		expect(env.data).toEqual({ app: 'arena', stack: 'main' });
	});

	it('successEnvelope drops empty hints array', () => {
		const env = successEnvelope({ command: 'status', elapsedMs: 1, hints: [] });
		expect('hints' in env).toBe(false);
	});

	it('errorEnvelope carries every documented sub-field', () => {
		const env = errorEnvelope({
			command: 'apply',
			error: {
				code: 'SEED_MANIFEST_MISMATCH',
				exitCode: EX_USAGE,
				message: 'fork seed manifest mismatch',
				hint: 'devstack wipe --keep-upstream-cache && devstack apply',
				recipe: 'devstack wipe --keep-upstream-cache && devstack apply',
				context: { metaPath: '/tmp/meta.json' },
			},
			elapsedMs: 412,
		});
		expect(env.ok).toBe(false);
		expect(env.error!.code).toBe('SEED_MANIFEST_MISMATCH');
		expect(env.error!.exitCode).toBe(EX_USAGE);
		expect(env.error!.hint).toMatch(/wipe/);
		expect(env.error!.recipe).toMatch(/apply/);
		expect(env.error!.context).toEqual({ metaPath: '/tmp/meta.json' });
		expect(env.elapsedMs).toBe(412);
	});

	it('jsonModeEnabled honors --json flag and DEVSTACK_JSON env', () => {
		const prev = process.env.DEVSTACK_JSON;
		try {
			delete process.env.DEVSTACK_JSON;
			expect(jsonModeEnabled(false)).toBe(false);
			expect(jsonModeEnabled(true)).toBe(true);
			process.env.DEVSTACK_JSON = '1';
			expect(jsonModeEnabled(false)).toBe(true);
			process.env.DEVSTACK_JSON = 'true';
			expect(jsonModeEnabled(false)).toBe(true);
			process.env.DEVSTACK_JSON = 'not-a-truthy';
			expect(jsonModeEnabled(false)).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.DEVSTACK_JSON;
			else process.env.DEVSTACK_JSON = prev;
		}
	});

	it('inputDisabled honors --no-input flag and DEVSTACK_NO_INPUT env', () => {
		const prev = process.env.DEVSTACK_NO_INPUT;
		try {
			delete process.env.DEVSTACK_NO_INPUT;
			expect(inputDisabled({ noInput: false })).toBe(false);
			expect(inputDisabled({ noInput: true })).toBe(true);
			process.env.DEVSTACK_NO_INPUT = '1';
			expect(inputDisabled({ noInput: false })).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.DEVSTACK_NO_INPUT;
			else process.env.DEVSTACK_NO_INPUT = prev;
		}
	});
});

describe('cli/exit-codes', () => {
	it('every ALL_EXIT_CODES entry has a name + description (used by --schema)', () => {
		expect(ALL_EXIT_CODES).toContain(EX_OK);
		expect(ALL_EXIT_CODES).toContain(EX_USAGE);
		for (const code of ALL_EXIT_CODES) {
			expect(exitCodeName(code)).toMatch(/^EX_/);
			expect(exitCodeDescription(code).length).toBeGreaterThan(0);
		}
	});

	it('exit codes are unique', () => {
		const set = new Set(ALL_EXIT_CODES);
		expect(set.size).toBe(ALL_EXIT_CODES.length);
	});
});

describe('cli/envelope emitEnvelope', () => {
	it('emits exactly one JSON line on stdout', async () => {
		// Capture Console.log via the global stub.
		const lines: Array<string> = [];
		const originalLog = console.log;
		console.log = (msg: unknown) => {
			lines.push(String(msg));
		};
		try {
			const env = successEnvelope({ command: 'status', elapsedMs: 1 });
			const { Effect } = await import('effect');
			await Effect.runPromise(emitEnvelope(env));
			expect(lines).toHaveLength(1);
			const parsed = JSON.parse(lines[0]!) as { schemaVersion: number; command: string };
			expect(parsed.schemaVersion).toBe(1);
			expect(parsed.command).toBe('status');
		} finally {
			console.log = originalLog;
		}
	});
});
