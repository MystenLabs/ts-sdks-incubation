// MVR named-form invariant.
//
// Generated Move bindings must be resolvable by an MVR NAME alone, so
// apps can register an `MvrClient` override keyed on
// `config.packages.<name>.mvr` and have generated functions
// (`options.package ?? '@local/<slug>'`) resolve by name. That requires
// the emitted placeholder to:
//   1. be the SAME string in both the binding default and `config.mvr`
//   2. pass BOTH `hasMvrName` (so the resolver tries to resolve it) and
//      `isValidNamedPackage` (so `MvrClient`'s override validation and
//      `findNamesInTransaction` accept it — both throw otherwise).
//
// `mvrNamedForm` builds `@local/<slug>`; `projectPackageConfig` mirrors
// the same `mvrPlaceholder` into `config.packages.<name>.mvr`. This test
// pins the validity + the binding-default/config equality so a future
// org/slug change cannot silently produce an unresolvable name.

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
// `isValidNamedPackage` is the load-bearing predicate: `MvrClient`'s
// `validateOverrides` and `findNamesInTransaction` BOTH throw when a name
// that looks like an MVR name fails it, so the emitted placeholder must
// pass it or the named-packages plugin rejects the override outright. It is
// exported from the public `@mysten/sui/utils` entry.
import { isValidNamedPackage } from '@mysten/sui/utils';

// `hasMvrName` (the predicate that decides whether the resolver attempts
// resolution at all) is NOT re-exported from any public `@mysten/sui` entry
// in the installed version — it lives in the internal `client/mvr` module.
// It is a trivial substring check; mirror it verbatim so this test pins the
// SAME behavior the SDK uses without reaching into an unstable deep path.
// Source: node_modules/@mysten/sui/dist/client/mvr.mjs `hasMvrName`.
const hasMvrName = (name: string): boolean =>
	name.includes('/') || name.includes('@') || name.includes('.sui');

import {
	mvrNamedForm,
	mvrNamedFormFrom,
	mvrSlugify,
} from '../../../src/plugins/package/dep-resolution.ts';
import { makeLocalCodegenable } from '../../../src/plugins/package/codegen.ts';
import type { ResolvedLocalPackage } from '../../../src/plugins/package/registry.ts';

const NAMES = ['connect-four', 'counter', 'deepbook', 'My Cool Pkg', 'token_v2'];

describe('mvrNamedForm', () => {
	it('produces @local/<slug> and passes hasMvrName + isValidNamedPackage', () => {
		for (const name of NAMES) {
			const named = mvrNamedForm(name);
			expect(named).toBe(`@local/${mvrSlugify(name)}`);
			expect(hasMvrName(named)).toBe(true);
			expect(isValidNamedPackage(named)).toBe(true);
		}
	});

	it('matches the documented examples exactly', () => {
		expect(mvrNamedForm('connect-four')).toBe('@local/connect-four');
		expect(mvrNamedForm('counter')).toBe('@local/counter');
		expect(mvrNamedForm('deepbook')).toBe('@local/deepbook');
	});

	it('the bare slug alone is NOT a valid named package (regression guard)', () => {
		// This is the bug the named form fixes: the bare slug fails both
		// predicates, so the named-packages plugin would never resolve it.
		for (const name of NAMES) {
			const slug = mvrSlugify(name);
			expect(hasMvrName(slug)).toBe(false);
			expect(isValidNamedPackage(slug)).toBe(false);
		}
	});
});

describe('package codegen emits the named form as binding default AND config.mvr', () => {
	const resolved: ResolvedLocalPackage = {
		kind: 'local',
		name: 'connect-four',
		packageId: '0xpkg',
		sourcePath: '/abs/connect-four',
		mvrPlaceholder: mvrNamedForm('connect-four'),
		captured: {},
	};

	it.effect('mvrPlaceholder (→ binding default) === config.packages.<name>.mvr === @local/<slug>', () =>
		Effect.gen(function* () {
			const decl = makeLocalCodegenable(resolved, { excluded: false });

			// Drive the emit body with a recording ctx so we can read both
			// the `packageBindings` (→ binding default via the bindings
			// emitter's `package:` field) and the `__packageConfig`
			// (→ `config.packages.<name>.mvr` via `projectPackageConfig`).
			const exported: Record<string, unknown> = {};
			const ctx = {
				exportConst: (name: string, value: unknown) => {
					exported[name] = value;
				},
				done: () => undefined,
			};
			yield* decl.emit(ctx as never);

			const bindings = exported['packageBindings'] as { mvrPlaceholder: string };
			const projected = decl.aggregate!.project(exported) as {
				packages: Record<string, { mvr: string; byNetwork: Record<string, string> }>;
				mvrOverrides: Record<string, string>;
			};

			const expected = '@local/connect-four';
			// The binding default the bindings emitter writes is this
			// `mvrPlaceholder` (threaded as `package:` into @mysten/codegen).
			expect(bindings.mvrPlaceholder).toBe(expected);
			// `config.packages.connect-four.mvr` MUST be the identical string.
			expect(projected.packages['connect-four']!.mvr).toBe(expected);
			expect(bindings.mvrPlaceholder).toBe(projected.packages['connect-four']!.mvr);

			// And it is a valid, resolvable named package.
			expect(hasMvrName(expected)).toBe(true);
			expect(isValidNamedPackage(expected)).toBe(true);

			// `config.mvrOverrides` contribution is the active-network
			// (`local`) name→id entry — exactly what the old per-app
			// `mvrOverrides()` helper computed for this package. Keyed by
			// the package's `mvr` placeholder, valued by `byNetwork.local`.
			expect(projected.mvrOverrides).toEqual({ '@local/connect-four': '0xpkg' });
			expect(projected.mvrOverrides[expected]).toBe(
				projected.packages['connect-four']!.byNetwork['local'],
			);
		}),
	);
});

describe('stale bare-slug mvrPlaceholder is corrected to the named form at the emit seam', () => {
	// FIX 3 regression guard: the package-publish cache
	// (`projection.v4.json`'s `mvrPlaceholder`) can serve a STALE bare slug
	// from a stack created before the `mvrSlugify`→`mvrNamedForm` change. An
	// incremental re-apply must STILL emit `@local/<slug>` in both the binding
	// default and `config.mvr`, or the bare slug fails `hasMvrName` and the
	// generated binding never resolves through the MvrClient override.
	const staleResolved: ResolvedLocalPackage = {
		kind: 'local',
		name: 'vault',
		packageId: '0xpkg',
		sourcePath: '/abs/vault',
		// Stale bare slug as it would be served from an old projection.
		mvrPlaceholder: 'vault',
		captured: {},
	};

	it.effect(
		'binding default === config.mvr === @local/vault despite stale bare placeholder',
		() =>
			Effect.gen(function* () {
				const decl = makeLocalCodegenable(staleResolved, { excluded: false });

				const exported: Record<string, unknown> = {};
				const ctx = {
					exportConst: (name: string, value: unknown) => {
						exported[name] = value;
					},
					done: () => undefined,
				};
				yield* decl.emit(ctx as never);

				const bindings = exported['packageBindings'] as { mvrPlaceholder: string };
				const projected = decl.aggregate!.project(exported) as {
					packages: Record<string, { mvr: string }>;
				};

				const expected = '@local/vault';
				// Binding default (→ @mysten/codegen `package:`) is corrected.
				expect(bindings.mvrPlaceholder).toBe(expected);
				// `config.packages.vault.mvr` is the identical corrected string.
				expect(projected.packages['vault']!.mvr).toBe(expected);
				expect(bindings.mvrPlaceholder).toBe(projected.packages['vault']!.mvr);

				// And the corrected form is resolvable.
				expect(hasMvrName(expected)).toBe(true);
				expect(isValidNamedPackage(expected)).toBe(true);
			}),
	);

	it('an already-named placeholder (e.g. a user override) is preserved verbatim', () => {
		// `mvrNamedFormFrom` must NOT double-wrap an already-named string,
		// which would corrupt a user-supplied `mvrPlaceholder` override.
		expect(mvrNamedFormFrom('@local/custom-name')).toBe('@local/custom-name');
		// A bare slug IS wrapped.
		expect(mvrNamedFormFrom('vault')).toBe('@local/vault');
	});
});
