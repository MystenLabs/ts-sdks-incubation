// Dashboard Sui GraphQL proxy.
//
// The SPA reads the node's Sui GraphQL straight from the browser. When the
// sui plugin is configured with `graphqlHeaders` (e.g. an `Authorization`
// token for a hosted GraphQL provider), those credentials must not be shipped
// to the browser, so the SPA POSTs to this route instead and the server
// forwards the body to the configured upstream with the headers attached.
//
// Hardening:
//   - LOOPBACK PEERS ONLY. The dashboard listener binds `0.0.0.0` so the
//     Dockerised router can reach it, which also exposes it to the LAN. An
//     `Origin` check is browser CSRF protection, not caller authentication —
//     any non-browser client can forge it — so the relay additionally refuses
//     every connection whose TCP peer is not loopback. The SPA reaches the
//     relay through the direct loopback URL (`suiGraphql.url`), never
//     through the router. Containers that can reach the host's loopback
//     (e.g. via Docker Desktop's host networking) are not excluded by this.
//   - The upstream URL is fixed by the resolved sui value; the request can
//     never choose where it is forwarded (no SSRF surface).
//   - Only the body and an explicit header allowlist are forwarded, so the
//     browser can't override or observe the configured credentials.
//   - Requests must also carry an allowlisted `Origin` (browsers always send
//     one on POST and on CORS preflights), so a page on another origin can't
//     drive the relay through the developer's browser.
//   - The route 404s when no headers are configured — the browser reads the
//     endpoint directly then, so the proxy has nothing to add.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Effect } from 'effect';
import { checkOrigin, type OriginPolicy } from './origin-policy.ts';
import type { DashboardDomain, DashboardSuiGraphql } from './domain.ts';

/** Path of the relay on the dashboard listener. The SPA never builds this
 *  itself — the control plane hands it the URL to query (`suiGraphql.url`). */
export const SUI_GRAPHQL_PROXY_PATH = '/sui-graphql';

/** Request header `SuiGraphQLClient` sends to tell the server the highest
 *  protocol version whose types it can decode. Not exported by
 *  `@mysten/sui`; pinned by the proxy test, which drives the real client. */
export const SUI_CLIENT_PROTOCOL_VERSION_HEADER = 'x-sui-client-protocol-version';

/** Client request headers the relay forwards upstream (besides the body).
 *  Everything else the browser sends is dropped. */
const FORWARDED_REQUEST_HEADERS = [SUI_CLIENT_PROTOCOL_VERSION_HEADER] as const;

/** Request-body cap. Sui GraphQL queries are small documents; anything larger
 *  is a misuse of the relay. */
const MAX_BODY_BYTES = 1024 * 1024;

const UPSTREAM_TIMEOUT_MS = 30_000;

/** Whether reads of `graphql` must go through the relay: only when there are
 *  credentials to attach. Shared by the relay's 404 and the URL the control
 *  plane advertises, so the two can't disagree. */
export const needsRelay = (graphql: DashboardSuiGraphql): boolean =>
	Object.keys(graphql.headers).length > 0;

/** Loopback URL of the relay for a dashboard listening on `port`. */
export const suiGraphqlProxyUrl = (port: number): string =>
	`http://127.0.0.1:${port}${SUI_GRAPHQL_PROXY_PATH}`;

/** Whether a socket's `remoteAddress` is a loopback peer (IPv4 `127/8`, IPv6
 *  `::1`, or an IPv4-mapped loopback address on a dual-stack listener). */
export const isLoopbackAddress = (address: string | undefined): boolean => {
	if (address === undefined) return false;
	const v4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
	return v4.startsWith('127.') || address === '::1';
};

/** GraphQL-shaped error body, so the SDK client surfaces `message` as-is.
 *  The one error envelope every relay failure goes through. */
export const sendProxyError = (res: ServerResponse, status: number, message: string): void => {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.end(JSON.stringify({ errors: [{ message }] }));
};

/** Buffer the request body, or `null` once it exceeds `MAX_BODY_BYTES`. An
 *  oversized body is drained rather than destroyed so the 413 still reaches
 *  the client. */
const readBody = (req: IncomingMessage): Promise<Buffer | null> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let overflowed = false;
		req.on('data', (chunk: Buffer) => {
			if (overflowed) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				overflowed = true;
				chunks.length = 0;
				resolve(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (!overflowed) resolve(Buffer.concat(chunks));
		});
		req.on('error', reject);
	});

/** Handle one request to `SUI_GRAPHQL_PROXY_PATH`. */
export const handleSuiGraphqlProxy = async (
	req: IncomingMessage,
	res: ServerResponse,
	deps: {
		readonly originPolicy: OriginPolicy;
		readonly pluginDomain: DashboardDomain;
	},
): Promise<void> => {
	if (!isLoopbackAddress(req.socket.remoteAddress)) {
		sendProxyError(res, 403, 'sui-graphql proxy: only loopback clients are allowed');
		return;
	}
	const origin = req.headers.origin;
	if (checkOrigin(deps.originPolicy, origin) !== 'ok') {
		sendProxyError(res, 403, 'sui-graphql proxy: origin not allowed');
		return;
	}
	res.setHeader('access-control-allow-origin', origin as string);
	res.setHeader('vary', 'Origin');

	if (req.method === 'OPTIONS') {
		res.statusCode = 204;
		res.setHeader('access-control-allow-methods', 'POST');
		res.setHeader(
			'access-control-allow-headers',
			['content-type', ...FORWARDED_REQUEST_HEADERS].join(', '),
		);
		res.end();
		return;
	}
	if (req.method !== 'POST') {
		res.setHeader('allow', 'POST, OPTIONS');
		sendProxyError(res, 405, 'sui-graphql proxy: only POST is supported');
		return;
	}

	const upstream = await Effect.runPromise(deps.pluginDomain.suiGraphql);
	if (upstream.state !== 'ready' || !needsRelay(upstream)) {
		sendProxyError(res, 404, 'sui-graphql proxy: no graphqlHeaders configured on the sui plugin');
		return;
	}

	const body = await readBody(req);
	if (body === null) {
		res.setHeader('connection', 'close');
		sendProxyError(res, 413, `sui-graphql proxy: request body exceeds ${MAX_BODY_BYTES} bytes`);
		return;
	}

	// `Headers.set` so configured values replace defaults and forwarded
	// headers case-insensitively — spreading plain objects would keep
	// `Content-Type` and `content-type` as two keys, which `fetch` joins.
	const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
	for (const name of FORWARDED_REQUEST_HEADERS) {
		const value = req.headers[name];
		if (typeof value === 'string') headers.set(name, value);
	}
	for (const [name, value] of Object.entries(upstream.headers)) {
		headers.set(name, value);
	}

	let response: Response;
	try {
		response = await fetch(upstream.url, {
			method: 'POST',
			headers,
			body: new Uint8Array(body),
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
		});
	} catch (cause) {
		// Name the upstream, never the headers.
		sendProxyError(
			res,
			502,
			`sui-graphql proxy: upstream ${upstream.url} unreachable: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		);
		return;
	}

	res.statusCode = response.status;
	res.setHeader(
		'content-type',
		response.headers.get('content-type') ?? 'application/json; charset=utf-8',
	);
	res.end(Buffer.from(await response.arrayBuffer()));
};
