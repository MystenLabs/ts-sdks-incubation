// Smoke coverage for the `prune` CLI surface.
//
// Two layers:
//   1. Pure helpers — `selectableKeys` from the Ink component module —
//      so the "select all orphans" path doesn't quietly include a
//      running supervisor's row.
//   2. Ink picker — render with `ink-testing-library`, drive a few
//      keystrokes, assert the rendered frame surfaces the right
//      selection state. Mirrors the pattern in `tui/components.test.tsx`.

import { describe, expect, it } from 'vitest';
import { render as inkRender } from 'ink-testing-library';
import React from 'react';
import { PruneApp, selectableKeys } from './_prune-ui.js';
import type { InventoryRow } from '../../internal/docker/inventory.js';

const row = (overrides: Partial<InventoryRow> = {}): InventoryRow => ({
	app: 'arena',
	stack: 'main',
	containers: [],
	networks: [],
	volumes: [],
	stateDirs: [],
	runningPid: undefined,
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
	const flush = (ms = 20): Promise<void> =>
		new Promise((resolve) => setTimeout(resolve, ms));

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
		await flush();
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
		await flush();
		// space: toggle, then \r (Enter) to open confirm.
		stdin.write(' ');
		await flush();
		stdin.write('\r');
		await flush();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('About to remove');
		expect(frame).toContain('Proceed?');
		unmount();
	});

	it('calls onQuit when q is pressed and never invokes onSubmit', async () => {
		let submits = 0;
		let quits = 0;
		const { stdin, unmount } = inkRender(
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
		await flush();
		stdin.write('q');
		await flush();
		expect(quits).toBe(1);
		expect(submits).toBe(0);
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
		await flush();
		stdin.write('\r');
		await flush();
		const frame = lastFrame() ?? '';
		expect(frame).not.toContain('About to remove');
		expect(frame).toContain('[space] toggle');
		unmount();
	});
});
