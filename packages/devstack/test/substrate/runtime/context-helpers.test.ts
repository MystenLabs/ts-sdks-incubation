// Substrate context-helpers — pure-data tests.
//
// Invariants under test:
//   1. `getOrDefault` returns the layered service when present.
//   2. `getOrDefault` returns the fallback when the service is missing.
//   3. `getOrDefaultEffect` runs the fallback Effect only when missing.
//   4. `getOrDefaultEffect` short-circuits the fallback when present.

import { Context, Effect, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	getOrDefault,
	getOrDefaultEffect,
} from '../../../src/substrate/runtime/context-helpers.ts';

interface NameShape {
	readonly name: string;
}

class NameTag extends Context.Service<NameTag, NameShape>()('@devstack/test/NameTag') {}

describe('getOrDefault', () => {
	it('returns the service when layered into context', () => {
		const ctx = Context.add(Context.empty(), NameTag, NameTag.of({ name: 'present' }));
		expect(getOrDefault(ctx, NameTag, { name: 'fallback' }).name).toBe('present');
	});

	it('returns the fallback when the service is absent', () => {
		expect(getOrDefault(Context.empty(), NameTag, { name: 'fallback' }).name).toBe('fallback');
	});

	it('typechecks against Context.Service classes (Logger / RuntimeRoot shape)', () => {
		// Compile-time shape check — the helper accepts a `Context.Service`
		// subclass exactly the way the supervisor's Logger / RuntimeRoot
		// call sites do.
		const v: NameShape = getOrDefault(Context.empty(), NameTag, { name: 'x' });
		expect(v.name).toBe('x');
	});
});

describe('getOrDefaultEffect', () => {
	it.effect('returns the layered service without running the fallback', () =>
		Effect.gen(function* () {
			const fallbackRan = yield* Ref.make(false);
			const ctx = Context.add(Context.empty(), NameTag, NameTag.of({ name: 'present' }));
			const result = yield* getOrDefaultEffect(
				ctx,
				NameTag,
				Effect.gen(function* () {
					yield* Ref.set(fallbackRan, true);
					return { name: 'fallback' } satisfies NameShape;
				}),
			);
			expect(result.name).toBe('present');
			expect(yield* Ref.get(fallbackRan)).toBe(false);
		}),
	);

	it.effect('runs the fallback Effect when the service is absent', () =>
		Effect.gen(function* () {
			const fallbackRan = yield* Ref.make(false);
			const result = yield* getOrDefaultEffect(
				Context.empty(),
				NameTag,
				Effect.gen(function* () {
					yield* Ref.set(fallbackRan, true);
					return { name: 'fallback' } satisfies NameShape;
				}),
			);
			expect(result.name).toBe('fallback');
			expect(yield* Ref.get(fallbackRan)).toBe(true);
		}),
	);
});
