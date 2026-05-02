// Wallet-server plugin. Adds an in-process HTTP server to the
// supervisor that exposes `ctx.accounts` to a browser-side signer
// adapter — the @mysten-incubation/dev-wallet `DevstackSignerAdapter`
// reads the service URL from the manifest and signs over HTTP, so
// private keys never enter the frontend bundle.
//
// One Service action:
//
//   wallet-server.serve — Starts a Node `http` server on the configured
//                         port. `getStatus` HEAD-probes `/health`; `run`
//                         spawns the server (idempotent, restarts on
//                         port reuse), prints the paired URL with a
//                         random bearer token, and registers
//                         `wallet-server` in `ctx.registry.services` so
//                         the manifest carries the URL the frontend reads.
//                         A shutdown hook closes the server gracefully on
//                         supervisor stop.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { hostProcess } from '../../actions/host-process.js';
import type { ActionRunContext } from '../../core/types.js';
import { requireLocalnetCtx } from '../../core/types.js';
import { definePlugin } from '../../plugin.js';
import { stackDir } from '../../runtime/active-stack.js';
import { startWalletServer } from './server.js';

export interface WalletServerPluginOptions {
	/** TCP port for the wallet HTTP server. Default 9420. */
	port?: number;
	/** Override the printed origin used in the paired URL (e.g. when proxying
	 * the dev server through a tunneling tool). Defaults to
	 * `http://localhost:<port>`. */
	publicOrigin?: string;
	/** Names of actions that must run before the server starts. Default
	 * `['sui.accounts']` so funded accounts are available before any sign
	 * request can arrive. Pass `[]` to start immediately. */
	needs?: string[];
}

export const WALLET_SERVER_DEFAULT_PORT = 9420;

export const walletServer = (opts: WalletServerPluginOptions = {}) => {
	const preferredPort = opts.port ?? WALLET_SERVER_DEFAULT_PORT;
	const explicitOrigin = opts.publicOrigin;
	const needs = opts.needs ?? ['sui.accounts'];

	// Per-instance state (closure scope, not module scope) — two
	// `walletServer()` instances in one process don't interleave.
	let activeServer: Server | undefined;
	let activeToken: string | undefined;
	let resolvedPort: number | undefined;
	let resolvedBaseUrl: string | undefined;

	const resolveEndpoint = async (
		ctx: ActionRunContext,
	): Promise<{ port: number; baseUrl: string }> => {
		if (ctx.network !== 'localnet') {
			throw new Error('wallet-server: localnet-only');
		}
		const [port] = await ctx.ports.allocate({
			slot: 'wallet-server.http',
			preferred: preferredPort,
		});
		const portValue = port as number;
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
			hostProcess({
				name: 'serve',
				needs,
				// Hint goes into the input hash (so changing the user's
				// preferred port re-runs); resolved port is a runtime
				// detail.
				inputs: { preferredPort, publicOrigin: explicitOrigin ?? null },
				provides: { registry: populateRegistry },
				getStatus: async (ctx) => {
					requireLocalnetCtx(ctx);
					const { baseUrl } = await resolveEndpoint(ctx);
					const reachable = await probeUrl(`${baseUrl}/health`);
					if (!reachable) return { ok: false, detail: `${baseUrl} not reachable` };
					// We need a token to publish in the registry's
					// endpointLabel. If we don't have one in memory and
					// none is persisted, the running server is from a
					// prior process whose token we lost — fail status so
					// `run` restarts with a known token.
					if (activeToken === undefined) {
						activeToken = readPersistedToken(ctx.appDir, ctx.stack);
						if (activeToken === undefined) {
							return { ok: false, detail: 'running but token unknown; restarting' };
						}
					}
					return { ok: true, detail: baseUrl };
				},
				run: async (ctx) => {
					requireLocalnetCtx(ctx);
					const { port, baseUrl } = await resolveEndpoint(ctx);
					const log = ctx.appendLog ?? ((line: string) => process.stdout.write(`${line}\n`));
					if (activeServer !== undefined && activeServer.listening) {
						// Idempotent — supervisor cycles call run again on warm
						// paths if getStatus says not-reachable. Don't double-bind
						// the port; the existing instance races the probe.
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

					const handle = startWalletServer({ port, accounts: ctx.accounts });
					activeServer = handle.server;
					activeToken = handle.token;
					writePersistedToken(ctx.appDir, ctx.stack, handle.token);
					log(`wallet-server listening on ${baseUrl}`);
					log(`pair URL: ${baseUrl}/?token=${handle.token}`);
					ctx.onShutdown?.(async () => {
						await new Promise<void>((resolve) => {
							handle.server.close(() => resolve());
							setTimeout(() => resolve(), 5_000).unref();
						});
						activeServer = undefined;
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
	writeFileSync(path, `${token}\n`, 'utf8');
}

async function probeUrl(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { method: 'GET' });
		return res.ok;
	} catch {
		return false;
	}
}
