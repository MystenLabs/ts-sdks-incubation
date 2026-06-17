// Vite build-integration — `@generated` alias plugin.
//
// App source imports Move codegen through a configurable alias prefix
// (default `@generated`) instead of `./generated`. This plugin points
// that alias at the committed `<root>/src/generated` tree — the ONE
// source of bindings, written only by the stack-free `devstack codegen`
// verb. On-chain ids are NOT baked into that tree; they resolve at
// runtime via the `__DEVSTACK_IDS__` global (see `resolveInjectedIds`),
// so the same generated source serves every stack. Resolution:
//   1. `options.generatedDir` — explicit escape hatch (relative → root).
//   2. `<root>/src/generated` — the committed tree, always.
//
// Because Playwright's `webServer` runs the app's OWN Vite as a child,
// the same plugin serves both `pnpm dev` and the e2e dev server
// automatically. Vitest has its own Vite pipeline, so apps add this
// plugin to `vitest.config.ts` too — and resolve `@generated` to the
// same committed tree (the per-stack live tree no longer exists).
//
// SYNC + dependency-light, mirroring the playwright/vitest helpers: NO
// heavy imports at module top-level, and `vite` is NOT imported (it is
// an app-side dev dependency, not a devstack runtime dep). The return
// value is a STRUCTURAL Vite `Plugin` — a `{ name, config }` object —
// typed loosely so this module loads without `vite` installed. The
// manifest read goes through the same `build-integrations/runtime`
// machinery the playwright/vitest integrations use.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

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

/** The committed generated-bindings subpath, relative to the Vite root.
 *  The single source of bindings — written by `devstack codegen` — that
 *  `@generated` always resolves to (absent the `options.generatedDir`
 *  escape hatch). */
const GENERATED_SUBPATH = 'src/generated';

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
	/** Production id-config FILE — the known deployment's `devstack-ids.json`
	 *  (same schema the dev stack writes), committed at e.g.
	 *  `config/<network>.ids.json`. Used only for `command === 'build'` to
	 *  inject `__DEVSTACK_IDS__`. Relative paths resolve against the Vite
	 *  root. If omitted, the `DEVSTACK_IDS_FILE` env (a path pointer) is used.
	 *  Neither ⇒ no ids baked, and the generated resolver throws loudly at
	 *  id-access time. We deliberately take a FILE, not a JSON env blob: a
	 *  real deployment's ids are many + nested. */
	readonly ids?: string;
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
/** Vite's `config` hook second arg — `{ command, mode }`. We read only
 *  `command` to pick the dev vs prod id-injection source. */
interface ViteConfigEnvLike {
	readonly command?: 'build' | 'serve';
}

export interface DevstackVitePlugin {
	readonly name: string;
	readonly config: (
		config: ViteUserConfigLike,
		env?: ViteConfigEnvLike,
	) => {
		readonly resolve: {
			readonly alias: Record<string, string>;
			// Mutable `string[]` (NOT `readonly`): Vite's `ResolveOptions.dedupe`
			// and `DepOptimizationConfig.include` are both `string[] | undefined`,
			// and a `readonly string[]` return makes the whole `config` hook
			// unassignable to Vite's `Plugin` type in a consuming app's
			// `vite.config.ts`/`vitest.config.ts`. The values we return
			// (`[...LIT_DEDUPE]`, a freshly built array) are already mutable.
			readonly dedupe?: string[];
		};
		readonly optimizeDeps?: { readonly include: string[] };
		/** Build-time `define` injecting the on-chain ids as the
		 *  `__DEVSTACK_IDS__` global (the generated resolver reads it). */
		readonly define: Record<string, string>;
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

/** Best-effort, SYNC read of a string-valued `codegen.<field>` from the
 *  active stack's manifest. Returns the value, or `null` on any miss. We
 *  read + `JSON.parse` directly (rather than the schema-decoding
 *  `readStackContext`, which drops the `codegen` field in its projection
 *  and throws on a version mismatch) so an out-of-date or partially-
 *  written manifest degrades gracefully instead of crashing the dev
 *  server. Never throws. */
const readCodegenField = (
	env: Readonly<Record<string, string | undefined>>,
	cwd: string,
	field: 'idsFile' | 'extrasDir',
): string | null => {
	try {
		const { stack, stateDir } = resolveDiscoveryEnv(env, { cwd });
		const manifestPath = discoverManifestPath({ env, stack, stateDir, cwd });
		if (manifestPath === undefined || !existsSync(manifestPath)) return null;
		const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
		if (typeof parsed !== 'object' || parsed === null) return null;
		const codegen = (parsed as { readonly codegen?: unknown }).codegen;
		if (typeof codegen !== 'object' || codegen === null) return null;
		const value = (codegen as Record<string, unknown>)[field];
		return typeof value === 'string' && value.length > 0 ? value : null;
	} catch {
		return null;
	}
};

/** The gitignored `devstack-ids.json` path the boot wrote for the active
 *  stack (`codegen.idsFile`), or `null` on any miss. */
const readIdsFileFromManifest = (
	env: Readonly<Record<string, string | undefined>>,
	cwd: string,
): string | null => readCodegenField(env, cwd, 'idsFile');

/** Best-effort, SYNC read+parse of an id-config FILE. Any miss (absent
 *  path, missing file, bad JSON) collapses to `null` rather than failing
 *  the Vite config load. */
const readIdConfigFile = (idsFile: string | null): unknown => {
	if (idsFile === null || !existsSync(idsFile)) return null;
	try {
		return JSON.parse(readFileSync(idsFile, 'utf8')) as unknown;
	} catch {
		return null;
	}
};

/** Resolve the on-chain ids to inject as the `__DEVSTACK_IDS__` global —
 *  ALWAYS from an id-config FILE (same schema in dev and prod), never a
 *  JSON env blob. Dev (`serve`): the live `devstack-ids.json` (via the
 *  manifest `codegen.idsFile`). Prod (`build`): the committed known-
 *  deployment file — the plugin `ids` option, else the `DEVSTACK_IDS_FILE`
 *  env (a PATH pointer, not data). Neither ⇒ `null`, so the generated
 *  resolver throws loudly at id-access time. */
const resolveInjectedIds = (
	env: Readonly<Record<string, string | undefined>>,
	root: string,
	command: 'build' | 'serve' | undefined,
	idsOption: string | undefined,
): unknown => {
	// Prod build: the known deployment's committed id-config file. Option
	// wins; else a `DEVSTACK_IDS_FILE` path pointer. Relative → Vite root.
	if (command === 'build') {
		const pointer = idsOption ?? env['DEVSTACK_IDS_FILE'];
		if (pointer === undefined || pointer.length === 0) return null;
		return readIdConfigFile(isAbsolute(pointer) ? pointer : resolve(root, pointer));
	}
	// Dev serve (and config-load default): the live id-config file.
	return readIdConfigFile(readIdsFileFromManifest(env, root));
};

/** The manifest-recorded dev-extras tree (`codegen.extrasDir`) the
 *  `@devstack-dev` alias points at for the active stack, or `null` on any
 *  miss. */
const readExtrasDirFromManifest = (
	env: Readonly<Record<string, string | undefined>>,
	cwd: string,
): string | null => readCodegenField(env, cwd, 'extrasDir');

/**
 * Build the devstack Vite plugin that aliases `options.alias`
 * (default `@generated`) at the committed `<root>/src/generated` tree.
 *
 *     // vite.config.ts
 *     import { devstackVitePlugin } from '@mysten-incubation/devstack/vite';
 *     export default defineConfig({ plugins: [devstackVitePlugin()] });
 *     // or devstackVitePlugin({ alias: '@gen' })
 *
 * The plugin's `config` hook merges `resolve.alias[<prefix>] = <dir>`
 * into the user config (Vite deep-merges the returned partial). Sync;
 * reads `process.env` + the manifest (for `__DEVSTACK_IDS__` / the
 * `@devstack-dev` extras dir) once at config-load.
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
		stack = resolveDiscoveryEnv(env, { cwd: root }).stack;
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

/** Lit packages deduped to a single instance. The injected dev-wallet UI and
 *  the app's dapp-kit UI are both Lit-based; if Vite loads two Lit copies they
 *  register custom elements in separate realms, and the second realm's element
 *  classes are unknown to the global `customElements` registry — so re-rendering
 *  the dev-wallet UI (e.g. on disconnect/reconnect) throws `Illegal constructor`
 *  and leaves the app in an unusable connection state. */
const LIT_DEDUPE = ['lit', 'lit-html', 'lit-element', '@lit/reactive-element'] as const;

/** The dev-wallet entry points the injected virtual module imports. They are
 *  reached only through the `<script>` this plugin adds in `transformIndexHtml`,
 *  so Vite's initial dep scan never sees them and re-optimizes mid-session the
 *  first time the page loads them — and that late, separate optimize pass pulls
 *  a SECOND Lit instance (see {@link LIT_DEDUPE}). Pre-bundling them up front via
 *  `optimizeDeps.include` keeps the whole dev-wallet UI graph in the initial pass,
 *  sharing one Lit. */
const DEV_WALLET_OPTIMIZE_ENTRIES = [
	'@mysten-incubation/dev-wallet/inject',
	'@mysten-incubation/dev-wallet/adapters',
] as const;

/** True when `@mysten-incubation/dev-wallet` is installed at the app root —
 *  i.e. the app actually depends on the dev wallet (the `app` template does;
 *  the headless `ts` template does not). Checked by package presence rather
 *  than `require.resolve('.../inject')`, whose `exports` entry declares only an
 *  `import` condition (the CJS resolver throws `ERR_PACKAGE_PATH_NOT_EXPORTED`).
 *  Best-effort: if it's absent we never hand Vite an `optimizeDeps.include` it
 *  can't resolve (which would fail the dep scan). */
const devWalletInstalled = (root: string): boolean =>
	existsSync(resolve(root, 'node_modules', '@mysten-incubation', 'dev-wallet', 'package.json'));

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
		config: (config: ViteUserConfigLike, configEnv?: ViteConfigEnvLike) => {
			const root = config.root ?? process.cwd();
			resolvedRoot = root;
			const env = process.env as Readonly<Record<string, string | undefined>>;
			// `command` comes from the second hook arg (`{ command, mode }`);
			// fall back to `config.command` (some callers pass it on the
			// config). Default the UNKNOWN case to `build` (build-safe): only an
			// EXPLICIT `serve` takes the live local-stack id-injection path, so a
			// programmatic `vite.build()` that omits the env arg never bakes
			// dev-stack ids into a production bundle.
			const command = configEnv?.command ?? config.command ?? 'build';
			// Explicit `generatedDir` wins (relative → resolved against the
			// Vite root). Otherwise always the committed `<root>/src/generated`
			// tree — the single source of bindings written by `devstack
			// codegen`; ids resolve at runtime via `__DEVSTACK_IDS__`, so the
			// same tree serves every stack.
			const explicit = options.generatedDir;
			const generatedDir =
				explicit !== undefined ? resolve(root, explicit) : resolve(root, GENERATED_SUBPATH);
			// `@devstack-dev` mirrors `@generated` exactly.
			const extrasDir = resolveExtrasDir(options, root, env);
			resolvedExtrasDir = extrasDir;
			// Return a partial config; Vite deep-merges it. `resolve.dedupe`
			// pins a single Lit copy, and — when this app carries the dev
			// wallet — we pre-bundle the injected dev-wallet entries so Vite
			// never re-optimizes them mid-session into a second Lit realm
			// (see the constants above).
			const includeDevWallet = injectDevWallet && devWalletInstalled(root);
			// Inject the on-chain ids as a build-time global. The generated
			// `config-runtime.ts` resolver reads `__DEVSTACK_IDS__`
			// synchronously and throws `DevstackConfigMissingError` when an id
			// is unresolved. `define` substitutes it identically in the dev
			// server and the prod build.
			const injectedIds = resolveInjectedIds(env, root, command, options.ids);
			return {
				resolve: {
					// A bare-prefix alias (no trailing `/`) matches both
					// `@generated` and `@generated/foo.js` under Vite's default
					// string-alias resolution.
					alias: {
						[alias]: generatedDir,
						[devExtrasAlias]: extrasDir,
					},
					dedupe: [...LIT_DEDUPE],
				},
				define: {
					__DEVSTACK_IDS__: JSON.stringify(injectedIds ?? null),
				},
				...(includeDevWallet
					? { optimizeDeps: { include: [...DEV_WALLET_OPTIMIZE_ENTRIES] } }
					: {}),
			};
		},

		configResolved: (config: ViteUserConfigLike) => {
			// DEV-gate: only a `serve` command injects the dev wallet. A
			// production `vite build` injects nothing.
			isServe = config.command !== 'build';
		},

		resolveId: (id: string) => {
			if (id === VIRTUAL_DEV_WALLET_ID) return RESOLVED_VIRTUAL_DEV_WALLET_ID;
			return undefined;
		},

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
				`  network: devWallet.network,`,
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
