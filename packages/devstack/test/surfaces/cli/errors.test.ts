// CLI tagged-error projection tests.
//
// These pin the (tag → sysexit, tag → summary, tag → hint) projections
// so the envelope renderer can never silently drift away from the
// architecture-enumerated mapping. The hint projection is operator-
// facing — adding a hint is observable in JSON envelope output and in
// the human-mode stderr line, so it deserves an explicit regression.

import { describe, expect, it } from 'vitest';

import {
	CliConfigNotFoundError,
	CliInternalError,
	CliSnapshotAmbiguousError,
	CliUsageError,
	exitCodeFor,
	hintFor,
	summaryFor,
} from '../../../src/surfaces/cli/errors.ts';
import { ExitCode } from '../../../src/surfaces/cli/sysexits.ts';

describe('exitCodeFor', () => {
	it('CliConfigNotFoundError → NO_INPUT (66)', () => {
		expect(
			exitCodeFor(new CliConfigNotFoundError({ message: 'no devstack.config.ts found' })),
		).toBe(ExitCode.NO_INPUT);
	});

	it('CliUsageError → USAGE (64)', () => {
		expect(exitCodeFor(new CliUsageError({ message: 'unknown subcommand' }))).toBe(ExitCode.USAGE);
	});

	it('CliInternalError → SOFTWARE (70)', () => {
		expect(exitCodeFor(new CliInternalError({ message: 'boom' }))).toBe(ExitCode.SOFTWARE);
	});
});

describe('hintFor', () => {
	it('CliConfigNotFoundError exposes the init/--config recipe', () => {
		// Regression: prior to phase-22g the projection returned
		// `undefined` for `CliConfigNotFoundError`, so the envelope's
		// `error.hint` was empty and operators saw a bare "config not
		// found" line with no actionable next step. Pin the recipe so a
		// future refactor that adds new error tags doesn't accidentally
		// shadow this branch.
		const hint = hintFor(new CliConfigNotFoundError({ message: 'searched paths exhausted' }));
		expect(hint).toBeDefined();
		expect(hint).toMatch(/devstack init/);
		expect(hint).toMatch(/--config/);
	});

	it('CliUsageError forwards the supplied hint verbatim', () => {
		expect(hintFor(new CliUsageError({ message: 'bad flag', hint: 'try --help' }))).toBe(
			'try --help',
		);
	});

	it('CliSnapshotAmbiguousError lists the candidate ids', () => {
		const hint = hintFor(
			new CliSnapshotAmbiguousError({
				snapshotRef: 'foo',
				matches: ['snap-a', 'snap-b'],
			}),
		);
		expect(hint).toMatch(/snap-a/);
		expect(hint).toMatch(/snap-b/);
	});

	it('CliInternalError leaves the hint undefined (cause renders into the chain)', () => {
		expect(hintFor(new CliInternalError({ message: 'boom' }))).toBeUndefined();
	});
});

describe('summaryFor', () => {
	it('CliConfigNotFoundError surfaces the message field directly', () => {
		const message = 'searched ./, ../, ../../ — no devstack.config.ts';
		expect(summaryFor(new CliConfigNotFoundError({ message }))).toBe(message);
	});
});
