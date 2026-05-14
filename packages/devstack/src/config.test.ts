import { describe, expect, it } from 'vitest';
import { defineDevstackConfig } from './config.js';
import { define } from './factories/define.js';

describe('defineDevstackConfig', () => {
	it('returns a fresh stack array (immune to caller mutation)', () => {
		const node = define<{ x: number }>({
			name: 'noop',
			start: async () => ({ x: 1 }),
		});
		const stack = [node];
		const config = defineDevstackConfig({ stack });
		stack.push(node);
		expect(config.stack).toHaveLength(1);
	});

	it('preserves order of producers in the stack', () => {
		const a = define<{ a: number }>({ name: 'a', start: async () => ({ a: 1 }) });
		const b = define<{ b: number }>({ name: 'b', start: async () => ({ b: 1 }) });
		const c = define<{ c: number }>({ name: 'c', start: async () => ({ c: 1 }) });
		const config = defineDevstackConfig({ stack: [a, b, c] });
		expect(config.stack.map((p) => p.name)).toEqual(['a', 'b', 'c']);
	});
});
