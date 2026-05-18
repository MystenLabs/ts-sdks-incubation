// walletApp — stand up the dev-only signing server consumed by the
// in-page dev wallet adapter. Binds an HTTP listener (default loopback),
// exposes a one-shot `pairUrl` carrying a token, and signs transactions
// with the resolved Account values for the declared accounts. Only fit
// for local dev use — the signing endpoints aren't authenticated beyond
// the pairing token, and the allowed-origins list is the only CSRF
// defense.

import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join as joinPath } from 'node:path';
import { Context, Effect } from 'effect';
import { writeFileAtomic } from '../../engine/atomic-write.js';
import { Identity } from '../../engine/identity.js';
import { PortAllocator } from '../../engine/port-allocator.js';
import {
	routerEntrypoint,
	removeFileProvider,
	writeFileProvider,
} from '../../engine/docker/router.js';
import { routerHostname, routerId } from '../../engine/router-hostname.js';
import { EndpointRegistry } from '../../engine/registries.js';
import { RUNTIME_DIR_NAME, servicePath } from '../../engine/service-paths.js';
import { StateStoreConfig } from '../../engine/state-store.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { tag, setPhase, type Ref } from '../../advanced/tag.js';
import { WalletAppError } from '../../engine/errors.js';
import type { Account } from '../../engine/shared.js';
import { EndpointName } from '../../runtime/endpoint-names.js';
import { SuiTag } from '../sui.js';

export interface WalletApp {
	readonly url: string;
	readonly pairUrl: string;
	readonly endpoint: { readonly name: string; readonly url: string };
	/**
	 * Local 127.0.0.1 port the wallet-app server actually binds.
	 * The public `url` is the router-fronted hostname URL; this is
	 * the upstream port traefik proxies TO. Surfaced for tests that
	 * need to re-bind the port after a scope close to assert the
	 * finalizer cleanup is correct.
	 */
	readonly localPort: number;
}

export interface WalletAppOptions<Name extends string> {
	/** Tag name for this primitive. Defaults to `'wallet-app'`. */
	readonly name?: Name;
	/**
	 * Accounts whose signers the wallet exposes for browser-driven
	 * signing. Each tag is yielded for ordering (so accounts are funded
	 * before the server accepts traffic) and the resolved `Account`
	 * value is keyed by address into the sign handler.
	 */
	readonly accounts: ReadonlyArray<Ref<any, Account, any, any>>;
	/**
	 * Extra CORS origins to accept on the signing endpoints, on top of
	 * the auto-derived `http://dev.<app>.localhost` (and stack-scoped
	 * variants for non-`main` stacks) plus `http://localhost`. Pass the
	 * exact origin (scheme + host + port) of any browser surface that
	 * pairs with the wallet — devstack rejects everything else.
	 */
	readonly allowedOrigins?: ReadonlyArray<string>;
	/**
	 * Preferred host port. Routed through `PortAllocator`, so a sibling
	 * stack already holding the preferred number causes a forward scan.
	 * Defaults to 5180. The actual bound port surfaces on the resolved
	 * tag's `localPort`; the public `url` is the router-fronted URL.
	 */
	readonly port?: number;
	/**
	 * Network interface the HTTP server binds. Defaults to `'0.0.0.0'`
	 * so traefik (running inside docker) can reach the wallet via
	 * `host.docker.internal:<port>`. Override to `'127.0.0.1'` for
	 * non-router setups, or to a specific interface for devcontainers /
	 * WSL where the browser lives on a different network.
	 */
	readonly bindAddress?: string;
}

export const walletApp = <const Name extends string = typeof EndpointName.WALLET_APP>(
	options: WalletAppOptions<Name>,
) => {
	const name = (options.name ?? EndpointName.WALLET_APP) as Name;
	return tag(
		name,
		Effect.gen(function* () {
			// Wait for sui to be ready before standing up the wallet server.
			yield* SuiTag;
			// Resolve each account tag — both for ordering (so accounts have been
			// funded/registered before the wallet server is callable) and so we
			// can wire the resolved Account values into the sign handler. Key by
			// address (v3 endpoints look accounts up by address, not by name).
			const accountsByAddress = new Map<string, Account>();
			for (const acc of options.accounts) {
				const account = yield* acc;
				accountsByAddress.set(account.address, account);
			}

			// Run the preferred port through the shared `PortAllocator` so
			// two stacks (or sibling examples whose supervisors share a
			// host) can boot side-by-side without stepping on each other's
			// 5180. The allocator scans forward from the preferred port
			// when it's already bound by another process.
			const allocator = yield* PortAllocator;
			const preferredPort = options.port ?? 5180;
			const port = yield* allocator.allocate(preferredPort).pipe(
				Effect.catchTag('PortAllocatorError', (cause) =>
					Effect.fail(
						new WalletAppError({
							phase: 'listen',
							message: `wallet-app: could not allocate port near ${preferredPort}: ${cause.message}`,
							cause,
						}),
					),
				),
			);
			// HIGH-SEC1: default to `127.0.0.1` so signing endpoints aren't
			// exposed to other devices on the LAN. Modern Docker Desktop
			// on macOS routes `host.docker.internal` traffic through the
			// host loopback (the gateway-NAT path was retired in 4.x), so
			// a 127.0.0.1-bound listener IS reachable from the traefik
			// container. Linux dockerd with `host.docker.internal`
			// configured via `--add-host` behaves the same way. Override
			// via `bindAddress: '0.0.0.0'` for devcontainers / WSL where
			// the browser lives on a different network interface; the
			// CSRF defense (mandatory Origin header on signing endpoints,
			// Phase 8 / C12) does the actual heavy lifting either way.
			const bindAddress = options.bindAddress ?? '127.0.0.1';
			// Auto-derive the routed dev-server origin from Identity so
			// non-`main` stacks don't have to enumerate
			// `test.dev.<app>.localhost` in user config. Each routed
			// hostname for `dev` AND the bare-localhost form (single-
			// stack development) is allowed; user-supplied extras are
			// merged on top.
			const identity = yield* Identity;
			// Pre-resolve the token path so we can read-existing-or-mint.
			// Snapshot restore extracts a previous run's token verbatim;
			// reading it instead of always re-minting means the browser-
			// side pairing the user already completed before the snapshot
			// keeps working without a re-pair UX after restore.
			const stateStoreCfgOpt = yield* Effect.serviceOption(StateStoreConfig);
			const tokenPath =
				stateStoreCfgOpt._tag === 'Some'
					? yield* servicePath('wallet', 'token').pipe(
							Effect.provideService(StateStoreConfig, stateStoreCfgOpt.value),
						)
					: joinPath(
							process.env.DEVSTACK_APP_DIR ?? process.cwd(),
							'.devstack',
							'stacks',
							identity.stack,
							RUNTIME_DIR_NAME,
							'wallet',
							'token',
						);
			const token = yield* readExistingTokenOrMint(tokenPath);
			const devHostname = routerHostname(identity, 'dev');
			const devEntrypoint = routerEntrypoint('vite');
			const defaultAllowedOrigins: ReadonlyArray<string> = [
				devEntrypoint !== undefined ? `http://${devHostname}:${devEntrypoint.port}` : '',
				`http://localhost:${devEntrypoint?.port ?? 5175}`,
			].filter((s) => s.length > 0);
			const allowedOrigins: ReadonlyArray<string> = [
				...defaultAllowedOrigins,
				...(options.allowedOrigins ?? []),
			];

			yield* setPhase('starting http server');
			// Capture the supervisor's Context once so signing handlers can
			// run their Account effects via `Effect.runPromiseWith(ctx)` —
			// otherwise each request runs on a fresh default runtime, losing
			// the TUI logger sink, tracer, and any FiberRefs the supervisor
			// had set. `Effect.context<never>()` type-claims an empty context
			// but at runtime returns the full current fiber context (see
			// effect internals: `getContext = withFiber((fiber) => fiber.context)`),
			// which is what we want to thread to a long-lived HTTP handler.
			const supervisorCtx = yield* Effect.context<never>();
			const server = yield* Effect.tryPromise({
				try: () =>
					startHttpServer(
						port,
						bindAddress,
						token,
						allowedOrigins,
						accountsByAddress,
						supervisorCtx,
					),
				catch: (cause) =>
					new WalletAppError({
						phase: 'listen',
						message: `failed to start wallet server on port ${port}: ${String(cause)}`,
						cause,
					}),
			});
			yield* Effect.annotateCurrentSpan({ 'wallet.port': port, 'wallet.bind': bindAddress });
			// Tear down on scope close. `server.close()` alone stops
			// accepting new connections but waits indefinitely for existing
			// keep-alive sockets to drain — a browser tab from the dev
			// wallet holding an open `fetch` keeps the port bound after
			// the supervisor exits, and the next example's `pnpm dev`
			// then hits `EADDRINUSE: 127.0.0.1:5180`. Force-close
			// connections first, then `await` the close callback so the
			// port is verifiably released before the finalizer returns.
			yield* Effect.addFinalizer(() =>
				Effect.callback<void>((resume) => {
					// `closeAllConnections` exists on Node 18.2+ — devstack
					// requires Node >= 24, so it's always present.
					(server as { closeAllConnections?: () => void }).closeAllConnections?.();
					server.close(() => resume(allocator.release(port)));
				}),
			);

			// Router-fronted public URL. The wallet-app is a Node
			// host process (not a docker container), so we drop a
			// file-provider YAML under `~/.devstack/traefik/dynamic/`
			// pointing traefik at `host.docker.internal:<localPort>`.
			// Browsers resolve `*.localhost` to 127.0.0.1, hit the
			// router on the well-known wallet entrypoint port (5180),
			// and the router forwards by `Host:` header to this
			// process. `identity` was resolved above for the auto-
			// `allowedOrigins` derivation; reuse the same handle here.
			const walletHostname = routerHostname(identity, 'wallet');
			const walletEntrypointInfo = routerEntrypoint('wallet');
			if (walletEntrypointInfo === undefined) {
				return yield* Effect.fail(
					new WalletAppError({
						phase: 'listen',
						message: "wallet-app: router entrypoint 'wallet' not registered",
					}),
				);
			}
			const walletRouterId = routerId(identity, 'wallet');
			yield* writeFileProvider({
				id: walletRouterId,
				hostname: walletHostname,
				entrypoint: 'wallet',
				upstreamUrl: `http://host.docker.internal:${port}`,
			}).pipe(
				Effect.catchTag('DockerError', (cause) =>
					Effect.logWarning(
						`wallet-app: file-provider YAML write failed (continuing on direct port): ${cause.message}`,
					),
				),
			);
			yield* Effect.addFinalizer(() => removeFileProvider(walletRouterId));

			const url = `http://${walletHostname}:${walletEntrypointInfo.port}`;
			// C13: token rides in the URL fragment, not a query param.
			// Fragments are NOT sent to the server (so they can't land
			// in access logs) and most browsers don't write them to
			// referrer headers. Adapter code on the page reads the
			// fragment and stashes the token in sessionStorage before
			// the hash is replaced.
			const pairUrl = `${url}/#token=${token}`;

			// Token persistence is handled inline at boot via
			// `readExistingTokenOrMint`: if the file is already present
			// (warm start or snapshot restore) we reuse the same token
			// so existing dev-wallet pairings keep working; otherwise we
			// mint a fresh one and write it.

			yield* EndpointRegistry.publish({
				name: EndpointName.WALLET_APP,
				url,
				kind: 'wallet',
				pairUrl,
			});

			return {
				url,
				pairUrl,
				endpoint: { name: EndpointName.WALLET_APP, url },
				localPort: port,
			} satisfies WalletApp;
		}).pipe(Effect.withSpan(`walletApp(${name})`)),
		{
			kind: 'service',
			displayTitle: 'wallet',
			// Redact the token from the TUI primary so a screen
			// recording / scrollback / over-the-shoulder doesn't leak
			// signing capability. The full `pairUrl` (with token) is
			// still in the manifest under `app.wallet.pairUrl` for
			// programmatic consumers.
			display: (s) => ({ title: 'wallet', primary: redactToken(s.pairUrl) }),
		},
	);
};

const redactToken = (pairUrl: string): string => {
	// Match either fragment (post-C13) or query (legacy / external) forms.
	return pairUrl
		.replace(/#token=[^&]+/i, '#token=<redacted>')
		.replace(/[?&]token=[^&]+/i, (m) => `${m[0]}token=<redacted>`);
};

// Start a minimal HTTP server backing the dev-wallet DevstackSignerAdapter.
// Endpoints mirror the v3 wallet-app server:
//   GET  /api/v1/devstack/health              → { ok: true }             (auth-gated)
//   GET  /api/v1/devstack/accounts            → { accounts: [...] }      (auth-gated)
//   POST /api/v1/devstack/sign-transaction    → { suiSignature, txBytes }(auth-gated)
//   POST /api/v1/devstack/sign-personal-message → { signature, bytes }   (auth-gated)
// CORS is restricted to an explicit allowlist passed by the user.
// Constant-time bearer compare — prevents a remote attacker from
// inferring the token byte-by-byte via timing differences. `===` on
// strings short-circuits at the first mismatch.
const safeBearerEquals = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
};

// Hard upper bound on signing-endpoint POST body size. Sign-tx /
// sign-personal-message inputs are tiny (a few KB at most) — capping
// at 64 KiB makes the signing surface immune to a `POST` flood that
// streams gigabytes of body to OOM the supervisor process.
const MAX_BODY_BYTES = 64 * 1024;

const startHttpServer = (
	port: number,
	bindAddress: string,
	token: string,
	allowedOrigins: ReadonlyArray<string>,
	accountsByAddress: ReadonlyMap<string, Account>,
	supervisorCtx: Context.Context<never>,
): Promise<Server> => {
	const expectedAuth = `Bearer ${token}`;
	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			const origin = req.headers.origin;
			if (origin !== undefined && !allowedOrigins.includes(origin)) {
				res.writeHead(403, { 'content-type': 'text/plain' });
				res.end('forbidden origin');
				return;
			}
			if (origin !== undefined) {
				res.setHeader('access-control-allow-origin', origin);
				res.setHeader('access-control-allow-headers', 'authorization,content-type');
				res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
			}
			if (req.method === 'OPTIONS') {
				res.writeHead(204);
				res.end();
				return;
			}
			if (req.url?.startsWith('/api/v1/devstack/')) {
				// C12: require an Origin header on every signing request.
				// The CORS allowlist above is fail-open when Origin is
				// absent — non-browser tooling (curl, service workers,
				// `file://`-served pages) sends no Origin and would sail
				// through with only the bearer-token check. Requiring
				// Origin on the signing path closes that bypass; the
				// allowlist still gates which origins are acceptable.
				if (origin === undefined) {
					res.writeHead(403, { 'content-type': 'text/plain' });
					res.end('Origin header required');
					return;
				}
				const auth = req.headers.authorization;
				if (auth === undefined || !safeBearerEquals(auth, expectedAuth)) {
					res.writeHead(401, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ error: 'unauthorized' }));
					return;
				}
				if (req.method === 'GET' && req.url === '/api/v1/devstack/health') {
					sendJson(res, 200, { ok: true });
					return;
				}
				if (req.method === 'GET' && req.url === '/api/v1/devstack/accounts') {
					handleAccounts(res, accountsByAddress);
					return;
				}
				if (req.method === 'POST' && req.url === '/api/v1/devstack/sign-transaction') {
					void handleSignTransaction(req, res, accountsByAddress, supervisorCtx);
					return;
				}
				if (req.method === 'POST' && req.url === '/api/v1/devstack/sign-personal-message') {
					void handleSignPersonalMessage(req, res, accountsByAddress, supervisorCtx);
					return;
				}
				res.writeHead(404, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: `no route for ${req.method} ${req.url}` }));
				return;
			}
			res.writeHead(404);
			res.end('not found');
		});
		server.on('error', reject);
		server.listen(port, bindAddress, () => resolve(server));
	});
};

const handleAccounts = (
	res: ServerResponse,
	accountsByAddress: ReadonlyMap<string, Account>,
): void => {
	const accounts = Array.from(accountsByAddress.values(), (a) => ({
		name: a.name,
		address: a.address,
		scheme: a.scheme,
		publicKey: Buffer.from(a.publicKey).toString('base64'),
	}));
	sendJson(res, 200, { accounts });
};

const handleSignTransaction = async (
	req: IncomingMessage,
	res: ServerResponse,
	accountsByAddress: ReadonlyMap<string, Account>,
	supervisorCtx: Context.Context<never>,
): Promise<void> => {
	let body: Record<string, unknown>;
	try {
		body = await readJsonBody(req);
	} catch (cause) {
		sendJson(res, 400, {
			error: `invalid request body: ${stringifyCause(cause)}`,
		});
		return;
	}
	const address = body['address'];
	const txBytes = body['txBytes'];
	if (typeof address !== 'string' || address.length === 0) {
		sendJson(res, 400, { error: 'address must be a non-empty string' });
		return;
	}
	if (typeof txBytes !== 'string' || txBytes.length === 0) {
		sendJson(res, 400, { error: 'txBytes must be a non-empty base64 string' });
		return;
	}
	const account = accountsByAddress.get(address);
	if (account === undefined) {
		sendJson(res, 404, { error: `no account for address '${address}'` });
		return;
	}
	let bytes: Buffer;
	try {
		bytes = Buffer.from(txBytes, 'base64');
	} catch (cause) {
		sendJson(res, 400, {
			error: `txBytes is not valid base64: ${stringifyCause(cause)}`,
		});
		return;
	}
	try {
		const result = await Effect.runPromiseWith(supervisorCtx)(
			account.signTransaction(bytes).pipe(
				Effect.withSpan('wallet.sign-transaction', {
					attributes: { 'account.name': account.name, 'account.address': account.address },
				}),
			),
		);
		sendJson(res, 200, { suiSignature: result.signature, txBytes: result.bytes });
	} catch (cause) {
		sendJson(res, 500, {
			error: `signTransaction failed: ${stringifyCause(cause)}`,
		});
	}
};

const handleSignPersonalMessage = async (
	req: IncomingMessage,
	res: ServerResponse,
	accountsByAddress: ReadonlyMap<string, Account>,
	supervisorCtx: Context.Context<never>,
): Promise<void> => {
	let body: Record<string, unknown>;
	try {
		body = await readJsonBody(req);
	} catch (cause) {
		sendJson(res, 400, {
			error: `invalid request body: ${stringifyCause(cause)}`,
		});
		return;
	}
	const address = body['address'];
	const message = body['message'] ?? body['messageBytes'];
	if (typeof address !== 'string' || address.length === 0) {
		sendJson(res, 400, { error: 'address must be a non-empty string' });
		return;
	}
	if (typeof message !== 'string' || message.length === 0) {
		sendJson(res, 400, { error: 'message must be a non-empty base64 string' });
		return;
	}
	const account = accountsByAddress.get(address);
	if (account === undefined) {
		sendJson(res, 404, { error: `no account for address '${address}'` });
		return;
	}
	let bytes: Buffer;
	try {
		bytes = Buffer.from(message, 'base64');
	} catch (cause) {
		sendJson(res, 400, {
			error: `message is not valid base64: ${stringifyCause(cause)}`,
		});
		return;
	}
	try {
		const result = await Effect.runPromiseWith(supervisorCtx)(
			account.signPersonalMessage(bytes).pipe(
				Effect.withSpan('wallet.sign-personal-message', {
					attributes: { 'account.name': account.name, 'account.address': account.address },
				}),
			),
		);
		sendJson(res, 200, { signature: result.signature, bytes: result.bytes });
	} catch (cause) {
		sendJson(res, 500, {
			error: `signPersonalMessage failed: ${stringifyCause(cause)}`,
		});
	}
};

const readJsonBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
	// HIGH-SEC2: cap the body size BEFORE buffering. An unbounded
	// `for await` on the request body would let a malicious /
	// runaway client stream gigabytes of payload into the supervisor
	// process, OOM-ing the host. 64 KiB is well above the largest
	// expected sign-tx body (a few KB) and small enough to be benign
	// even under a bot flood.
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
		total += buf.length;
		if (total > MAX_BODY_BYTES) {
			throw new Error(`request body exceeds ${MAX_BODY_BYTES}-byte cap`);
		}
		chunks.push(buf);
	}
	const raw = Buffer.concat(chunks).toString('utf8');
	if (raw.length === 0) return {};
	const parsed = JSON.parse(raw) as unknown;
	if (parsed === null || typeof parsed !== 'object') {
		throw new Error('body must be a JSON object');
	}
	return parsed as Record<string, unknown>;
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
};

const randomBytesHex = (n: number): string => randomBytes(n).toString('hex');

const TOKEN_HEX_RE = /^[0-9a-f]+$/;

/** Reuse the existing wallet token if `runtime/wallet/token` is on disk;
 *  otherwise mint a fresh 16-byte hex token and write it (mode 0o600).
 *
 *  Persistence rationale: the dev-wallet adapter pairs against
 *  `pairUrl?token=...` once per session and stashes the token in
 *  sessionStorage. If we re-mint the token every boot, every restart
 *  (and every snapshot restore) invalidates the pairing — the user gets
 *  a "wallet not paired" UX even though they completed the pairing
 *  moments ago. Reading the existing file means warm starts AND
 *  snapshot restores reuse the same token, so the existing pairing
 *  keeps working. Snapshot save tars the file under
 *  `runtime/wallet/token`, restore puts it back, this read-existing
 *  path finds it.
 *
 *  Failures fall back to minting a fresh token + best-effort write.
 *  Logged at warn level rather than failing the supervisor — without
 *  the file, the manifest pairUrl still carries the token via the URL
 *  fragment, so the browser-side flow degrades to "must pair every
 *  boot" rather than breaking entirely. */
const readExistingTokenOrMint = (tokenPath: string): Effect.Effect<string, never, never> =>
	Effect.gen(function* () {
		const existing = yield* Effect.tryPromise({
			try: () => nodeFs.readFile(tokenPath, 'utf8'),
			catch: () => undefined,
		}).pipe(Effect.catch(() => Effect.succeed(undefined as string | undefined)));
		if (typeof existing === 'string') {
			const trimmed = existing.trim();
			// Sanity-check the on-disk shape: 32 hex chars (= randomBytesHex(16)).
			// Anything else triggers a re-mint — guards against truncated
			// writes or unrelated junk that happened to land at this path.
			if (trimmed.length === 32 && TOKEN_HEX_RE.test(trimmed)) {
				return trimmed;
			}
		}
		const token = randomBytesHex(16);
		yield* Effect.tryPromise({
			try: () => writeFileAtomic(tokenPath, token, { mode: 0o600 }),
			catch: (cause) => cause,
		}).pipe(
			Effect.catch((cause) =>
				// Log the PATH, not the token. `stringifyCause` only ever
				// sees the underlying I/O error (ENOSPC, EROFS, etc.) —
				// the token string is never passed to it. The pairUrl
				// fragment is the only place the token transits, and that
				// goes only to the manifest (0o600 on the file too, via
				// writeFileAtomicIfChanged elsewhere).
				Effect.logWarning(
					`walletApp: failed to write token file at ${tokenPath} ` +
						`(continuing; manifest pairUrl still carries the token): ${stringifyCause(cause)}`,
				),
			),
		);
		return token;
	});
