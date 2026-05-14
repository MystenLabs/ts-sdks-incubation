import { describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import { BuildError } from '../engine/build.js';
import type { AnyNodeImpl } from '../engine/types.js';
import { defineSchema } from './define-schema.js';
import { dep } from './dep.js';

describe('defineSchema', () => {
	const env = { appName: 'test', appDir: '/tmp/schema-test', network: 'localnet' };

	const sui = defineSchema({
		id: 'sui',
		provides: {
			rpc: dep((s: { rpcUrl: string }) => ({ url: s.rpcUrl })),
		},
		create: ({ network }: { network: string }) => ({
			name: `sui.${network}`,
			start: async () => ({ rpcUrl: `http://localhost/${network}` }),
		}),
	});

	it('exposes a stable __id symbol per schema', () => {
		expect(typeof sui.__id).toBe('symbol');
		expect(sui.__id.description).toBe('sui');
	});

	it('static get() returns Deps with __pluginId and no __producer', () => {
		const d = sui.get('rpc');
		expect(d.__pluginId).toBe(sui.__id);
		expect(d.__producer).toBeUndefined();
		expect(d.type).toBe('rpc');
	});

	it('create(config) returns a Producer carrying both __id and __pluginId', () => {
		const inst = sui.create({ network: 'localnet' });
		expect(inst.name).toBe('sui.localnet');
		expect(inst.__pluginId).toBe(sui.__id);
		expect(inst.__id).not.toBe(sui.__id); // __id is fresh per instance
	});

	it('produces fresh __id per create() call so two instances are distinct', () => {
		const a = sui.create({ network: 'localnet' });
		const b = sui.create({ network: 'testnet' });
		expect(a.__id).not.toBe(b.__id);
		expect(a.__pluginId).toBe(b.__pluginId);
	});

	it('instance get() returns Deps with __producer, not __pluginId', () => {
		const inst = sui.create({ network: 'localnet' });
		const d = inst.get('rpc');
		expect(d.__producer).toBe(inst);
		expect(d.__pluginId).toBeUndefined();
	});

	// Runtime validation tests: TS forbids omitting `name` or lifecycle hooks
	// at compile time, so we cast the schema definition to bypass the check
	// and verify the runtime guard fires. Explicit generics on defineSchema
	// keep TState inference clean despite the `any` return.
	const xRecipe = dep((s: { v: number }) => s.v);
	type XProvides = { x: typeof xRecipe };

	it('throws if create returns a config without name', () => {
		const broken = defineSchema<undefined, { v: number }, XProvides>({
			id: 'broken',
			provides: { x: xRecipe },
			create: (): any => ({ start: async () => ({ v: 1 }) }),
		});

		expect(() => broken.create(undefined)).toThrow(/must include `name`/);
	});

	it('throws if create returns a config without start or run', () => {
		const broken = defineSchema<undefined, { v: number }, XProvides>({
			id: 'lifecycle-missing',
			provides: { x: xRecipe },
			create: (): any => ({ name: 'oops' }),
		});

		expect(() => broken.create(undefined)).toThrow(/at least one of start, run/);
	});

	it('static get() throws for keys not in the schema provides', () => {
		const get = sui.get as unknown as (k: string) => unknown;
		expect(() => get('unknown')).toThrow(/does not provide "unknown"/);
	});

	it('integrates: a static schema Dep is resolved to the running instance at graph build', async () => {
		// Consumer references `sui.get('rpc')` *statically* — engine resolves
		// it to the running instance at graph build by matching __pluginId.
		let observed: { url: string } | undefined;
		const consumer = {
			__id: Symbol('consumer'),
			name: 'consumer',
			deps: { rpc: sui.get('rpc') },
			run: async ({ deps }: { deps: { rpc: { url: string } } }) => {
				observed = deps.rpc;
				return undefined;
			},
			get: () => {
				throw new Error('consumer is a leaf');
			},
		} as unknown as AnyNodeImpl;

		const inst = sui.create({ network: 'localnet' });
		const engine = new Engine({ stack: [inst, consumer] }, { env });
		await engine.runOnce();
		expect(observed).toEqual({ url: 'http://localhost/localnet' });
	});

	it('build errors when a static schema Dep has no matching instance in the stack', () => {
		const consumer = {
			__id: Symbol('consumer'),
			name: 'consumer',
			deps: { rpc: sui.get('rpc') },
			run: async () => undefined,
			get: () => {
				throw new Error('consumer is a leaf');
			},
		} as unknown as AnyNodeImpl;

		expect(() => new Engine({ stack: [consumer] }, { env })).toThrow(BuildError);
	});

	it('build errors when two instances of the same schema are in the stack', () => {
		const a = sui.create({ network: 'localnet' });
		const b = sui.create({ network: 'testnet' });
		const consumer = {
			__id: Symbol('consumer'),
			name: 'consumer',
			deps: { rpc: sui.get('rpc') },
			run: async () => undefined,
			get: () => {
				throw new Error('consumer is a leaf');
			},
		} as unknown as AnyNodeImpl;

		expect(() => new Engine({ stack: [a, b, consumer] }, { env })).toThrow(/two instances/);
	});
});
