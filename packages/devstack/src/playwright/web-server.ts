import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { PlaywrightTestConfig } from '@playwright/test';
import { discoverManifestPath } from '../runtime/discover-manifest.js';
import { fromManifest } from '../runtime/manifest-loader.js';

type PlaywrightWebServer = NonNullable<PlaywrightTestConfig['webServer']>;
type PlaywrightWebServerSingle =
	PlaywrightWebServer extends Array<infer U> ? U : PlaywrightWebServer;

export interface WebServerOptions {
	/** Manifest endpoint name to use as the dev server URL (e.g. `'dev-server'`). */
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
					`supported endpoints (dev-server, wallet-app, sui-rpc, sui-faucet, ` +
					`sui-graphql, walrus-aggregator, walrus-publisher, seal-key-server).`,
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
	// Pass the raw string so `fromManifest` can apply `jsonBigintReviver`
	// — `JSON.parse(raw)` would coerce `{__bigint:"…"}` shapes into bare
	// objects, which downstream consumers (a future SuiManifest carrying
	// chainId or gas budgets in bigint form) would then read as the
	// wrong type.
	const manifest = fromManifest(raw);
	// Project the v4 manifest's nested endpoints into a flat
	// `{name → url}` lookup so callers reach for canonical short names
	// like `dev-server`, `sui-rpc`, `wallet-app`. The mapping mirrors
	// what consumers expected from v3's `endpoints[]` array.
	const flat: Record<string, string> = {};
	const sui = manifest.services.sui;
	if (sui !== undefined) {
		flat['sui-rpc'] = sui.rpc.url;
		if (sui.faucet !== undefined) flat['sui-faucet'] = sui.faucet.url;
		if (sui.graphql !== undefined) flat['sui-graphql'] = sui.graphql.url;
		if (sui.indexerDb !== undefined) flat['sui-indexer-db'] = sui.indexerDb.url;
	}
	const seal = manifest.services.seal;
	if (seal !== undefined) flat['seal-key-server'] = seal.keyServer.url;
	const walrus = manifest.services.walrus;
	if (walrus !== undefined) {
		flat['walrus-aggregator'] = walrus.aggregator.url;
		flat['walrus-publisher'] = walrus.publisher.url;
	}
	if (manifest.app.dev !== undefined) flat['dev-server'] = manifest.app.dev.url;
	if (manifest.app.wallet !== undefined) flat['wallet-app'] = manifest.app.wallet.url;
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

/** Endpoint → (router-service-name, traefik entrypoint port) mapping.
 *  Matches the supervisor's wire-up in `services/{dev,wallet,sui,walrus,
 *  seal}` — each routes via `<stack>.<service>.<app>.localhost:<port>`
 *  on the matching traefik entrypoint. Used when the manifest doesn't
 *  exist yet so `webServer({ endpoint })` can still produce a URL for
 *  playwright's config-load step. */
const CONVENTIONAL_ROUTES: Record<string, { service: string; port: number }> = {
	'dev-server': { service: 'dev', port: 5175 },
	'wallet-app': { service: 'wallet', port: 5180 },
	'sui-rpc': { service: 'sui', port: 9000 },
	'sui-faucet': { service: 'faucet', port: 9123 },
	'sui-graphql': { service: 'graphql', port: 9125 },
	'walrus-aggregator': { service: 'walrus-agg', port: 9185 },
	'walrus-publisher': { service: 'walrus-pub', port: 9185 },
	'seal-key-server': { service: 'seal', port: 2024 },
};

const conventionalUrl = (endpoint: string): string | undefined => {
	const route = CONVENTIONAL_ROUTES[endpoint];
	if (route === undefined) return undefined;
	const stack = process.env.DEVSTACK_STACK ?? 'main';
	const app = readAppName(process.cwd()) ?? basename(process.cwd());
	const host =
		stack === 'main'
			? `${route.service}.${app}.localhost`
			: `${stack}.${route.service}.${app}.localhost`;
	return `http://${host}:${route.port}`;
};

/** Read the `name` field out of `<dir>/package.json`. Returns the
 *  un-scoped basename so `@org/foo` → `foo`. Mirrors `deriveAppName`
 *  in the engine so the conventional URL fallback matches the
 *  supervisor's eventual routing. */
const readAppName = (dir: string): string | undefined => {
	try {
		const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as {
			name?: string;
		};
		if (typeof pkg.name !== 'string') return undefined;
		const stripped = pkg.name.replace(/^@[^/]+\//, '').replace(/^[^a-zA-Z0-9]+/, '');
		return stripped.length > 0 ? stripped : undefined;
	} catch {
		return undefined;
	}
};
