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
	topoLevels,
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
		const stack: ReadonlyArray<DepGraphMember> = [{ key: 'foo', __upstreamKeys: ['ghost'] }];
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

describe('topoLevels', () => {
	it('emits leaves at level 0 and consumers at higher levels', () => {
		// fixture: sui ← package ← codegen ← dev. Each level holds exactly one
		// node because the chain is linear.
		const graph = buildDepGraph(fixtureStack);
		const levels = topoLevels(graph);
		expect(levels).toEqual([['sui'], ['package'], ['codegen'], ['dev']]);
	});

	it('groups independent siblings into the same level', () => {
		// Two independent chains share level structure: both leaves at
		// level 0, both consumers at level 1.
		const stack: ReadonlyArray<DepGraphMember> = [
			{ key: 'a1' },
			{ key: 'b1' },
			{ key: 'a2', __upstreamKeys: ['a1'] },
			{ key: 'b2', __upstreamKeys: ['b1'] },
		];
		const graph = buildDepGraph(stack);
		const levels = topoLevels(graph);
		expect(levels).toEqual([
			['a1', 'b1'],
			['a2', 'b2'],
		]);
	});

	it('handles a diamond (consumer waits for both upstreams)', () => {
		// sui ← {walrus, seal} ← dev. Walrus and seal are siblings at
		// level 1, dev sits at level 2.
		const stack: ReadonlyArray<DepGraphMember> = [
			{ key: 'sui' },
			{ key: 'walrus', __upstreamKeys: ['sui'] },
			{ key: 'seal', __upstreamKeys: ['sui'] },
			{ key: 'dev', __upstreamKeys: ['walrus', 'seal'] },
		];
		const graph = buildDepGraph(stack);
		const levels = topoLevels(graph);
		expect(levels).toEqual([['sui'], ['walrus', 'seal'], ['dev']]);
	});

	it('preserves input order within a level (stable per-level emission)', () => {
		// Three leaves declared in a specific order — the per-level
		// emission must respect that order so the TUI surfaces siblings
		// in the user's authored sequence.
		const stack: ReadonlyArray<DepGraphMember> = [
			{ key: 'gamma' },
			{ key: 'alpha' },
			{ key: 'beta' },
		];
		const graph = buildDepGraph(stack);
		const levels = topoLevels(graph);
		expect(levels).toEqual([['gamma', 'alpha', 'beta']]);
	});

	it('returns an empty array for an empty graph', () => {
		const graph = buildDepGraph([]);
		expect(topoLevels(graph)).toEqual([]);
	});

	it('treats undeclared upstreams as leaves (missing __upstreamKeys)', () => {
		// A primitive that omits `__upstreamKeys` ends up with an empty
		// upstream set (see buildDepGraph). Phase B's scheduler treats
		// these as leaves; if they actually yield* a service from a
		// non-leaf, Effect's MemoMap still resolves the dep via the
		// surrounding `Layer.mergeAll` — they just lose the topo
		// optimisation. The invariant: the level emission doesn't choke.
		const stack: ReadonlyArray<DepGraphMember> = [
			{ key: 'a' }, // no __upstreamKeys → leaf
			{ key: 'b' }, // ditto
			{ key: 'c', __upstreamKeys: ['a'] },
		];
		const graph = buildDepGraph(stack);
		const levels = topoLevels(graph);
		expect(levels).toEqual([['a', 'b'], ['c']]);
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

// -----------------------------------------------------------------------------
// Phase A — `provide()` / `tag()` / plugin-author helpers populate
// `__upstreamKeys` from the `upstreamKeys` option
// -----------------------------------------------------------------------------
//
// These tests close the data-substrate gap §2.2 calls out: no primitive
// populated `__upstreamKeys`. The substrate now resolves
// `LayeredTag | string` entries to their `.key` and stamps the result
// onto the returned stack member. `buildDepGraph` then sees a real graph.

describe('Phase A: __upstreamKeys population at factory time', () => {
	it('tag() resolves LayeredTag entries to their .key', async () => {
		const { tag } = await import('../advanced/tag.js');
		const { Effect } = await import('effect');
		const a = tag('a', Effect.succeed(1), { upstreamKeys: [] });
		const b = tag('b', Effect.succeed(2), { upstreamKeys: [a] });
		expect(a.__upstreamKeys).toEqual([]);
		expect(b.__upstreamKeys).toEqual(['a']);
	});

	it('tag() accepts bare-string upstream keys (forward-declared deps)', async () => {
		const { tag } = await import('../advanced/tag.js');
		const { Effect } = await import('effect');
		const m = tag('m', Effect.succeed(1), {
			upstreamKeys: ['@devstack/SuiTag', '@devstack/FaucetTag'],
		});
		expect(m.__upstreamKeys).toEqual(['@devstack/SuiTag', '@devstack/FaucetTag']);
	});

	it('tag() dedupes upstream keys (composite + bare-string overlap)', async () => {
		const { tag } = await import('../advanced/tag.js');
		const { Effect } = await import('effect');
		const sui = tag('@devstack/SuiTag' as const, Effect.succeed(1), { upstreamKeys: [] });
		const m = tag('m', Effect.succeed(1), { upstreamKeys: [sui, '@devstack/SuiTag', sui] });
		expect(m.__upstreamKeys).toEqual(['@devstack/SuiTag']);
	});

	it('hostScript auto-derives __upstreamKeys from dependsOn', async () => {
		const { hostScript } = await import('../advanced/plugin-author/host-script.js');
		const { tag } = await import('../advanced/tag.js');
		const { Effect } = await import('effect');
		const upstream = tag('up', Effect.succeed('x'), { upstreamKeys: [] });
		const hs = hostScript({
			name: 'hs',
			command: 'true',
			dependsOn: [upstream],
		});
		expect(hs.__upstreamKeys).toEqual(['up']);
	});

	it('hostScript declares empty __upstreamKeys when no dependsOn is set', async () => {
		const { hostScript } = await import('../advanced/plugin-author/host-script.js');
		const hs = hostScript({ name: 'hs', command: 'true' });
		expect(hs.__upstreamKeys).toEqual([]);
	});

	it('dockerOneShot auto-derives __upstreamKeys from dependsOn', async () => {
		const { dockerOneShot } = await import('../advanced/plugin-author/docker-one-shot.js');
		const { tag } = await import('../advanced/tag.js');
		const { Effect } = await import('effect');
		const a = tag('a', Effect.succeed(1), { upstreamKeys: [] });
		const b = tag('b', Effect.succeed(2), { upstreamKeys: [] });
		const job = dockerOneShot({
			name: 'job',
			image: 'busybox:1.36',
			dependsOn: [a, b],
		});
		expect(job.__upstreamKeys).toEqual(['a', 'b']);
	});

	it('dockerOneShot declares empty __upstreamKeys when no dependsOn is set', async () => {
		const { dockerOneShot } = await import('../advanced/plugin-author/docker-one-shot.js');
		const job = dockerOneShot({ name: 'job', image: 'busybox:1.36' });
		expect(job.__upstreamKeys).toEqual([]);
	});

	it('dockerContainer declares its inner image tag as an upstream', async () => {
		const { dockerContainer } = await import('../advanced/plugin-author/docker-container.js');
		const t = dockerContainer('svc', { image: { pull: 'busybox:1.36' } });
		// `dockerContainer` creates a sibling `dockerImage` tag named
		// `<name>.image` and surfaces it as an upstream. The container's
		// `yield* imageTag` inside the build body is the actual edge.
		expect(t.__upstreamKeys).toEqual(['svc.image']);
	});

	it('dockerContainer with {tag: ...} surfaces no inner image upstream', async () => {
		const { dockerContainer } = await import('../advanced/plugin-author/docker-container.js');
		// `{tag}` means a sibling `dockerImage(...)` already materialized
		// the image; the caller owns the upstream wiring themselves so
		// `dockerContainer` declares no inner-image upstream.
		const t = dockerContainer('svc', { image: { tag: 'devstack-svc:abc' } as never });
		expect(t.__upstreamKeys).toEqual([]);
	});

	it('gitFetch declares no upstream keys (leaf primitive)', async () => {
		const { gitFetch } = await import('../advanced/plugin-author/git-fetch.js');
		const g = gitFetch({ name: 'src', repo: 'https://example.com/r.git', ref: 'v1' });
		expect(g.__upstreamKeys).toEqual([]);
	});

	it('dockerImage declares no upstream keys (leaf primitive)', async () => {
		const { dockerImage } = await import('../advanced/plugin-author/docker-image.js');
		const img = dockerImage({ name: 'i', pull: 'busybox:1.36' });
		expect(img.__upstreamKeys).toEqual([]);
	});

	it('buildDepGraph + computeDownstreamClosure read the populated field', async () => {
		// End-to-end check: tag() + plugin-author helpers populate the
		// field, and `buildDepGraph` consumes it as expected.
		const { tag } = await import('../advanced/tag.js');
		const { hostScript } = await import('../advanced/plugin-author/host-script.js');
		const { Effect } = await import('effect');

		const sui = tag('@devstack/SuiTag' as const, Effect.succeed({}), { upstreamKeys: [] });
		const faucet = tag('@devstack/FaucetTag' as const, Effect.succeed({}), { upstreamKeys: [sui] });
		const job = hostScript({ name: 'seed', command: 'true', dependsOn: [sui, faucet] });

		const stack = [sui, faucet, job];
		const graph = buildDepGraph(stack);
		expect(graph.get('@devstack/SuiTag')?.upstreamKeys).toEqual([]);
		expect(graph.get('@devstack/FaucetTag')?.upstreamKeys).toEqual(['@devstack/SuiTag']);
		expect(graph.get('seed')?.upstreamKeys).toEqual(['@devstack/SuiTag', '@devstack/FaucetTag']);

		const closure = computeDownstreamClosure(graph);
		expect(closure.get('@devstack/SuiTag')).toEqual(new Set(['@devstack/FaucetTag', 'seed']));
		expect(closure.get('@devstack/FaucetTag')).toEqual(new Set(['seed']));
		expect(closure.get('seed')).toEqual(new Set());
	});
});
