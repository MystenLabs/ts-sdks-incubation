import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { Effect, SubscriptionRef } from 'effect';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

import { emptyDashboardDomain } from '../../../src/plugins/dashboard/domain.ts';
import type { OriginPolicy } from '../../../src/plugins/dashboard/origin-policy.ts';
import { makeDashboardListener } from '../../../src/plugins/dashboard/server.ts';
import {
	isLoopbackAddress,
	SUI_CLIENT_PROTOCOL_VERSION_HEADER,
	SUI_GRAPHQL_PROXY_PATH,
	suiGraphqlProxyUrl,
} from '../../../src/plugins/dashboard/sui-graphql-proxy.ts';
import { emptyControlPlaneDomain } from '../../../src/substrate/runtime/control-plane/domain.ts';
import { emptyProjection } from '../../../src/substrate/runtime/projection/state-ref.ts';
import { withTempRootAsync } from '../../helpers/with-temp-root.ts';

const ALLOWED_ORIGIN = 'http://api.dashboard-demo.localhost:9810';
const ORIGIN_POLICY: OriginPolicy = { allowed: new Set([ALLOWED_ORIGIN]) };
const SECRET = 'Bearer s3cret';

interface SeenRequest {
	readonly headers: IncomingHttpHeaders;
	readonly body: string;
}

interface Harness {
	/** The relay's URL on the dashboard listener. */
	readonly proxyUrl: string;
	/** The dashboard's control-plane GraphQL endpoint. */
	readonly controlUrl: string;
	/** Requests the fake upstream received, in order. */
	readonly seen: ReadonlyArray<SeenRequest>;
}

const listen = async (server: Server): Promise<number> => {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return (server.address() as AddressInfo).port;
};

const close = (server: Server): Promise<void> =>
	new Promise((resolve) => server.close(() => resolve()));

/** Run `body` against a dashboard listener whose relay forwards to a fake
 *  upstream. `configured: false` models a sui plugin without
 *  `graphqlHeaders`; `peerAddress` overrides the TCP peer every request
 *  appears to come from (the listener itself is on loopback). */
const withProxy = (
	opts: { readonly configured?: boolean; readonly peerAddress?: string },
	body: (harness: Harness) => Promise<void>,
): Promise<void> =>
	withTempRootAsync('devstack-dashboard-proxy', async (assetsDir) => {
		writeFileSync(join(assetsDir, 'index.html'), '<div id="root"></div>', 'utf8');
		const seen: SeenRequest[] = [];
		const upstream = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({ data: { chainIdentifier: 'abc' } }));
			});
		});
		const upstreamUrl = `http://127.0.0.1:${await listen(upstream)}/graphql`;

		const configured = opts.configured ?? true;
		const listener = makeDashboardListener({
			assetsDir,
			originPolicy: ORIGIN_POLICY,
			context: {
				state: Effect.runSync(SubscriptionRef.make(emptyProjection())),
				publishCommand: () => Effect.void,
				submitCommand: () => Effect.void,
				domain: emptyControlPlaneDomain,
				pluginDomain: {
					...emptyDashboardDomain,
					suiGraphqlUpstream: Effect.succeed(
						configured ? { url: upstreamUrl, headers: { authorization: SECRET } } : null,
					),
				},
				suiGraphqlProxyUrl: 'http://127.0.0.1:1234/sui-graphql',
			},
		});
		const dashboard = createServer((req, res) => {
			if (opts.peerAddress !== undefined) {
				Object.defineProperty(req.socket, 'remoteAddress', { value: opts.peerAddress });
			}
			listener(req, res);
		});
		const port = await listen(dashboard);
		try {
			await body({
				proxyUrl: `http://127.0.0.1:${port}${SUI_GRAPHQL_PROXY_PATH}`,
				controlUrl: `http://127.0.0.1:${port}/graphql`,
				seen,
			});
		} finally {
			await close(dashboard);
			await close(upstream);
		}
	});

const post = (
	url: string,
	headers: Record<string, string>,
	body = '{"query":"{ chainIdentifier }"}',
) =>
	fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

describe('sui-graphql proxy helpers', () => {
	it('advertises the relay on the loopback interface', () => {
		expect(SUI_GRAPHQL_PROXY_PATH).toBe('/sui-graphql');
		expect(suiGraphqlProxyUrl(39300)).toBe('http://127.0.0.1:39300/sui-graphql');
	});

	it.each([
		['127.0.0.1', true],
		['127.4.5.6', true],
		['::1', true],
		['::ffff:127.0.0.1', true],
		['192.168.1.20', false],
		['::ffff:192.168.1.20', false],
		['172.17.0.2', false],
		['fe80::1', false],
		[undefined, false],
	])('isLoopbackAddress(%s) is %s', (address, expected) => {
		expect(isLoopbackAddress(address)).toBe(expected);
	});
});

describe('dashboard sui-graphql proxy', () => {
	it('relays a real SuiGraphQLClient query with the configured credentials', () =>
		withProxy({}, async ({ proxyUrl, seen }) => {
			// The SDK client exactly as the SPA builds it — pins the protocol
			// header name the relay must forward, and the body passthrough.
			const client = new SuiGraphQLClient({
				url: proxyUrl,
				network: 'localnet',
				headers: { origin: ALLOWED_ORIGIN },
			});
			const result = await client.query({ query: '{ chainIdentifier }', variables: {} });
			expect(result.data).toEqual({ chainIdentifier: 'abc' });
			expect(seen).toHaveLength(1);
			expect(seen[0]!.headers.authorization).toBe(SECRET);
			expect(seen[0]!.headers[SUI_CLIENT_PROTOCOL_VERSION_HEADER]).toMatch(/^\d+$/);
		}));

	it('drops client headers outside the allowlist, so credentials cannot be overridden', () =>
		withProxy({}, async ({ proxyUrl, seen }) => {
			const res = await post(proxyUrl, {
				origin: ALLOWED_ORIGIN,
				authorization: 'Bearer attacker',
				cookie: 'session=1',
			});
			expect(res.status).toBe(200);
			expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
			expect(seen[0]!.headers.authorization).toBe(SECRET);
			expect(seen[0]!.headers.cookie).toBeUndefined();
		}));

	it('refuses a non-loopback peer even with an allowlisted (forgeable) Origin', () =>
		withProxy({ peerAddress: '192.168.1.20' }, async ({ proxyUrl, seen }) => {
			const res = await post(proxyUrl, { origin: ALLOWED_ORIGIN });
			expect(res.status).toBe(403);
			expect(await res.text()).toContain('only loopback clients');
			expect(seen).toHaveLength(0);
		}));

	it('accepts an IPv4-mapped loopback peer (dual-stack listener)', () =>
		withProxy({ peerAddress: '::ffff:127.0.0.1' }, async ({ proxyUrl }) => {
			expect((await post(proxyUrl, { origin: ALLOWED_ORIGIN })).status).toBe(200);
		}));

	it('refuses a missing or foreign Origin without contacting the upstream', () =>
		withProxy({}, async ({ proxyUrl, seen }) => {
			expect((await post(proxyUrl, {})).status).toBe(403);
			expect((await post(proxyUrl, { origin: 'https://evil.example.com' })).status).toBe(403);
			expect(seen).toHaveLength(0);
		}));

	it('allows the headers SuiGraphQLClient sends in the CORS preflight', () =>
		withProxy({}, async ({ proxyUrl }) => {
			const res = await fetch(proxyUrl, {
				method: 'OPTIONS',
				headers: {
					origin: ALLOWED_ORIGIN,
					'access-control-request-method': 'POST',
					'access-control-request-headers': `content-type, ${SUI_CLIENT_PROTOCOL_VERSION_HEADER}`,
				},
			});
			expect(res.status).toBe(204);
			expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
			const allowed = (res.headers.get('access-control-allow-headers') ?? '')
				.split(',')
				.map((h) => h.trim());
			expect(allowed).toEqual(
				expect.arrayContaining(['content-type', SUI_CLIENT_PROTOCOL_VERSION_HEADER]),
			);
		}));

	it('answers an oversized body with a 413 the client actually receives', () =>
		withProxy({}, async ({ proxyUrl, seen }) => {
			const res = await post(proxyUrl, { origin: ALLOWED_ORIGIN }, 'x'.repeat(1024 * 1024 + 1));
			expect(res.status).toBe(413);
			expect(await res.json()).toEqual({
				errors: [{ message: expect.stringContaining('exceeds') }],
			});
			expect(seen).toHaveLength(0);
		}));

	it('404s when the sui plugin has no graphqlHeaders', () =>
		withProxy({ configured: false }, async ({ proxyUrl }) => {
			expect((await post(proxyUrl, { origin: ALLOWED_ORIGIN })).status).toBe(404);
		}));
});

describe('dashboard schema suiGraphqlProxyUrl', () => {
	const query = async (controlUrl: string) => {
		const res = await post(controlUrl, {}, JSON.stringify({ query: '{ suiGraphqlProxyUrl }' }));
		return ((await res.json()) as { data?: { suiGraphqlProxyUrl?: string | null } }).data
			?.suiGraphqlProxyUrl;
	};

	it('advertises the relay URL while graphqlHeaders are configured', () =>
		withProxy({}, async ({ controlUrl }) => {
			expect(await query(controlUrl)).toBe('http://127.0.0.1:1234/sui-graphql');
		}));

	it('is null when the browser should read the endpoint directly', () =>
		withProxy({ configured: false }, async ({ controlUrl }) => {
			expect(await query(controlUrl)).toBeNull();
		}));
});
