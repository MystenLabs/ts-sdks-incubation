import { resolve } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { readStackEngine, type Stack } from '../../src/api/define-devstack.ts';
import { makeConfigLoader } from '../../src/cli/wirings/config-loader.ts';
import type { SupervisedStack } from '../../src/substrate/runtime/index.ts';

const fixtureConfig = resolve('test/fixtures/config-loader/devstack.config.ts');

describe('config loader', () => {
	it('preserves the public Stack handle and exposes the validated engine separately', async () => {
		const loaded = await Effect.runPromise(makeConfigLoader().load(fixtureConfig));
		const publicStack = loaded.stack as Stack<SupervisedStack['members']>;
		const engine = loaded.engine as SupervisedStack;

		expect(readStackEngine(publicStack)).toBe(engine);
		expect(() => readStackEngine(engine as unknown as Stack<SupervisedStack['members']>)).toThrow(
			/missing internal engine stack/,
		);
		expect(engine.options.stackName).toBe('config-loader-fixture');
		expect(engine.members.map((member) => member.id)).toEqual(['test/config-loader-leaf']);
	});
});
