// Smoke coverage for the `prune` CLI surface.
//
// Two layers:
//   1. Pure helpers — the "select all orphans" predicate inlined below —
//      so the path doesn't quietly include a running supervisor's row.
//   2. Ink picker — render with `ink-testing-library`, drive a few
//      keystrokes, assert the rendered frame surfaces the right
//      selection state. Mirrors the pattern in `tui/components.test.tsx`.

import { describe, expect, it, vi } from 'vitest';
import { render as inkRender } from 'ink-testing-library';
import React from 'react';
import { PruneApp } from './_prune-ui.js';
import type { InventoryRow } from '../../engine/docker/inventory.js';

// Inline mirror of the selectable-row predicate used by `_prune-ui.tsx`:
// non-running rows are selectable, identified by `<app>/<stack>` keys.
const selectableKeys = (rows: ReadonlyArray<InventoryRow>): ReadonlyArray<string> =>
	rows.filter((r) => r.runningPid === undefined).map((r) => `${r.app}/${r.stack}`);

const row = (overrides: Partial<InventoryRow> = {}): InventoryRow => ({
	app: 'arena',
	stack: 'main',
	containers: [],
	networks: [],
	volumes: [],
	stateDirs: [],
	runningPid: undefined,
	classification: 'idle',
	registryEntry: undefined,
	...overrides,
});

describe('selectableKeys', () => {
	it('omits rows with a live supervisor', () => {
		const rows = [
			row({ app: 'arena', stack: 'main' }),
			row({ app: 'arena', stack: 'test', runningPid: 12345 }),
			row({ app: 'wallet', stack: 'main' }),
		];
		expect(selectableKeys(rows)).toEqual(['arena/main', 'wallet/main']);
	});

	it('returns empty when every row is running', () => {
		const rows = [
			row({ app: 'a', stack: 'main', runningPid: 1 }),
			row({ app: 'b', stack: 'main', runningPid: 2 }),
		];
		expect(selectableKeys(rows)).toEqual([]);
	});
});

describe('PruneApp', () => {
	// Wait until `lastFrame()` reflects an expected state. ink commits
	// renders on `setImmediate` and React batches state updates, so a
	// plain `setTimeout` flush has flaky timing under load — by the time
	// the next stdin.write fires, the previous keystroke's effect may
	// not have re-rendered yet, and the captured state read by `useInput`
	// is stale. Polling via `vi.waitFor` is the deterministic alternative.
	const waitForFrame = (
		lastFrame: () => string | undefined,
		predicate: (frame: string) => boolean,
	): Promise<void> => vi.waitFor(() => expect(predicate(lastFrame() ?? '')).toBe(true));

	it('renders one row per stack and surfaces the running marker', async () => {
		const rows = [
			row({ app: 'arena', stack: 'main' }),
			row({ app: 'arena', stack: 'test', runningPid: 99999 }),
		];
		const { lastFrame, unmount } = inkRender(
			React.createElement(PruneApp, {
				rows,
				onSubmit: () => undefined,
				onQuit: () => undefined,
			}),
		);
		await waitForFrame(lastFrame, (f) => f.includes('[space] toggle'));
		const frame = lastFrame() ?? '';
		expect(frame).toContain('arena/main');
		expect(frame).toContain('arena/test');
		expect(frame).toContain('running pid 99999');
		expect(frame).toContain('[space] toggle');
		unmount();
	});

	it('shows the confirmation prompt after toggle + enter', async () => {
		const rows = [row({ app: 'arena', stack: 'main' })];
		const { lastFrame, stdin, unmount } = inkRender(
			React.createElement(PruneApp, {
				rows,
				onSubmit: () => undefined,
				onQuit: () => undefined,
			}),
		);
		// Wait for the initial commit + useInput effect registration before
		// pumping keystrokes; otherwise the listener can miss the space.
		await waitForFrame(lastFrame, (f) => f.includes('[space] toggle'));
		// space: toggle, then \r (Enter) to open confirm.
		stdin.write(' ');
		// Wait for the toggle to commit so `selected` is non-empty when the
		// Enter handler reads it via `useEffectEvent`. Without this, Enter
		// can see the pre-toggle `selected` (size 0) and silently no-op.
		await waitForFrame(lastFrame, (f) => /\[x\] arena\/main/.test(f));
		stdin.write('\r');
		await waitForFrame(lastFrame, (f) => f.includes('Will remove'));
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Will remove');
		expect(frame).toContain('Proceed?');
		unmount();
	});

	it('calls onQuit when q is pressed and never invokes onSubmit', async () => {
		let submits = 0;
		let quits = 0;
		const { lastFrame, stdin, unmount } = inkRender(
			React.createElement(PruneApp, {
				rows: [row()],
				onSubmit: () => {
					submits += 1;
				},
				onQuit: () => {
					quits += 1;
				},
			}),
		);
		await waitForFrame(lastFrame, (f) => f.includes('[space] toggle'));
		stdin.write('q');
		await vi.waitFor(() => expect(quits).toBe(1));
		expect(submits).toBe(0);
		unmount();
	});

	it('pre-selects repo-gone rows on mount', async () => {
		const rows = [
			row({ app: 'arena', stack: 'main', classification: 'idle' }),
			row({ app: 'arena', stack: 'old', classification: 'repo-gone' }),
			row({ app: 'wallet', stack: 'main', classification: 'repo-gone' }),
		];
		const { lastFrame, unmount } = inkRender(
			React.createElement(PruneApp, {
				rows,
				onSubmit: () => undefined,
				onQuit: () => undefined,
			}),
		);
		await waitForFrame(lastFrame, (f) => f.includes('[repo gone]'));
		const frame = lastFrame() ?? '';
		// The two repo-gone rows render with `[x]`; the idle row with `[ ]`.
		const checked = frame.split('\n').filter((l) => l.includes('[x]')).length;
		expect(checked).toBe(2);
		expect(frame).toContain('[repo gone]');
		unmount();
	});

	it("doesn't open confirm when nothing is selected", async () => {
		const { lastFrame, stdin, unmount } = inkRender(
			React.createElement(PruneApp, {
				rows: [row()],
				onSubmit: () => undefined,
				onQuit: () => undefined,
			}),
		);
		await waitForFrame(lastFrame, (f) => f.includes('[space] toggle'));
		stdin.write('\r');
		// Negative-assertion guard: give ink a tick to potentially (but
		// incorrectly) open the confirm prompt. We can't `waitFor` for
		// nothing to happen, so a short flush is acceptable here.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const frame = lastFrame() ?? '';
		expect(frame).not.toContain('Will remove');
		expect(frame).toContain('[space] toggle');
		unmount();
	});
});
