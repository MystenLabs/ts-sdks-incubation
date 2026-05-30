// cascade-formatter — regression tests pinning the rendered output.
//
// Architecture invariants under test:
//   1. Mixed-cause scenarios (Fail + Die + Interrupt in one cause) render
//      every reason separated by `--- (also)`, with `DEFECT:` prefix for
//      `Die` and `INTERRUPT[<fiberId>]` for `Interrupt`.
//   2. A real v4 `Cause` constructed via `Cause.fromReasons` flows through
//      the formatter without any bridge casts — the substrate consumes
//      the public `Cause.isFailReason` / `isDieReason` / `isInterruptReason`
//      guards directly.
//   3. Empty causes render as the single-line sentinel `(empty cause)`.
//   4. A nested tagged-error `cause` chain renders with `caused by:`
//      indented two spaces deeper than the parent.

import { Cause } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	formatCause,
	formatValue,
} from '../../../../src/substrate/runtime/observability/cascade-formatter.ts';

describe('cascade-formatter', () => {
	it('renders a mixed Fail + Die + Interrupt cause via --- (also) separators', () => {
		const cause = Cause.fromReasons<{ _tag: string; message?: string }>([
			Cause.makeFailReason({ _tag: 'PluginAError', message: 'boom' }),
			Cause.makeDieReason(new Error('unexpected defect')),
			Cause.makeInterruptReason(42),
		]);

		const out = formatCause(cause);
		const blocks = out.split('\n--- (also)\n');

		expect(blocks).toHaveLength(3);
		expect(blocks[0]).toContain('PluginAError: boom');
		expect(blocks[1]?.startsWith('DEFECT:')).toBe(true);
		expect(blocks[1]).toContain('unexpected defect');
		expect(blocks[2]).toBe('INTERRUPT[42]');
	});

	it('renders Cause.empty as the (empty cause) sentinel', () => {
		expect(formatCause(Cause.empty)).toBe('(empty cause)');
	});

	it('renders an Interrupt without fiberId as INTERRUPT[unknown]', () => {
		expect(formatCause(Cause.interrupt())).toBe('INTERRUPT[unknown]');
	});

	it('renders nested cause chains with caused by: + 4-space indent', () => {
		const inner = { _tag: 'InnerError', message: 'root reason' };
		const outer = { _tag: 'OuterError', message: 'wrapping', cause: inner };
		const out = formatCause(Cause.fail(outer));

		expect(out).toContain('OuterError: wrapping');
		expect(out).toContain('  caused by:');
		expect(out).toContain('    InnerError: root reason');
	});

	it('formatValue accepts a real Cause and dispatches via Cause.isCause', () => {
		// Verifies the value-shaped entry point still detects v4 causes via
		// the public Cause.isCause guard (no bespoke duck-typing).
		const cause = Cause.die(new Error('boom'));
		const out = formatValue(cause);

		expect(out.startsWith('DEFECT:')).toBe(true);
		expect(out).toContain('boom');
	});
});
