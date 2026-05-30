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
			// The allowlist is the ROUTED app origin only — the policy does NOT
			// auto-add a bare-loopback `localhost:<port>` form. The dev-server's
			// raw-loopback origin is reachable instead via the host-service's
			// routed `value.url` (see host-service `index.ts`) or, for devs who
			// insist on the raw Vite URL, via `allowedOrigins` (→ `extraOrigins`,
			// covered below). See the `origin-policy.ts` history note.
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

			expect(policy.allowed.has('http://dev.private-content.private-content.localhost:6173')).toBe(
				true,
			);
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
