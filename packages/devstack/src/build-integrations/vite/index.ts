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
import { resolveNetworkOptions } from '../../orchestrators/network-options.ts';
import { decodeIdConfig } from '../../orchestrators/codegen/id-config.ts';

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
	 *  env (`'1'`/`'true'`), then to the active network's `autoApproveSigning`
	 *  per-network policy (ON for every network except live `mainnet`). A
	 *  single switch, replacing per-app `VITE_*_AUTO_APPROVE`.
	 *
	 *  HARD-CLAMP: on live `mainnet` the per-network policy forces
	 *  auto-approve OFF — a real-funds signature is NEVER granted without a
	 *  human in the loop. An explicit `autoApprove: true` here, or
	 *  `DEVSTACK_AUTO_APPROVE`, still take precedence (the author opted in
	 *  deliberately), but the policy default never silently auto-approves on
	 *  mainnet. */
	readonly autoApprove?: boolean;
	/** Per-network overrides for the dev-convenience policy (the same
	 *  `networkOptions` shape `defineDevstack` takes, forwarded verbatim).
	 *  Only the `autoApproveSigning` field is read here, to resolve the
	 *  auto-approve default for the active network. Omitted ⇒ the built-in
	 *  policy (ON except live `mainnet`) applies. The override RECORD is not
	 *  otherwise on disk, so an app that customizes per-network signing must
	 *  thread it here explicitly; the mainnet hard-clamp holds regardless. */
	readonly networkOptions?: Readonly<Record<string, unknown>>;
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

/** The structural subset of Vite's `ViteDevServer` the `configureServer`
 *  hook uses: the chokidar `watcher` (to track the ids file) and the HMR
 *  channel (to push a full reload). `ws` is Vite's long-stable channel;
 *  `hot` is the newer alias — we use whichever the running Vite exposes. */
interface ViteDevServerLike {
	readonly watcher: {
		add: (paths: string | ReadonlyArray<string>) => void;
		on: (event: 'change' | 'add', listener: (path: string) => void) => void;
	};
	readonly ws?: { send: (payload: { type: 'full-reload' }) => void };
	readonly hot?: { send: (payload: { type: 'full-reload' }) => void };
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
			// `vite.config.ts`/`vitest.config.ts`. The value we return
			// (`resolvableLitDedupe(root)`, a freshly built array) is already
			// mutable.
			readonly dedupe?: string[];
		};
		readonly optimizeDeps?: { readonly include: string[] };
		/** `define` injecting the on-chain ids as `__DEVSTACK_IDS__`. In a
		 *  prod `build` this is the static id literal; in dev `serve` it is a
		 *  reference to the `globalThis.__DEVSTACK_IDS_LIVE__` runtime global
		 *  the `transformIndexHtml` hook sets fresh per page load, so a
		 *  republished id reaches the app on reload (`define` is fixed for the
		 *  dev server's lifetime and could never hot-update). */
		readonly define: Record<string, string>;
	};
	/** Capture the resolved command so injection is DEV-only. */
	readonly configResolved: (config: ViteUserConfigLike) => void;
	/** Dev-only: watch the live `devstack-ids.json` and full-reload the page
	 *  when it changes, so a republished package id (rewritten by the
	 *  supervisor's post-acquire hook) reaches the running app. */
	readonly configureServer: (server: ViteDevServerLike) => void;
	/** Resolve the dev-wallet virtual module. */
	readonly resolveId: (id: string) => string | undefined;
	/** Emit the dev-wallet register module (or a no-op when not applicable). */
	readonly load: (id: string) => string | undefined;
	/** Inject the dev-only HTML tags: the `__DEVSTACK_IDS_LIVE__` global
	 *  (read fresh from the ids file per request) and, when the app carries
	 *  the dev wallet, the `<script type="module">` importing the virtual
	 *  module. The return shape mirrors a structural subset of Vite's
	 *  `IndexHtmlTransformResult` so the plugin stays assignable to Vite's
	 *  `Plugin` without devstack importing `vite`. */
	readonly transformIndexHtml: (html: string) =>
		| {
				html: string;
				tags: Array<{
					tag: string;
					attrs?: Record<string, string | boolean>;
					children?: string;
					injectTo: 'head' | 'head-prepend';
				}>;
		  }
		| undefined;
}

/** Best-effort, SYNC read of a string-valued field at `dottedPath` (e.g.
 *  `'codegen.idsFile'`, `'identity.network'`) from the active stack's
 *  manifest. Walks each path segment as a nested object, returning the leaf
 *  value, or `null` on ANY miss (absent / partially-written / version-
 *  mismatched manifest, a non-object hop, a missing or non-string/empty
 *  leaf). We read + `JSON.parse` directly (rather than the schema-decoding
 *  `readStackContext`, which drops the `codegen` field in its projection
 *  and throws on a version mismatch) so an out-of-date or partially-written
 *  manifest degrades gracefully instead of crashing the dev server. Never
 *  throws — the single discover→parse→guard→degrade-to-null reader every
 *  manifest field above (`codegen.idsFile`, `codegen.extrasDir`,
 *  `identity.network`) routes through. */
const readManifestField = (
	env: Readonly<Record<string, string | undefined>>,
	cwd: string,
	dottedPath: string,
): string | null => {
	try {
		const { stack, stateDir } = resolveDiscoveryEnv(env, { cwd });
		const manifestPath = discoverManifestPath({ env, stack, stateDir, cwd });
		if (manifestPath === undefined || !existsSync(manifestPath)) return null;
		let node: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
		for (const segment of dottedPath.split('.')) {
			if (typeof node !== 'object' || node === null) return null;
			node = (node as Record<string, unknown>)[segment];
		}
		return typeof node === 'string' && node.length > 0 ? node : null;
	} catch {
		return null;
	}
};

/** The gitignored `devstack-ids.json` path the boot wrote for the active
 *  stack (`codegen.idsFile`), or `null` on any miss. */
const readIdsFileFromManifest = (
	env: Readonly<Record<string, string | undefined>>,
	cwd: string,
): string | null => readManifestField(env, cwd, 'codegen.idsFile');

/** SYNC read + schema-decode of an id-config FILE. The MISSING-file case
 *  (absent path, no file on disk) collapses to `null` so the Vite config
 *  load degrades gracefully when no stack has booted / no committed file is
 *  wired. A PRESENT-but-malformed file is NOT swallowed: it flows through
 *  the shared {@link decodeIdConfig}, which THROWS on bad JSON or a shape
 *  that violates `IdConfigSchema` — surfacing a genuinely broken committed
 *  id-config at config-load instead of silently injecting `null`. */
const readIdConfigFile = (idsFile: string | null): unknown => {
	if (idsFile === null || !existsSync(idsFile)) return null;
	return decodeIdConfig(readFileSync(idsFile, 'utf8'));
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
): string | null => readManifestField(env, cwd, 'codegen.extrasDir');

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

/** Filter {@link LIT_DEDUPE} to the packages actually installed at the app
 *  root (`<root>/node_modules/<pkg>`). `resolve.dedupe` forces Vite to
 *  resolve each listed package from the ROOT copy — but under pnpm's strict
 *  layout a package is only surfaced at the root when the app declares it as
 *  a direct dependency. Listing a package that is merely a phantom
 *  (transitive-only, reachable solely under `@mysten/dapp-kit-core`'s nested
 *  store dir) makes Vite's resolver look for a root copy that does not exist
 *  and FAIL the production build with `Rollup failed to resolve import
 *  "lit"`. So we dedupe only what the app truly hoists: the `app` template
 *  declares `lit` (all dapp-kit-core Lit usage routes through the `lit`
 *  meta-package, so one `lit` ⇒ one nested `@lit/reactive-element`); the
 *  sub-packages stay phantom and are correctly dropped here. */
const resolvableLitDedupe = (root: string): string[] =>
	LIT_DEDUPE.filter((pkg) => existsSync(resolve(root, 'node_modules', ...pkg.split('/'))));

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
			// Inject the on-chain ids the generated `config-runtime.ts` resolver
			// reads as `__DEVSTACK_IDS__`.
			//   - PROD build: bake the static literal.
			//   - DEV server (`vite dev`): point the identifier at the
			//     `__DEVSTACK_IDS_LIVE__` runtime global the `transformIndexHtml`
			//     hook sets fresh per page load — `define` is fixed for the dev
			//     server's lifetime, so baking the value would pin the FIRST id
			//     forever and a republish would never reach the app. A distinct
			//     global name avoids a single-pass `define` token collision with
			//     `__DEVSTACK_IDS__`.
			//   - VITEST: vitest ALSO reports `command === 'serve'`, but it runs
			//     no `transformIndexHtml` (no HTML), so the live global is never
			//     set — and esbuild's stricter `define` rejects an operator
			//     expression anyway. Bake a literal instead: the Vite config loads
			//     BEFORE the test stack boots, so `injectedIds` is null and the
			//     resolver falls back to the `DEVSTACK_IDS_FILE` env the vitest
			//     globalSetup points at the freshly-booted stack (see
			//     vitest/global-setup.ts).
			// The define VALUE must be esbuild-valid (a JSON literal or a
			// member-access chain) — note the bare `globalThis.…`, NOT a
			// parenthesised `(… ?? null)`; `config-runtime.ts` already guards the
			// `typeof … === 'undefined'` case.
			const injectedIds = resolveInjectedIds(env, root, command, options.ids);
			const isVitest = env['VITEST'] !== undefined;
			const idsDefine =
				command === 'serve' && !isVitest
					? 'globalThis.__DEVSTACK_IDS_LIVE__'
					: JSON.stringify(injectedIds ?? null);
			return {
				resolve: {
					// A bare-prefix alias (no trailing `/`) matches both
					// `@generated` and `@generated/foo.js` under Vite's default
					// string-alias resolution.
					alias: {
						[alias]: generatedDir,
						[devExtrasAlias]: extrasDir,
					},
					dedupe: resolvableLitDedupe(root),
				},
				define: {
					__DEVSTACK_IDS__: idsDefine,
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
			// Auto-approve resolution (highest precedence first): explicit
			// `options.autoApprove`, then the `DEVSTACK_AUTO_APPROVE` env, then
			// the active network's `autoApproveSigning` per-network policy. The
			// policy is ON for every network EXCEPT live `mainnet`, so a stack
			// booted against real mainnet never silently auto-approves a
			// real-funds signature. The active network comes from the manifest
			// boot wrote (`identity.network`); absent that we conservatively
			// resolve as `mainnet` (auto-approve OFF) rather than assuming a
			// dev network. The override RECORD isn't on disk — `networkOptions`
			// is read from the plugin option when the app threads it.
			const network = readManifestField(env, resolvedRoot, 'identity.network') ?? 'mainnet';
			const netOpts = resolveNetworkOptions(network, options.networkOptions);
			const autoApprove =
				options.autoApprove ?? (autoApproveFromEnv(env) || netOpts.autoApproveSigning);
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

		configureServer: (server: ViteDevServerLike) => {
			if (!isServe) return;
			const env = process.env as Readonly<Record<string, string | undefined>>;
			const idsFile = readIdsFileFromManifest(env, resolvedRoot);
			if (idsFile === null) return;
			// Watch the live id-config and full-reload on change. The supervisor's
			// post-acquire hook rewrites this file whenever a package (re)publishes
			// (e.g. after a Move-source edit fires the file watcher → selective
			// restart); a reload re-runs `transformIndexHtml`, which re-reads the
			// file into `__DEVSTACK_IDS_LIVE__`, so the app picks up the new id.
			server.watcher.add(idsFile);
			const reloadOnIdsChange = (changed: string): void => {
				// Chokidar fires absolute paths for an absolute `watcher.add`, so
				// `resolve(changed)` is normally a no-op; resolve against the Vite
				// root anyway so a relative event path can't silently miss.
				if (resolve(resolvedRoot, changed) !== resolve(idsFile)) return;
				const channel = server.hot ?? server.ws;
				channel?.send({ type: 'full-reload' });
			};
			server.watcher.on('change', reloadOnIdsChange);
			server.watcher.on('add', reloadOnIdsChange);
		},

		transformIndexHtml: (html: string) => {
			if (!isServe) return undefined;
			const env = process.env as Readonly<Record<string, string | undefined>>;
			// Read the live ids FRESH per request so a full-reload after a
			// republish injects the new id. Set on a distinct global
			// (`__DEVSTACK_IDS_LIVE__`) the `config` hook's `define` points
			// `__DEVSTACK_IDS__` at; `head-prepend` runs it before any app module.
			const liveIds = resolveInjectedIds(env, resolvedRoot, 'serve', options.ids);
			const tags: Array<{
				tag: string;
				attrs?: Record<string, string | boolean>;
				children?: string;
				injectTo: 'head' | 'head-prepend';
			}> = [
				{
					tag: 'script',
					children: `globalThis.__DEVSTACK_IDS_LIVE__ = ${JSON.stringify(liveIds ?? null)};`,
					injectTo: 'head-prepend',
				},
			];
			// Gate the script tag on the app actually carrying the wallet (same
			// condition as the `config` hook's `optimizeDeps` include), so a
			// headless app emits zero dev-wallet plumbing rather than a tag that
			// resolves to the no-op virtual module.
			if (injectDevWallet && devWalletInstalled(resolvedRoot)) {
				tags.push({
					tag: 'script',
					attrs: { type: 'module', src: VIRTUAL_DEV_WALLET_SCRIPT_SRC },
					injectTo: 'head',
				});
			}
			return { html, tags };
		},
	};
};
