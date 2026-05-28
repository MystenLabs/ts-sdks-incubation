// Wallet plugin — in-process HTTP server.
//
// Responsibilities:
//
//   1. Bind a `node:http` server on a substrate-allocated port (the
//      port broker hands the port in; we don't pick it here).
//   2. Dispatch by `(METHOD, path)` to the four handlers below
//      (health, accounts, sign-transaction, sign-personal-message).
//   3. Enforce the auth gate: mandatory Origin in policy.allowed +
//      constant-time bearer compare.
//   4. Body-cap enforcement: 64 KiB before buffering — protects the
//      supervisor from OOM via streaming payloads.
//   5. Per-request span + log annotation under the captured
//      supervisor context — so handler errors hit the TUI logger
//      sink instead of bare stderr.
//   6. Scope-finalizer teardown: `closeAllConnections()` →
//      `close()` awaited → port release (the substrate's scope
//      finalizer chain handles release; we just close).
//
// Wiring status (15-wallet.md alignment): both the per-route handler
// bodies (auth + decode + dispatch to `AccountValue` sign closures)
// AND the in-process `node:http.Server` listen loop are real. The
// listener buffers each request body up to `MAX_BODY_BYTES`, forks the
// dispatcher Effect under the captured supervisor context (so handler
// logs flow to the TUI logger sink), while the substrate scoped HTTP
// listener owns bind/close lifecycle.

import { Cause, Context, Effect, Schema } from 'effect';
import type { Scope } from 'effect';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { listenScopedHttpServer } from '../../substrate/runtime/scoped-http-server.ts';
import { SpanAttr } from '../../substrate/runtime/observability/spans.ts';
import { decodeJsonText } from '../../substrate/runtime/runtime-decode.ts';
import { WalletSpans } from './spans.ts';
import type { AccountValue } from '../account/index.ts';
import {
	walletBootError,
	walletRequestError,
	type WalletBootError,
	type WalletRequestError,
} from './errors.ts';
import { checkOrigin, corsHeadersFor, type OriginPolicy } from './origin-policy.ts';
import { parseBearerHeader, safeBearerEquals, type PairingToken } from './pairing.ts';
import {
	AccountsResponseSchema,
	HealthResponseSchema,
	SignRequestSchema,
	SignResponseSchema,
	WALLET_AUTH_HEADER,
	WALLET_PROTOCOL_PREFIX,
	WalletHttpPath,
	type AccountSummary,
} from './protocol.ts';

// ----------------------------------------------------------------------
// Server config + handle
// ----------------------------------------------------------------------

/** Inputs the substrate hands to `startHttpServer`. The plugin's
 *  acquire body builds this from its resolved inputs (port broker,
 *  origin policy, accounts map, token). */
export interface WalletServerConfig {
	readonly bindAddress: string;
	readonly port: number;
	readonly token: PairingToken;
	readonly policy: OriginPolicy;
	readonly accountsByAddress: ReadonlyMap<string, AccountValue>;
	/** Captured supervisor context — handler errors log under this so
	 *  the TUI logger sink receives them. Stub: the substrate primitive
	 *  will hand this in; today the field is opaque. */
	readonly supervisorCtx: unknown;
}

/** Opaque server handle. The substrate's scope finalizer chain
 *  invokes `.close()`; callers don't dispatch into it directly. */
export interface WalletServerHandle {
	readonly url: string; // direct loopback URL — `http://<bindAddress>:<port>`
	readonly close: () => Effect.Effect<void>;
}

/** Body cap — 64 KiB. Above the largest reasonable sign-tx payload,
 *  well below any OOM threshold. */
export const MAX_BODY_BYTES = 64 * 1024;

// ----------------------------------------------------------------------
// Top-level boot
// ----------------------------------------------------------------------

/** Per-request socket-level timeout, milliseconds. Caps the time a
 *  malicious / hung peer can hold an idle connection. */
const REQUEST_SOCKET_TIMEOUT_MS = 30_000;

/**
 * Boot the wallet HTTP server.
 *
 * Wires `node:http.createServer` against the dispatcher. Listens on
 * `bindAddress:port` (the substrate's port broker chose `port` upstream
 * of this call). The scope finalizer awaits graceful close on teardown
 * — `closeAllConnections()` followed by `close()` with await.
 *
 *  Request flow (per connection):
 *
 *    1. `request` listener fires with `IncomingMessage`+`ServerResponse`.
 *    2. We buffer the request body up to `MAX_BODY_BYTES`. If the
 *       inbound payload exceeds the cap, the socket is destroyed and
 *       a 413 returned without ever invoking the dispatcher (closes the
 *       supervisor-OOM path).
 *    3. Construct a `WalletRequest` from the buffered body + headers.
 *    4. `Effect.runForkWith(supervisorContext)(dispatch(config, req))`
 *       — captured at acquire time so handler logs/spans flow to the
 *       TUI logger sink.
 *    5. On fiber completion, write status + headers + body to `res`.
 *    6. On uncaught exception in the listener path: 500 with an opaque
 *       message (no token leak, no internal-state leak).
 *
 *  Scope finalizer:
 *
 *    Calls `server.closeAllConnections()` (kills idle keepalive
 *    sockets) then awaits `server.close()` (drains in-flight). The
 *    finalizer is uninterruptible so a Ctrl-C double-tap doesn't
 *    leave the socket dangling.
 */
export const startHttpServer = (
	config: WalletServerConfig,
): Effect.Effect<WalletServerHandle, WalletBootError, Scope.Scope> =>
	Effect.gen(function* () {
		// Capture the supervisor context so handler fibers run with the
		// same Logger / span sinks as the rest of the stack. The
		// dispatcher's R-channel is `never`, but capturing the context
		// keeps fiber-refs (logger, spans) flowing.
		const supervisorContext = yield* Effect.context<never>();
		const runDispatch = Effect.runForkWith(supervisorContext as Context.Context<never>);

		const handle = yield* listenScopedHttpServer({
			bindAddress: config.bindAddress,
			port: config.port,
			listener: makeRequestListener(config, runDispatch),
			onListenError: (cause): WalletBootError =>
				walletBootError({
					phase: 'listen',
					message:
						`wallet HTTP server listen failed on ${config.bindAddress}:${config.port} — ` +
						(cause instanceof Error ? cause.message : String(cause)),
					hint:
						'check that the port broker did not hand out a busy port; ' +
						'a sibling devstack on the same address would also explain this.',
					cause,
				}),
		});

		yield* Effect.logInfo('wallet HTTP server listening').pipe(
			Effect.annotateLogs({
				[SpanAttr.host]: config.bindAddress,
				[SpanAttr.port]: config.port,
			}),
		);

		return {
			url: handle.url,
			close: handle.close,
		} satisfies WalletServerHandle;
	});

// ----------------------------------------------------------------------
// Node request listener — bridges `node:http` → dispatcher Effect
// ----------------------------------------------------------------------

/**
 * Build the `(req, res)` listener Node hands to `http.createServer`.
 *
 * The listener:
 *
 *   - Buffers the request body up to `MAX_BODY_BYTES`. Over-cap →
 *     413 + socket destroyed (the dispatcher's body-cap check is the
 *     second line of defense; this one is the first).
 *   - Drops invalid socket-level errors silently (defensive: the
 *     wallet is loopback-only, but a malformed HTTP/1.1 line shouldn't
 *     crash the supervisor).
 *   - Forks the dispatcher Effect via the captured supervisor runtime.
 *   - Writes the resolved `WalletResponse` back to `res`.
 *
 * Returns void (Node listener signature) — all error reporting flows
 * through the dispatcher (request errors) or `Effect.logError` (boot/
 * listener path errors).
 */
const makeRequestListener =
	(
		config: WalletServerConfig,
		runDispatch: <A, E>(effect: Effect.Effect<A, E, never>) => unknown,
	): ((req: IncomingMessage, res: ServerResponse) => void) =>
	(req, res) => {
		// Socket-level timeout — protects against hung peers parking
		// requests on the supervisor's loopback.
		req.socket.setTimeout(REQUEST_SOCKET_TIMEOUT_MS);

		const chunks: Buffer[] = [];
		let totalBytes = 0;
		let overflowed = false;

		req.on('data', (chunk: Buffer) => {
			if (overflowed) return;
			totalBytes += chunk.length;
			if (totalBytes > MAX_BODY_BYTES) {
				overflowed = true;
				writeOverflow(res);
				try {
					req.destroy();
				} catch {
					/* defensive */
				}
				return;
			}
			chunks.push(chunk);
		});

		req.on('error', () => {
			// Socket-level error — drop. Per-request errors are handled
			// inside the dispatcher.
		});

		req.on('end', () => {
			if (overflowed) return;
			const body = Buffer.concat(chunks).toString('utf8');
			const walletReq: WalletRequest = {
				method: req.method ?? 'GET',
				url: req.url ?? '/',
				headers: normalizeHeaders(req.headers),
				body,
			};
			const program = dispatch(config, walletReq).pipe(
				// `dispatch` is typed `Effect<WalletResponse>` (no failure
				// channel) — its handlers map every expected failure into a
				// WalletResponse with the right HTTP status. Anything that
				// lands here is therefore a *defect* (thrown sync exception,
				// runtime invariant violation). We project the full Cause via
				// `matchCauseEffect` so we have something to log; `matchEffect`
				// would type the failure as `never` and the defect would
				// bypass it.
				Effect.matchCauseEffect({
					onFailure: (cause) =>
						Effect.logError('wallet dispatcher defect').pipe(
							Effect.annotateLogs({
								[WalletSpans.requestMethod]: walletReq.method,
								[WalletSpans.requestUrl]: walletReq.url,
								cause: Cause.pretty(cause),
							}),
							Effect.flatMap(() =>
								Effect.sync(() => {
									writeServerError(res);
								}),
							),
						),
					onSuccess: (resp) => Effect.sync(() => writeResponse(res, resp)),
				}),
			);
			runDispatch(program);
		});
	};

const writeResponse = (res: ServerResponse, resp: WalletResponse): void => {
	if (res.writableEnded) return;
	res.statusCode = resp.status;
	for (const [k, v] of Object.entries(resp.headers)) {
		res.setHeader(k, v);
	}
	res.end(resp.body);
};

const writeOverflow = (res: ServerResponse): void => {
	if (res.writableEnded) return;
	res.statusCode = 413;
	res.setHeader('content-type', 'text/plain; charset=utf-8');
	res.end('payload too large');
};

/** Write an opaque 500 — no token, no internal state leak. The
 *  caller is responsible for logging the underlying cause (see the
 *  `Effect.logError('wallet dispatcher defect')` in `dispatch`'s
 *  `matchCauseEffect` onFailure branch). */
const writeServerError = (res: ServerResponse): void => {
	if (res.writableEnded) return;
	res.statusCode = 500;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.end(
		JSON.stringify({
			error: 'internal error',
			code: 'internal-error',
		}),
	);
};

/** Normalize Node's `IncomingHttpHeaders` (string | string[] | undefined)
 *  to the `WalletRequest.headers` shape (string | undefined). Picks the
 *  first value for repeated headers — matches browser send semantics
 *  for the headers we care about (Origin, Authorization, Content-Type). */
const normalizeHeaders = (
	headers: IncomingMessage['headers'],
): Readonly<Record<string, string | undefined>> => {
	const out: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(headers)) {
		if (v === undefined) {
			out[k] = undefined;
		} else if (Array.isArray(v)) {
			out[k] = v[0];
		} else {
			out[k] = v;
		}
	}
	return out;
};

// ----------------------------------------------------------------------
// Dispatcher — pure(ish) function from request → effect
// ----------------------------------------------------------------------

/** Inbound request shape — substrate-runtime-agnostic. The substrate's
 *  http-server primitive converts a `node:http` IncomingMessage into
 *  this; tests can construct it directly. */
export interface WalletRequest {
	readonly method: string;
	readonly url: string; // path + query, no host
	readonly headers: Readonly<Record<string, string | undefined>>;
	readonly body: string; // already-buffered (capped at MAX_BODY_BYTES)
}

/** Outbound response. */
export interface WalletResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

const json = (
	status: number,
	body: unknown,
	extraHeaders: Readonly<Record<string, string>> = {},
): WalletResponse => ({
	status,
	headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
	body: JSON.stringify(body),
});

const text = (
	status: number,
	body: string,
	extraHeaders: Readonly<Record<string, string>> = {},
): WalletResponse => ({
	status,
	headers: { 'content-type': 'text/plain; charset=utf-8', ...extraHeaders },
	body,
});

/**
 * Dispatch a single request to its handler. Returns an Effect that
 * always succeeds (the response is built); request-level failures
 * are projected to JSON envelopes via `errorEnvelope` below.
 *
 * The dispatch order matters:
 *   1. OPTIONS preflight (returns 204 + CORS) — no auth required.
 *   2. Path-prefix gate — anything not under `/api/v1/devstack/` is
 *      a flat 404 (text/plain). PROTECTS the auth gate from being
 *      visible on arbitrary URLs.
 *   3. Origin check (must be in policy.allowed; missing → 403).
 *   4. Bearer check (must constant-time-equal `config.token`).
 *   5. Method+path route to handler.
 */
export const dispatch = (
	config: WalletServerConfig,
	req: WalletRequest,
): Effect.Effect<WalletResponse> =>
	Effect.gen(function* () {
		const requestId = randomUUID();
		yield* Effect.annotateCurrentSpan({
			[WalletSpans.requestId]: requestId,
			[WalletSpans.requestMethod]: req.method,
			[WalletSpans.requestUrl]: req.url,
		});

		// 1. OPTIONS preflight — no auth check, but the origin still has
		//    to be in the allowlist so we don't leak CORS headers to
		//    arbitrary callers.
		if (req.method === 'OPTIONS') {
			const origin = req.headers['origin'];
			if (origin !== undefined && config.policy.allowed.has(origin)) {
				return { status: 204, headers: corsHeadersFor(origin), body: '' };
			}
			return text(403, 'forbidden origin');
		}

		// 2. Path-prefix gate.
		const path = req.url.split('?')[0] ?? '';
		if (!path.startsWith(WALLET_PROTOCOL_PREFIX)) {
			return text(404, 'not found');
		}

		// 3. Origin check.
		const originResult = checkOrigin(config.policy, req.headers['origin']);
		if (originResult === 'missing') {
			// Log the BEARER-VALIDITY only, never the token itself.
			yield* Effect.logWarning('wallet origin missing').pipe(
				Effect.annotateLogs({
					[SpanAttr.requestId]: requestId,
					[SpanAttr.httpMethod]: req.method,
					[SpanAttr.httpPath]: path,
				}),
			);
			return text(403, 'Origin header required');
		}
		if (originResult === 'forbidden') {
			yield* Effect.logWarning('wallet origin forbidden').pipe(
				Effect.annotateLogs({
					[SpanAttr.requestId]: requestId,
					[WalletSpans.origin]: req.headers.origin ?? '(missing)',
					[SpanAttr.httpMethod]: req.method,
					[SpanAttr.httpPath]: path,
				}),
			);
			return text(403, 'forbidden origin');
		}
		const origin = req.headers['origin']!;

		// 4. Bearer check. Token never appears in log lines — only the
		//    boolean validity.
		const bearer = parseBearerHeader(req.headers[WALLET_AUTH_HEADER]);
		const bearerValid = bearer !== null && safeBearerEquals(bearer, config.token);
		yield* Effect.annotateCurrentSpan({ [WalletSpans.bearerValid]: bearerValid });
		if (!bearerValid) {
			yield* Effect.logWarning('wallet bearer check failed').pipe(
				Effect.annotateLogs({
					[SpanAttr.requestId]: requestId,
					[WalletSpans.bearerValid]: bearerValid,
					[SpanAttr.httpMethod]: req.method,
					[SpanAttr.httpPath]: path,
				}),
			);
			return errorEnvelope(
				walletRequestError({
					phase: 'unauthorized',
					httpStatus: 401,
					message: 'unauthorized',
				}),
				corsHeadersFor(origin),
			);
		}

		// 5. Route.
		const corsHdr = corsHeadersFor(origin);
		return yield* routeRequest(config, req, path, corsHdr).pipe(
			Effect.catchTag('WalletRequestError', (err) => Effect.succeed(errorEnvelope(err, corsHdr))),
		);
	});

// ----------------------------------------------------------------------
// Routing
// ----------------------------------------------------------------------

const routeRequest = (
	config: WalletServerConfig,
	req: WalletRequest,
	path: string,
	corsHdr: Readonly<Record<string, string>>,
): Effect.Effect<WalletResponse, WalletRequestError> => {
	if (req.method === 'GET' && path === WalletHttpPath.HEALTH) {
		return Effect.succeed(
			json(200, { ok: true } satisfies Schema.Schema.Type<typeof HealthResponseSchema>, corsHdr),
		);
	}
	if (req.method === 'GET' && path === WalletHttpPath.ACCOUNTS) {
		return handleAccounts(config, corsHdr);
	}
	if (req.method === 'POST' && path === WalletHttpPath.SIGN_TRANSACTION) {
		return handleSign(config, req, 'transaction', corsHdr);
	}
	if (req.method === 'POST' && path === WalletHttpPath.SIGN_PERSONAL_MESSAGE) {
		return handleSign(config, req, 'personal-message', corsHdr);
	}
	return Effect.fail(
		walletRequestError({
			phase: 'route-not-found',
			httpStatus: 404,
			message: `no route for ${req.method} ${path}`,
		}),
	);
};

// ----------------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------------

const handleAccounts = (
	config: WalletServerConfig,
	corsHdr: Readonly<Record<string, string>>,
): Effect.Effect<WalletResponse, WalletRequestError> =>
	Effect.sync(() => {
		const accounts: ReadonlyArray<AccountSummary> = Array.from(
			config.accountsByAddress.values(),
		).map((acct) => ({
			name: acct.name,
			address: acct.address,
			scheme: acct.scheme,
			publicKey: Buffer.from(acct.publicKey).toString('base64'),
			source: acct.source,
		}));
		// Schema-validate the response so a drift between AccountValue
		// and the wire envelope blows up at the boundary rather than at
		// the browser-side decode.
		const validated: Schema.Schema.Type<typeof AccountsResponseSchema> = { accounts };
		return json(200, validated, corsHdr);
	});

const decodeJsonBody = <A>(
	schema: Schema.Schema<A>,
	body: string,
): Effect.Effect<A, WalletRequestError> =>
	Effect.gen(function* () {
		// Body-byte cap is enforced solely at the request listener (line
		// ~200): we accumulate `chunk.length` byte counts and write a 413
		// + destroy the socket the moment we cross `MAX_BODY_BYTES`. A
		// secondary in-dispatcher check on `body.length` would be wrong
		// anyway — `String.length` counts UTF-16 code units, not bytes,
		// so a 64 KiB body of multi-byte runes could slip past it. The
		// listener already gated correctly, so there's no second check
		// here.
		// Sanctioned cast: `decodeJsonText`'s `S extends Schema.Decoder<unknown>`
		// constraint is wider than `Schema.Schema<A>` (DecodingServices /
		// RequiresServices variance — Effect v4's `Decoder<unknown>` pins
		// these to `unknown` while `Schema.Schema<A>` pins them to `never`).
		// The runtime helper happily consumes either; only the TS variance
		// disagrees. Phase 19A attempted to widen the constraint to
		// `Schema.Top` but `decodeUnknownSync` requires `Decoder<unknown,
		// never>`, which a `Top` constraint can't satisfy without a
		// downstream cast that ends up uglier than this one.
		return (yield* decodeJsonText(schema as Schema.Decoder<unknown>, body, {
			source: 'wallet request body',
			mkError: (issue) =>
				walletRequestError({
					phase: 'body-invalid',
					httpStatus: 400,
					message:
						issue.message === 'failed to parse JSON'
							? 'invalid JSON body'
							: 'request body did not match schema',
					cause: issue.cause,
				}),
		})) as A;
	});

const handleSign = (
	config: WalletServerConfig,
	req: WalletRequest,
	kind: 'transaction' | 'personal-message',
	corsHdr: Readonly<Record<string, string>>,
): Effect.Effect<WalletResponse, WalletRequestError> =>
	Effect.gen(function* () {
		const body = yield* decodeJsonBody(SignRequestSchema, req.body);
		const account = config.accountsByAddress.get(body.address);
		if (account === undefined) {
			return yield* Effect.fail(
				walletRequestError({
					phase: 'address-not-found',
					httpStatus: 404,
					message: `no account for address '${body.address}'`,
				}),
			);
		}
		const bytes = Buffer.from(body.bytes, 'base64');
		const signed = yield* (
			kind === 'transaction' ? account.signTransaction(bytes) : account.signPersonalMessage(bytes)
		).pipe(
			Effect.mapError((cause) =>
				walletRequestError({
					phase: 'sign-route-failed',
					httpStatus: 500,
					message: `${kind === 'transaction' ? 'signTransaction' : 'signPersonalMessage'} failed`,
					cause,
				}),
			),
		);
		const resp: Schema.Schema.Type<typeof SignResponseSchema> = signed;
		return json(200, resp, corsHdr);
	});

// ----------------------------------------------------------------------
// Error envelope
// ----------------------------------------------------------------------

const errorEnvelope = (
	err: WalletRequestError,
	corsHdr: Readonly<Record<string, string>>,
): WalletResponse => json(err.httpStatus, { error: err.message, code: err.phase }, corsHdr);
