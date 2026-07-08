import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	checkOrigin,
	describeAllowedOrigins,
	resolveOriginPolicy,
} from '../../../src/plugins/wallet/origin-policy.ts';

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
			expect(checkOrigin(policy, 'http://dev.wallet-demo.localhost:5175')).toBe('ok');
			expect(checkOrigin(policy, 'http://localhost:5175')).toBe('forbidden');
		}),
	);

	it.effect('allows any same-stack routed endpoint origin without allowing raw loopback', () =>
		Effect.gen(function* () {
			const policy = yield* resolveOriginPolicy({
				app: 'wallet-demo',
				stack: 'main',
				routedAppOrigin: 'http://dev.wallet-demo.localhost:5175',
				extraOrigins: [],
			});

			expect(checkOrigin(policy, 'http://app.wallet-demo.localhost:5175')).toBe('ok');
			expect(checkOrigin(policy, 'http://admin.wallet-demo.localhost:5175')).toBe('ok');
			expect(checkOrigin(policy, 'http://127.0.0.1:5173')).toBe('forbidden');
			expect(checkOrigin(policy, 'http://dev.other-app.localhost:5175')).toBe('forbidden');
			expect(describeAllowedOrigins(policy)).toEqual([
				'http://dev.wallet-demo.localhost:5175',
				'http://*.wallet-demo.localhost:5175',
			]);
		}),
	);

	it.effect('scopes routed wildcard origins by named stack', () =>
		Effect.gen(function* () {
			const policy = yield* resolveOriginPolicy({
				app: 'wallet-demo',
				stack: 'preview',
				routedAppOrigin: 'http://dev.preview.wallet-demo.localhost:5175',
				extraOrigins: [],
			});

			expect(checkOrigin(policy, 'http://app.preview.wallet-demo.localhost:5175')).toBe('ok');
			expect(checkOrigin(policy, 'http://app.other.wallet-demo.localhost:5175')).toBe('forbidden');
			expect(checkOrigin(policy, 'http://app.wallet-demo.localhost:5175')).toBe('forbidden');
			expect(describeAllowedOrigins(policy)).toEqual([
				'http://dev.preview.wallet-demo.localhost:5175',
				'http://*.preview.wallet-demo.localhost:5175',
			]);
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
			const policy = yield* resolveOriginPolicy({
				app: 'app',
				stack: 'main',
				routedAppOrigin: null,
				extraOrigins: [],
			});

			expect(policy.allowed.size).toBe(0);
			expect(describeAllowedOrigins(policy)).toEqual([]);
		}),
	);
});
