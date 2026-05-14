import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PlaywrightTestConfig } from '@playwright/test';
import type { Manifest } from '../shapes/index.js';

type PlaywrightWebServer = NonNullable<PlaywrightTestConfig['webServer']>;
type PlaywrightWebServerSingle =
	PlaywrightWebServer extends Array<infer U> ? U : PlaywrightWebServer;

export interface WebServerOptions {
	/** Manifest endpoint name to use as the dev server URL (e.g. `'vite-dev'`). */
	endpoint: string;
	/** Path to the manifest JSON sidecar. Default: walk up from cwd
	 * looking for `.devstack/stacks/<stack>/manifest.json` where
	 * `<stack>` is `process.env.DEVSTACK_STACK ?? 'test'`. */
	manifestPath?: string;
	/** Command to launch the dev server. Default `pnpm dev`. */
	command?: string;
	/** webServer timeout in ms. Default 120_000 (matches `devstack up`'s
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
	const manifestPath = opts.manifestPath ?? discoverManifestPath();
	const raw = (() => {
		try {
			return readFileSync(manifestPath, 'utf8');
		} catch (err) {
			if ((err as { code?: string }).code === 'ENOENT') {
				throw new Error(
					`[devstack/playwright] webServer: manifest not found at ${manifestPath}. ` +
						`Run \`devstack up\` (or \`devstack apply\`) first — Playwright's webServer config ` +
						`needs the named endpoint resolved before tests can start.`,
				);
			}
			throw err;
		}
	})();
	const manifest = JSON.parse(raw) as Manifest;
	const ep = manifest.endpoints.find((e) => e.name === opts.endpoint);
	if (ep === undefined) {
		const available = manifest.endpoints.map((e) => e.name).join(', ') || '<none>';
		throw new Error(
			`[devstack/playwright] webServer: no endpoint '${opts.endpoint}' in manifest ` +
				`at ${manifestPath} (available: ${available}). Check the plugin that's supposed to emit it.`,
		);
	}
	return {
		command: opts.command ?? 'pnpm dev',
		url: ep.url,
		timeout: opts.timeout ?? 120_000,
		reuseExistingServer: !process.env.CI,
		...opts.extend,
	};
}

function discoverManifestPath(): string {
	const stack = process.env.DEVSTACK_STACK ?? 'test';
	let dir = process.cwd();
	while (true) {
		const candidate = join(dir, '.devstack', 'stacks', stack, 'manifest.json');
		// existsSync via readFileSync probe — webServer() callers expect
		// the synchronous shape, and existsSync is the canonical way.
		try {
			readFileSync(candidate, 'utf8');
			return candidate;
		} catch (err) {
			if ((err as { code?: string }).code !== 'ENOENT') throw err;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// Fall back to the cwd path so the eventual error message points
	// at the expected location.
	return resolve(process.cwd(), '.devstack', 'stacks', stack, 'manifest.json');
}
