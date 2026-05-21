// Browser build integration — vitest config builder for `@vitest/browser`.
//
// Architecture (distilled/23-build-integrations.md § Vitest, § Browser
// and § Per-integration requirements):
//
//   - Same shape as the vitest preset (canonical include/exclude,
//     `passWithNoTests: true`, no devstack lifecycle).
//   - Adds browser-mode config that runs tests in a real browser via
//     `@vitest/browser` instead of jsdom.
//   - Pure config builder: synchronous, idempotent, no I/O at call
//     time. Returns a `ViteUserConfig`. No teardown.
//   - The setup file (`setup.ts` in this directory) is wired in via
//     `test.setupFiles` so the codegen-emitted dapp-kit config lands
//     in the global slot before any spec runs.
//
// The shape mirrors `defineDevstackVitestConfig` so apps can swap from
// node-mode to browser-mode without rewriting their config skeleton —
// only the entry point (`@mysten-incubation/devstack/vitest` vs
// `@mysten-incubation/devstack/build-integrations/browser`) changes.

import { defineConfig, type ViteUserConfig } from 'vitest/config';

import { BrowserConfigOptionsError } from './errors.ts';

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

/**
 * Browser-mode knobs. The defaults are the conservative ones: headless
 * Chromium via the `playwright` provider, single instance (browser
 * tests contend on shared faucet/wallet/RPC same as Playwright).
 */
export interface DevstackBrowserModeOptions {
	/** Enable browser mode. Default `true` — the whole point of this
	 *  preset. Set `false` to fall back to node-mode in tests where the
	 *  browser bundle isn't needed. */
	readonly enabled?: boolean;
	/** Vitest browser provider — `'playwright'` (default), `'webdriverio'`,
	 *  or `'preview'`. */
	readonly provider?: 'playwright' | 'webdriverio' | 'preview';
	/** Headless mode. Defaults to `true` in CI, `false` interactively. */
	readonly headless?: boolean;
	/** Per-browser instance list. Defaults to a single `chromium`
	 *  instance, which matches the dApp Kit + dev-wallet support matrix. */
	readonly instances?: ReadonlyArray<{ readonly browser: string }>;
}

export interface DevstackBrowserConfigOptions {
	/** Extra `test` fields merged into the resulting config. Top-level
	 *  keys here win (same precedence rule as `defineDevstackVitestConfig`). */
	readonly test?: NonNullable<ViteUserConfig['test']>;
	/** Browser-mode configuration; see `DevstackBrowserModeOptions`. */
	readonly browser?: DevstackBrowserModeOptions;
	/**
	 * Absolute or workspace-relative path to the codegen-emitted
	 * dapp-kit config the setup file should load. Defaults to the
	 * canonical codegen output, `./.devstack/codegen/dapp-kit-config.ts`.
	 * Override only if the app moves codegen output.
	 */
	readonly dappKitConfigPath?: string;
	/** Extra setup files to append after the devstack browser-setup. */
	readonly extraSetupFiles?: ReadonlyArray<string>;
}

// -----------------------------------------------------------------------------
// Builder
// -----------------------------------------------------------------------------

/**
 * Build the canonical devstack vitest browser-mode config. Apps reduce
 * their `vitest.browser.config.ts` (or branch their existing config) to
 * a single call:
 *
 *   import { defineDevstackBrowserConfig }
 *     from '@mysten-incubation/devstack/build-integrations/browser';
 *
 *   export default defineDevstackBrowserConfig();
 *
 * Bundles the same canonical include/exclude as `defineDevstackVitestConfig`
 * plus browser-mode wiring (`@vitest/browser` provider, single-instance
 * chromium, headless in CI), and pins the devstack browser-setup file
 * via `setupFiles`. No devstack lifecycle is started here — the test
 * file owns lifecycle via `@effect/vitest`'s `it.layer(stack.layer)`
 * exactly like in node-mode vitest.
 *
 * Throws `BrowserConfigOptionsError` for config-shape mistakes (e.g.
 * `browser.enabled: false` with `browser.instances` supplied).
 */
export function defineDevstackBrowserConfig(
	options: DevstackBrowserConfigOptions = {},
): ViteUserConfig {
	const browserOptions = options.browser ?? {};
	const browserEnabled = browserOptions.enabled ?? true;

	if (
		!browserEnabled &&
		(browserOptions.instances !== undefined ||
			browserOptions.provider !== undefined ||
			browserOptions.headless !== undefined)
	) {
		throw new BrowserConfigOptionsError({
			message:
				'browser.enabled is false but browser-only fields were supplied; either enable browser mode or drop the unused fields',
			field: 'browser',
		});
	}

	const setupFiles = [
		// Resolved relative to the consumer's `vitest.config.ts`; this
		// preset ships the setup module at a stable subpath under
		// `@mysten-incubation/devstack/build-integrations/browser/setup`.
		'@mysten-incubation/devstack/build-integrations/browser/setup',
		...(options.extraSetupFiles ?? []),
	];

	const headless = browserOptions.headless ?? Boolean(process.env['CI']);

	// The `browser.instances` field is the vitest 3+ shape (modern
	// API); vitest 2.x typed `browser.name` instead. The runtime
	// consumers of this preset pin vitest 3+ via `@effect/vitest`'s
	// peer constraint, but the catalog still resolves to a 2.x
	// installation at typecheck time. Cast through `as never` so the
	// builder compiles against either typing without dropping
	// type-safety on the surrounding `test` block.
	const browserBlock = browserEnabled
		? {
				browser: {
					enabled: true,
					provider: browserOptions.provider ?? 'playwright',
					headless,
					instances: browserOptions.instances ?? [{ browser: 'chromium' }],
				} as never,
			}
		: {};

	// Thread the configurable `dappKitConfigPath` to the setup file via
	// Vite's `define`. The setup file (`./setup.ts`) declares the
	// constant and falls back to the conventional codegen output when
	// absent. The configurable knob was unwired in the prior shape —
	// vitest's setup file ran with the hard-coded default regardless of
	// what the consumer passed.
	const defineConsts: Record<string, string> =
		options.dappKitConfigPath !== undefined && options.dappKitConfigPath !== ''
			? { __DEVSTACK_DAPP_KIT_CONFIG_PATH__: JSON.stringify(options.dappKitConfigPath) }
			: {};

	return defineConfig({
		define: defineConsts,
		test: {
			include: ['src/**/*.{test,spec}.ts?(x)'],
			exclude: ['e2e/**', 'node_modules', 'dist', '.turbo'],
			passWithNoTests: true,
			setupFiles,
			...browserBlock,
			...options.test,
		},
	});
}
