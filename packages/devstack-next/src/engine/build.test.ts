import { describe, expect, it } from 'vitest';

import { BuildError, buildGraph } from './build.js';
import { dep, makeSchemaDep, mockProducer } from './test-utils.js';

describe('buildGraph', () => {
	it('builds a single-node graph from one producer', () => {
		const a = mockProducer({ name: 'a' });
		const graph = buildGraph({ stack: [a] });
		expect(graph.nodes.size).toBe(1);
		expect(graph.topoOrder).toEqual([a.__id]);
		expect(graph.idByName.get('a')).toBe(a.__id);
	});

	it('pulls a transitively-needed producer into the graph', () => {
		const upstream = mockProducer({ name: 'upstream' });
		const consumer = mockProducer({
			name: 'consumer',
			deps: { up: dep(upstream, 'value') },
		});
		const graph = buildGraph({ stack: [consumer] });
		expect(graph.nodes.size).toBe(2);
		expect(graph.idByName.get('upstream')).toBe(upstream.__id);
		expect(graph.topoOrder.indexOf(upstream.__id)).toBeLessThan(
			graph.topoOrder.indexOf(consumer.__id),
		);
	});

	it('aggregates request payloads per upstream and dep type', () => {
		const upstream = mockProducer({ name: 'upstream' });
		const consumerA = mockProducer({
			name: 'consumer-a',
			deps: { x: dep(upstream, 'signer', { name: 'publisher' }) },
		});
		const consumerB = mockProducer({
			name: 'consumer-b',
			deps: { x: dep(upstream, 'signer', { name: 'minter' }) },
		});
		const graph = buildGraph({ stack: [consumerA, consumerB] });
		const requests = graph.requestsByProducer.get(upstream.__id);
		expect(requests).toBeDefined();
		expect(requests?.get('signer')).toEqual([{ name: 'publisher' }, { name: 'minter' }]);
	});

	it('walks both array-form and object-form deps', () => {
		const x = mockProducer({ name: 'x' });
		const y = mockProducer({ name: 'y' });
		const z = mockProducer({ name: 'z' });
		const arrayConsumer = mockProducer({
			name: 'arr',
			deps: [dep(x, 'a'), dep(y, 'b')],
		});
		const objectConsumer = mockProducer({
			name: 'obj',
			deps: { p: dep(y, 'c'), q: dep(z, 'd') },
		});
		const graph = buildGraph({ stack: [arrayConsumer, objectConsumer] });
		expect([...graph.idByName.keys()].sort()).toEqual(['arr', 'obj', 'x', 'y', 'z']);
	});

	it('resolves __pluginId Deps against schema instances in the stack', () => {
		const pluginId = Symbol('schema-foo');
		const schemaInstance = mockProducer({ name: 'foo.instance', pluginId });
		const consumer = mockProducer({
			name: 'consumer',
			deps: { foo: makeSchemaDep({ pluginId, type: 'rpc' }) },
		});
		const graph = buildGraph({ stack: [schemaInstance, consumer] });
		expect(graph.nodes.size).toBe(2);
		const consumerNode = graph.nodes.get(consumer.__id);
		expect(consumerNode?.edges.has(schemaInstance.__id)).toBe(true);
	});

	it('throws when a __pluginId Dep has no matching schema instance', () => {
		const pluginId = Symbol('schema-missing');
		const consumer = mockProducer({
			name: 'consumer',
			deps: { foo: makeSchemaDep({ pluginId, type: 'rpc' }) },
		});
		expect(() => buildGraph({ stack: [consumer] })).toThrow(BuildError);
	});

	it('throws on duplicate producer name', () => {
		const a = mockProducer({ name: 'dup' });
		const b = mockProducer({ name: 'dup' });
		expect(() => buildGraph({ stack: [a, b] })).toThrow(/duplicate producer name "dup"/);
	});

	it('throws when a producer has neither start nor run', () => {
		const broken: ReturnType<typeof mockProducer> = mockProducer({ name: 'broken' });
		broken.start = undefined;
		broken.run = undefined;
		expect(() => buildGraph({ stack: [broken] })).toThrow(/at least one of start, run/);
	});

	it('throws on cycles in the dependency graph', () => {
		const a = mockProducer({ name: 'a' });
		const b = mockProducer({ name: 'b' });
		a.deps = { b: dep(b, 'value') };
		b.deps = { a: dep(a, 'value') };
		expect(() => buildGraph({ stack: [a] })).toThrow(/cycle detected/);
	});

	it('exposes downstream subtree for cascade computation', () => {
		const root = mockProducer({ name: 'root' });
		const mid = mockProducer({
			name: 'mid',
			deps: { r: dep(root, 'v') },
		});
		const leaf = mockProducer({
			name: 'leaf',
			deps: { m: dep(mid, 'v') },
		});
		const graph = buildGraph({ stack: [leaf] });
		const downstream = graph.downstreamSubtreeOf(root.__id);
		expect(downstream.has(mid.__id)).toBe(true);
		expect(downstream.has(leaf.__id)).toBe(true);
		expect(graph.downstreamSubtreeOf(leaf.__id).size).toBe(0);
	});
});
