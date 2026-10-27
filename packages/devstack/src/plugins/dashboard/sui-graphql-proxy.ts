// Dashboard Sui GraphQL proxy.
//
// The SPA reads the node's Sui GraphQL straight from the browser. When the
// sui plugin is configured with `graphqlHeaders` (e.g. an `Authorization`
// token for a hosted GraphQL provider), those credentials must not be shipped
// to the browser, so the SPA POSTs to this same-origin route instead and the
// server forwards the body to the configured upstream with the headers
// attached.
//
// Hardening:
//   - The upstream URL is fixed by the resolved sui value; the request can
//     never choose where it is forwarded (no SSRF surface).
//   - Only the request BODY is forwarded — no client headers — so the browser
//     can't override or observe the configured credentials.
//   - Requests must carry an allowlisted `Origin` (browsers always send one on
//     POST). Unlike `/graphql`, a missing Origin is refused: the only
//     legitimate caller is the SPA, and this route spends the user's
//     credentials.
//   - The route 404s when no headers are configured — the browser reads the
//     endpoint directly then, so the proxy has nothing to add.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Effect } from 'effect';
import { checkOrigin, type OriginPolicy } from './origin-policy.ts';
import type { DashboardDomain } from './domain.ts';

/** Same-origin path the SPA POSTs Sui GraphQL queries to when
 *  `suiGraphqlProxied` is true. Mirrored in the dashboard app's
 *  `sui-graphql.ts`; pinned by `server.test.ts`. */
export const SUI_GRAPHQL_PROXY_PATH = '/sui-graphql';

/** Request-body cap. Sui GraphQL queries are small documents; anything larger
 *  is a misuse of the relay. */
const MAX_BODY_BYTES = 1024 * 1024;

const UPSTREAM_TIMEOUT_MS = 30_000;

/** GraphQL-shaped error body, so the SDK client surfaces `message` as-is. */
const sendError = (res: ServerResponse, status: number, message: string): void => {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.end(JSON.stringify({ errors: [{ message }] }));
};

const readBody = (req: IncomingMessage): Promise<Buffer | null> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				resolve(null);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
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
	const origin = req.headers.origin;
	if (checkOrigin(deps.originPolicy, origin) !== 'ok') {
		sendError(res, 403, 'sui-graphql proxy: origin not allowed');
		return;
	}
	res.setHeader('access-control-allow-origin', origin as string);
	res.setHeader('vary', 'Origin');

	if (req.method === 'OPTIONS') {
		res.statusCode = 204;
		res.setHeader('access-control-allow-methods', 'POST');
		res.setHeader('access-control-allow-headers', 'content-type');
		res.end();
		return;
	}
	if (req.method !== 'POST') {
		res.setHeader('allow', 'POST, OPTIONS');
		sendError(res, 405, 'sui-graphql proxy: only POST is supported');
		return;
	}

	const upstream = await Effect.runPromise(deps.pluginDomain.suiGraphqlUpstream);
	if (upstream === null) {
		sendError(res, 404, 'sui-graphql proxy: no graphqlHeaders configured on the sui plugin');
		return;
	}

	const body = await readBody(req);
	if (body === null) {
		sendError(res, 413, `sui-graphql proxy: request body exceeds ${MAX_BODY_BYTES} bytes`);
		return;
	}

	let response: Response;
	try {
		response = await fetch(upstream.url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
				...upstream.headers,
			},
			body: new Uint8Array(body),
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
		});
	} catch (cause) {
		// Name the upstream, never the headers.
		sendError(
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
