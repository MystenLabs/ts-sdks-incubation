// Registry dependency reader — synchronous access to resolved upstream values.
//
// Public plugin bodies now receive resolved dependencies through
// `start(ctx, deps)`. The lifecycle registry still owns the runtime
// guard: a plugin may only read resources listed in its normalized
// `dependsOn` refs, and those refs map positionally to upstream keys.

import { Effect, Scope } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { definePlugin, resource, type AnyPlugin, type AnyResourceRef } from '../../src/substrate/plugin.ts';
import { pluginKey, type PluginKey } from '../../src/substrate/brand.ts';
import {
	buildDependencyReaderFor,
	makeEntry,
	makeRegistry,
	type PluginEntry,
	type PluginRegistry,
} from '../../src/substrate/runtime/lifecycle/plugin-registry.ts';
import type { DepNode } from '../../src/substrate/runtime/lifecycle/dep-graph.ts';

interface AliceValue {
	readonly address: string;
}

interface PackageValue {
	readonly packageId: string;
}

const AliceResource = resource<'account/alice', AliceValue>('account/alice');
const PackageResource = resource<'package:demo', PackageValue>('package:demo');
const StrangerResource = resource<'account/stranger', AliceValue>('account/stranger');

const alice = definePlugin({
	id: AliceResource.id,
	kind: 'leaf-long-running',
	start: () => Effect.succeed<AliceValue>({ address: '0xa11ce' }),
});

const makeConsumerNode = (
	upstreamResources: ReadonlyArray<AnyResourceRef>,
	upstreamKeys: ReadonlyArray<PluginKey>,
): DepNode => ({
	key: pluginKey('consumer#0'),
	member: definePlugin({
		id: 'consumer',
		dependsOn: upstreamResources,
		kind: 'leaf-long-running',
		start: () => Effect.succeed({ ok: true } as const),
	}) as AnyPlugin,
	compositeParent: null,
	upstreamResources,
	upstreamKeys,
});

const setupRegistry = (
	entries: ReadonlyArray<{ readonly key: PluginKey; readonly value: unknown }>,
): Effect.Effect<PluginRegistry, never, Scope.Scope> =>
	Effect.gen(function* () {
		const parent = yield* Effect.scope;
		const pluginEntries = new Map<PluginKey, PluginEntry>();
		for (const { key } of entries) {
			const node: DepNode = {
				key,
				member: alice,
				compositeParent: null,
				upstreamResources: [],
				upstreamKeys: [],
			};
			const entry = yield* makeEntry(node, parent);
			pluginEntries.set(key, entry);
		}
		const registry = makeRegistry(pluginEntries, () => Effect.void);
		for (const { key, value } of entries) {
			yield* Effect.orDie(registry.markReady(key, value));
		}
		return registry;
	});

describe('registry dependency reader', () => {
	it.effect('returns the resolved value for a declared dependency resource', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const aliceKey = pluginKey('account/alice#0');
				const registry = yield* setupRegistry([{ key: aliceKey, value: { address: '0xa11ce' } }]);
				const node = makeConsumerNode([AliceResource], [aliceKey]);
				const read = buildDependencyReaderFor(registry, node);

				expect(read(AliceResource)).toEqual({ address: '0xa11ce' });
			}),
		),
	);

	it.effect('reads multiple declared dependencies by resource id', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const aliceKey = pluginKey('account/alice#0');
				const pkgKey = pluginKey('package:demo#1');
				const registry = yield* setupRegistry([
					{ key: aliceKey, value: { address: '0xa11ce' } },
					{ key: pkgKey, value: { packageId: '0xdeadbeef' } },
				]);
				const node = makeConsumerNode([AliceResource, PackageResource], [aliceKey, pkgKey]);
				const read = buildDependencyReaderFor(registry, node);

				expect(read(AliceResource)).toEqual({ address: '0xa11ce' });
				expect(read(PackageResource)).toEqual({ packageId: '0xdeadbeef' });
			}),
		),
	);

	it.effect('throws when a plugin reads outside declared dependencies', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const aliceKey = pluginKey('account/alice#0');
				const registry = yield* setupRegistry([{ key: aliceKey, value: { address: '0xa11ce' } }]);
				const node = makeConsumerNode([AliceResource], [aliceKey]);
				const read = buildDependencyReaderFor(registry, node);

				expect(() => read(StrangerResource)).toThrow(
					/resource 'account\/stranger' not in this plugin's declared dependencies/,
				);
			}),
		),
	);
});
