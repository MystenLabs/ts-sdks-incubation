// Hostname + dispatch-id minting helpers — pure-function coverage.
//
// Architecture invariants under test:
//   #7  — distinct `(app, stack, role)` triples mint distinct hostnames;
//          default stack ('main') omits the stack segment; every other
//          stack includes it.
//   #8  — dots in hostname role segments fold to label-safe chars.
//   #13 — hostname labels reject invalid chars; dispatch ids hash the
//          full source tuple so readable slug folding cannot collide.
//
// Post-B1: pure URL composition + hostname minting live in
// `substrate/runtime/routed-url.ts`. This file keeps the dispatch-id +
// `routerHostname` (L3 adapter) coverage; the substrate primitives have
// their own coverage at `test/substrate/runtime/routed-url.test.ts`.

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { appName, chainId, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import {
	DEFAULT_STACK,
	dispatchFileId,
	normalizeDispatchSegment,
	normalizeServiceSegment,
	renderUrl,
	routerHostname,
} from '../../../src/orchestrators/router/hostname.ts';

const identity = (stack: string): Identity => ({
	app: appName('my-app'),
	stack: stackName(stack),
	chain: chainId('sui:localnet'),
});

describe('routerHostname', () => {
	it.effect('default stack omits the stack segment', () =>
		Effect.gen(function* () {
			const host = yield* routerHostname(identity(DEFAULT_STACK), 'api');
			expect(host).toBe('api.my-app.localhost');
		}),
	);

	it.effect('non-default stack keeps the service segment first', () =>
		Effect.gen(function* () {
			const host = yield* routerHostname(identity('feature-x'), 'api');
			expect(host).toBe('api.feature-x.my-app.localhost');
		}),
	);

	it.effect('parallel stacks of the same role mint distinct hostnames (invariant #7)', () =>
		Effect.gen(function* () {
			const a = yield* routerHostname(identity('main'), 'wallet-app');
			const b = yield* routerHostname(identity('feature-x'), 'wallet-app');
			const c = yield* routerHostname(identity('feature-y'), 'wallet-app');
			expect(new Set([a, b, c]).size).toBe(3);
		}),
	);

	it.effect('role with dots is folded to hyphens before hostname assembly (invariant #8)', () =>
		Effect.gen(function* () {
			const host = yield* routerHostname(identity('main'), 'walrus.node.0');
			expect(host).toBe('walrus-node-0.my-app.localhost');
		}),
	);

	it.effect('rejects roles with disallowed characters', () =>
		routerHostname(identity('main'), 'has space').pipe(
			Effect.flip,
			Effect.tap((err) => {
				expect(err._tag).toBe('RouterValidationError');
				return Effect.void;
			}),
		),
	);

	it.effect('rejects roles starting with a digit-only is fine, but underscores fail', () =>
		routerHostname(identity('main'), 'has_underscore').pipe(
			Effect.flip,
			Effect.tap((err) => {
				expect(err._tag).toBe('RouterValidationError');
				return Effect.void;
			}),
		),
	);
});

describe('dispatchFileId', () => {
	it.effect('mints a readable, file-safe id with a sha256 identity suffix', () =>
		Effect.gen(function* () {
			const id = yield* dispatchFileId({
				identity: identity('main'),
				dispatch: {
					serviceKey: 'wallet.my-app.main',
					role: 'api',
				},
			});
			expect(id).toMatch(/^r1-my-app-main-wallet-my-app-main-api-[a-f0-9]{64}$/);
		}),
	);

	it.effect('keeps the same readable prefix for folded inputs but changes the hash', () =>
		Effect.gen(function* () {
			const a = yield* dispatchFileId({
				identity: identity('main'),
				dispatch: {
					serviceKey: 'walrus.service.local',
					role: 'walrus.node.0',
				},
			});
			const b = yield* dispatchFileId({
				identity: identity('main'),
				dispatch: {
					serviceKey: 'walrus-service-local',
					role: 'walrus-node-0',
				},
			});
			expect(a).not.toBe(b);
			expect(a.replace(/[a-f0-9]{64}$/, '<hash>')).toBe(b.replace(/[a-f0-9]{64}$/, '<hash>'));
		}),
	);

	it.effect('does not collide on raw underscores versus encoded-looking separators', () =>
		Effect.gen(function* () {
			const a = yield* dispatchFileId({
				identity: identity('main'),
				dispatch: {
					serviceKey: 'walrus:walrus',
					role: 'node',
				},
			});
			const b = yield* dispatchFileId({
				identity: identity('main'),
				dispatch: {
					serviceKey: 'walrus_3a_walrus',
					role: 'node',
				},
			});
			expect(a).not.toBe(b);
		}),
	);

	it.effect('does not collide when old `--` separators can be reassociated', () =>
		Effect.gen(function* () {
			const a = yield* dispatchFileId({
				identity: identity('main'),
				dispatch: { serviceKey: 'a--b', role: 'c' },
			});
			const b = yield* dispatchFileId({
				identity: identity('main'),
				dispatch: { serviceKey: 'a', role: 'b--c' },
			});
			expect(a).not.toBe(b);
		}),
	);

	it.effect('distinct source identity tuples mint distinct ids', () =>
		Effect.gen(function* () {
			const dispatch = { serviceKey: 'k1', role: 'r1' };
			const a = yield* dispatchFileId({ identity: identity('main'), dispatch });
			const b = yield* dispatchFileId({ identity: identity('feature-x'), dispatch });
			const c = yield* dispatchFileId({
				identity: identity('main'),
				dispatch: { serviceKey: 'k1', role: 'r2' },
			});
			const d = yield* dispatchFileId({
				identity: identity('main'),
				dispatch: { serviceKey: 'k2', role: 'r1' },
			});
			expect(new Set([a, b, c, d]).size).toBe(4);
		}),
	);
});

describe('normalizeServiceSegment', () => {
	it('lower-cases and replaces dots', () => {
		expect(normalizeServiceSegment('Walrus.Node.0')).toBe('walrus-node-0');
	});
});

describe('normalizeDispatchSegment', () => {
	it('builds a readable slug; it is not the uniqueness key', () => {
		expect(normalizeDispatchSegment('Walrus.Main:Node/0')).toBe('walrus-main-node-0');
	});
});

describe('renderUrl', () => {
	it('produces http://host:port for both http and h2c', () => {
		expect(renderUrl({ protocol: 'http', hostname: 'a.b.localhost', port: 1234 })).toBe(
			'http://a.b.localhost:1234',
		);
		expect(renderUrl({ protocol: 'h2c', hostname: 'a.b.localhost', port: 1234 })).toBe(
			'http://a.b.localhost:1234',
		);
	});
});
