// Mode-detect tests.
//
// resolveMode is pure — we feed it explicit inputs and assert the
// mapping. detectMode is exercised under TTY / non-TTY by mutating
// `process.stdout.isTTY` (saved + restored).

import { afterEach, describe, expect, it } from 'vitest';

import { detectMode, resolveMode } from '../../../src/surfaces/tui/mode-detect.ts';

describe('resolveMode (pure)', () => {
	it('honors explicit ink override', () => {
		expect(resolveMode({ requested: 'ink', stdoutIsTty: false })).toBe('ink');
	});
	it('honors explicit plain override', () => {
		expect(resolveMode({ requested: 'plain', stdoutIsTty: true })).toBe('plain');
	});
	it('honors explicit silent override', () => {
		expect(resolveMode({ requested: 'silent', stdoutIsTty: true })).toBe('silent');
	});
	it('auto-picks ink for TTY', () => {
		expect(resolveMode({ stdoutIsTty: true })).toBe('ink');
	});
	it('auto-picks plain for non-TTY', () => {
		expect(resolveMode({ stdoutIsTty: false })).toBe('plain');
	});
});

describe('detectMode (reads process.stdout.isTTY)', () => {
	const saved = process.stdout.isTTY;
	afterEach(() => {
		(process.stdout as { isTTY?: boolean }).isTTY = saved;
	});

	it('returns ink under TTY', () => {
		(process.stdout as { isTTY?: boolean }).isTTY = true;
		expect(detectMode()).toBe('ink');
	});
	it('returns plain under non-TTY', () => {
		(process.stdout as { isTTY?: boolean }).isTTY = false;
		expect(detectMode()).toBe('plain');
	});
});
