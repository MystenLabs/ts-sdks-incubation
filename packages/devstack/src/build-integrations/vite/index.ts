// Vite build-integration — `@generated` alias plugin.
//
// notes/per-stack-codegen-design.md §"Import mapping via a customizable
// alias": app source imports its Move codegen through a configurable
// alias prefix (default `@generated`) instead of `./generated`. This
// plugin points that alias at the ACTIVE stack's output dir — the EXACT
// dir codegen wrote to for the current stack — so two stacks of the
// same app (`pnpm dev` on the home stack + `pnpm test:e2e` on a
// `--stack e2e` override) resolve `@generated/*` to different
// directories and never read each other's clobbered package-id /
// wallet-pair-token literals.
//
// The target is the manifest-recorded `codegen.generatedDir` (the
// single source of truth — the supervisor wrote it at flush time; see
// `orchestrators/codegen/output-location.ts` +
// `runtime-composition.ts`). Resolution:
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

/** Default home-stack output subpath, relative to the Vite root. The
 *  cold-start fallback when no manifest / `codegen.generatedDir` is on
 *  disk yet. Mirrors `output-location.ts`'s home rule. */
const FALLBACK_GENERATED_SUBPATH = 'src/generated';

export interface DevstackVitePluginOptions {
	/** Import-alias prefix. Default `'@generated'`. */
	readonly alias?: string;
	/** Explicit generated dir — bypasses manifest discovery entirely
	 *  (escape hatch for unusual layouts / tests). Relative paths
	 *  resolve against the Vite root. */
	readonly generatedDir?: string;
}

/** A `vite` `Plugin`'s `config` hook receives the partial user config.
 *  We only ever read `config.root` and return a `resolve.alias` patch,
 *  so a one-field structural subset is enough — this keeps the module
 *  loadable without `vite` types (mirroring how the playwright/vitest
 *  presets avoid importing their optional peer at module init). */
interface ViteUserConfigLike {
	readonly root?: string;
}

/** The structural `Plugin` shape we return — `name` + a `config` hook.
 *  Typed as the loose object Vite accepts (Vite's `Plugin` is
 *  structurally compatible) so callers spread it into `plugins: []`
 *  without devstack depending on `vite`. */
export interface DevstackVitePlugin {
	readonly name: string;
	readonly config: (config: ViteUserConfigLike) => {
		readonly resolve: { readonly alias: Record<string, string> };
	};
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
export const devstackVitePlugin = (options: DevstackVitePluginOptions = {}): DevstackVitePlugin => {
	const alias = options.alias ?? DEFAULT_GENERATED_ALIAS;
	return {
		name: 'devstack:generated-alias',
		config: (config: ViteUserConfigLike) => {
			const root = config.root ?? process.cwd();
			// Explicit `generatedDir` wins (relative → resolved against the
			// Vite root). Otherwise consult the manifest-recorded dir, then
			// fall back to the home-stack `src/generated/` for the
			// pre-supervisor cold-start window.
			const explicit = options.generatedDir;
			const generatedDir =
				explicit !== undefined
					? resolve(root, explicit)
					: (readGeneratedDirFromManifest(
							process.env as Readonly<Record<string, string | undefined>>,
							root,
						) ?? resolve(root, FALLBACK_GENERATED_SUBPATH));
			// Return a partial config; Vite merges `resolve.alias` into the
			// existing alias map. A bare-prefix alias (no trailing `/`)
			// matches both `@generated` and `@generated/foo.js` under Vite's
			// default string-alias resolution.
			return { resolve: { alias: { [alias]: generatedDir } } };
		},
	};
};
