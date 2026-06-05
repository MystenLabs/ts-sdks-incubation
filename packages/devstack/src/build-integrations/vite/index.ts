// Vite build-integration — `@generated` alias plugin.
//
// App source imports Move codegen through a configurable alias prefix
// (default `@generated`) instead of `./generated`. This plugin points
// that alias at the ACTIVE stack's output dir — the EXACT dir codegen
// wrote to for the current stack — so two stacks of the same app
// (`pnpm dev` on the home stack + `pnpm test:e2e` on a `--stack e2e`
// override) resolve `@generated/*` to different directories and never
// read each other's clobbered package-id / wallet-pair-token literals.
//
// The target is the manifest-recorded `codegen.generatedDir` (the
// single source of truth — the supervisor wrote it at flush time; see
// `orchestrators/codegen/output-location.ts` +
// `orchestrators/boot.ts`). Resolution:
//   1. `options.generatedDir` — explicit escape hatch, used verbatim.
//   2. `resolveDiscoveryEnv(process.env)` → `{ stack, stateDir }`
//      (single source of truth; honors `DEVSTACK_STACK` +
//      `DEVSTACK_RUNTIME_ROOT`/`DEVSTACK_STATE_DIR`), then
//      `discoverManifestPath(...)` locates `<stateDir>/stacks/<stack>/manifest.json`,
//      and we read its `codegen.generatedDir`.
//   3. Cold-start fallback — no manifest / no field yet → `<root>/src/generated`.
//      (In the supervised flow Vite starts AFTER post-acquire codegen,
//      so the field is present; the fallback is the pre-`up` window.)
//
// Because Playwright's `webServer` runs the app's OWN Vite as a child
// inheriting `DEVSTACK_STACK`, the same plugin serves both `pnpm dev`
// and the e2e dev server automatically. Vitest has its own Vite
// pipeline, so apps add this plugin to `vitest.config.ts` too.
//
// SYNC + dependency-light, mirroring the playwright/vitest helpers: NO
// heavy imports at module top-level, and `vite` is NOT imported (it is
// an app-side dev dependency, not a devstack runtime dep). The return
// value is a STRUCTURAL Vite `Plugin` — a `{ name, config }` object —
// typed loosely so this module loads without `vite` installed. The
// manifest read goes through the same `build-integrations/runtime`
// machinery the playwright/vitest integrations use.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { discoverManifestPath, resolveDiscoveryEnv } from '../runtime/index.ts';

/** Default import-alias prefix. Customizable via `options.alias` (some
 *  apps prefer `@gen`, `~generated`, …). The app MUST use the SAME
 *  prefix in three derivable places: this plugin option, the
 *  `tsconfig` `paths` entry, and its import specifiers. */
export const DEFAULT_GENERATED_ALIAS = '@generated';

/** Default dev-extras import-alias prefix. Resolves the PRIMARY stack's
 *  `.devstack/stacks/<stack>/generated-extras` tree (dev-only / secret
 *  artifacts — `accounts.ts`, `dev-wallet.ts`). Mirror the `@generated`
 *  three-place discipline: this option, the `tsconfig` `paths` entry,
 *  and the import specifiers. */
export const DEFAULT_DEV_EXTRAS_ALIAS = '@devstack-dev';

/** Default home-stack output subpath, relative to the Vite root. The
 *  cold-start fallback when no manifest / `codegen.generatedDir` is on
 *  disk yet. Mirrors `output-location.ts`'s home rule. */
const FALLBACK_GENERATED_SUBPATH = 'src/generated';

export interface DevstackVitePluginOptions {
	/** Import-alias prefix. Default `'@generated'`. */
	readonly alias?: string;
	/** Dev-extras import-alias prefix. Default `'@devstack-dev'`. */
	readonly devExtrasAlias?: string;
	/** Explicit generated dir — bypasses manifest discovery entirely
	 *  (escape hatch for unusual layouts / tests). Relative paths
	 *  resolve against the Vite root. */
	readonly generatedDir?: string;
	/** Explicit dev-extras dir — bypasses manifest discovery. Relative
	 *  paths resolve against the Vite root. */
	readonly extrasDir?: string;
	/** Inject + register the devstack dev wallet on the page in DEV
	 *  (wallet-standard, so dApp Kit auto-discovers it). Defaults to
	 *  `true`. Production builds (`command === 'build'`) inject nothing
	 *  regardless. */
	readonly injectDevWallet?: boolean;
	/** Auto-approve all dev-wallet signing requests (headless Playwright /
	 *  in-app "Open/Join as" buttons). Defaults to the `DEVSTACK_AUTO_APPROVE`
	 *  env (`'1'`/`'true'`). A single switch, replacing per-app
	 *  `VITE_*_AUTO_APPROVE`. */
	readonly autoApprove?: boolean;
}

/** A `vite` `Plugin`'s `config` hook receives the partial user config.
 *  We only ever read `config.root` and return a `resolve.alias` patch,
 *  so a one-field structural subset is enough — this keeps the module
 *  loadable without `vite` types (mirroring how the playwright/vitest
 *  presets avoid importing their optional peer at module init). */
interface ViteUserConfigLike {
	readonly root?: string;
	readonly command?: 'build' | 'serve';
}

/** Virtual module id the dev-only HTML injection imports. Vite convention:
 *  a `virtual:` specifier resolved to a `\0`-prefixed id in `resolveId`. */
const VIRTUAL_DEV_WALLET_ID = 'virtual:devstack-dev-wallet';
const RESOLVED_VIRTUAL_DEV_WALLET_ID = '\0virtual:devstack-dev-wallet';
/** The `/@id/` URL form Vite's middleware understands for a `\0`-prefixed
 *  virtual id: the NUL byte is encoded as the literal `__x00__` token (a
 *  raw `\0` in an HTML attribute is mangled to a space, which Vite then
 *  misroutes to the SPA fallback). Used for the injected `<script src>`. */
const VIRTUAL_DEV_WALLET_SCRIPT_SRC = `/@id/__x00__${VIRTUAL_DEV_WALLET_ID}`;

/** The structural `Plugin` shape we return — `name`, a `config` hook, and
 *  the DEV-only dev-wallet-injection hooks. Typed as the loose object Vite
 *  accepts (Vite's `Plugin` is structurally compatible) so callers spread
 *  it into `plugins: []` without devstack depending on `vite`. */
export interface DevstackVitePlugin {
	readonly name: string;
	readonly config: (config: ViteUserConfigLike) => {
		readonly resolve: { readonly alias: Record<string, string> };
	};
	/** Capture the resolved command so injection is DEV-only. */
	readonly configResolved: (config: ViteUserConfigLike) => void;
	/** Resolve the dev-wallet virtual module. */
	readonly resolveId: (id: string) => string | undefined;
	/** Emit the dev-wallet register module (or a no-op when not applicable). */
	readonly load: (id: string) => string | undefined;
	/** Inject a `<script type="module">` importing the virtual module into
	 *  the dev page's HTML. DEV-only. The return shape mirrors a structural
	 *  subset of Vite's `IndexHtmlTransformResult` (mutable `tags`,
	 *  `injectTo` as the literal `'head'`) so the plugin stays assignable to
	 *  Vite's `Plugin` without devstack importing `vite`. */
	readonly transformIndexHtml: (html: string) =>
		| {
				html: string;
				tags: Array<{
					tag: string;
					attrs: Record<string, string | boolean>;
					injectTo: 'head';
				}>;
		  }
		| undefined;
}

/** Best-effort, SYNC read of the manifest-recorded `codegen.generatedDir`
 *  for the active stack. Returns the absolute dir, or `null` on any
 *  miss (no manifest yet, no `codegen` field, unreadable/corrupt file).
 *  Never throws — the caller falls back to `src/generated/`. We read +
 *  `JSON.parse` directly (rather than the schema-decoding
 *  `readStackContext`, which (a) drops the `codegen` field in its
 *  projection and (b) throws on a version mismatch) so an out-of-date
 *  or partially-written manifest degrades to the cold-start fallback
 *  instead of crashing the dev server. */
const readGeneratedDirFromManifest = (
	env: Readonly<Record<string, string | undefined>>,
	cwd: string,
): string | null => {
	try {
		const { stack, stateDir } = resolveDiscoveryEnv(env);
		const manifestPath = discoverManifestPath({ env, stack, stateDir, cwd });
		if (manifestPath === undefined || !existsSync(manifestPath)) return null;
		const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
		if (typeof parsed !== 'object' || parsed === null) return null;
		const codegen = (parsed as { readonly codegen?: unknown }).codegen;
		if (typeof codegen !== 'object' || codegen === null) return null;
		const generatedDir = (codegen as { readonly generatedDir?: unknown }).generatedDir;
		return typeof generatedDir === 'string' && generatedDir.length > 0 ? generatedDir : null;
	} catch {
		// Discovery / read / parse failure → cold-start fallback. A
		// best-effort alias resolver must never fail the Vite config load.
		return null;
	}
};

/** Best-effort, SYNC read of the manifest-recorded `codegen.extrasDir`
 *  for the active stack (the dev-extras tree the `@devstack-dev` alias
 *  points at). Returns the absolute dir, or `null` on any miss. Mirrors
 *  `readGeneratedDirFromManifest` exactly; never throws. */
const readExtrasDirFromManifest = (
	env: Readonly<Record<string, string | undefined>>,
	cwd: string,
): string | null => {
	try {
		const { stack, stateDir } = resolveDiscoveryEnv(env);
		const manifestPath = discoverManifestPath({ env, stack, stateDir, cwd });
		if (manifestPath === undefined || !existsSync(manifestPath)) return null;
		const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
		if (typeof parsed !== 'object' || parsed === null) return null;
		const codegen = (parsed as { readonly codegen?: unknown }).codegen;
		if (typeof codegen !== 'object' || codegen === null) return null;
		const extrasDir = (codegen as { readonly extrasDir?: unknown }).extrasDir;
		return typeof extrasDir === 'string' && extrasDir.length > 0 ? extrasDir : null;
	} catch {
		return null;
	}
};

/**
 * Build the devstack Vite plugin that aliases `options.alias`
 * (default `@generated`) at the active stack's codegen output dir.
 *
 *     // vite.config.ts
 *     import { devstackVitePlugin } from '@mysten-incubation/devstack/vite';
 *     export default defineConfig({ plugins: [devstackVitePlugin()] });
 *     // or devstackVitePlugin({ alias: '@gen' })
 *
 * The plugin's `config` hook merges `resolve.alias[<prefix>] = <dir>`
 * into the user config (Vite deep-merges the returned partial). Sync;
 * reads `process.env` + the manifest once at config-load.
 */
/** Derive the cold-start fallback dev-extras dir
 *  (`<root>/.devstack/stacks/<stack>/generated-extras`) for the active
 *  stack — used when no manifest / `codegen.extrasDir` is on disk yet.
 *  Mirrors `output-location.ts`'s `extrasDirFor`. Best-effort: a
 *  discovery failure collapses to the `default` stack name. */
const fallbackExtrasDir = (
	env: Readonly<Record<string, string | undefined>>,
	root: string,
): string => {
	let stack = 'default';
	try {
		stack = resolveDiscoveryEnv(env).stack;
	} catch {
		// keep the `default` fallback.
	}
	return resolve(root, '.devstack', 'stacks', stack, 'generated-extras');
};

/** Resolve the dev-extras dir for the active stack (shared by the alias
 *  config and the dev-wallet virtual module). Explicit option wins, else
 *  manifest `codegen.extrasDir`, else the derived cold-start path. */
const resolveExtrasDir = (
	options: DevstackVitePluginOptions,
	root: string,
	env: Readonly<Record<string, string | undefined>>,
): string => {
	const explicitExtras = options.extrasDir;
	return explicitExtras !== undefined
		? resolve(root, explicitExtras)
		: (readExtrasDirFromManifest(env, root) ?? fallbackExtrasDir(env, root));
};

/** Read the `DEVSTACK_AUTO_APPROVE` env (`'1'`/`'true'`, case-insensitive). */
const autoApproveFromEnv = (env: Readonly<Record<string, string | undefined>>): boolean => {
	const raw = env['DEVSTACK_AUTO_APPROVE'];
	return raw === '1' || raw?.toLowerCase() === 'true';
};

export const devstackVitePlugin = (options: DevstackVitePluginOptions = {}): DevstackVitePlugin => {
	const alias = options.alias ?? DEFAULT_GENERATED_ALIAS;
	const devExtrasAlias = options.devExtrasAlias ?? DEFAULT_DEV_EXTRAS_ALIAS;
	const injectDevWallet = options.injectDevWallet ?? true;

	// Captured across hooks. `config` runs first (alias resolution),
	// `configResolved` records the command (DEV-gate), and `load` re-reads
	// the dev-wallet config off `extrasDir`.
	let resolvedRoot = process.cwd();
	let resolvedExtrasDir: string | null = null;
	let isServe = false;

	return {
		name: 'devstack:generated-alias',
		config: (config: ViteUserConfigLike) => {
			const root = config.root ?? process.cwd();
			resolvedRoot = root;
			const env = process.env as Readonly<Record<string, string | undefined>>;
			// Explicit `generatedDir` wins (relative → resolved against the
			// Vite root). Otherwise consult the manifest-recorded dir, then
			// fall back to the home-stack `src/generated/` for the
			// pre-supervisor cold-start window.
			const explicit = options.generatedDir;
			const generatedDir =
				explicit !== undefined
					? resolve(root, explicit)
					: (readGeneratedDirFromManifest(env, root) ?? resolve(root, FALLBACK_GENERATED_SUBPATH));
			// `@devstack-dev` mirrors `@generated` exactly.
			const extrasDir = resolveExtrasDir(options, root, env);
			resolvedExtrasDir = extrasDir;
			// Return a partial config; Vite merges `resolve.alias` into the
			// existing alias map. A bare-prefix alias (no trailing `/`)
			// matches both `@generated` and `@generated/foo.js` under Vite's
			// default string-alias resolution.
			return {
				resolve: {
					alias: {
						[alias]: generatedDir,
						[devExtrasAlias]: extrasDir,
					},
				},
			};
		},

		configResolved: (config: ViteUserConfigLike) => {
			// DEV-gate: only a `serve` command injects the dev wallet. A
			// production `vite build` injects nothing.
			isServe = config.command !== 'build';
		},

		resolveId: (id: string) =>
			id === VIRTUAL_DEV_WALLET_ID ? RESOLVED_VIRTUAL_DEV_WALLET_ID : undefined,

		load: (id: string): string | undefined => {
			if (id !== RESOLVED_VIRTUAL_DEV_WALLET_ID) return undefined;
			// Graceful no-op when injection is off, not a dev serve, or the
			// dev-extras config is absent (no `devstack apply` yet).
			const extrasDir = resolvedExtrasDir ?? resolveExtrasDir(options, resolvedRoot, process.env);
			const devWalletFile = resolve(extrasDir, 'dev-wallet.ts');
			const accountsFile = resolve(extrasDir, 'accounts.ts');
			if (!injectDevWallet || !isServe || !existsSync(devWalletFile) || !existsSync(accountsFile)) {
				return 'export {};';
			}
			const env = process.env as Readonly<Record<string, string | undefined>>;
			const autoApprove = options.autoApprove ?? autoApproveFromEnv(env);
			// Re-export the generated config through the `@devstack-dev`
			// alias (already wired in `config`), parse the token, and
			// register the page wallet on load. Kept as source the dev
			// server transpiles — it imports `@mysten-incubation/dev-wallet`
			// + the generated extras, both resolvable in the app graph.
			return [
				`import { registerDevstackDevWallet } from '@mysten-incubation/dev-wallet/inject';`,
				`import { parseDevstackToken } from '@mysten-incubation/dev-wallet/adapters';`,
				`import { devWallet } from '${devExtrasAlias}/dev-wallet.js';`,
				`import { accounts } from '${devExtrasAlias}/accounts.js';`,
				// The wallet EXECUTES (and simulates) against the same routed
				// RPC the app's dApp Kit client uses — a raw 127.0.0.1 RPC is
				// CORS-blocked from the routed page origin. Sourced from the
				// generated runtime config (active network's `rpc`).
				`import { config as __devstackConfig } from '${alias}/config.js';`,
				`registerDevstackDevWallet({`,
				`  serverOrigin: devWallet.walletUrl,`,
				`  token: parseDevstackToken(devWallet.pairUrl),`,
				`  accounts,`,
				`  rpcUrl: __devstackConfig.networks[__devstackConfig.network].rpc,`,
				`  chain: devWallet.chain,`,
				`  autoApprove: ${autoApprove ? 'true' : 'false'},`,
				`  mountUI: true,`,
				`}).catch((err) => console.error('[devstack] dev-wallet injection failed:', err));`,
			].join('\n');
		},

		transformIndexHtml: (html: string) => {
			if (!injectDevWallet || !isServe) return undefined;
			return {
				html,
				tags: [
					{
						tag: 'script',
						attrs: { type: 'module', src: VIRTUAL_DEV_WALLET_SCRIPT_SRC },
						injectTo: 'head',
					},
				],
			};
		},
	};
};
