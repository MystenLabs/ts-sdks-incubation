import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

describe('devstack-effect scaffold', () => {
	it.effect('runs an Effect through @effect/vitest', () =>
		Effect.gen(function* () {
			const greeting = yield* Effect.succeed('hello from effect');
			expect(greeting).toBe('hello from effect');
		}),
	);
});
