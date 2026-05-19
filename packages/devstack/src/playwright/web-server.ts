import type { PlaywrightTestConfig } from '@playwright/test';
import { ManifestDiscoveryError } from '../engine/errors.js';
import { conventionalUrl } from '../runtime/conventional-routes.js';
import { readStackContextSync } from '../runtime/read-stack-context.js';

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
	// Read + Schema-decode the manifest via the shared reader. On cold
	// start (no manifest on disk yet — `devstack up` hasn't run for this
	// stack), the reader throws `ManifestDiscoveryError`; we fall back to
	// a URL computed from the routed-hostname + traefik-entrypoint
	// convention so playwright's `webServer.url` can still be set at
	// config-load time. The spawned `pnpm dev` will then materialize the
	// real manifest, and the URL we computed converges with what the
	// supervisor wires (same `<stack>.<service>.<app>.localhost` +
	// traefik entrypoint port).
	//
	// Any OTHER error (`ManifestShapeError` — stale pre-v4 layout) is
	// re-thrown verbatim because its `message` already carries an
	// actionable "regenerate via …" recipe.
	let ctx;
	try {
		ctx = readStackContextSync({
			...(manifestPathOpt !== undefined ? { manifestPath: manifestPathOpt } : {}),
		});
	} catch (err) {
		if (err instanceof ManifestDiscoveryError) {
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
		throw err;
	}
	const entry = ctx.endpoint(endpoint);
	if (entry === undefined) {
		throw new Error(
			`[devstack/playwright] no endpoint '${endpoint}' in manifest at ${ctx.manifestPath}. ` +
				`Check the plugin that's supposed to emit it.`,
		);
	}
	return { name: endpoint, url: entry.url };
}
