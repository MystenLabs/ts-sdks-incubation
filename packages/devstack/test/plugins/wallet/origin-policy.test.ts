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
				routedAppOrigin: null,
				extraOrigins: [],
				allowLocalhostVite: false,
			});

			expect(policy.stackScopedHost).toBe('dev.private-content.private-content.localhost');
			expect(policy.allowed.has('http://dev.private-content.private-content.localhost:5175')).toBe(
				true,
			);
		}),
	);

	it.effect('allows the routed app origin without caller supplied extras', () =>
		Effect.gen(function* () {
			const policy = yield* resolveOriginPolicy({
				app: 'wallet-demo',
				stack: 'main',
				vitePortForThisStack: null,
				routedAppOrigin: 'http://dev.wallet-demo.localhost:5175',
				extraOrigins: [],
				allowLocalhostVite: false,
			});

			expect(policy.allowed.has('http://dev.wallet-demo.localhost:5175')).toBe(true);
			expect(policy.allowed.has('http://localhost:5175')).toBe(false);
		}),
	);
});
