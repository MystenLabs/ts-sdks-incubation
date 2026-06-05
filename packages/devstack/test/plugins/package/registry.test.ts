// Package-plugin PackageRegistry — pinned behaviors.
//
// The L2 package plugin exposes a typed `PackageRegistryService`
// Context.Service over a self-contained last-write-wins
// `PackageKey -> ResolvedPackage` map (formerly the substrate
// `defineScopedRefMap` single mode, strangled into the plugin).
// Consumers (mode-local / mode-known acquire bodies, plus future
// cross-plugin readers) yield `PackageRegistryService` and call
// `set(name, pkg)` / `find(name)` / `entries()`. Covers round-trip,
// LWW, insertion order across many writes, and scope-bound lifecycle.

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import {
	PackageRegistryService,
	layerPackageRegistry,
	type ResolvedLocalPackage,
	type ResolvedKnownPackage,
	type ResolvedPackage,
} from '../../../src/plugins/package/registry.ts';

const localFixture = (name: string, packageId: string): ResolvedLocalPackage => ({
	kind: 'local',
	name,
	packageId,
	sourcePath: `/fixtures/${name}`,
	mvrPlaceholder: name,
	captured: {},
});

const knownFixture = (name: string, packageId: string): ResolvedKnownPackage => ({
	kind: 'known',
	name,
	packageId,
	mvrPlaceholder: name,
});

describe('plugins/package — PackageRegistry', () => {
	it.effect('set + find round-trips a local package', () =>
		Effect.gen(function* () {
			const reg = yield* PackageRegistryService;
			const pkg = localFixture('mock_usdc', '0xMOCK');
			yield* reg.set(pkg.name, pkg);
			const found = yield* reg.find('mock_usdc');
			expect(found).toEqual(pkg);
		}).pipe(Effect.provide(layerPackageRegistry)),
	);

	it.effect('find returns null for an unknown key', () =>
		Effect.gen(function* () {
			const reg = yield* PackageRegistryService;
			const missing = yield* reg.find('nope');
			expect(missing).toBeNull();
		}).pipe(Effect.provide(layerPackageRegistry)),
	);

	it.effect('set overwrites — last-write-wins under the same key', () =>
		Effect.gen(function* () {
			const reg = yield* PackageRegistryService;
			const first = localFixture('coin_pkg', '0xAAA');
			const second: ResolvedPackage = {
				...localFixture('coin_pkg', '0xBBB'),
				captured: { admin: '0xADMIN' },
			};
			yield* reg.set(first.name, first);
			yield* reg.set(second.name, second);
			const found = yield* reg.find('coin_pkg');
			expect(found).toEqual(second);
		}).pipe(Effect.provide(layerPackageRegistry)),
	);

	// Migrated from the substrate single-mode suite ("entries returns all
	// pairs in insertion order" / "repeated set"): `entries` orders keys
	// by their latest write — re-setting an existing key advances its seq
	// and re-sorts it to the END, while keeping one entry per key.
	it.effect('entries reflects insertion order; re-set re-sorts the key to the end', () =>
		Effect.gen(function* () {
			const reg = yield* PackageRegistryService;
			yield* reg.set('c', localFixture('c', '0xC'));
			yield* reg.set('a', localFixture('a', '0xA'));
			yield* reg.set('b', localFixture('b', '0xB'));
			expect((yield* reg.entries()).map(([k]) => k)).toEqual(['c', 'a', 'b']);
			// Re-set 'c' — one entry per key, but its seq now leads, so it
			// moves to the tail of the iteration order.
			yield* reg.set('c', localFixture('c', '0xC2'));
			const entries = yield* reg.entries();
			expect(entries.map(([k]) => k)).toEqual(['a', 'b', 'c']);
			expect(entries.find(([k]) => k === 'c')?.[1].packageId).toBe('0xC2');
		}).pipe(Effect.provide(layerPackageRegistry)),
	);

	it.effect('local + known packages coexist under distinct keys', () =>
		Effect.gen(function* () {
			const reg = yield* PackageRegistryService;
			const loc = localFixture('app_pkg', '0xLOC');
			const kno = knownFixture('deepbook', '0xDEEP');
			yield* reg.set(loc.name, loc);
			yield* reg.set(kno.name, kno);
			const entries = yield* reg.entries();
			expect(new Set(entries.map(([k]) => k))).toEqual(new Set(['app_pkg', 'deepbook']));
			const founLoc = yield* reg.find('app_pkg');
			const founKno = yield* reg.find('deepbook');
			expect(founLoc?.kind).toBe('local');
			expect(founKno?.kind).toBe('known');
		}).pipe(Effect.provide(layerPackageRegistry)),
	);

	it.effect('each Layer build materializes an independent registry', () =>
		Effect.gen(function* () {
			const seen = yield* Effect.gen(function* () {
				const reg = yield* PackageRegistryService;
				yield* reg.set('pkg', localFixture('pkg', '0xONCE'));
				return yield* reg.find('pkg');
			}).pipe(Effect.provide(layerPackageRegistry));
			expect(seen?.packageId).toBe('0xONCE');

			// Independent layer build — the previous registry's entries
			// must not leak across.
			const fresh = yield* Effect.gen(function* () {
				const reg = yield* PackageRegistryService;
				return yield* reg.find('pkg');
			}).pipe(Effect.provide(layerPackageRegistry));
			expect(fresh).toBeNull();
		}),
	);
});
