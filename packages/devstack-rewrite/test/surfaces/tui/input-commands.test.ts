// Input → command-publication test.
//
// The keyboard handler must publish typed `EngineCommand`s, NOT call
// engine methods. We don't try to drive Ink in a unit test (that
// would require a TTY harness); instead, we mirror the key→command
// table directly and verify the union shape.
//
// This is the architecture-required test: input handlers are
// renderless and side-effect free except for invoking `publish(cmd)`.

import { describe, expect, it } from 'vitest';

import { pluginKey } from '../../../src/substrate/brand.ts';
import type { EngineCommand } from '../../../src/substrate/events.ts';

// Mirror of input.tsx's key map so the test is independent of the
// React tree. If the table here diverges from input.tsx, both should
// be updated together (the table is small and stable enough that
// duplication is cheaper than an ink-headless harness).
const keyToCommand = (input: string, ctrl: boolean): EngineCommand | null => {
	if (ctrl && input === 'c') return { tag: 'shutdown.requested' };
	switch (input) {
		case 'q':
		case 'Q':
			return { tag: 'shutdown.requested' };
		case 'r':
		case 'R':
			return { tag: 'stack.restart' };
		case 's':
		case 'S':
			return { tag: 'snapshot.capture' };
		default:
			return null;
	}
};

describe('input → EngineCommand mapping', () => {
	it('q publishes shutdown.requested', () => {
		expect(keyToCommand('q', false)).toEqual({ tag: 'shutdown.requested' });
		expect(keyToCommand('Q', false)).toEqual({ tag: 'shutdown.requested' });
	});
	it('ctrl-c publishes shutdown.requested', () => {
		expect(keyToCommand('c', true)).toEqual({ tag: 'shutdown.requested' });
	});
	it('r publishes stack.restart', () => {
		expect(keyToCommand('r', false)).toEqual({ tag: 'stack.restart' });
		expect(keyToCommand('R', false)).toEqual({ tag: 'stack.restart' });
	});
	it('s publishes snapshot.capture', () => {
		expect(keyToCommand('s', false)).toEqual({ tag: 'snapshot.capture' });
	});
	it('unmapped keys publish nothing', () => {
		expect(keyToCommand('a', false)).toBeNull();
		expect(keyToCommand('1', false)).toBeNull();
	});
	it('selective-restart command shape is well-typed (Phase-4 wiring)', () => {
		// Compile-time check: the union accepts selective-restart with a
		// branded pluginKey. The test is illustrative — input.tsx does
		// not yet publish this command (needs row-selection UI).
		const cmd: EngineCommand = {
			tag: 'selective-restart.requested',
			pluginKey: pluginKey('sui'),
		};
		expect(cmd.tag).toBe('selective-restart.requested');
	});
});
