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
import { commandForKey, selectionDeltaForKey } from '../../../src/surfaces/tui/input.tsx';

describe('input → EngineCommand mapping', () => {
	it('q publishes shutdown.requested', () => {
		expect(commandForKey('q', false)).toEqual({ tag: 'shutdown.requested' });
		expect(commandForKey('Q', false)).toEqual({ tag: 'shutdown.requested' });
	});
	it('ctrl-c publishes shutdown.requested', () => {
		expect(commandForKey('c', true)).toEqual({ tag: 'shutdown.requested' });
	});
	it('r publishes stack.restart', () => {
		expect(commandForKey('r', false)).toEqual({ tag: 'stack.restart' });
		expect(commandForKey('R', false)).toEqual({ tag: 'stack.restart' });
	});
	it('s publishes snapshot.capture', () => {
		expect(commandForKey('s', false)).toEqual({ tag: 'snapshot.capture' });
	});
	it('unmapped keys publish nothing', () => {
		expect(commandForKey('a', false)).toBeNull();
		expect(commandForKey('1', false)).toBeNull();
	});
	it('focus keys move local row selection', () => {
		expect(selectionDeltaForKey('j', {})).toBe(1);
		expect(selectionDeltaForKey('k', {})).toBe(-1);
		expect(selectionDeltaForKey('', { downArrow: true })).toBe(1);
		expect(selectionDeltaForKey('', { upArrow: true })).toBe(-1);
		expect(selectionDeltaForKey('x', {})).toBeNull();
	});
	it('selective-restart command shape is well-typed', () => {
		// Compile-time check: the union accepts selective-restart with a
		// branded pluginKey. The current keymap keeps restart stack-wide.
		const cmd: EngineCommand = {
			tag: 'selective-restart.requested',
			pluginKey: pluginKey('sui'),
		};
		expect(cmd.tag).toBe('selective-restart.requested');
	});
});
