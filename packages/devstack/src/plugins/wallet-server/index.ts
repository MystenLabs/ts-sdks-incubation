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

import type { Server } from 'node:http';
import { service } from '../../actions/service.js';
import { requireLocalnetCtx } from '../../core/types.js';
import { definePlugin } from '../../plugin.js';
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

let activeServer: Server | undefined;
let activeToken: string | undefined;

export const walletServer = (opts: WalletServerPluginOptions = {}) => {
	const port = opts.port ?? WALLET_SERVER_DEFAULT_PORT;
	const baseUrl = opts.publicOrigin ?? `http://localhost:${port}`;
	const needs = opts.needs ?? ['sui.accounts'];

	return definePlugin({
		name: 'wallet-server',
		actions: () => [
			service({
				name: 'serve',
				needs,
				inputs: { port, baseUrl },
				getStatus: async () => {
					const reachable = await probeUrl(`${baseUrl}/health`);
					if (!reachable) return { ok: false, detail: `${baseUrl} not reachable` };
					return { ok: true, detail: baseUrl };
				},
				run: async (ctx) => {
					requireLocalnetCtx(ctx);
					const log = ctx.appendLog ?? ((line: string) => process.stdout.write(`${line}\n`));
					if (activeServer !== undefined && activeServer.listening) {
						// Idempotent: warm cycles re-run when getStatus says
						// not-reachable. Don't double-bind the port; the existing
						// instance races the probe.
						registerService(ctx, baseUrl, port, activeToken ?? '');
						return;
					}
					const handle = startWalletServer({ port, accounts: ctx.accounts });
					activeServer = handle.server;
					activeToken = handle.token;
					log(`wallet-server listening on ${baseUrl}`);
					log(`pair URL: ${baseUrl}/?token=${handle.token}`);
					ctx.onShutdown?.(async () => {
						await new Promise<void>((resolve) => {
							handle.server.close(() => resolve());
							setTimeout(() => resolve(), 5_000).unref();
						});
						activeServer = undefined;
						activeToken = undefined;
					});
					registerService(ctx, baseUrl, port, handle.token);
				},
			}),
		],
	});
};

function registerService(
	ctx: { registry: import('../../core/types.js').Registry },
	url: string,
	port: number,
	token: string,
): void {
	ctx.registry.services.register({
		name: 'wallet-server',
		kind: 'wallet-server',
		url,
		port,
		endpointLabel: token === '' ? undefined : `${url}/?token=${token}`,
	});
}

async function probeUrl(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { method: 'GET' });
		return res.ok;
	} catch {
		return false;
	}
}
