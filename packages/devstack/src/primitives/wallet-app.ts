// walletApp — stand up the dev-only signing server that backs
// `@mysten-incubation/devstack-wallet-panels`. Binds an HTTP listener
// (default loopback), exposes a one-shot `pairUrl` carrying a token,
// and signs transactions with the resolved Account values for the
// declared accounts. Only fit for local dev use — the signing
// endpoints aren't authenticated beyond the pairing token, and the
// allowed-origins list is the only CSRF defense.

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Effect } from 'effect';
import { Identity } from '../internal/identity.js';
import { PortAllocator } from '../internal/port-allocator.js';
import {
	routerEntrypoint,
	removeFileProvider,
	writeFileProvider,
} from '../internal/docker/router.js';
import { routerHostname, routerId } from '../internal/router-hostname.js';
import { EndpointRegistry } from '../internal/registries.js';
import { stringifyCause } from '../internal/stringify-cause.js';
import { makeTag, setPhase, type PluginTag } from '../tag.js';
import { WalletAppError } from './errors.js';
import type { Account } from './shared.js';
import { Sui } from './sui.js';

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
	readonly accounts: ReadonlyArray<PluginTag<any, Account, any, any>>;
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

export const walletApp = <const Name extends string = 'wallet-app'>(
	options: WalletAppOptions<Name>,
) => {
	const name = (options.name ?? 'wallet-app') as Name;
	return makeTag(
		name,
		Effect.gen(function* () {
			// Wait for sui to be ready before standing up the wallet server.
			yield* Sui;
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
			const port = yield* allocator
				.allocate(preferredPort)
				.pipe(
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
			// Default to loopback so signing endpoints aren't exposed to other devices
			// on the LAN (e.g. a coffee-shop network). Override via `bindAddress` for
			// devcontainers / WSL where the browser lives on a different interface.
			// Default to 0.0.0.0 so traefik (running inside a docker
			// container) can dial the wallet-app via `host.docker.internal:<port>`
			// from the devstack-router network. Without this the file-
			// provider YAML's upstream URL is unreachable and the
			// router 502s on every signing request.
			const bindAddress = options.bindAddress ?? '0.0.0.0';
			const token = randomBytesHex(16);
			// Auto-derive the routed dev-server origin from Identity so
			// non-`main` stacks don't have to enumerate
			// `test.dev.<app>.localhost` in user config. Each routed
			// hostname for `dev` AND the bare-localhost form (single-
			// stack development) is allowed; user-supplied extras are
			// merged on top.
			const identity = yield* Identity;
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
			const server = yield* Effect.tryPromise({
				try: () => startHttpServer(port, bindAddress, token, allowedOrigins, accountsByAddress),
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
						message: 'wallet-app: router entrypoint \'wallet\' not registered',
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
			const pairUrl = `${url}/?token=${token}`;

			yield* EndpointRegistry.publish({
				name: 'wallet-app',
				url,
				kind: 'wallet',
				pairUrl,
			});

			return {
				url,
				pairUrl,
				endpoint: { name: 'wallet-app', url },
				localPort: port,
			} satisfies WalletApp;
		}).pipe(Effect.withSpan(`walletApp(${name})`)),
		{
			kind: 'service',
			displayTitle: 'wallet',
			display: (s) => ({ title: 'wallet', primary: s.pairUrl }),
		},
	);
};

// Start a minimal HTTP server backing the dev-wallet DevstackSignerAdapter.
// Endpoints mirror the v3 wallet-app server:
//   GET  /api/v1/devstack/health              → { ok: true }             (auth-gated)
//   GET  /api/v1/devstack/accounts            → { accounts: [...] }      (auth-gated)
//   POST /api/v1/devstack/sign-transaction    → { suiSignature, txBytes }(auth-gated)
//   POST /api/v1/devstack/sign-personal-message → { signature, bytes }   (auth-gated)
// CORS is restricted to an explicit allowlist passed by the user.
const startHttpServer = (
	port: number,
	bindAddress: string,
	token: string,
	allowedOrigins: ReadonlyArray<string>,
	accountsByAddress: ReadonlyMap<string, Account>,
): Promise<Server> => {
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
				const auth = req.headers.authorization;
				if (auth !== `Bearer ${token}`) {
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
					void handleSignTransaction(req, res, accountsByAddress);
					return;
				}
				if (req.method === 'POST' && req.url === '/api/v1/devstack/sign-personal-message') {
					void handleSignPersonalMessage(req, res, accountsByAddress);
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
		const result = await Effect.runPromise(account.signTransaction(bytes));
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
		const result = await Effect.runPromise(account.signPersonalMessage(bytes));
		sendJson(res, 200, { signature: result.signature, bytes: result.bytes });
	} catch (cause) {
		sendJson(res, 500, {
			error: `signPersonalMessage failed: ${stringifyCause(cause)}`,
		});
	}
};

const readJsonBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
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
