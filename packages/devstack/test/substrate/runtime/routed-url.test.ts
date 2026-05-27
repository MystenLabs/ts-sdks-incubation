// Substrate-blind URL composer + routed-hostname accessor coverage.
//
// `routed-url.ts` is the L2-facing seam that replaced
// `orchestrators/router/hostname.ts:renderUrl + routerHostname` (B1).
// We assert the URL composer's scheme/port/path handling and the
// routedHostname Effect against the same architecture invariants the
// orchestrator-side test covers (default-stack omission, non-default
// stack composition, dot-folding, character-class validation).

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { appName, chainId, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import {
	DEFAULT_STACK,
	HostnameValidationError,
	normalizeServiceSegment,
	renderUrl,
	routedHostname,
} from '../../../src/substrate/runtime/routed-url.ts';

const identity = (stack: string): Identity => ({
	app: appName('my-app'),
	stack: stackName(stack),
	chain: chainId('sui:localnet'),
});

describe('renderUrl', () => {
	it('renders http with port', () => {
		expect(renderUrl({ protocol: 'http', hostname: 'foo.localhost', port: 80 })).toBe(
			'http://foo.localhost:80',
		);
	});

	it('appends an explicit path verbatim (leading slash supplied by caller)', () => {
		expect(
			renderUrl({
				protocol: 'http',
				hostname: 'foo.localhost',
				port: 39200,
				path: '/health',
			}),
		).toBe('http://foo.localhost:39200/health');
	});

	it('renders h2c as http:// (Traefik handles h2c upstream selection internally)', () => {
		expect(renderUrl({ protocol: 'h2c', hostname: 'a.b.localhost', port: 1234 })).toBe(
			'http://a.b.localhost:1234',
		);
	});

	it('renders https:// when protocol is https', () => {
		expect(renderUrl({ protocol: 'https', hostname: 'a.b.localhost', port: 8443 })).toBe(
			'https://a.b.localhost:8443',
		);
	});

	it('renders tcp:// for tcp upstreams (file-provider distinguishes wire family)', () => {
		expect(renderUrl({ protocol: 'tcp', hostname: 'a.b.localhost', port: 5432 })).toBe(
			'tcp://a.b.localhost:5432',
		);
	});
});

describe('routedHostname', () => {
	it.effect('default stack omits the stack segment', () =>
		Effect.gen(function* () {
			const host = yield* routedHostname(identity(DEFAULT_STACK), 'api');
			expect(host).toBe('api.my-app.localhost');
		}),
	);

	it.effect('non-default stack keeps the role segment first', () =>
		Effect.gen(function* () {
			const host = yield* routedHostname(identity('feature-x'), 'api');
			expect(host).toBe('api.feature-x.my-app.localhost');
		}),
	);

	it.effect('parallel stacks mint distinct hostnames for the same role (invariant #7)', () =>
		Effect.gen(function* () {
			const a = yield* routedHostname(identity('main'), 'wallet-app');
			const b = yield* routedHostname(identity('feature-x'), 'wallet-app');
			const c = yield* routedHostname(identity('feature-y'), 'wallet-app');
			expect(new Set([a, b, c]).size).toBe(3);
		}),
	);

	it.effect('folds dots in role to hyphens before assembly (invariant #8)', () =>
		Effect.gen(function* () {
			const host = yield* routedHostname(identity('main'), 'walrus.node.0');
			expect(host).toBe('walrus-node-0.my-app.localhost');
		}),
	);

	it.effect('rejects roles with disallowed characters via HostnameValidationError', () =>
		routedHostname(identity('main'), 'has space').pipe(
			Effect.flip,
			Effect.tap((err) => {
				expect(err).toBeInstanceOf(HostnameValidationError);
				expect(err.field).toBe('hostname');
				return Effect.void;
			}),
		),
	);
});

describe('normalizeServiceSegment', () => {
	it('lower-cases and replaces dots', () => {
		expect(normalizeServiceSegment('Walrus.Node.0')).toBe('walrus-node-0');
	});
});
