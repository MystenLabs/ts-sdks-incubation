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

	// Regression: Phase B fix made the table the source of truth for
	// `schema --json` consumers. Pin that every `ExitCode.*` value has a
	// matching `exitCodeTable` entry — accidentally leaving a value out of
	// the table when adding a new code would silently break downstream
	// scripts inspecting the schema.
	it('exitCodeTable contains every ExitCode.* value', () => {
		const tableValues = new Set(exitCodeTable.map((entry) => entry.code));
		for (const value of Object.values(ExitCode)) {
			expect(tableValues.has(value)).toBe(true);
		}
		// And vice-versa — every table entry corresponds to a known ExitCode value.
		const enumValues = new Set<number>(Object.values(ExitCode));
		for (const entry of exitCodeTable) {
			expect(enumValues.has(entry.code)).toBe(true);
		}
		// Sanity: the two sets are exactly the same size.
		expect(tableValues.size).toBe(enumValues.size);
	});

	// Regression: the exhaustiveness `_exhaustive: never` switch in
	// `exitCodeName` ensures adding a new ExitCode entry without
	// extending the switch fails compilation. We can't trigger TS failure
	// at runtime, but we can assert that every named code passes through.
	it('exitCodeName resolves every ExitCode.* without falling into the never branch', () => {
		for (const [name, value] of Object.entries(ExitCode)) {
			expect(exitCodeName(value)).toBe(name);
		}
	});
});
