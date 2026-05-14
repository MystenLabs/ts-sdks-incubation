// Pure-helper coverage for the inventory module. The Effect-shaped
// docker enumeration is exercised indirectly via the CLI tests + the
// `pnpm dev` smoke loop; here we focus on the parsers + formatters
// since they're the bits most likely to drift when docker's `--format`
// output changes.

import { describe, expect, it } from 'vitest';
import {
	formatBytes,
	parseSize,
	renderInventoryRow,
	renderTotals,
	summarizeContainers,
	totalsFor,
	volumeBytes,
	type InventoryRow,
} from './inventory.js';

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

describe('parseSize', () => {
	it.each([
		['0B', 0],
		['12.4MB', 12_400_000],
		['1.234GB', 1_234_000_000],
		['100B', 100],
		['2.5kB', 2_500],
	])('parses %s', (input, expected) => {
		const v = parseSize(input);
		expect(v).toBeCloseTo(expected, 0);
	});

	it('parses binary units (MiB)', () => {
		const v = parseSize('1MiB');
		expect(v).toBe(1024 * 1024);
	});

	it('returns undefined for nonsense input', () => {
		expect(parseSize('garbage')).toBeUndefined();
		expect(parseSize('')).toBeUndefined();
	});
});

describe('formatBytes', () => {
	it.each([
		[0, '0 B'],
		[500, '500 B'],
		[2_500, '2.5 KB'],
		[12_400_000, '12.4 MB'],
		[1_234_000_000, '1.2 GB'],
	])('formats %d as %s', (input, expected) => {
		expect(formatBytes(input)).toBe(expected);
	});
});

describe('summarizeContainers', () => {
	it('reports zero containers explicitly', () => {
		expect(summarizeContainers(row())).toBe('0 containers');
	});
	it('reports mixed running/stopped', () => {
		expect(
			summarizeContainers(
				row({
					containers: [
						{ id: 'a', name: 'a', status: 'Up 1m', running: true },
						{ id: 'b', name: 'b', status: 'Exited (0)', running: false },
					],
				}),
			),
		).toBe('1 running, 1 stopped');
	});
	it('reports all-stopped specifically', () => {
		expect(
			summarizeContainers(
				row({
					containers: [
						{ id: 'a', name: 'a', status: 'Exited', running: false },
						{ id: 'b', name: 'b', status: 'Exited', running: false },
					],
				}),
			),
		).toBe('0 containers (2 stopped)');
	});
});

describe('renderInventoryRow', () => {
	it('renders the canonical row format', () => {
		const r = row({
			containers: [
				{ id: 'a', name: 'a', status: 'Up', running: true },
				{ id: 'b', name: 'b', status: 'Exited', running: false },
			],
			networks: [{ id: 'n', name: 'net' }],
			volumes: [{ name: 'v', sizeBytes: 1_234_000_000 }],
			stateDirs: ['/tmp/foo/.devstack/stacks/main'],
		});
		const rendered = renderInventoryRow(r);
		expect(rendered).toContain('arena / main');
		expect(rendered).toContain('1 running, 1 stopped');
		expect(rendered).toContain('1 network');
		expect(rendered).toContain('1 volume');
		expect(rendered).toContain('1.2 GB');
		expect(rendered).toContain('state present');
	});

	it('marks the row as running when runningPid is set', () => {
		const rendered = renderInventoryRow(row({ runningPid: 12345 }));
		expect(rendered).toContain('← running');
	});

	it("emits 'no state' when stateDirs is empty", () => {
		const rendered = renderInventoryRow(row());
		expect(rendered).toContain('no state');
	});
});

describe('totalsFor / renderTotals', () => {
	it('aggregates across rows and dedups apps', () => {
		const rows: ReadonlyArray<InventoryRow> = [
			row({
				app: 'arena',
				stack: 'main',
				containers: [{ id: 'a', name: 'a', status: 'Up', running: true }],
				volumes: [{ name: 'v', sizeBytes: 1_000_000 }],
			}),
			row({
				app: 'arena',
				stack: 'test',
				containers: [{ id: 'b', name: 'b', status: 'Up', running: true }],
				networks: [{ id: 'n', name: 'n' }],
				volumes: [{ name: 'w', sizeBytes: 2_000_000 }],
			}),
			row({
				app: 'wallet',
				stack: 'main',
				stateDirs: ['/dir/.devstack/stacks/main'],
			}),
		];
		const totals = totalsFor(rows);
		expect(totals.apps).toBe(2);
		expect(totals.stacks).toBe(3);
		expect(totals.containers).toBe(2);
		expect(totals.networks).toBe(1);
		expect(totals.volumes).toBe(2);
		expect(totals.bytes).toBe(3_000_000);
		expect(totals.stateDirs).toBe(1);

		const rendered = renderTotals(totals);
		expect(rendered).toContain('2 apps');
		expect(rendered).toContain('3 stacks');
		expect(rendered).toContain('3.0 MB');
	});
});

describe('volumeBytes', () => {
	it('ignores volumes with unknown sizes', () => {
		const total = volumeBytes(
			row({
				volumes: [
					{ name: 'a', sizeBytes: 1_000 },
					{ name: 'b', sizeBytes: undefined },
					{ name: 'c', sizeBytes: 500 },
				],
			}),
		);
		expect(total).toBe(1_500);
	});
});
