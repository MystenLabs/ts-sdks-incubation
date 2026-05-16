// Pure-helper coverage for the inventory module. The Effect-shaped
// docker enumeration is exercised indirectly via the CLI tests + the
// `pnpm dev` smoke loop; here we focus on the parsers + formatters
// since they're the bits most likely to drift when docker's `--format`
// output changes.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	computeClassification,
	formatBytes,
	parseSize,
	renderInventoryRow,
	renderTotals,
	shortRepoPath,
	summarizeContainers,
	totalsFor,
	volumeBytes,
	type InventoryRow,
} from './inventory.js';
import type { RegistryEntry } from '../registry.js';

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

describe('shortRepoPath', () => {
	it('returns an em-dash for missing/empty input', () => {
		expect(shortRepoPath(undefined)).toBe('—');
		expect(shortRepoPath('')).toBe('—');
	});
	it('returns the full path when it splits to ≤ 2 segments', () => {
		expect(shortRepoPath('foo/bar')).toBe('foo/bar');
		expect(shortRepoPath('foo')).toBe('foo');
	});
	it('keeps only the last two segments for deeper paths', () => {
		expect(shortRepoPath('/Users/me/code/repo/examples/wallet')).toBe('…/examples/wallet');
		// Leading `/` produces an empty first segment, so anything
		// rooted at `/` collapses to its last two segments.
		expect(shortRepoPath('/foo/bar')).toBe('…/foo/bar');
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

	it('flags repo-gone rows inline', () => {
		const rendered = renderInventoryRow(
			row({
				classification: 'repo-gone',
				registryEntry: {
					app: 'arena',
					stack: 'main',
					network: 'localnet',
					repoPath: '/never/exists',
					firstSeen: '2026-01-01T00:00:00.000Z',
					lastSeen: '2026-04-01T00:00:00.000Z',
				},
			}),
		);
		expect(rendered).toContain('[repo gone]');
		expect(rendered).toContain('…/never/exists');
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

// ---------------------------------------------------------------------------
// computeClassification — three-way row state used by picker + doctor
// ---------------------------------------------------------------------------

const regEntry = (overrides: Partial<RegistryEntry> = {}): RegistryEntry => ({
	app: 'arena',
	stack: 'main',
	network: 'localnet',
	repoPath: '/never-exists-' + Math.random(),
	firstSeen: '2026-01-01T00:00:00.000Z',
	lastSeen: '2026-04-30T00:00:00.000Z',
	...overrides,
});

describe('computeClassification', () => {
	it("returns 'idle' for a registry-less row with no running pid", () => {
		expect(computeClassification({ entry: undefined, runningPid: undefined })).toBe('idle');
	});

	it("returns 'running' for a row with a live runningPid (regardless of registry)", () => {
		// process.pid is always alive while the test runs.
		expect(computeClassification({ entry: undefined, runningPid: process.pid })).toBe('running');
		expect(computeClassification({ entry: regEntry(), runningPid: process.pid })).toBe('running');
	});

	it("returns 'repo-gone' when the registry has an entry and the repoPath does not exist", () => {
		expect(
			computeClassification({
				entry: regEntry({ repoPath: '/this/path/will/never/exist/devstack-test' }),
				runningPid: undefined,
			}),
		).toBe('repo-gone');
	});

	it("returns 'idle' when the registry entry's repoPath does exist on disk", () => {
		const dir = mkdtempSync(joinPath(tmpdir(), 'devstack-inventory-test-'));
		try {
			mkdirSync(dir, { recursive: true });
			const out = computeClassification({
				entry: regEntry({ repoPath: dir }),
				runningPid: undefined,
			});
			expect(out).toBe('idle');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
