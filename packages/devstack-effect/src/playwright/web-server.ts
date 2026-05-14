import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PlaywrightTestConfig } from '@playwright/test';
import type { ManifestData } from '../primitives/manifest.js';

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
	const manifestPath = manifestPathOpt ?? discoverManifestPath();
	const raw = (() => {
		try {
			return readFileSync(manifestPath, 'utf8');
		} catch (err) {
			if ((err as { code?: string }).code === 'ENOENT') {
				throw new Error(
					`[devstack-effect/playwright] manifest not found at ${manifestPath}. ` +
						`Run \`devstack up\` (or \`devstack apply\`) first — Playwright's ` +
						`webServer / baseURL helpers need the manifest written before ` +
						`tests can start.`,
				);
			}
			throw err;
		}
	})();
	const manifest = JSON.parse(raw) as ManifestData;
	const ep = manifest.endpoints.find((e) => e.name === endpoint);
	if (ep === undefined) {
		const available = manifest.endpoints.map((e) => e.name).join(', ') || '<none>';
		throw new Error(
			`[devstack-effect/playwright] no endpoint '${endpoint}' in manifest at ${manifestPath} ` +
				`(available: ${available}). Check the plugin that's supposed to emit it.`,
		);
	}
	return ep;
}

// Walk up from cwd looking for a manifest file. Check the v4-flat
// layout first (`.devstack/manifest.json`), then the v3-style per-stack
// layout (`.devstack/stacks/<stack>/manifest.json`). The fallback path
// returned on miss points at the v4-flat location so the eventual
// error message guides the user to the canonical spot.
function discoverManifestPath(): string {
	const stack = process.env.DEVSTACK_STACK ?? 'main';
	let dir = process.cwd();
	while (true) {
		const candidates = [
			join(dir, '.devstack', 'manifest.json'),
			join(dir, '.devstack', 'stacks', stack, 'manifest.json'),
		];
		for (const candidate of candidates) {
			try {
				readFileSync(candidate, 'utf8');
				return candidate;
			} catch (err) {
				if ((err as { code?: string }).code !== 'ENOENT') throw err;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return resolve(process.cwd(), '.devstack', 'manifest.json');
}
