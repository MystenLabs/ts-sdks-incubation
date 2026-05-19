// Unit tests for the static dep graph (Phase 1 of selective-restart).
// Synchronous / pure — no Effect, no fixtures, no fs. Each test
// constructs a fixture stack as a plain array of `DepGraphMember` shapes
// and exercises one of the three exported functions:
//
//   - `buildDepGraph`           — node enumeration, watch-path capture,
//                                  upstream filtering, cycle detection.
//   - `computeDownstreamClosure` — reverse-edge BFS produces the
//                                  transitive consumer set per node.
//   - `reachableConsumers`      — convenience accessor; empty set for
//                                  unknown owner keys.

import { describe, expect, it } from '@effect/vitest';
import {
	buildDepGraph,
	computeDownstreamClosure,
	DepGraphError,
	reachableConsumers,
	type DepGraphMember,
} from './dep-graph.js';

// Fixture stack matching the plan's P1 test gate: `sui ← package ← codegen ← dev`.
// Each member declares its direct upstream by key. `sui` is a leaf;
// `dev` is a sink.
const fixtureStack: ReadonlyArray<DepGraphMember> = [
	{ key: 'sui' },
	{ key: 'package', __upstreamKeys: ['sui'] },
	{ key: 'codegen', __upstreamKeys: ['package'] },
	{ key: 'dev', __upstreamKeys: ['codegen'] },
];

describe('buildDepGraph', () => {
	it('derives-static-graph: each node carries the expected upstream keys', () => {
		const graph = buildDepGraph(fixtureStack);
		expect(graph.get('sui')?.upstreamKeys).toEqual([]);
		expect(graph.get('package')?.upstreamKeys).toEqual(['sui']);
		expect(graph.get('codegen')?.upstreamKeys).toEqual(['package']);
		expect(graph.get('dev')?.upstreamKeys).toEqual(['codegen']);
	});

	it('watch-paths-attached: positive includes surface on the node, negations drop', () => {
		const stack: ReadonlyArray<DepGraphMember> = [
			{
				key: 'publish.vault',
				__watchPaths: ['/abs/move/**/*.move', '!**/build/**'],
			},
		];
		const graph = buildDepGraph(stack);
		const node = graph.get('publish.vault');
		expect(node?.watchPaths).toEqual(['/abs/move/**/*.move']);
	});

	it('skips members without a key (hand-rolled layers)', () => {
		const stack: ReadonlyArray<DepGraphMember> = [
			{ key: 'a' },
			{}, // hand-rolled layer escape hatch — no identity to attribute scope to
			{ key: 'b', __upstreamKeys: ['a'] },
		];
		const graph = buildDepGraph(stack);
		expect(graph.size).toBe(2);
		expect(graph.has('a')).toBe(true);
		expect(graph.has('b')).toBe(true);
	});

	it('drops dangling upstream references (stale annotation surface)', () => {
		// A primitive declares a dep on a tag not in this particular
		// stack composition (e.g. a plugin's `dependsOn:` mentions a
		// service the user didn't include). The reference is filtered
		// out rather than turning into a graph that has phantom edges.
		const stack: ReadonlyArray<DepGraphMember> = [
			{ key: 'foo', __upstreamKeys: ['ghost'] },
		];
		const graph = buildDepGraph(stack);
		expect(graph.get('foo')?.upstreamKeys).toEqual([]);
	});

	it('keeps the first occurrence on duplicate keys', () => {
		// Mirrors `composeStackLayer`'s duplicate-key handling (first
		// declaration wins; the supervisor warns separately).
		const stack: ReadonlyArray<DepGraphMember> = [
			{ key: 'dup', __watchPaths: ['/first'] },
			{ key: 'dup', __watchPaths: ['/second'] },
		];
		const graph = buildDepGraph(stack);
		expect(graph.size).toBe(1);
		expect(graph.get('dup')?.watchPaths).toEqual(['/first']);
	});

	it('cycle-detection: a cyclic graph fails with DepGraphError(phase=cycle)', () => {
		// `__upstreamKeys` is plain data — a typo'd annotation could
		// spell a cycle even though Effect's `Layer.provideMerge` fold
		// would reject it at compose time. We detect on the data side
		// so the closure walk can't infinite-loop. The plan flagged
		// this as evaluable-or-skip per the conversion-agent's note;
		// we ship it as an active assertion since `__upstreamKeys` is
		// data and arbitrary annotations CAN form a cycle.
		const stack: ReadonlyArray<DepGraphMember> = [
			{ key: 'a', __upstreamKeys: ['b'] },
			{ key: 'b', __upstreamKeys: ['c'] },
			{ key: 'c', __upstreamKeys: ['a'] },
		];
		expect(() => buildDepGraph(stack)).toThrow(DepGraphError);
		try {
			buildDepGraph(stack);
		} catch (err) {
			const e = err as DepGraphError;
			expect(e.phase).toBe('cycle');
			// The cycle path includes each node from the back-edge's
			// destination, ending at the same node.
			expect(e.cycle.length).toBeGreaterThanOrEqual(2);
			expect(e.cycle[0]).toBe(e.cycle[e.cycle.length - 1]);
		}
	});
});

describe('computeDownstreamClosure', () => {
	it('computes-downstream-closure: closure is strictly-downstream (owner NOT included)', () => {
		// Per the plan's P1.T2 assertion `downstream[dev] = {}` and the
		// P3 prose `owner ∪ downstreamClosure[ownerKey]` — closure
		// values are STRICTLY the transitive consumers of each key,
		// with the key itself excluded.
		const graph = buildDepGraph(fixtureStack);
		const closure = computeDownstreamClosure(graph);
		expect(closure.get('sui')).toEqual(new Set(['package', 'codegen', 'dev']));
		expect(closure.get('package')).toEqual(new Set(['codegen', 'dev']));
		expect(closure.get('codegen')).toEqual(new Set(['dev']));
		expect(closure.get('dev')).toEqual(new Set());
	});

	it('handles a diamond: two consumers share an upstream', () => {
		// sui ← walrus + seal ← dev. A watch-fire on sui invalidates
		// walrus, seal, AND dev transitively — strictly-downstream so
		// `sui` itself is excluded from its closure.
		const stack: ReadonlyArray<DepGraphMember> = [
			{ key: 'sui' },
			{ key: 'walrus', __upstreamKeys: ['sui'] },
			{ key: 'seal', __upstreamKeys: ['sui'] },
			{ key: 'dev', __upstreamKeys: ['walrus', 'seal'] },
		];
		const graph = buildDepGraph(stack);
		const closure = computeDownstreamClosure(graph);
		expect(closure.get('sui')).toEqual(new Set(['walrus', 'seal', 'dev']));
		expect(closure.get('walrus')).toEqual(new Set(['dev']));
		expect(closure.get('seal')).toEqual(new Set(['dev']));
		expect(closure.get('dev')).toEqual(new Set());
	});

	it('isolates independent subgraphs (sibling stacks share nothing)', () => {
		// Two unrelated branches; invalidating one mustn't drag the
		// other in.
		const stack: ReadonlyArray<DepGraphMember> = [
			{ key: 'a1' },
			{ key: 'a2', __upstreamKeys: ['a1'] },
			{ key: 'b1' },
			{ key: 'b2', __upstreamKeys: ['b1'] },
		];
		const graph = buildDepGraph(stack);
		const closure = computeDownstreamClosure(graph);
		expect(closure.get('a1')).toEqual(new Set(['a2']));
		expect(closure.get('b1')).toEqual(new Set(['b2']));
		// And `a1` is NOT in `b1`'s closure (independence).
		expect(closure.get('b1')?.has('a1')).toBe(false);
	});
});

describe('reachableConsumers', () => {
	it('returns the strictly-downstream set for a known owner', () => {
		const graph = buildDepGraph(fixtureStack);
		const closure = computeDownstreamClosure(graph);
		const set = reachableConsumers(closure, 'package');
		expect(set).toEqual(new Set(['codegen', 'dev']));
	});

	it('returns an empty set for an unknown owner key', () => {
		const graph = buildDepGraph(fixtureStack);
		const closure = computeDownstreamClosure(graph);
		const set = reachableConsumers(closure, 'unknown.key');
		expect(set.size).toBe(0);
	});
});
