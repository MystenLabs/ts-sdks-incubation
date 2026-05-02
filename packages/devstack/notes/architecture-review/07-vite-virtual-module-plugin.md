# Vite virtual-module plugin (`@mysten-incubation/devstack/vite`)

**Verdict**: B — Right shape, wrong amount of testing. Type-generation duplication and a stale wasm-url claim are the two visible drift points.

## What the plugin actually is

`devstackVitePlugins()` returns a single Vite `Plugin` (despite the plural name and `Plugin[]` return type) — `devstackManifestPlugin`, which serves the virtual ID `virtual:devstack-manifest`. The plugin synchronously reads `<viteRoot>/.devstack/active` (defaulting to `'main'`), then reads `<viteRoot>/.devstack/stacks/<active>/manifest.json` and emits `export const manifest = <inline JSON>`. An empty typed manifest fallback (`EMPTY_MANIFEST` at `plugin.ts:38`) is returned when the file is missing or unparseable, so apps boot before first `devstack up`.

The wasm-url module the docs reference does **not exist in code**. `packages/devstack/src/react/walrus.ts:45` documents `virtual:devstack-walrus-wasm-url` as auto-resolved by `devstackVitePlugins()`, but there is no implementation, and `examples/private-content/src/lib/walrus.ts:14` resolves the wasm directly via `@mysten/walrus-wasm/web/walrus_wasm_bg.wasm?url`. **This is a documentation/code drift bug.**

## Architecture

The virtual-module choice is correct for this problem: a static file emit (e.g. `src/generated/manifest.json`) would either need a writer in two places (the runtime AND the plugin) or commit generated JSON to git. The virtual module reads disk lazily inside `load()` per request, so the bundle just has the inlined JSON — no runtime fetch.

Active-stack resolution is layered cleanly: `DEVSTACK_STACK` env override → `.devstack/active` pointer → `'main'` default. The pointer indirection is what enables `devstack stack use <other>` without restarting Vite. `manifestPath` overrides skip both layers — useful for e2e tests that pin a frozen stack.

HMR is wired via `configureServer.server.watcher`. It re-primes the watcher on every change so a stack flip (which changes `currentManifestPath()` to the new stack's file) starts watching the new file. `server.reloadModule()` is the right call — manifests almost always trigger boot-time choices (provider config, dapp-kit registration), not partial-fast-refresh updates, so a full module re-evaluation is appropriate.

## Problem fit

For first-party use (private-content, token-studio, etc.) the plugin works well. The empty fallback paired with `dependsOnKind` on the codegen action means apps typecheck before first bring-up. Stack switches reload deterministically. Everything that flows out — `dapp-kit.ts`, `generated/deployment.ts`, walrus client — is already a thin adapter on top of `manifest`.

## Integration

**Type generation is the weakest seam.** Every example duplicates a hand-written `declare module 'virtual:devstack-manifest'` block in `src/vite-env.d.ts` (e.g. `examples/private-content/src/vite-env.d.ts:3-49`). The plugin emits the typed export `manifest: Manifest` from `runtime/manifest-types.ts`, but consumers can't `import type { Manifest }` from `'virtual:devstack-manifest'` without an ambient declaration — and since the plugin's `load()` only emits a `const manifest = ...` (no `export type Manifest`), the four examples each redeclare a *narrower, hand-maintained* `Manifest` shape. This is duplication and drift bait. The plugin should either: (a) ship an ambient `.d.ts` file at `dist/vite/virtual.d.ts` that consumers reference once, or (b) write `export type Manifest = ...` into the virtual module's source.

`vite build` works because `load()` returns inlined JSON — production deploys will simply bake whatever the live-net manifest contained at build time. There is no documentation of *which* manifest a production build picks; today it's whatever `.devstack/active` points at.

## Customizability + gaps

- **Custom manifest path:** supported via `manifestPath` (absolute or relative-to-root).
- **Multiple stacks at once:** not supported — only one `virtual:devstack-manifest` ID. A real use case (compare-stacks-in-one-app) would need either a parametrized virtual ID like `virtual:devstack-manifest?stack=test` or a second factory call.
- **Live-net manifest:** the plugin doesn't auto-detect `mode === 'production'` to pick `.devstack/manifests/<network>.json`. Consumers must wire it manually with `manifestPath`.
- **Non-Vite consumers:** zero support. Webpack/esbuild/Rollup users would each need a port. This is fine given the repo's Vite-first stance, but the file's docstring should say "Vite only" rather than implying a generic plugin.
- **The `devstackVitePlugins` array indirection** is dead today (one plugin returned). Useful only as a future extension point — and the wasm-url module would have been one.

## Testing

**Zero tests.** No `plugin.test.ts` next to `vite/plugin.ts`; `find` confirms it's the only file in `src/vite/`. Untested behaviors that matter: virtual ID resolution, fallback on missing/corrupt JSON, env-var override precedence, watcher rebind on stack flip, `manifestPath` absolute vs. relative resolution. All of these are pure-fs and mockable — a `tmpdir`-based test would be cheap. Given the plugin's tier-zero position (every example consumes it), this is the highest-leverage gap.

## Top recommendations

1. **Implement `virtual:devstack-walrus-wasm-url` to match the doc**, OR remove the dangling reference in `react/walrus.ts:44-46`. Prefer implementing it — it removes the direct `@mysten/walrus-wasm` import from app code.
2. **Ship an ambient `.d.ts` for `virtual:devstack-manifest`** alongside the plugin, deleting the four duplicates.
3. **Add unit tests** covering fallback, override precedence, and stack switching.
4. **Document `manifestPath` for production builds**; consider `mode`-aware default selection.
