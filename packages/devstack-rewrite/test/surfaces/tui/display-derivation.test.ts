// Display-derivation tests.
//
// These verify the load-bearing invariants:
//   1. EVERY visible cell is computed from `row.kind` + `row.status`
//      + `row.phase` + `row.lastError` — NOT from any pre-baked
//      `title`/`primary`/`extras` field.
//   2. Status / kind tables are exhaustive (all enum members render).
//   3. Truncation caps fire on overly-long phase / error inputs.
//
// The tests do NOT boot any engine; they call pure functions with
// fabricated `Row` values. This is the "test the renderer against a
// fake projection" pattern from distilled/21-tui § Learnings.

import { describe, expect, it } from 'vitest';

import { endpointKey, pluginKey } from '../../../src/substrate/brand.ts';
import type { LifecycleStatus, PluginKind } from '../../../src/substrate/lifecycle.ts';
import type { Row, StructuredError } from '../../../src/substrate/projection.ts';
import {
	deriveDisplayCells,
	endpointsForRow,
	endpointLine,
	errorSummaryFor,
	groupRows,
	kindGlyph,
	kindLabel,
	kindLabelColor,
	labelForRow,
	narrationFor,
	ownerForRow,
	sectionForRow,
	selectRowKey,
	statusColor,
	statusGlyph,
	statusLabel,
} from '../../../src/surfaces/tui/display-derivation.ts';

const fakeRow = (overrides: Partial<Row> = {}): Row => ({
	key: pluginKey('devstack:sui'),
	kind: 'leaf-long-running',
	status: 'ready',
	phase: null,
	lastError: null,
	logTail: { lines: [], level: 'info', truncated: false },
	endpoints: [],
	compositeChildren: null,
	selectiveRestartHighlight: false,
	narrationByContributor: null,
	rebootCost: null,
	displayHint: undefined,
	...overrides,
});

describe('display-derivation', () => {
	describe('statusGlyph / statusColor', () => {
		const allStatuses: ReadonlyArray<LifecycleStatus> = [
			'pending',
			'acquiring',
			'ready',
			'failed',
			'stopping',
			'stopped',
			'done',
		];
		it('returns a non-empty glyph for every status', () => {
			for (const s of allStatuses) {
				expect(statusGlyph(s).length).toBeGreaterThan(0);
				expect(statusGlyph(s)).not.toBe('?');
			}
		});
		it('returns a color token for every status', () => {
			for (const s of allStatuses) {
				expect(statusColor(s)).not.toBe('white');
			}
		});
		it('statusLabel mirrors the status', () => {
			for (const s of allStatuses) {
				expect(statusLabel(s)).toBe(s);
			}
		});
	});

	describe('kindGlyph / kindLabel / kindLabelColor', () => {
		const allKinds: ReadonlyArray<PluginKind> = [
			'leaf-long-running',
			'leaf-one-shot',
			'composite',
			'hidden-leaf',
			'renderer',
		];
		it('returns a non-empty glyph + label for every kind', () => {
			for (const k of allKinds) {
				expect(kindGlyph(k).length).toBeGreaterThan(0);
				expect(kindGlyph(k)).not.toBe('?');
				expect(kindLabel(k).length).toBeGreaterThan(0);
				expect(kindLabel(k)).not.toBe('unknown');
				expect(kindLabelColor(k)).not.toBe(undefined);
			}
		});
	});

	describe('labelForRow', () => {
		it('strips the devstack: prefix', () => {
			expect(labelForRow('devstack:sui', 'leaf-long-running')).toBe('Sui');
		});
		it('strips the app: prefix', () => {
			expect(labelForRow('app:wallet', 'composite')).toBe('Wallet');
		});
		it('removes internal prefixes and counters', () => {
			expect(labelForRow('account/alice#0', 'leaf-one-shot')).toBe('Alice');
			expect(labelForRow('seal/composite/0', 'composite')).toBe('Composite');
		});
	});

	describe('ownerForRow / sectionForRow', () => {
		it('derives plugin owner chips from row keys', () => {
			expect(ownerForRow('account/alice#0')).toBe('Account');
			expect(ownerForRow('sui.localnet')).toBe('Sui');
		});
		it('groups long-running and endpoint rows as services', () => {
			expect(sectionForRow(fakeRow({ kind: 'leaf-long-running' }))).toBe('service');
			expect(
				sectionForRow(
					fakeRow({
						key: pluginKey('package/connect-four#0'),
						kind: 'leaf-one-shot',
						endpoints: [endpointKey('package/connect-four#0:docs')],
					}),
				),
			).toBe('service');
		});
		it('groups one-shot rows by friendly domain', () => {
			expect(
				sectionForRow(fakeRow({ key: pluginKey('package/connect-four#0'), kind: 'leaf-one-shot' })),
			).toBe('package');
			expect(
				sectionForRow(fakeRow({ key: pluginKey('account/alice#0'), kind: 'leaf-one-shot' })),
			).toBe('account');
			expect(
				sectionForRow(fakeRow({ key: pluginKey('action/mint#0'), kind: 'leaf-one-shot' })),
			).toBe('action');
			expect(
				sectionForRow(fakeRow({ key: pluginKey('app/frontend#0'), kind: 'leaf-one-shot' })),
			).toBe('app');
		});
	});

	describe('narrationFor', () => {
		it('returns empty for null phase on non-acquiring statuses', () => {
			expect(narrationFor(null, 'ready')).toBe('');
			expect(narrationFor(null, 'stopped')).toBe('');
		});
		it('returns "starting…" for null phase on acquiring', () => {
			expect(narrationFor(null, 'acquiring')).toBe('starting…');
		});
		it('truncates long narrations', () => {
			const long = 'x'.repeat(200);
			const out = narrationFor(long, 'acquiring');
			expect(out.length).toBeLessThanOrEqual(80);
			expect(out.endsWith('…')).toBe(true);
		});
		it('preserves short narrations verbatim', () => {
			expect(narrationFor('waiting for chain', 'acquiring')).toBe('waiting for chain');
		});
	});

	describe('errorSummaryFor', () => {
		const fakeErr = (summary: string): StructuredError => ({
			at: 0,
			pluginKey: null,
			tag: 'BootError',
			summary,
			chain: [],
			severity: 'error',
		});
		it('returns empty for null', () => {
			expect(errorSummaryFor(null)).toBe('');
		});
		it('renders tag + summary', () => {
			expect(errorSummaryFor(fakeErr('docker exited 1'))).toBe('BootError: docker exited 1');
		});
		it('truncates over 120 chars', () => {
			const long = 'x'.repeat(300);
			const out = errorSummaryFor(fakeErr(long));
			expect(out.length).toBeLessThanOrEqual(120);
			expect(out.endsWith('…')).toBe(true);
		});
	});

	describe('endpointLine', () => {
		it('prefers displayUrl over url', () => {
			expect(
				endpointLine({
					endpointKey: endpointKey('e1'),
					name: 'gql',
					url: 'http://localhost:9000',
					displayUrl: 'https://devstack.local/gql',
					wireProtocol: 'http',
					registeredAt: 0,
				}),
			).toBe('gql: https://devstack.local/gql');
		});
		it('falls back to url when displayUrl is null', () => {
			expect(
				endpointLine({
					endpointKey: endpointKey('e2'),
					name: 'rpc',
					url: 'http://localhost:9001',
					displayUrl: null,
					wireProtocol: 'http',
					registeredAt: 0,
				}),
			).toBe('rpc: http://localhost:9001');
		});
	});

	describe('row endpoints and grouping', () => {
		const endpoint = {
			endpointKey: endpointKey('sui:rpc'),
			name: 'rpc',
			url: 'http://localhost:9000',
			displayUrl: null,
			wireProtocol: 'http',
			registeredAt: 0,
		};

		it('selects endpoints owned by a row', () => {
			const row = fakeRow({ key: pluginKey('sui'), endpoints: [endpoint.endpointKey] });
			expect(endpointsForRow(row, [endpoint])).toEqual([endpoint]);
		});

		it('groups rows in operator scan order', () => {
			const sections = groupRows([
				fakeRow({ key: pluginKey('action/mint#0'), kind: 'leaf-one-shot' }),
				fakeRow({ key: pluginKey('account/alice#0'), kind: 'leaf-one-shot' }),
				fakeRow({ key: pluginKey('sui'), kind: 'leaf-long-running' }),
			]);
			expect(sections.map((section) => section.key)).toEqual(['service', 'account', 'action']);
		});
	});

	describe('selection', () => {
		const rows = [
			fakeRow({ key: pluginKey('sui') }),
			fakeRow({ key: pluginKey('account/alice#0') }),
			fakeRow({ key: pluginKey('action/mint#0') }),
		];

		it('moves focus cyclically', () => {
			expect(selectRowKey(rows, null, 1)).toBe('sui');
			expect(selectRowKey(rows, 'sui', 1)).toBe('account/alice#0');
			expect(selectRowKey(rows, 'sui', -1)).toBe('action/mint#0');
		});
	});

	describe('deriveDisplayCells', () => {
		it('produces every cell from row.kind/status/phase/lastError', () => {
			const row = fakeRow({
				kind: 'leaf-long-running',
				status: 'acquiring',
				phase: 'pulling image',
			});
			const cells = deriveDisplayCells(row);
			expect(cells.statusGlyph).toBe(statusGlyph('acquiring'));
			expect(cells.statusColor).toBe(statusColor('acquiring'));
			expect(cells.statusLabel).toBe('acquiring');
			expect(cells.kindGlyph).toBe(kindGlyph('leaf-long-running'));
			expect(cells.kindLabel).toBe('service');
			expect(cells.label).toBe('Sui');
			expect(cells.narration).toBe('pulling image');
			expect(cells.errorSummary).toBe('');
			expect(cells.section).toBe('service');
			expect(cells.owner).toBe('Sui');
		});
		it('renders error summary on failed row', () => {
			const row = fakeRow({
				status: 'failed',
				lastError: {
					at: 0,
					pluginKey: null,
					tag: 'BootError',
					summary: 'docker daemon unreachable',
					chain: [],
					severity: 'error',
				},
			});
			const cells = deriveDisplayCells(row);
			expect(cells.errorSummary).toContain('BootError');
			expect(cells.errorSummary).toContain('docker daemon unreachable');
		});
	});
});
