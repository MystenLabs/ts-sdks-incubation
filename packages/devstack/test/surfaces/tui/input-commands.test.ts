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
import { commandForKey, inputActionForKey } from '../../../src/surfaces/tui/input.tsx';

describe('input → EngineCommand mapping', () => {
	it('q publishes shutdown.requested', () => {
		expect(commandForKey('q', false)).toEqual({ tag: 'shutdown.requested' });
		expect(commandForKey('Q', false)).toEqual({ tag: 'shutdown.requested' });
	});
	it('ctrl-c publishes shutdown.requested', () => {
		expect(commandForKey('c', true)).toEqual({ tag: 'shutdown.requested' });
	});
	it('repeated ctrl-c escalates to hard kill', () => {
		expect(commandForKey('c', true, { shutdownAlreadyRequested: true, now: () => 123 })).toEqual({
			tag: 'shutdown.hardKillRequested',
			signal: 'SIGINT',
			exitCode: 130,
			at: 123,
		});
	});
	it('r publishes stack.restart', () => {
		expect(commandForKey('r', false)).toEqual({ tag: 'stack.restart' });
		expect(commandForKey('R', false)).toEqual({ tag: 'stack.restart' });
	});
	it('s opens the snapshot-name prompt', () => {
		expect(inputActionForKey('s', { ctrl: false })).toEqual({ tag: 'snapshotPrompt.open' });
		expect(inputActionForKey('S', { ctrl: false })).toEqual({ tag: 'snapshotPrompt.open' });
		expect(commandForKey('s', false)).toBeNull();
	});
	it('snapshot prompt submits named captures', () => {
		expect(
			inputActionForKey('', { return: true }, { snapshotPromptValue: 'before-change' }),
		).toEqual({
			tag: 'publish',
			command: { tag: 'snapshot.capture', name: 'before-change' },
		});
	});
	it('snapshot prompt keeps generated names when submitted empty', () => {
		expect(inputActionForKey('', { return: true }, { snapshotPromptValue: '   ' })).toEqual({
			tag: 'publish',
			command: { tag: 'snapshot.capture' },
		});
	});
	it('snapshot prompt edits and cancels without publishing', () => {
		expect(inputActionForKey('abc', {}, { snapshotPromptValue: '' })).toEqual({
			tag: 'snapshotPrompt.update',
			value: 'abc',
		});
		expect(inputActionForKey('', { backspace: true }, { snapshotPromptValue: 'abc' })).toEqual({
			tag: 'snapshotPrompt.update',
			value: 'ab',
		});
		expect(inputActionForKey('', { escape: true }, { snapshotPromptValue: 'abc' })).toEqual({
			tag: 'snapshotPrompt.cancel',
		});
	});
	it('ctrl-c still works while the snapshot prompt is active', () => {
		expect(inputActionForKey('c', { ctrl: true }, { snapshotPromptValue: 'abc' })).toEqual({
			tag: 'publish',
			command: { tag: 'shutdown.requested' },
		});
	});
	it('unmapped keys publish nothing', () => {
		expect(commandForKey('a', false)).toBeNull();
		expect(commandForKey('1', false)).toBeNull();
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
