import { readFileSync } from 'node:fs';
import type { PlaywrightTestConfig } from '@playwright/test';
import { conventionalUrl } from '../runtime/conventional-routes.js';
import { discoverManifestPath } from '../runtime/discover-manifest.js';
import { EndpointName } from '../runtime/endpoint-names.js';
import type { Manifest } from '../runtime/manifest-schema.js';

type PlaywrightWebServer = NonNullable<PlaywrightTestConfig['webServer']>;
type PlaywrightWebServerSingle =
	PlaywrightWebServer extends Array<infer U> ? U : PlaywrightWebServer;

export interface WebServerOptions {
	/** Manifest endpoint name to use as the dev server URL (e.g. `'frontend.dev-server'`). */
	endpoint: string;
	/** Path to the manifest JSON sidecar. Default: walk up from cwd
	 * looking for `.devstack/manifest.json` (v4 default), falling back
	 * to `.devstack/stacks/<stack>/manifest.json` where `<stack>` is
	 * `process.env.DEVSTACK_STACK ?? 'main'`. */
	manifestPath?: string;
	/** Command to launch the dev server. Default `pnpm dev`. */
	command?: string;
	/** webServer timeout in ms. Default 120_000 (matches devstack's
	 * cold-start window for walrus/seal/sui images on first pull). */
	timeout?: number;
	/** Extra fields to merge into the resulting webServer config. */
	extend?: Partial<PlaywrightWebServerSingle>;
}

/**
 * Wire Playwright's `webServer` from the named manifest endpoint —
 * looks up `manifest.endpoints.find(e => e.name === opts.endpoint)`
 * and uses its URL.
 *
 * Fails loudly if:
 *   - The manifest file doesn't exist (run `devstack up` first).
 *   - The named endpoint isn't in the manifest (typo, or plugin didn't
 *     emit it). No silent localhost fallback.
 *
 * Reads the manifest synchronously because `playwright.config.ts` is
 * loaded synchronously by Playwright; async config requires `await`
 * at the export site which is awkward boilerplate.
 */
export function webServer(opts: WebServerOptions): PlaywrightWebServerSingle {
	const ep = resolveEndpoint(opts.endpoint, opts.manifestPath);
	return {
		command: opts.command ?? 'pnpm dev',
		url: ep.url,
		timeout: opts.timeout ?? 120_000,
		reuseExistingServer: !process.env.CI,
		// Stamp `PLAYWRIGHT=1` into the supervisor's env so configs that
		// want e2e-specific behavior (the most common: `hotRestart: false`
		// — codegen's first-cycle `sui move build` touches files inside
		// the Move source dir and trips the watcher, restarting vite
		// mid-test) can branch on it. User-supplied `env` wins.
		env: { PLAYWRIGHT: '1', ...(opts.extend as { env?: Record<string, string> } | undefined)?.env },
		// Playwright spawns the command via `shell: true`, so the shell
		// owns the whole supervisor / Dev / vite process tree. Default
		// shutdown is SIGKILL on the shell — reparents every descendant
		// to init with no cleanup, leaving orphan vite processes that
		// hold ports for hours. `gracefulShutdown` switches to SIGTERM
		// first (with a 10s budget) so pnpm propagates to the supervisor,
		// the supervisor's NodeRuntime runs Effect finalizers, the Dev
		// primitive's spawner sends SIGTERM to vite's process group,
		// and everything actually exits.
		gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
		...opts.extend,
	};
}

export interface BaseURLOptions {
	/** Manifest endpoint name to resolve into a `use.baseURL`. */
	readonly endpoint: string;
	/** Path to the manifest JSON sidecar. Default: same discovery as `webServer`. */
	readonly manifestPath?: string;
}

/**
 * Read the named manifest endpoint and return its URL — for use as
 * `use.baseURL` in a Playwright config so `page.goto('/')` resolves
 * against the manifest-declared dev server URL. Pairs with `webServer({
 * endpoint })`; pass the same endpoint name to both.
 *
 * Fails for the same reasons as `webServer` (missing manifest, unknown
 * endpoint).
 */
export function baseURL(opts: BaseURLOptions): string {
	return resolveEndpoint(opts.endpoint, opts.manifestPath).url;
}

function resolveEndpoint(
	endpoint: string,
	manifestPathOpt: string | undefined,
): { readonly url: string; readonly name: string } {
	// Discover via the shared helper. On cold-start (manifest doesn't
	// exist yet — `devstack up` hasn't run for this stack), fall back
	// to a URL computed from the routed-hostname + traefik-entrypoint
	// convention so playwright's `webServer.url` can still be set at
	// config-load time. The spawned `pnpm dev` will then materialize
	// the real manifest, and the URL we computed converges with what
	// the supervisor wires (same `<stack>.<service>.<app>.localhost`
	// + traefik entrypoint port).
	const manifestPath = discoverManifestPath({ override: manifestPathOpt });
	if (manifestPath === undefined) {
		const fallback = conventionalUrl(endpoint);
		if (fallback === undefined) {
			throw new Error(
				`[devstack/playwright] no manifest at <state-dir>/stacks/<stack>/manifest.json ` +
					`and endpoint '${endpoint}' has no conventional URL fallback. ` +
					`Run \`devstack apply\` first to write a manifest, or use one of the ` +
					`supported endpoints (frontend.dev-server, wallet-app, sui-rpc, ` +
					`sui-faucet, sui-graphql, walrus-aggregator, walrus-publisher, ` +
					`seal-key-server).`,
			);
		}
		return { name: endpoint, url: fallback };
	}
	const raw = (() => {
		try {
			return readFileSync(manifestPath, 'utf8');
		} catch (err) {
			if ((err as { code?: string }).code === 'ENOENT') {
				throw new Error(
					`[devstack/playwright] manifest not found at ${manifestPath}. ` +
						`Run \`devstack up\` (or \`devstack apply\`) first — Playwright's ` +
						`webServer / baseURL helpers need the manifest written before ` +
						`tests can start.`,
				);
			}
			throw err;
		}
	})();
	// v5 manifest is all-strings — no bigint fields in the schema, so a
	// plain `JSON.parse` is sound. If a future schema folds bigint
	// fields (gas budgets, on-chain numeric scalars), wire the
	// `jsonBigintReviver` from `engine/json-bigint.ts` here.
	const manifest = JSON.parse(raw) as Manifest;
	// Stale-manifest guard. The v3 manifest used a flat `endpoints[]`
	// array and had no `services` key; v4+ groups by service
	// (`services.sui.rpc.url`, etc.). If a v3 (or otherwise pre-v4)
	// manifest sits on disk from an older devstack release, the nested
	// projection below NPEs with `Cannot read properties of undefined
	// (reading 'sui')`. Catch the missing-discriminator case here and
	// surface a typed error pointing the user at the regenerate recipe
	// — never NPE, never silently fall through to "endpoint not found".
	if (
		manifest === null ||
		typeof manifest !== 'object' ||
		(manifest as { services?: unknown }).services === undefined ||
		typeof (manifest as { services?: unknown }).services !== 'object' ||
		(manifest as { app?: unknown }).app === undefined
	) {
		throw new Error(
			`[devstack/playwright] manifest at ${manifestPath} is in an unrecognized shape ` +
				`(missing top-level \`services\` and/or \`app\`). This usually means a stale ` +
				`pre-v4 manifest from an older devstack release is on disk. ` +
				`RECOVERY: \`rm -rf .devstack/manifest.json .devstack/stacks/*/manifest.json && devstack up\` ` +
				`to regenerate.`,
		);
	}
	// Project the v4 manifest's nested endpoints into a flat
	// `{name → url}` lookup so callers reach for canonical short names
	// like `dev-server`, `sui-rpc`, `wallet-app`. The mapping mirrors
	// what consumers expected from v3's `endpoints[]` array.
	const flat: Record<string, string> = {};
	const sui = manifest.services.sui;
	if (sui !== undefined) {
		flat[EndpointName.SUI_RPC] = sui.rpc.url;
		if (sui.faucet !== undefined) flat[EndpointName.SUI_FAUCET] = sui.faucet.url;
		if (sui.graphql !== undefined) flat[EndpointName.SUI_GRAPHQL] = sui.graphql.url;
		if (sui.indexerDb !== undefined) flat[EndpointName.SUI_INDEXER_DB] = sui.indexerDb.url;
	}
	const seal = manifest.services.seal;
	if (seal !== undefined) flat[EndpointName.SEAL_KEY_SERVER] = seal.keyServer.url;
	const walrus = manifest.services.walrus;
	if (walrus !== undefined) {
		flat[EndpointName.WALRUS_AGGREGATOR] = walrus.aggregator.url;
		flat[EndpointName.WALRUS_PUBLISHER] = walrus.publisher.url;
	}
	if (manifest.app.dev !== undefined) flat[EndpointName.DEV_SERVER_PRIMARY] = manifest.app.dev.url;
	if (manifest.app.wallet !== undefined) flat[EndpointName.WALLET_APP] = manifest.app.wallet.url;
	const url = flat[endpoint];
	if (url === undefined) {
		const available = Object.keys(flat).join(', ') || '<none>';
		throw new Error(
			`[devstack/playwright] no endpoint '${endpoint}' in manifest at ${manifestPath} ` +
				`(available: ${available}). Check the plugin that's supposed to emit it.`,
		);
	}
	return { name: endpoint, url };
}
