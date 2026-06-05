// Falsifiable coverage for `isEngineCommand` — the cross-process
// command-channel boundary validator (`cli/wirings/up.ts` rejects
// untrusted records with it before `handle.runCommand`). The
// `_exhaustive: never` switch only guards against a NEW tag added
// without a case; the SECURITY-RELEVANT logic is the per-tag field
// validation, which this suite drives directly: every variant gets one
// accepting payload AND at least one rejecting payload (missing or
// wrong-typed required field), plus the structural rejections
// (non-object / null / array / unknown tag / non-string tag).
//
// These cases run the real production function — inverting any branch
// (a guard that returns `true` for a tag, or rejects a valid payload)
// flips the corresponding assertion.

import { describe, expect, it } from 'vitest';

import { isEngineCommand } from '../../src/cli/wirings/engine-command.ts';
import { pluginKey } from '../../src/substrate/brand.ts';
import type { EngineCommand } from '../../src/substrate/events.ts';

// Each accepting payload is typed as `EngineCommand` so a future
// type-level change to the command union forces this table to be
// revisited (the guard's whole job is to certify these shapes).
const accepting: ReadonlyArray<{ readonly label: string; readonly value: EngineCommand }> = [
	{ label: 'stack.start', value: { tag: 'stack.start' } },
	{ label: 'stack.stop', value: { tag: 'stack.stop' } },
	{ label: 'stack.restart', value: { tag: 'stack.restart' } },
	{ label: 'codegen.requested', value: { tag: 'codegen.requested' } },
	{ label: 'snapshot.list', value: { tag: 'snapshot.list' } },
	{ label: 'wipe.requested', value: { tag: 'wipe.requested' } },
	{ label: 'prune.requested', value: { tag: 'prune.requested' } },
	{ label: 'shutdown.requested', value: { tag: 'shutdown.requested' } },
	{ label: 'snapshot.restore w/ snapshotId', value: { tag: 'snapshot.restore', snapshotId: 's1' } },
	{ label: 'snapshot.delete w/ snapshotId', value: { tag: 'snapshot.delete', snapshotId: 's1' } },
	{
		label: 'advance-clock.requested w/ toMillis',
		value: { tag: 'advance-clock.requested', toMillis: 1000 },
	},
	{
		label: 'shutdown.hardKillRequested SIGINT',
		value: { tag: 'shutdown.hardKillRequested', signal: 'SIGINT', exitCode: 130, at: 5 },
	},
	{
		label: 'shutdown.hardKillRequested SIGTERM',
		value: { tag: 'shutdown.hardKillRequested', signal: 'SIGTERM', exitCode: 143, at: 5 },
	},
	{
		label: 'selective-restart.requested w/ pluginKey',
		value: { tag: 'selective-restart.requested', pluginKey: pluginKey('sui#0') },
	},
	{ label: 'apply.requested without pluginKey', value: { tag: 'apply.requested' } },
	{
		label: 'apply.requested with pluginKey',
		value: { tag: 'apply.requested', pluginKey: pluginKey('sui#0') },
	},
	{ label: 'snapshot.capture bare', value: { tag: 'snapshot.capture' } },
	{
		label: 'snapshot.capture with snapshotId + name',
		value: { tag: 'snapshot.capture', snapshotId: 's1', name: 'baseline' },
	},
	{
		label: 'snapshot.capture with replacement',
		value: { tag: 'snapshot.capture', name: 'baseline', replaceExisting: true },
	},
];

// Each rejecting payload exercises a field-level guard: a required field
// missing or wrong-typed, or an out-of-set enum value. Typed `unknown`
// because these are exactly the untrusted shapes the boundary must
// refuse — they are NOT valid `EngineCommand`s.
const rejecting: ReadonlyArray<{ readonly label: string; readonly value: unknown }> = [
	// snapshot.restore / delete — snapshotId required + must be a string.
	{ label: 'snapshot.restore missing snapshotId', value: { tag: 'snapshot.restore' } },
	{
		label: 'snapshot.restore non-string snapshotId',
		value: { tag: 'snapshot.restore', snapshotId: 7 },
	},
	{ label: 'snapshot.delete missing snapshotId', value: { tag: 'snapshot.delete' } },
	{
		label: 'snapshot.delete non-string snapshotId',
		value: { tag: 'snapshot.delete', snapshotId: null },
	},
	// advance-clock — toMillis required + numeric.
	{ label: 'advance-clock missing toMillis', value: { tag: 'advance-clock.requested' } },
	{
		label: 'advance-clock string toMillis',
		value: { tag: 'advance-clock.requested', toMillis: '1000' },
	},
	// shutdown.hardKillRequested — signal enum + numeric exitCode/at.
	{
		label: 'hardKill bad signal',
		value: { tag: 'shutdown.hardKillRequested', signal: 'SIGKILL', exitCode: 137, at: 5 },
	},
	{
		label: 'hardKill missing exitCode',
		value: { tag: 'shutdown.hardKillRequested', signal: 'SIGINT', at: 5 },
	},
	{
		label: 'hardKill non-numeric at',
		value: { tag: 'shutdown.hardKillRequested', signal: 'SIGINT', exitCode: 130, at: 'now' },
	},
	// selective-restart — pluginKey required + string.
	{ label: 'selective-restart missing pluginKey', value: { tag: 'selective-restart.requested' } },
	{
		label: 'selective-restart non-string pluginKey',
		value: { tag: 'selective-restart.requested', pluginKey: 42 },
	},
	// apply.requested — pluginKey OPTIONAL but, when present, must be a
	// string (a wrong-typed optional must still be refused).
	{ label: 'apply.requested numeric pluginKey', value: { tag: 'apply.requested', pluginKey: 1 } },
	// snapshot.capture — both fields OPTIONAL but wrong-typed must refuse.
	{
		label: 'snapshot.capture numeric snapshotId',
		value: { tag: 'snapshot.capture', snapshotId: 1 },
	},
	{ label: 'snapshot.capture numeric name', value: { tag: 'snapshot.capture', name: 5 } },
	{
		label: 'snapshot.capture string replaceExisting',
		value: { tag: 'snapshot.capture', replaceExisting: 'true' },
	},
	// Structural rejections.
	{ label: 'null', value: null },
	{ label: 'undefined', value: undefined },
	{ label: 'string', value: 'stack.start' },
	{ label: 'number', value: 42 },
	{ label: 'array', value: [{ tag: 'stack.start' }] },
	{ label: 'empty object', value: {} },
	{ label: 'non-string tag', value: { tag: 123 } },
	{ label: 'unknown tag', value: { tag: 'totally.unknown' } },
];

describe('isEngineCommand', () => {
	for (const { label, value } of accepting) {
		it(`accepts ${label}`, () => {
			expect(isEngineCommand(value)).toBe(true);
		});
	}

	for (const { label, value } of rejecting) {
		it(`rejects ${label}`, () => {
			expect(isEngineCommand(value)).toBe(false);
		});
	}

	it('narrows the type to EngineCommand on the accepting branch', () => {
		const value: unknown = { tag: 'advance-clock.requested', toMillis: 250 };
		if (isEngineCommand(value)) {
			// Type-level proof that the guard narrows: this only compiles
			// because `value` is `EngineCommand` here.
			const cmd: EngineCommand = value;
			expect(cmd.tag).toBe('advance-clock.requested');
		} else {
			throw new Error('expected isEngineCommand to accept a valid advance-clock command');
		}
	});
});
