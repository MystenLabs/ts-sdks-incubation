// Sysexit-code table invariants.
//
// Architecture: "numbers are stable; new codes added at the end of
// the domain block." Pin the numeric values here so accidental reuse
// or shift surfaces in CI.

import { describe, expect, it } from 'vitest';

import { ExitCode, exitCodeName, exitCodeTable } from '../../../src/surfaces/cli/sysexits.ts';

describe('ExitCode numeric values are pinned', () => {
	it('standard sysexits', () => {
		expect(ExitCode.OK).toBe(0);
		expect(ExitCode.GENERIC).toBe(1);
		expect(ExitCode.USAGE).toBe(64);
		expect(ExitCode.DATA_ERR).toBe(65);
		expect(ExitCode.NO_INPUT).toBe(66);
		expect(ExitCode.UNAVAILABLE).toBe(69);
		expect(ExitCode.SOFTWARE).toBe(70);
		expect(ExitCode.CANT_CREATE).toBe(73);
		expect(ExitCode.TEMP_FAIL).toBe(75);
		expect(ExitCode.CONFIG).toBe(78);
	});

	it('devstack-domain block', () => {
		expect(ExitCode.SUPERVISOR_LIVE).toBe(40);
		expect(ExitCode.SNAPSHOT_NOT_FOUND).toBe(41);
		expect(ExitCode.SEED_MISMATCH).toBe(42);
		expect(ExitCode.CONFIRM_REQUIRED).toBe(43);
	});

	it('exitCodeName covers every value in the table', () => {
		for (const entry of exitCodeTable) {
			expect(exitCodeName(entry.code)).toBe(entry.name);
		}
	});

	it('no duplicate numeric values', () => {
		const seen = new Set<number>();
		for (const entry of exitCodeTable) {
			expect(seen.has(entry.code)).toBe(false);
			seen.add(entry.code);
		}
	});
});
