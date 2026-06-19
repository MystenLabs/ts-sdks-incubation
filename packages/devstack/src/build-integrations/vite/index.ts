// Vite build-integration — `@generated` alias plugin.
//
// App source imports Move codegen through a configurable alias prefix
// (default `@generated`) instead of `./generated`. This plugin points
// that alias at the committed `<root>/src/generated` tree — the ONE
// source of bindings, written only by the stack-free `devstack codegen`
// verb. On-chain ids are NOT baked into that tree; they resolve at
// runtime via the `__DEVSTACK_DEPLOYMENT__` global (see
// `resolveInjectedDeployment`), so the same generated source serves every
// stack. Resolution:
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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { discoverManifestPath, resolveDiscoveryEnv } from '../runtime/index.ts';
import { resolveNetworkOptions } from '../../orchestrators/network-options.ts';
import {
	decodeDeployment,
	decodeNetworkDeployment,
	type DevstackDeployment,
	type NetworkDeployment,
} from '../../orchestrators/codegen/deployment.ts';

/** Default import-alias prefix. Customizable via `options.alias` (some
 *  apps prefer `@gen`, `~generated`, …). The app MUST use the SAME
 *  prefix in three derivable places: this plugin option, the
 *  `tsconfig` `paths` entry, and its import specifiers. */
export const DEFAULT_GENERATED_ALIAS = '@generated';

/** The committed generated-bindings subpath, relative to the Vite root.
 *  The single source of bindings — written by `devstack codegen` — that
 *  `@generated` always resolves to (absent the `options.generatedDir`
 *  escape hatch). */
const GENERATED_SUBPATH = 'src/generated';

export interface DevstackVitePluginOptions {
	/** Import-alias prefix. Default `'@generated'`. */
	readonly alias?: string;
	/** Explicit generated dir — bypasses manifest discovery entirely
	 *  (escape hatch for unusual layouts / tests). Relative paths
	 *  resolve against the Vite root. */
	readonly generatedDir?: string;
	/** Inject + register the devstack dev wallet on the page in DEV
	 *  (wallet-standard, so dApp Kit auto-discovers it). Defaults to
	 *  `true`. Production builds (`command === 'build'`) inject nothing
	 *  regardless. */
	readonly injectDevWallet?: boolean;
	/** Auto-approve all dev-wallet signing requests (headless Playwright /
	 *  in-app "Open/Join as" buttons). Defaults to the `DEVSTACK_AUTO_APPROVE`
	 *  env (`'1'`/`'true'`), then to the active network's `autoApproveSigning`
	 *  per-network policy (OFF by default on every network — a normal `pnpm dev`
	 *  shows the real connect + approve UX; opt in per-network). A single
	 *  switch, replacing per-app `VITE_*_AUTO_APPROVE`.
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
	 *  policy (OFF by default; opt in per-network) applies. The override RECORD is not
	 *  otherwise on disk, so an app that customizes per-network signing must
	 *  thread it here explicitly; the mainnet hard-clamp holds regardless. */
	readonly networkOptions?: Readonly<Record<string, unknown>>;
	/** Committed, per-network PROD deployments — `{ <net>: () => import('./deployments/<net>.ts') }`,
	 *  each thunk resolving to `{ deployment: NetworkDeployment }` (the typed
	 *  hand-written / `dump-deployment`-emitted file). These are the
	 *  non-local networks a production `build` ships, and the additional
	 *  networks a dev `serve` makes selectable alongside the live local one.
	 *  Each thunk's `deployment` is validated against `NetworkDeploymentSchema`
	 *  at config-load — a malformed committed file fails LOUDLY rather than
	 *  silently injecting a broken network.
	 *
	 *  DEFAULT (when omitted): AUTO-DISCOVERY of `<root>/deployments/*.ts` (D7
	 *  — "just drop a file"). Each filename (sans `.ts`) becomes a live network
	 *  name keyed to a dynamic-`import()` thunk reading the file's `deployment`
	 *  export. Supplying this option OVERRIDES auto-discovery entirely (a
	 *  custom dir / explicit paths). No `deployments/` dir + no option ⇒ no
	 *  committed networks. */
	readonly deployments?: Readonly<Record<string, () => Promise<{ deployment: NetworkDeployment }>>>;
	/** The network the app opens on when no live local network is present
	 *  (a pure production build, or a dev serve with only committed
	 *  networks). Defaults to the first committed network key. The live
	 *  local network always wins as the default in dev. */
	readonly defaultNetwork?: string;
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
	) => Promise<{
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
		/** `define` injecting the deployment envelope as
		 *  `__DEVSTACK_DEPLOYMENT__`. In a prod `build` this is the static
		 *  envelope literal; in dev `serve` it is a reference to the
		 *  `globalThis.__DEVSTACK_DEPLOYMENT_LIVE__` runtime global the
		 *  `transformIndexHtml` hook sets fresh per page load, so a republished
		 *  id reaches the app on reload (`define` is fixed for the dev server's
		 *  lifetime and could never hot-update). */
		readonly define: Record<string, string>;
	}>;
	/** Capture the resolved command so injection is DEV-only. */
	readonly configResolved: (config: ViteUserConfigLike) => void;
	/** Dev-only: watch the live `deployment.json` and full-reload the page
	 *  when it changes, so a republished package id (rewritten by the
	 *  supervisor's post-acquire hook) reaches the running app. */
	readonly configureServer: (server: ViteDevServerLike) => void;
	/** Resolve the dev-wallet virtual module. */
	readonly resolveId: (id: string) => string | undefined;
	/** Emit the dev-wallet register module (or a no-op when not applicable). */
	readonly load: (id: string) => string | undefined;
	/** Inject the dev-only HTML tags: the `__DEVSTACK_DEPLOYMENT_LIVE__`
	 *  global (read fresh from the deployment file per request) and, when the
	 *  app carries the dev wallet, the `<script type="module">` importing the
	 *  virtual module. The return shape mirrors a structural subset of Vite's
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
 *  `'codegen.deploymentFile'`, `'identity.network'`) from the active stack's
 *  manifest. Walks each path segment as a nested object, returning the leaf
 *  value, or `null` on ANY miss (absent / partially-written / version-
 *  mismatched manifest, a non-object hop, a missing or non-string/empty
 *  leaf). We read + `JSON.parse` directly (rather than the schema-decoding
 *  `readStackContext`, which drops the `codegen` field in its projection
 *  and throws on a version mismatch) so an out-of-date or partially-written
 *  manifest degrades gracefully instead of crashing the dev server. Never
 *  throws — the single discover→parse→guard→degrade-to-null reader every
 *  manifest field above (`codegen.deploymentFile`, `identity.network`)
 *  routes through. */
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

/** The gitignored `deployment.json` path the boot wrote for the active
 *  stack (`codegen.deploymentFile`), or `null` on any miss. */
const readIdsFileFromManifest = (
	env: Readonly<Record<string, string | undefined>>,
	cwd: string,
): string | null => readManifestField(env, cwd, 'codegen.deploymentFile');

/** SYNC read + schema-decode of a deployment ENVELOPE file. The MISSING-file
 *  case (absent path, no file on disk) collapses to `null` so the Vite config
 *  load degrades gracefully when no stack has booted / no committed file is
 *  wired. A PRESENT-but-malformed file is NOT swallowed: it flows through the
 *  shared {@link decodeDeployment}, which THROWS on bad JSON or a shape that
 *  violates `DevstackDeploymentSchema` — surfacing a genuinely broken
 *  deployment at config-load instead of silently injecting `null`. */
const readDeploymentFile = (file: string | null): DevstackDeployment | null => {
	if (file === null || !existsSync(file)) return null;
	return decodeDeployment(readFileSync(file, 'utf8'));
};

/** The LIVE local-stack deployment envelope for the active stack — the
 *  `deployment.json` boot wrote (via the manifest `codegen.deploymentFile`),
 *  or `null` on any miss. Read fresh so a republish reaches the app. */
const readLiveEnvelope = (
	env: Readonly<Record<string, string | undefined>>,
	root: string,
): DevstackDeployment | null => readDeploymentFile(readIdsFileFromManifest(env, root));

/** Resolve + validate the committed per-network deployments — the
 *  `deployments` option's thunks, each `() => Promise<{ deployment }>`. Each
 *  `deployment` is validated against `NetworkDeploymentSchema` (loud-fail on a
 *  malformed committed file) and stamped `{ network: <key>, local: false }` so
 *  the envelope key is authoritative and the deploy filter treats it as a real
 *  (non-local) network. Empty when no `deployments` are supplied. */
const resolveCommittedNetworks = async (
	deployments: Readonly<Record<string, () => Promise<{ deployment: NetworkDeployment }>>>,
): Promise<Record<string, NetworkDeployment>> => {
	const committed: Record<string, NetworkDeployment> = {};
	for (const [net, thunk] of Object.entries(deployments)) {
		const loaded = await thunk();
		const validated = decodeNetworkDeployment(loaded.deployment, `deployments['${net}']`);
		committed[net] = { ...validated, network: net, local: false };
	}
	return committed;
};

/** Auto-discover the committed per-network deployment thunks by globbing
 *  `<root>/deployments/*.ts` (D7 — "just drop a file" UX). Each filename
 *  (sans `.ts`) becomes a live network name keyed to a thunk that
 *  dynamically `import()`s the absolute file path and reads its `deployment`
 *  export (the `dump-deployment`-emitted / hand-written
 *  `export const deployment = {…} satisfies AppNetworkDeployment`). Returns
 *  `{}` when there is no `deployments/` dir (a clean clone / template — a
 *  pure types-only `deployment.ts` with an empty `ProvidedDeployments`). The
 *  explicit `deployments` option overrides this entirely (custom dir/paths).
 *  File CONTENTS are not read here — only the import is wired; ids load when
 *  Vite transforms the thunk at build/serve. */
const autoDiscoverDeployments = (
	root: string,
): Record<string, () => Promise<{ deployment: NetworkDeployment }>> => {
	const deploymentsDir = resolve(root, 'deployments');
	if (!existsSync(deploymentsDir)) return {};
	const thunks: Record<string, () => Promise<{ deployment: NetworkDeployment }>> = {};
	let files: ReadonlyArray<string>;
	try {
		files = readdirSync(deploymentsDir);
	} catch {
		return {};
	}
	for (const file of files) {
		if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
		const net = file.slice(0, -'.ts'.length);
		if (net.length === 0) continue;
		const abs = resolve(deploymentsDir, file);
		// `/* @vite-ignore */` — the specifier is a runtime-computed absolute
		// path (not a static literal Vite/Rollup can pre-analyze). Both Vite's
		// dev server and `vite build` resolve it as a dynamic import.
		thunks[net] = () =>
			import(/* @vite-ignore */ pathToFileURL(abs).href) as Promise<{
				deployment: NetworkDeployment;
			}>;
	}
	return thunks;
};

/** The committed per-network deployments to merge — the explicit
 *  `deployments` option when supplied, else auto-discovery of
 *  `<root>/deployments/*.ts` (D7). */
const resolveDeploymentThunks = (
	options: DevstackVitePluginOptions,
	root: string,
): Record<string, () => Promise<{ deployment: NetworkDeployment }>> =>
	options.deployments !== undefined ? { ...options.deployments } : autoDiscoverDeployments(root);

/** The first key of a record, or `undefined` when empty. */
const firstKey = (record: Record<string, unknown>): string | undefined => Object.keys(record)[0];

/** Merge the committed + live deployments into the envelope to inject as
 *  `__DEVSTACK_DEPLOYMENT__`.
 *   - `command === 'build'` (DEPLOY): the committed, NON-local networks only —
 *     the live local network is dropped. Empty ⇒ `null` (the generated
 *     resolver throws loudly at access time).
 *   - dev `serve` (and config-load default): the committed networks OVERLAID
 *     with the live local network(s), the live default winning. No live
 *     envelope ⇒ committed only (default = `defaultNetwork` option / first
 *     committed key).
 *  The live envelope's entries are forced `local: true` (they ARE the running
 *  local stack) so a later `build` would drop them. */
const mergeDeployment = (
	command: 'build' | 'serve' | undefined,
	committed: Record<string, NetworkDeployment>,
	live: DevstackDeployment | null,
	defaultNetworkOption: string | undefined,
): DevstackDeployment | null => {
	if (command === 'build') {
		if (Object.keys(committed).length === 0) return null;
		const fallback = firstKey(committed)!;
		// A pure prod build ships NO dev accounts (committed-only, network-
		// agnostic identities exist only when running through devstack).
		return {
			defaultNetwork:
				defaultNetworkOption !== undefined && committed[defaultNetworkOption] !== undefined
					? defaultNetworkOption
					: fallback,
			networks: committed,
			accounts: {},
		};
	}
	// Dev serve / config-load default: overlay the live local network(s).
	const networks: Record<string, NetworkDeployment> = { ...committed };
	if (live !== null) {
		for (const [net, dep] of Object.entries(live.networks)) {
			networks[net] = { ...dep, network: net, local: true };
		}
		// Dev `accounts` ride the ENVELOPE (network-agnostic dev identities):
		// the live local stack supplies them; committed `deployments/*.ts`
		// networks carry none. Carry them through onto the merged envelope.
		return {
			defaultNetwork: live.defaultNetwork,
			networks,
			accounts: live.accounts ?? {},
		};
	}
	const fallback = firstKey(networks);
	if (fallback === undefined) return null;
	return {
		defaultNetwork:
			defaultNetworkOption !== undefined && networks[defaultNetworkOption] !== undefined
				? defaultNetworkOption
				: fallback,
		networks,
		accounts: {},
	};
};

/** Resolve the deployment envelope to inject as `__DEVSTACK_DEPLOYMENT__` —
 *  the committed per-network `deployments` thunks merged with the live local
 *  stack (`command === 'serve'` and the config-load default) / nothing
 *  (`command === 'build'`). No committed networks + no live stack ⇒ `null`, so
 *  the generated resolver throws loudly at access time. */
const resolveInjectedDeployment = async (
	env: Readonly<Record<string, string | undefined>>,
	root: string,
	command: 'build' | 'serve' | undefined,
	options: DevstackVitePluginOptions,
): Promise<DevstackDeployment | null> => {
	const committed = await resolveCommittedNetworks(resolveDeploymentThunks(options, root));
	const live = command === 'build' ? null : readLiveEnvelope(env, root);
	return mergeDeployment(command, committed, live, options.defaultNetwork);
};

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
 * into the user config (Vite deep-merges the returned partial). Async
 * (it awaits the committed `deployments` thunks); reads `process.env` +
 * the manifest (for `__DEVSTACK_DEPLOYMENT__`) once at config-load.
 */

/** The on-disk dev-wallet pairing-token path for the active stack. The
 *  token lives in a `0o600` side-channel file (`<stackRoot>/wallet/token`,
 *  written by `pairing.ts`), NEVER in the world-readable `deployment.json`.
 *  The boot writes `deployment.json` into the SAME `<stackRoot>`, so the
 *  token sits at `<dirname(deploymentFile)>/wallet/token`. Read in Node by
 *  the `load` hook (which runs server-side) so the secret stays off the
 *  manifest/deployment surface. Returns `null` on any miss. */
const readDevWalletToken = (
	env: Readonly<Record<string, string | undefined>>,
	cwd: string,
): string | null => {
	const deploymentFile = readIdsFileFromManifest(env, cwd);
	if (deploymentFile === null) return null;
	const tokenFile = resolve(dirname(deploymentFile), 'wallet', 'token');
	try {
		if (!existsSync(tokenFile)) return null;
		const raw = readFileSync(tokenFile, 'utf8').trim();
		return /^[0-9a-f]{32}$/.test(raw) ? raw : null;
	} catch {
		return null;
	}
};

/** Read the `DEVSTACK_AUTO_APPROVE` env (`'1'`/`'true'`, case-insensitive). */
const autoApproveFromEnv = (env: Readonly<Record<string, string | undefined>>): boolean => {
	const raw = env['DEVSTACK_AUTO_APPROVE'];
	return raw === '1' || raw?.toLowerCase() === 'true';
};

/** True under a Playwright e2e run (`DEVSTACK_E2E` set to `'1'`/`'true'`,
 *  case-insensitive). DEDICATED signal — distinct from `DEVSTACK_AUTO_APPROVE`
 *  — driving the injected `__DEVSTACK_E2E__` global. Gates dApp Kit's
 *  `autoConnect` ON only under e2e, so a normal `pnpm dev` serve exercises the
 *  real connect UX. A prod `vite build` never sets the env ⇒ injects `false`
 *  (tree-shakeable). */
const e2eFromEnv = (env: Readonly<Record<string, string | undefined>>): boolean => {
	const raw = env['DEVSTACK_E2E'];
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
	const injectDevWallet = options.injectDevWallet ?? true;

	// Captured across hooks. `config` runs first (alias resolution + committed
	// deployment validation), `configResolved` records the command (DEV-gate),
	// and `load` reads the dev-wallet connection off the injected deployment +
	// the secret token off its side-channel file.
	let resolvedRoot = process.cwd();
	let isServe = false;
	// The committed per-network deployments, resolved + validated ONCE in the
	// async `config` hook (the thunks are async; the runtime-global path in
	// `transformIndexHtml` is sync). Stable for the dev server's lifetime, so
	// the per-request HTML injection overlays the fresh live network on top of
	// these without re-awaiting.
	let resolvedCommittedNetworks: Record<string, NetworkDeployment> = {};

	return {
		name: 'devstack:generated-alias',
		config: async (config: ViteUserConfigLike, configEnv?: ViteConfigEnvLike) => {
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
			// codegen`; ids resolve at runtime via `__DEVSTACK_DEPLOYMENT__`, so
			// the same tree serves every stack.
			const explicit = options.generatedDir;
			const generatedDir =
				explicit !== undefined ? resolve(root, explicit) : resolve(root, GENERATED_SUBPATH);
			// Return a partial config; Vite deep-merges it. `resolve.dedupe`
			// pins a single Lit copy, and — when this app carries the dev
			// wallet — we pre-bundle the injected dev-wallet entries so Vite
			// never re-optimizes them mid-session into a second Lit realm
			// (see the constants above).
			const includeDevWallet = injectDevWallet && devWalletInstalled(root);
			// Resolve + validate the committed per-network deployments ONCE (the
			// thunks are async; the per-request HTML path is sync). Captured so
			// `transformIndexHtml` overlays the fresh live network on top of
			// these without re-awaiting. A malformed committed file throws here,
			// at config-load.
			resolvedCommittedNetworks = await resolveCommittedNetworks(
				resolveDeploymentThunks(options, root),
			);
			// Inject the deployment envelope the generated `config-runtime.ts`
			// resolver reads as `__DEVSTACK_DEPLOYMENT__`.
			//   - PROD build: bake the static merged envelope literal (committed,
			//     non-local networks only).
			//   - DEV server (`vite dev`): point the identifier at the
			//     `__DEVSTACK_DEPLOYMENT_LIVE__` runtime global the
			//     `transformIndexHtml` hook sets fresh per page load — `define`
			//     is fixed for the dev server's lifetime, so baking the value
			//     would pin the FIRST id forever and a republish would never
			//     reach the app. A distinct global name avoids a single-pass
			//     `define` token collision with `__DEVSTACK_DEPLOYMENT__`.
			//   - VITEST: vitest ALSO reports `command === 'serve'`, but it runs
			//     no `transformIndexHtml` (no HTML), so the live global is never
			//     set — and esbuild's stricter `define` rejects an operator
			//     expression anyway. Bake a literal instead: the Vite config loads
			//     BEFORE the test stack boots, so the merged envelope is null and
			//     the resolver falls back to the `DEVSTACK_DEPLOYMENT_FILE` env the
			//     vitest globalSetup points at the freshly-booted stack (see
			//     vitest/global-setup.ts).
			// The define VALUE must be esbuild-valid (a JSON literal or a
			// member-access chain) — note the bare `globalThis.…`, NOT a
			// parenthesised `(… ?? null)`; `config-runtime.ts` already guards the
			// `typeof … === 'undefined'` case.
			const injectedDeployment = await resolveInjectedDeployment(env, root, command, options);
			const isVitest = env['VITEST'] !== undefined;
			const deploymentDefine =
				command === 'serve' && !isVitest
					? 'globalThis.__DEVSTACK_DEPLOYMENT_LIVE__'
					: JSON.stringify(injectedDeployment ?? null);
			return {
				resolve: {
					// A bare-prefix alias (no trailing `/`) matches both
					// `@generated` and `@generated/foo.js` under Vite's default
					// string-alias resolution.
					alias: {
						[alias]: generatedDir,
					},
					dedupe: resolvableLitDedupe(root),
				},
				define: {
					__DEVSTACK_DEPLOYMENT__: deploymentDefine,
					// `true` ONLY under a Playwright e2e run (`DEVSTACK_E2E`), so the
					// app's dApp Kit `autoConnect` is on for headless e2e and OFF for a
					// normal `pnpm dev` serve. A prod `vite build` never sets the env ⇒
					// `false` (tree-shakeable). Distinct from `DEVSTACK_AUTO_APPROVE`.
					__DEVSTACK_E2E__: JSON.stringify(e2eFromEnv(env)),
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
			const env = process.env as Readonly<Record<string, string | undefined>>;
			// The dev-wallet connection metadata rides the injected deployment's
			// `values['dev-wallet'].connection` channel (non-secret); the secret
			// pairing token stays in its `0o600` side-channel file, read HERE in
			// Node (the `load` hook runs server-side) so it never lands in the
			// world-readable `deployment.json`. Graceful no-op when injection is
			// off, not a dev serve, or no live stack has written the token yet
			// (no `devstack up`). The presence of BOTH the deployment file (for the
			// connection) and the token gate injection — the browser side resolves
			// the connection off the injected envelope.
			const token = readDevWalletToken(env, resolvedRoot);
			if (!injectDevWallet || !isServe || token === null) {
				return 'export {};';
			}
			// Auto-approve resolution (highest precedence first): explicit
			// `options.autoApprove`, then the `DEVSTACK_AUTO_APPROVE` env, then
			// the active network's `autoApproveSigning` per-network policy. The
			// policy defaults OFF on every network — a normal `pnpm dev` exercises
			// the real connect + approve UX, headless e2e sets the env, and an
			// author can opt a network back in via `networkOptions`. Live
			// `mainnet` is additionally hard-clamped OFF, so a stack booted
			// against real mainnet never silently auto-approves a real-funds
			// signature. The active network comes from the manifest
			// boot wrote (`identity.network`); absent that we conservatively
			// resolve as `mainnet` (auto-approve OFF) rather than assuming a
			// dev network. The override RECORD isn't on disk — `networkOptions`
			// is read from the plugin option when the app threads it.
			const network = readManifestField(env, resolvedRoot, 'identity.network') ?? 'mainnet';
			const netOpts = resolveNetworkOptions(network, options.networkOptions);
			const autoApprove =
				options.autoApprove ?? (autoApproveFromEnv(env) || netOpts.autoApproveSigning);
			// Browser-side registration source the dev server transpiles. It reads
			// the dev-only account name→address map (`resolveAccounts()`) and the
			// non-secret dev-wallet connection (`optionalValue(dep, 'dev-wallet',
			// 'connection')`) off the injected deployment envelope (via the
			// generated `config-runtime.ts`), and the FULL network set the app
			// supports off the generated `config.networks` map (each with its
			// routed `rpc` + optional `faucet`). The wallet advertises each network
			// as a wallet-standard chain and operates on whichever dApp Kit has
			// selected, so it PERSISTS across a UI `switchNetwork` (registered once;
			// only the active chain changes). The token is baked in from the Node
			// read above — the only secret on this surface.
			return [
				`import { registerDevstackDevWallet } from '@mysten-incubation/dev-wallet/inject';`,
				`import { config as __devstackConfig } from '${alias}/config.js';`,
				`import { resolveAccounts, optionalValue } from '${alias}/config-runtime.js';`,
				`const __devstackToken = ${JSON.stringify(token)};`,
				// name → address (from the injected envelope's dev `accounts`),
				// mapped to the inject API's `{ address }` shape.
				`const __devstackAccounts = Object.fromEntries(`,
				`  Object.entries(resolveAccounts()).map(([__name, __address]) => [`,
				`    __name,`,
				`    { name: __name, address: __address },`,
				`  ]),`,
				`);`,
				// The full routed network set (live local + any committed live).
				`const __devstackNetworks = Object.fromEntries(`,
				`  Object.entries(__devstackConfig.networks).map(([__net, __dep]) => [`,
				`    __net,`,
				`    { rpc: __dep.rpc, faucet: __dep.faucet ?? null },`,
				`  ]),`,
				`);`,
				// Non-secret connection (server URL + protocol paths), resolved off
				// the default network's `values['dev-wallet'].connection`. No
				// stack ⇒ undefined ⇒ no injection.
				`const __devstackDefaultDep = __devstackConfig.networks[__devstackConfig.defaultNetwork];`,
				`const __devstackConnection = __devstackDefaultDep`,
				`  ? optionalValue(__devstackDefaultDep, 'dev-wallet', 'connection')`,
				`  : undefined;`,
				`if (__devstackConnection) {`,
				`  registerDevstackDevWallet({`,
				`    serverOrigin: __devstackConnection.walletUrl,`,
				`    token: __devstackToken,`,
				`    accounts: __devstackAccounts,`,
				`    networks: __devstackNetworks,`,
				`    defaultNetwork: __devstackConfig.defaultNetwork,`,
				`    autoApprove: ${autoApprove ? 'true' : 'false'},`,
				`    mountUI: true,`,
				`  }).catch((err) => console.error('[devstack] dev-wallet injection failed:', err));`,
				`}`,
			].join('\n');
		},

		configureServer: (server: ViteDevServerLike) => {
			if (!isServe) return;
			const env = process.env as Readonly<Record<string, string | undefined>>;
			const idsFile = readIdsFileFromManifest(env, resolvedRoot);
			if (idsFile === null) return;
			// Watch the live deployment and full-reload on change. The supervisor's
			// post-acquire hook rewrites this file whenever a package (re)publishes
			// (e.g. after a Move-source edit fires the file watcher → selective
			// restart); a reload re-runs `transformIndexHtml`, which re-reads the
			// file into `__DEVSTACK_DEPLOYMENT_LIVE__`, so the app picks up the new id.
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
			// Read the live local envelope FRESH per request so a full-reload
			// after a republish injects the new id, then overlay it on the
			// committed networks captured at config-load (a sync merge — the
			// committed thunks were already awaited in `config`). Set on a
			// distinct global (`__DEVSTACK_DEPLOYMENT_LIVE__`) the `config` hook's
			// `define` points `__DEVSTACK_DEPLOYMENT__` at; `head-prepend` runs it
			// before any app module.
			const live = readLiveEnvelope(env, resolvedRoot);
			const liveDeployment = mergeDeployment(
				'serve',
				resolvedCommittedNetworks,
				live,
				options.defaultNetwork,
			);
			const tags: Array<{
				tag: string;
				attrs?: Record<string, string | boolean>;
				children?: string;
				injectTo: 'head' | 'head-prepend';
			}> = [
				{
					tag: 'script',
					children: `globalThis.__DEVSTACK_DEPLOYMENT_LIVE__ = ${JSON.stringify(liveDeployment ?? null)};`,
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
