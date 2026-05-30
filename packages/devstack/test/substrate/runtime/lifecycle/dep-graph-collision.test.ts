// Dep-graph collision detection tests.
//
// Architecture invariants under test:
//   1. `resolveGraph` fails with `DuplicateResourceIdError` when two
//      members share the same `resource id` (i.e. the same
//      `definePlugin({ id })`). Without the guard the provider index
//      would last-writer-wins and every dependent would silently bind
//      to the second declaration.
//   2. Two members with different ids resolve cleanly — the guard
//      does not produce false positives on the common case.
//   3. The error payload carries the colliding `resourceId` plus
//      both `firstPluginKey` and `secondPluginKey` so a developer can
//      locate the conflict from the boot-time message alone.
//
// Companion to the package-plugin-level guard in
// `plugins/package/mode-local.ts`: that guard fires earlier on the
// registry path; this substrate-level guard catches the same class of
// mistake for ANY plugin.

import { Cause, Effect, Exit, Option } from 'effect';
import { describe, expect, it } from 'vitest';

import { definePlugin } from '../../../../src/substrate/plugin.ts';
import {
	DuplicateResourceIdError,
	resolveGraph,
} from '../../../../src/substrate/runtime/lifecycle/dep-graph.ts';

const makeServicePlugin = (id: string) =>
	definePlugin({
		id,
		role: 'service' as const,
		section: 'service',
		start: () => Effect.succeed({ tag: id }),
	});

describe('resolveGraph collision detection', () => {
	it('fails with DuplicateResourceIdError when two members share an id', async () => {
		const a = makeServicePlugin('collide:me');
		const b = makeServicePlugin('collide:me');

		const exit = await Effect.runPromiseExit(resolveGraph([a, b]));

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const failureOpt = Cause.findErrorOption(exit.cause);
			const failure = Option.isSome(failureOpt) ? failureOpt.value : null;
			expect(failure).toBeInstanceOf(DuplicateResourceIdError);
			expect(failure).toMatchObject({
				_tag: 'DuplicateResourceIdError',
				resourceId: 'collide:me',
			});
			// Payload must carry both colliding plugin keys so a developer
			// can locate the conflict. Ordinal-derived keys distinguish
			// the first and second declarations.
			const err = failure as DuplicateResourceIdError;
			expect(err.firstPluginKey).not.toBe(err.secondPluginKey);
			expect(String(err.firstPluginKey)).toBe('collide:me#0');
			expect(String(err.secondPluginKey)).toBe('collide:me#1');
		}
	});

	it('reports stable-key collisions using the declared pluginKey when set', async () => {
		// When members declare a stable `pluginKey`, the error payload
		// should surface those keys verbatim — they're what the developer
		// sees in trace exports and supervisor logs.
		const a = definePlugin({
			id: 'collide:stable',
			role: 'service' as const,
			section: 'service',
			pluginKey: 'stable-a',
			start: () => Effect.succeed({}),
		});
		const b = definePlugin({
			id: 'collide:stable',
			role: 'service' as const,
			section: 'service',
			pluginKey: 'stable-b',
			start: () => Effect.succeed({}),
		});

		const exit = await Effect.runPromiseExit(resolveGraph([a, b]));

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const failureOpt = Cause.findErrorOption(exit.cause);
			const failure = Option.isSome(failureOpt) ? failureOpt.value : null;
			expect(failure).toBeInstanceOf(DuplicateResourceIdError);
			const err = failure as DuplicateResourceIdError;
			expect(String(err.firstPluginKey)).toBe('stable-a');
			expect(String(err.secondPluginKey)).toBe('stable-b');
		}
	});

	it('resolves cleanly when ids are distinct', async () => {
		// No false-positives: two ordinary members with different ids
		// must produce a topo-sorted graph.
		const a = makeServicePlugin('unique:a');
		const b = makeServicePlugin('unique:b');

		const exit = await Effect.runPromiseExit(resolveGraph([a, b]));

		expect(Exit.isSuccess(exit)).toBe(true);
		if (Exit.isSuccess(exit)) {
			const graph = exit.value;
			expect(graph.nodes.size).toBe(2);
			// Both members land in the first level (no dependencies).
			expect(graph.levels).toHaveLength(1);
			expect(graph.levels[0]).toHaveLength(2);
		}
	});
});
