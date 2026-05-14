// `walletApp` — in-process HTTP signer endpoint backing the dev-wallet
// `DevstackSignerAdapter`. Exposes a fixed list of named signers so a
// browser-side adapter can list addresses and request transaction
// signatures without ever loading private keys into the frontend bundle.
//
// Caller passes `accounts: [{ name, signer: pool.get('signer', { name }) }, …]`
// — each entry resolves the Dep to a live `Signer` at start time. Adding
// or removing an account in `devstack.config.ts` flips the input hash
// and triggers a clean restart with the new signer set; the bearer
// token persists across restarts via `<stackDir>/wallet-token` so the
// frontend's stored pair URL keeps working.
//
// `walletApp.get('endpoint')` is a static Dep returning the `Endpoint`
// shape — feed it to `manifest({ endpoints: [...] })` so the frontend
// discovers the wallet server URL alongside sui-rpc and friends.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Signer } from '@mysten/sui/cryptography';
import type { Dep, Provides } from '../../engine/types.js';
import { dep } from '../../factories/dep.js';
import { defineSchema, type SchemaInstanceConfig } from '../../factories/define-schema.js';
import { ports } from '../../standard/ports.js';
import type { Endpoint } from '../../shapes/index.js';
import { generateToken, startWalletServer, type WalletServerHandle } from './server.js';

export const WALLET_APP_PORT_SLOT = 'walletApp.http';

export interface WalletAppAccount {
	name: string;
	signer: Dep<Signer>;
}

export interface WalletAppOptions {
	/** Accounts to expose. Each entry pairs a logical name with a Dep
	 * returning a `Signer` — typically `pool.get('signer', { name })`
	 * from the `accounts` plugin. */
	accounts: WalletAppAccount[];
	/** Dev-server origin to fold into the CORS allowlist. Pass as a Dep
	 * (e.g. from `viteDevServer.get('origin')`) so the wallet-app
	 * restarts cleanly when the dev server's port changes. */
	devServerOrigin?: Dep<string>;
	/** Extra static origins on top of `devServerOrigin`. Useful for
	 * sibling tooling (Storybook, separate test harness) that lives off
	 * the dev server. */
	allowedOrigins?: string[];
	/** Override the printed origin in the paired URL (e.g. when
	 * proxying through a tunneling tool). Defaults to
	 * `http://localhost:<port>`. */
	publicOrigin?: string;
	/** Bind address. Default `127.0.0.1` so the listener is unreachable
	 * from sibling LAN hosts. Override with `'0.0.0.0'` only when
	 * knowingly accepting that exposure. */
	host?: string;
	/** Max request body size in bytes. Default 2 MB. */
	maxBodyBytes?: number;
}

export interface WalletAppState {
	url: string;
	token: string;
	port: number;
}

const provides = {
	url: dep((s: WalletAppState) => s.url),
	token: dep((s: WalletAppState) => s.token),
	port: dep((s: WalletAppState) => s.port),
	/** Pair URL the user clicks to bind the frontend's adapter to this
	 * server (token in query string). */
	pairUrl: dep((s: WalletAppState) => `${s.url}/?token=${s.token}`),
	/** `Endpoint` shape for the `manifest` plugin's `endpoints:` list.
	 *  Sets `pairUrl` so the dev-wallet adapter (or any other consumer)
	 *  can parse the bearer token out of the manifest entry. */
	endpoint: dep(
		(s: WalletAppState): Endpoint => ({
			name: 'wallet-app',
			url: s.url,
			kind: 'wallet-app',
			pairUrl: `${s.url}/?token=${s.token}`,
		}),
	),
	full: dep((s: WalletAppState) => s),
} satisfies Provides<WalletAppState>;

export const walletApp = defineSchema<WalletAppOptions, WalletAppState, typeof provides>({
	id: 'walletApp',
	provides,
	create: (opts): SchemaInstanceConfig<WalletAppState, typeof provides, any> => {
		if (opts.accounts.length === 0) {
			throw new Error('walletApp: at least one account is required');
		}
		const host = opts.host ?? '127.0.0.1';
		const explicitOrigin = opts.publicOrigin;
		const staticAllowedOrigins = opts.allowedOrigins ?? [];

		// Per-instance closure: tracks the running listener so a warm
		// cycle with unchanged inputs can reuse it, and an input-hash
		// change can close the old server cleanly before binding a new
		// one. Closure-per-instance (not module) means two `walletApp`
		// instances in one process can't collide — though the schema
		// currently enforces a single instance per stack.
		let active: WalletServerHandle | undefined;

		// Flat array of { name, signer-Dep }. ResolveDep walks arrays
		// and objects, so at `start()` time `deps.accounts` is
		// `{ name: string; signer: Signer }[]` — no manual unwrap.
		const accountDeps = opts.accounts.map((a) => ({ name: a.name, signer: a.signer }));

		const deps = {
			port: ports.get('allocate', { slot: WALLET_APP_PORT_SLOT }),
			accounts: accountDeps,
			...(opts.devServerOrigin !== undefined ? { devServerOrigin: opts.devServerOrigin } : {}),
		};

		return {
			name: 'walletApp',
			deps,
			inputs: ({ deps }) => {
				const resolved = deps as ResolvedWalletAppDeps;
				return {
					host,
					publicOrigin: explicitOrigin ?? null,
					accountNames: resolved.accounts.map((a) => a.name).sort(),
					accountAddresses: resolved.accounts
						.map((a) => a.signer.toSuiAddress())
						.sort(),
					allowedOrigins: computeAllowedOrigins(
						resolved.devServerOrigin,
						staticAllowedOrigins,
					).sort(),
					// Port stays out of the input hash on purpose: warm
					// restarts reuse the prior allocation, and a port
					// re-allocation shouldn't be the trigger for a restart
					// (that would loop).
				};
			},
			start: async ({ deps, env, log, onShutdown }) => {
				const resolved = deps as ResolvedWalletAppDeps;
				const allowedOrigins = computeAllowedOrigins(
					resolved.devServerOrigin,
					staticAllowedOrigins,
				);

				// Warm-cycle fast path: same listener, same shape, just
				// keep going. The engine only invokes start when the
				// input hash flips, so reaching here with `active` set
				// means an external trigger (file watcher with no
				// content change, etc.).
				if (active !== undefined && active.server.listening) {
					return { url: active.url, token: active.token, port: resolved.port };
				}

				const persisted = await readPersistedToken(env.appDir, env.stack);
				const token = persisted ?? generateToken();
				if (persisted === undefined) {
					await writePersistedToken(env.appDir, env.stack, token);
				}

				const signers = resolved.accounts.map((a) => ({ name: a.name, signer: a.signer }));
				const handle = await startWalletServer({
					port: resolved.port,
					host,
					token,
					signers,
					allowedOrigins,
					...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
				});
				active = handle;

				const url = explicitOrigin ?? handle.url;
				log(`wallet-app listening on ${url}`);
				log(`pair URL: ${url}/?token=${token}`);
				log(
					allowedOrigins.length > 0
						? `CORS allowed: ${allowedOrigins.join(', ')}`
						: 'CORS allowed: (none)',
				);

				onShutdown(async () => {
					await closeServer(handle);
					active = undefined;
				});

				return { url, token, port: resolved.port };
			},
		};
	},
});

interface ResolvedWalletAppDeps {
	port: number;
	accounts: { name: string; signer: Signer }[];
	devServerOrigin?: string;
}

function computeAllowedOrigins(
	devServerOrigin: string | undefined,
	extra: readonly string[],
): string[] {
	const out: string[] = [];
	if (devServerOrigin !== undefined) {
		try {
			out.push(new URL(devServerOrigin).origin);
		} catch {
			// Skip malformed input. The server-side sanitize step in
			// startWalletServer rejects anything bad with a clear error;
			// no need to duplicate that policy here.
		}
	}
	for (const o of extra) out.push(o);
	return out;
}

function tokenPath(appDir: string, stack: string | undefined): string {
	return join(appDir, '.devstack', 'stacks', stack ?? 'main', 'wallet-token');
}

async function readPersistedToken(
	appDir: string,
	stack: string | undefined,
): Promise<string | undefined> {
	try {
		const raw = await readFile(tokenPath(appDir, stack), 'utf8');
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch (err) {
		if ((err as { code?: string }).code === 'ENOENT') return undefined;
		throw err;
	}
}

async function writePersistedToken(
	appDir: string,
	stack: string | undefined,
	token: string,
): Promise<void> {
	const path = tokenPath(appDir, stack);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function closeServer(handle: WalletServerHandle): Promise<void> {
	await new Promise<void>((resolve) => {
		handle.server.close(() => resolve());
		// Guard against a stuck connection holding the close open.
		setTimeout(() => resolve(), 5_000).unref();
	});
}
