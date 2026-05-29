import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { resolveOriginPolicy } from '../../../src/plugins/wallet/origin-policy.ts';

describe('plugins/wallet/origin-policy', () => {
	it.effect('allows the routed app origin without caller supplied extras', () =>
		Effect.gen(function* () {
			const policy = yield* resolveOriginPolicy({
				app: 'wallet-demo',
				stack: 'main',
				routedAppOrigin: 'http://dev.wallet-demo.localhost:5175',
				extraOrigins: [],
			});

			expect(policy.allowed.has('http://dev.wallet-demo.localhost:5175')).toBe(true);
			// The legacy auto-allowlisted bare `localhost:<vite>` form is gone:
			// devstack never tracked an external vite port, so the branch that
			// produced it was dead and was removed (STYLE_GUIDE §5).
			expect(policy.allowed.has('http://localhost:5175')).toBe(false);
		}),
	);

	it.effect('merges caller-supplied extra origins on top of the routed origin', () =>
		Effect.gen(function* () {
			const policy = yield* resolveOriginPolicy({
				app: 'private-content',
				stack: 'private-content',
				routedAppOrigin: 'http://dev.private-content.private-content.localhost:6173',
				extraOrigins: ['http://localhost:4321', 'https://custom.example'],
			});

			expect(
				policy.allowed.has('http://dev.private-content.private-content.localhost:6173'),
			).toBe(true);
			expect(policy.allowed.has('http://localhost:4321')).toBe(true);
			expect(policy.allowed.has('https://custom.example')).toBe(true);
		}),
	);

	it.effect('resolves an empty allowlist when neither source is present', () =>
		Effect.gen(function* () {
			// Node-only / e2e stacks compose without any client UI. The
			// wallet still boots, but the per-request gate refuses every
			// Origin — the HTTP surface is effectively closed.
			const policy = yield* resolveOriginPolicy({
				app: 'app',
				stack: 'main',
				routedAppOrigin: null,
				extraOrigins: [],
			});

			expect(policy.allowed.size).toBe(0);
		}),
	);
});
