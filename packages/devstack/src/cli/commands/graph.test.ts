// Unit tests for `devstack graph`'s three pure renderers (`renderText`,
// `renderMermaid`, `renderDot`). The dynamic-import path that resolves a
// `devstack.config.ts` is exercised through `loaders.test.ts` already;
// here we pin the rendering shape against a synthetic dep graph so a
// future change to the syntax (Mermaid escapes, DOT direction, level
// numbering) is visible in a diff.

import { describe, expect, it } from 'vitest';
import { buildDepGraph, topoLevels, type DepGraph } from '../../engine/dep-graph.js';
import type { StackMember } from '../../engine/supervisor.js';
import { renderDot, renderMermaid, renderText } from './graph.js';

// The renderers read only `key`, `__displayTitle`, `__upstreamKeys`
// off each member. Mint `Partial<StackMember>` records and cast through
// `unknown` rather than inventing a fake `__layer` value just to satisfy
// the public interface.
const fakeMember = (m: Partial<StackMember>): StackMember => m as unknown as StackMember;

// Synthetic stack: a small diamond.
//   sui          (leaf)
//    ↓
//   walrus, seal (siblings — both depend on sui)
//    ↓
//   dev          (depends on both walrus + seal)
const fixture = (): {
	graph: DepGraph;
	memberByKey: ReadonlyMap<string, StackMember>;
} => {
	const stack: ReadonlyArray<StackMember> = [
		fakeMember({ key: '@devstack/SuiTag', __displayTitle: 'sui.localnet' }),
		fakeMember({
			key: '@devstack/WalrusNetworkTag',
			__displayTitle: 'walrus.cluster',
			__upstreamKeys: ['@devstack/SuiTag'],
		}),
		fakeMember({
			key: '@devstack/SealKeyServerTag',
			__displayTitle: 'seal.local',
			__upstreamKeys: ['@devstack/SuiTag'],
		}),
		fakeMember({
			key: 'dev',
			__displayTitle: 'dev.app',
			__upstreamKeys: ['@devstack/WalrusNetworkTag', '@devstack/SealKeyServerTag'],
		}),
	];
	const memberByKey = new Map<string, StackMember>();
	for (const m of stack) memberByKey.set(m.key!, m);
	return { graph: buildDepGraph(stack), memberByKey };
};

describe('graph renderers', () => {
	it('renderText groups members by topological level with friendly titles', () => {
		const { graph, memberByKey } = fixture();
		const levels = topoLevels(graph);
		const out = renderText(graph, levels, memberByKey);
		expect(out).toContain('4 member(s), 3 level(s)');
		// Level 0 = sui (no upstream).
		expect(out).toMatch(/level 0:\s*sui\.localnet/);
		// Level 1 = walrus + seal (siblings).
		expect(out).toMatch(/level 1:\s*walrus\.cluster,\s*seal\.local/);
		// Level 2 = dev (downstream consumer of both).
		expect(out).toMatch(/level 2:\s*dev\.app/);
	});

	it('renderMermaid emits flowchart TD with one edge per upstream', () => {
		const { graph, memberByKey } = fixture();
		const out = renderMermaid(graph, memberByKey);
		expect(out).toMatch(/^flowchart TD/);
		// Each node carries a label.
		expect(out).toContain('"sui.localnet"');
		expect(out).toContain('"walrus.cluster"');
		expect(out).toContain('"seal.local"');
		expect(out).toContain('"dev.app"');
		// Edges (sanitised ids: `@devstack/SuiTag` → `_devstack_SuiTag`).
		expect(out).toContain('_devstack_SuiTag --> _devstack_WalrusNetworkTag');
		expect(out).toContain('_devstack_SuiTag --> _devstack_SealKeyServerTag');
		expect(out).toContain('_devstack_WalrusNetworkTag --> dev');
		expect(out).toContain('_devstack_SealKeyServerTag --> dev');
	});

	it('renderDot emits digraph with LR rankdir + box shape', () => {
		const { graph, memberByKey } = fixture();
		const out = renderDot(graph, memberByKey);
		expect(out).toMatch(/^digraph devstack/);
		expect(out).toContain('rankdir=LR');
		expect(out).toContain('shape=box');
		// Each node carries a label.
		expect(out).toContain('label="sui.localnet"');
		// Edges use `->` (not `-->`).
		expect(out).toContain('_devstack_SuiTag -> _devstack_WalrusNetworkTag;');
		expect(out).toContain('_devstack_WalrusNetworkTag -> dev;');
		// Closing brace.
		expect(out).toMatch(/}\s*$/);
	});

	it('falls back to the key when no displayTitle is set', () => {
		// A primitive without `__displayTitle` should render under its
		// raw key (engine-internal identifier). Mirrors the TUI's
		// fallback behaviour.
		const stack: ReadonlyArray<StackMember> = [
			fakeMember({ key: 'rawkey' }),
			fakeMember({ key: 'consumer', __upstreamKeys: ['rawkey'] }),
		];
		const memberByKey = new Map<string, StackMember>();
		for (const m of stack) memberByKey.set(m.key!, m);
		const graph = buildDepGraph(stack);
		const out = renderText(graph, topoLevels(graph), memberByKey);
		expect(out).toContain('level 0: rawkey');
		expect(out).toContain('level 1: consumer');
	});
});
