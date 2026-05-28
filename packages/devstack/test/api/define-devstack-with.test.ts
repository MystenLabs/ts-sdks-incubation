// `defineDevstackWith` — callback-form composer invariants.
//
// The flat-form composer is exercised by `define-devstack.test.ts`. The
// callback form's contract surface is:
//
//   1. Runtime: the returned value carries the same `Stack` brand
//      (`_tag: 'Stack'`) as `defineDevstack`.
//   2. Compile-time: the `BuildCtx<Mode>.network` narrows by `Mode`
//      generic, so factories that only accept `local` reject when the
//      mode is `'fork'` (mirrors the typecheck fixture at
//      `test/fixtures/typecheck/complex.ts:59,29`).
//   3. Runtime: the defensive non-plugin-member rejection at
//      `src/api/define-devstack-with.ts:76` throws when the builder
//      returns something that's not branded with `isPlugin` (the
//      compile-time check would normally catch this, but the runtime
//      gate guards against `as unknown as AnyPlugin` casts).

import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import { defineDevstackWith } from '../../src/api/define-devstack-with.ts';
import { defineDevstack, readStackEngine } from '../../src/api/define-devstack.ts';
import { definePlugin } from '../../src/api/define-plugin.ts';
import { chainId } from '../../src/substrate/brand.ts';
import type { NetworkConfig } from '../../src/substrate/network.ts';

// --- Fixtures -----------------------------------------------------------

const leaf = definePlugin({
	id: 'test/with-leaf',
	role: 'service',
	section: 'service',
	start: () => Effect.succeed({ ok: true } as const),
});

const localNetwork: NetworkConfig<'local'> = {
	mode: 'local',
	chain: chainId('demo:local'),
};
const forkNetwork: NetworkConfig<'fork'> = {
	mode: 'fork',
	chain: chainId('demo:fork@1'),
	checkpoint: '1',
};

describe('api/define-devstack-with', () => {
	it('returns a value branded with the same `Stack` shape as defineDevstack', () => {
		const stack = defineDevstackWith(
			{ network: localNetwork, stackName: 'with-brand' },
			() => [leaf] as const,
		);
		// The compile-time brand checks at the readStackEngine boundary —
		// if the callback form returned a different shape, this would throw.
		const engine = readStackEngine(stack);
		expect(engine._tag).toBe('Stack');
		expect(engine.members).toHaveLength(1);
		expect(engine.members[0]?.id).toBe('test/with-leaf');
		expect(engine.options.stackName).toBe('with-brand');
	});

	it('BuildCtx.network narrows by Mode — local-mode context carries the local NetworkConfig', () => {
		let observedMode: string | null = null;
		const stack = defineDevstackWith(
			{ network: localNetwork, stackName: 'with-local' },
			(ctx) => {
				// Runtime confirmation of narrowing — the compile-time test
				// fixture at `test/fixtures/typecheck/complex.ts` pins the
				// type-level half (mode-incompatible factory access fails).
				observedMode = ctx.network.mode;
				return [leaf] as const;
			},
		);
		expect(observedMode).toBe('local');
		expect(readStackEngine(stack).members).toHaveLength(1);
	});

	it('BuildCtx.network narrows by Mode — fork-mode context carries the fork NetworkConfig', () => {
		let observedMode: string | null = null;
		let observedCheckpoint: string | undefined;
		const stack = defineDevstackWith(
			{ network: forkNetwork, stackName: 'with-fork' },
			(ctx) => {
				observedMode = ctx.network.mode;
				if (ctx.network.mode === 'fork') {
					observedCheckpoint = ctx.network.checkpoint;
				}
				return [leaf] as const;
			},
		);
		expect(observedMode).toBe('fork');
		expect(observedCheckpoint).toBe('1');
		expect(readStackEngine(stack).members).toHaveLength(1);
	});

	it('forwards options (stackName + network) into the composed stack', () => {
		const stack = defineDevstackWith(
			{ network: localNetwork, stackName: 'with-options' },
			() => [leaf] as const,
		);
		const engine = readStackEngine(stack);
		expect(engine.options.stackName).toBe('with-options');
		expect(engine.options.network).toEqual(localNetwork);
	});

	it('produces the same engine shape as the equivalent flat-form defineDevstack call', () => {
		const viaCallback = defineDevstackWith(
			{ network: localNetwork, stackName: 'parity' },
			() => [leaf] as const,
		);
		const viaFlat = defineDevstack({
			members: [leaf],
			network: localNetwork,
			stackName: 'parity',
		});
		const callbackEngine = readStackEngine(viaCallback);
		const flatEngine = readStackEngine(viaFlat);
		expect(callbackEngine.members.map((m) => m.id)).toEqual(
			flatEngine.members.map((m) => m.id),
		);
		expect(callbackEngine.options.stackName).toBe(flatEngine.options.stackName);
	});

	// -----------------------------------------------------------------------
	// Defensive runtime check at src/api/define-devstack-with.ts:76.
	// The TS gate (`ValidateBuild<Members>`) requires `AnyPlugin` members;
	// this test bypasses TS with `as unknown` to verify the runtime guard
	// still rejects a non-plugin value.
	// -----------------------------------------------------------------------
	it('rejects a builder that returns a value missing the plugin brand', () => {
		const notAPlugin = { id: 'fake', notReally: true };
		expect(() =>
			defineDevstackWith(
				{ network: localNetwork, stackName: 'with-bad-member' },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				() => [notAPlugin] as unknown as any,
			),
		).toThrowError(/not a plugin member/i);
	});

	it('rejects a mixed builder return where one member is not a plugin', () => {
		const notAPlugin = { id: 'fake' };
		expect(() =>
			defineDevstackWith(
				{ network: localNetwork, stackName: 'with-mixed-bad' },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				() => [leaf, notAPlugin] as unknown as any,
			),
		).toThrowError(/not a plugin member/i);
	});
});
