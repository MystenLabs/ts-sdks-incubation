import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { resolveOriginPolicy } from '../../../src/plugins/wallet/origin-policy.ts';

describe('plugins/wallet/origin-policy', () => {
	it.effect('keeps the dev service label first for non-main stack origins', () =>
		Effect.gen(function* () {
			const policy = yield* resolveOriginPolicy({
				app: 'private-content',
				stack: 'private-content',
				vitePortForThisStack: 5175,
				extraOrigins: [],
				allowLocalhostVite: false,
			});

			expect(policy.stackScopedHost).toBe('dev.private-content.private-content.localhost');
			expect(policy.allowed.has('http://dev.private-content.private-content.localhost:5175')).toBe(
				true,
			);
		}),
	);
});
