// Wallet-server plugin. Adds an in-process HTTP server to the
// supervisor that exposes `ctx.accounts` to a browser-side signer
// adapter — the @mysten-incubation/dev-wallet `DevstackSignerAdapter`
// reads the service URL from the manifest and signs over HTTP, so
// private keys never enter the frontend bundle.
//
// Two actions, lifecycle-split (resolves the cold-first-run manifest
// race documented in notes/architecture-review/23-playwright-integration.md):
//
//   wallet-server.register — Register action. Allocates the host port via
//                            ctx.ports, reads or mints the bearer token,
//                            populates `ctx.registry.services` with the
//                            deterministic URL+token. Runs in apply mode
//                            (Playwright globalSetup, devstack apply, …),
//                            so the manifest carries a wallet-server entry
//                            even before the listener is up.
//
//   wallet-server.serve    — HostProcess action. Reads the URL+token from
//                            the registry (populated by register), spawns
//                            the Node `http` server, prints the paired URL.
//                            Only runs in long-running supervisor paths
//                            (`devstack up`, `devstack watch`); skipped by
//                            `applyTestSetupFilter` so test bring-up doesn't
//                            start a listener that would die on process exit.
//
//                            Adoption path: if a prior supervisor left a
//                            server listening on the same port + the persisted
//                            token, this action probes /health and trusts it
//                            instead of double-binding.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { hostProcess } from '../../actions/host-process.js';
import { register } from '../../actions/register.js';
import type { ActionRunContext } from '../../core/types.js';
import { requireLocalnetCtx } from '../../core/types.js';
import { probeUrl } from '../../helpers/probe.js';
import { definePlugin } from '../../plugin.js';
import { stackDir } from '../../runtime/active-stack.js';
import { generateToken, startWalletServer } from './server.js';

interface WalletServerPluginOptions {
	/** TCP port for the wallet HTTP server. Default 9420. */
	port?: number;
	/** Override the printed origin used in the paired URL (e.g. when proxying
	 * the dev server through a tunneling tool). Defaults to
	 * `http://localhost:<port>`. */
	publicOrigin?: string;
	/** Names of actions that must run before the server starts. Default
	 * `['accounts.fund']` so funded accounts are available before any sign
	 * request can arrive. Pass `[]` to start immediately. */
	needs?: string[];
	/** Bind address. Defaults to `127.0.0.1` so the listener is
	 * unreachable from sibling machines on the LAN. Override with
	 * `'0.0.0.0'` (or a specific NIC) only when the user knowingly
	 * accepts that exposure. */
	host?: string;
	/** Extra CORS-allowed origins on top of the dev-server origin the
	 * plugin auto-discovers from the manifest. Pass when a sibling tool
	 * (Storybook, Cypress UI) lives off the dev-server. The dev-server
	 * origin itself is added automatically; pass nothing for the default
	 * setup. `'*'` is rejected — the underlying server throws. */
	allowedOrigins?: string[];
}

const WALLET_SERVER_DEFAULT_PORT = 9420;

export const walletServer = (opts: WalletServerPluginOptions = {}) => {
	const preferredPort = opts.port ?? WALLET_SERVER_DEFAULT_PORT;
	const explicitOrigin = opts.publicOrigin;
	const needs = opts.needs ?? ['accounts.fund'];
	const host = opts.host ?? '127.0.0.1';
	const extraAllowedOrigins = opts.allowedOrigins ?? [];

	// Per-instance state (closure scope, not module scope) — two
	// `walletServer()` instances in one process don't interleave.
	let activeServer: Server | undefined;
	let activeToken: string | undefined;
	let resolvedPort: number | undefined;
	let resolvedBaseUrl: string | undefined;
	// Hot-reload: serve.run captures the running listener's
	// `setAccounts` callback so warm cycles can swap in a fresh
	// AccountsContext (new account added between cycles) without
	// restarting. `lastAccountNames` is the change-detector for
	// serve.getStatus — when the supervisor's resolved accounts list
	// drifts from what the listener last saw, we return ok:false and
	// rely on `run` to call `setActiveAccounts(ctx.accounts)`.
	let setActiveAccounts: ((accounts: import('../../core/types.js').AccountsContext) => void) | undefined;
	let lastAccountNames: readonly string[] | undefined;
	// Hot-reload for the CORS allowlist. `wallet-server.serve` only has
	// `needs: ['register']` — it can (and frequently does) start before
	// `frontend.dev-server` has registered its URL, so the initial
	// allowlist is empty and the browser's first /api/v1/devstack/*
	// fetch 403s with no Access-Control-Allow-Origin header. Each
	// supervisor cycle now re-reads `dev-server` from the registry and
	// pushes through `setAllowedOrigins` to the still-listening
	// server — `lastAllowedOrigins` is the drift detector that gates the
	// hot-reload.
	let setAllowedOrigins: ((origins: string[]) => void) | undefined;
	let lastAllowedOrigins: readonly string[] | undefined;

	/** Compute the CORS allowlist from the current registry state.
	 * `dev-server` may not be registered when `serve` first runs (it's
	 * registered by `frontend.dev-server`'s provides.registry, which can
	 * fire later); the supervisor cycle re-checks each pass and pushes
	 * through `setAllowedOrigins` when the result drifts. */
	const currentAllowedOrigins = (ctx: ActionRunContext): string[] => {
		const devServer = ctx.registry.services.find('dev-server');
		return [
			...(devServer !== undefined ? [originOf(devServer.url)] : []),
			...extraAllowedOrigins,
		];
	};

	const resolveEndpoint = async (
		ctx: ActionRunContext,
	): Promise<{ port: number; baseUrl: string }> => {
		if (ctx.network !== 'localnet') {
			throw new Error('wallet-server: localnet-only');
		}
		const [portValue] = await ctx.ports.allocate({
			slot: 'wallet-server.http',
			preferred: preferredPort,
		});
		if (portValue === undefined) {
			throw new Error('wallet-server: port allocator returned no ports');
		}
		resolvedPort = portValue;
		resolvedBaseUrl = explicitOrigin ?? `http://localhost:${portValue}`;
		return { port: portValue, baseUrl: resolvedBaseUrl };
	};

	const populateRegistry = (ctx: ActionRunContext): void => {
		if (activeToken === undefined || resolvedBaseUrl === undefined || resolvedPort === undefined) {
			return;
		}
		ctx.registry.services.register({
			name: 'wallet-server',
			kind: 'wallet-server',
			url: resolvedBaseUrl,
			port: resolvedPort,
			endpointLabel: `${resolvedBaseUrl}/?token=${activeToken}`,
		});
	};

	return definePlugin({
		name: 'wallet-server',
		actions: () => [
			register({
				name: 'register',
				needs,
				// Hint goes into the input hash (so changing the user's
				// preferred port re-runs); resolved port is a runtime
				// detail.
				inputs: { preferredPort, publicOrigin: explicitOrigin ?? null },
				provides: { registry: populateRegistry },
				getStatus: async (ctx) => {
					requireLocalnetCtx(ctx);
					const { baseUrl, port } = await resolveEndpoint(ctx);
					const persisted = readPersistedToken(ctx.appDir, ctx.stack);
					if (persisted === undefined) {
						return { ok: false, detail: 'no persisted token' };
					}
					activeToken = persisted;
					const cached = ctx.registry.services.find('wallet-server');
					const expectedLabel = `${baseUrl}/?token=${persisted}`;
					if (
						cached === undefined ||
						cached.url !== baseUrl ||
						cached.port !== port ||
						cached.endpointLabel !== expectedLabel
					) {
						return { ok: false, detail: 'registry entry stale' };
					}
					return { ok: true, detail: baseUrl };
				},
				run: async (ctx) => {
					requireLocalnetCtx(ctx);
					await resolveEndpoint(ctx);
					let token = readPersistedToken(ctx.appDir, ctx.stack);
					if (token === undefined) {
						token = generateToken();
						writePersistedToken(ctx.appDir, ctx.stack, token);
					}
					activeToken = token;
					populateRegistry(ctx);
				},
			}),
			hostProcess({
				name: 'serve',
				// Register populates URL+token in the registry; serve only
				// starts the listener once that's done. Sui.accounts is a
				// transitive need (register depends on it).
				needs: ['register'],
				inputs: { preferredPort, publicOrigin: explicitOrigin ?? null },
				// No `provides.registry` — register's hook owns the entry.
				getStatus: async (ctx) => {
					const { baseUrl } = await resolveEndpoint(ctx);
					const reachable = await probeUrl(`${baseUrl}/health`);
					if (!reachable) return { ok: false, detail: `${baseUrl} not reachable` };
					if (activeToken === undefined) {
						activeToken = readPersistedToken(ctx.appDir, ctx.stack);
						if (activeToken === undefined) {
							return { ok: false, detail: 'running but token unknown; restarting' };
						}
					}
					// Hot-reload trigger: drift between the last-seen account
					// names and the supervisor's currently-resolved list means
					// `devstack.config.ts` grew (or lost) an account. Return
					// `ok: false` and let `run` call setActiveAccounts to plumb
					// the new context into the still-listening server.
					const currentNames = ctx.accounts.names();
					if (
						setActiveAccounts !== undefined &&
						lastAccountNames !== undefined &&
						!arraysEqual(currentNames, lastAccountNames)
					) {
						return { ok: false, detail: 'accounts changed; hot-reloading' };
					}
					// Same drift gate for the CORS allowlist. The most common
					// trigger is `dev-server` arriving in the registry one
					// cycle after `serve` started — without this re-check
					// the browser's fetches stay 403'd until the user
					// restarts the supervisor.
					const currentOrigins = currentAllowedOrigins(ctx);
					if (
						setAllowedOrigins !== undefined &&
						lastAllowedOrigins !== undefined &&
						!arraysEqual(currentOrigins, lastAllowedOrigins)
					) {
						return { ok: false, detail: 'CORS allowlist changed; hot-reloading' };
					}
					return { ok: true, detail: baseUrl };
				},
				run: async (ctx) => {
					const { port, baseUrl } = await resolveEndpoint(ctx);
					const log = ctx.appendLog ?? ((line: string) => process.stdout.write(`${line}\n`));
					if (activeServer !== undefined && activeServer.listening) {
						// Warm-cycle hot-reload path: the listener is healthy but
						// `getStatus` saw new accounts. Plumb the fresh
						// `ctx.accounts` reference into the running server (next
						// /accounts list / sign request rebuilds the snapshot
						// from it) and update our drift tracker.
						if (setActiveAccounts !== undefined) {
							setActiveAccounts(ctx.accounts);
							lastAccountNames = ctx.accounts.names();
							log(`wallet-server hot-reloaded accounts: [${lastAccountNames.join(', ')}]`);
						}
						if (setAllowedOrigins !== undefined) {
							const next = currentAllowedOrigins(ctx);
							setAllowedOrigins(next);
							lastAllowedOrigins = next;
							log(`wallet-server hot-reloaded CORS allowed: [${next.join(', ') || '(none)'}]`);
						}
						return;
					}
					// Adoption path: a prior supervisor instance left a server
					// listening AND its token is on disk. Trust it instead of
					// trying to re-bind the port.
					const persistedToken = readPersistedToken(ctx.appDir, ctx.stack);
					if (persistedToken !== undefined && (await probeUrl(`${baseUrl}/health`))) {
						activeToken = persistedToken;
						log(`wallet-server adopted (existing process on ${baseUrl})`);
						return;
					}

					// Use the token populated by `register`; register's run
					// always writes one before serve runs (transitive `needs`).
					const token = persistedToken ?? generateToken();
					// Build CORS allowlist: dev-server origin from the
					// manifest (auto-discovered) plus any caller-supplied
					// extras. Without this, the browser's CORS preflight
					// from the Vite dev-server origin would be denied.
					const allowedOrigins = currentAllowedOrigins(ctx);
					const handle = await startWalletServer({
						port,
						host,
						token,
						accounts: ctx.accounts,
						allowedOrigins,
					});
					activeServer = handle.server;
					activeToken = handle.token;
					setActiveAccounts = handle.setAccounts;
					setAllowedOrigins = handle.setAllowedOrigins;
					lastAccountNames = ctx.accounts.names();
					lastAllowedOrigins = allowedOrigins;
					writePersistedToken(ctx.appDir, ctx.stack, handle.token);
					log(`wallet-server listening on ${baseUrl}`);
					if (allowedOrigins.length > 0) {
						log(`CORS allowed: ${allowedOrigins.join(', ')}`);
					} else {
						log('CORS allowed: (empty — dev-server not yet registered, will hot-reload)');
					}
					log(`pair URL: ${baseUrl}/?token=${handle.token}`);
					ctx.onShutdown?.(async () => {
						await new Promise<void>((resolve) => {
							handle.server.close(() => resolve());
							setTimeout(() => resolve(), 5_000).unref();
						});
						activeServer = undefined;
						setActiveAccounts = undefined;
						setAllowedOrigins = undefined;
						lastAccountNames = undefined;
						lastAllowedOrigins = undefined;
						// activeToken stays so a subsequent same-process cycle
						// can re-publish it without re-spawning.
					});
				},
			}),
		],
	});
};

function tokenPath(appDir: string, stack: string): string {
	return resolve(stackDir(appDir, stack), 'wallet-token');
}

function readPersistedToken(appDir: string, stack: string): string | undefined {
	try {
		const raw = readFileSync(tokenPath(appDir, stack), 'utf8').trim();
		return raw.length > 0 ? raw : undefined;
	} catch {
		return undefined;
	}
}

function writePersistedToken(appDir: string, stack: string, token: string): void {
	const path = tokenPath(appDir, stack);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
}

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return url;
	}
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
