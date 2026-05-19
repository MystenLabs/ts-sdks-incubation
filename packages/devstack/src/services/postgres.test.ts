// L1 unit test for `Postgres(opts)` — factory shape: returns a tag with
// a layer that, when provided, exposes a `Postgres` value carrying
// `url(db)` for each requested database. Full lifecycle (container boot,
// pg_isready probe, CREATE DATABASE idempotency) is covered at L3 by
// `postgres.docker.test.ts`.

import { describe, expect, it } from 'vitest';
import { Postgres } from './postgres.js';

describe('Postgres factory shape (P2.T1)', () => {
	it('returns a tag-shaped value with __layer + __kind=service', () => {
		const pg = Postgres({
			name: 'pg-test',
			databases: ['deepbook', 'app'],
		});

		expect(typeof pg).toBe('function');
		expect((pg as unknown as { __kind?: string }).__kind).toBe('service');
		// LayeredTag's `__layer` is a Layer.
		expect((pg as unknown as { __layer?: unknown }).__layer).toBeDefined();
		// Image build layer threads into __layers.
		const layers = (pg as unknown as { __layers?: ReadonlyArray<unknown> }).__layers;
		expect(layers).toBeDefined();
		expect(layers!.length).toBeGreaterThanOrEqual(2);
	});

	it('throws when databases array is empty', () => {
		expect(() => Postgres({ databases: [] })).toThrow(/non-empty/);
	});
});
