// LifecycleFact bridge tests.
//
// Architecture invariants under test:
//   1. `factFromEvent` projects lifecycle-shaped `EngineEvent`s to
//      `LifecycleFactDelta`s; non-lifecycle events return `null`.
//   2. `applyLifecycleFact` merges the delta into the row,
//      preserving non-delta fields (the merge-not-replace shape
//      `LifecycleFact` promises).
//   3. `factFromRow` reconstructs the closed `LifecycleFact` slice
//      so diagnostic surfaces can derive the typed fact from a row.
//   4. The projection updater consumes facts — applying a
//      `lifecycle.statusChanged` event mutates the row's `status`
//      AND no other lifecycle field.

import { describe, expect, it } from 'vitest';

import { applyEvent } from '../../../../src/substrate/runtime/projection/index.ts';
import {
	applyLifecycleFact,
	factFromEvent,
	factFromRow,
} from '../../../../src/substrate/runtime/lifecycle/lifecycle-fact.ts';
import { pluginKey } from '../../../../src/substrate/brand.ts';
import type { Row, SubscribableState } from '../../../../src/substrate/projection.ts';

const sampleRow: Row = {
	key: pluginKey('demo'),
	role: 'service',
	status: 'pending',
	phase: null,
	lastError: null,
	logTail: { lines: [], level: 'info', truncated: false },
	endpoints: [],
	selectiveRestartHighlight: false,
};

const emptyState = (): SubscribableState => ({
	identity: { app: 'a', stack: 's', network: 'n' },
	cycle: { id: 0, startedAt: 0, phase: 'booting' },
	rows: [sampleRow],
	endpoints: [],
	accounts: [],
	packages: [],
	errors: [],
	lastEvent: { seq: 0, at: 0 },
	stackBuild: [],
});

describe('factFromEvent', () => {
	it('projects lifecycle.statusChanged into a status delta', () => {
		const fact = factFromEvent({
			tag: 'lifecycle.statusChanged',
			pluginKey: pluginKey('demo'),
			from: 'pending',
			to: 'acquiring',
			at: 1,
		});
		expect(fact).toEqual({ pluginKey: 'demo', delta: { status: 'acquiring' } });
	});

	it('projects lifecycle.phaseSet into a phase delta', () => {
		const fact = factFromEvent({
			tag: 'lifecycle.phaseSet',
			pluginKey: pluginKey('demo'),
			phase: 'rpc-probe',
			at: 1,
		});
		expect(fact).toEqual({ pluginKey: 'demo', delta: { phase: 'rpc-probe' } });
	});

	it('returns null for non-lifecycle events', () => {
		const fact = factFromEvent({
			tag: 'log.appended',
			pluginKey: pluginKey('demo'),
			line: 'x',
			level: 'info',
			at: 1,
		});
		expect(fact).toBeNull();
	});

	it('returns null for stack-targeted restart events', () => {
		const fact = factFromEvent({
			tag: 'restart.requested',
			target: 'stack',
			at: 1,
		});
		expect(fact).toBeNull();
	});
});

describe('applyLifecycleFact', () => {
	it('merges status without touching phase or highlight', () => {
		const out = applyLifecycleFact({ ...sampleRow, phase: 'probing' }, { status: 'ready' });
		expect(out.status).toBe('ready');
		expect(out.phase).toBe('probing');
		expect(out.selectiveRestartHighlight).toBe(false);
	});

	it('reflects a multi-field delta verbatim', () => {
		const out = applyLifecycleFact(sampleRow, {
			status: 'failed',
			phase: 'fork-lock',
			selectiveRestartHighlight: true,
		});
		expect({
			status: out.status,
			phase: out.phase,
			selectiveRestartHighlight: out.selectiveRestartHighlight,
		}).toEqual({ status: 'failed', phase: 'fork-lock', selectiveRestartHighlight: true });
	});
});

describe('factFromRow', () => {
	it('extracts the closed LifecycleFact slice from a row', () => {
		const fact = factFromRow({
			...sampleRow,
			status: 'ready',
			phase: 'running',
			selectiveRestartHighlight: true,
		});
		expect(fact).toEqual({
			status: 'ready',
			phase: 'running',
			selectiveRestartHighlight: true,
		});
	});
});

describe('projection updater consumes facts via the bridge', () => {
	it('lifecycle.statusChanged updates only the row.status field', () => {
		const before = emptyState();
		const after = applyEvent(before, {
			tag: 'lifecycle.statusChanged',
			pluginKey: pluginKey('demo'),
			from: 'pending',
			to: 'acquiring',
			at: 99,
		});
		const row = after.rows.find((r) => r.key === pluginKey('demo'))!;
		expect(row.status).toBe('acquiring');
		// Non-delta fields preserved.
		expect(row.phase).toBe(before.rows[0]!.phase);
		expect(row.selectiveRestartHighlight).toBe(before.rows[0]!.selectiveRestartHighlight);
	});
});
