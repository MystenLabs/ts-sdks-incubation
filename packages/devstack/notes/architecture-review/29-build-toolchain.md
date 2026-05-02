# Build toolchain + package consumption

**Verdict**: B+ — Well-shaped tsdown config. `unbundle: true` solves the asset-resolution problem cleanly. **No build-output smoke test exists** — the recent tsup→tsdown migration broke exactly this surface and is fixing the symptom (image -r6 bump), not the cause.

## Architecture

The tsdown config (`packages/devstack/tsdown.config.ts:13-50`) is well-shaped for the problem at hand. `unbundle: true` preserves the `src/` tree under `dist/` as `.mjs` siblings (verified: 77 `.mjs` files mirror the source layout with parallel `.d.mts` declarations, `.mjs.map` source maps, and `dist/plugins/{sui,seal,walrus,codegen,imports,vite,wallet-server}/` all populated). This is the right call — `dirname(fileURLToPath(import.meta.url))` resolves identically in source and built form, so the runtime asset-resolution code path is a single shape across dev and publish. The `copy:` array correctly mirrors the two non-source assets we actually use (`sui/Dockerfile`, `sui/entrypoint.sh`, `seal/Dockerfile`); the dist confirms they land alongside the matching `.mjs`. The `format: 'esm'` + `type: 'module'` + `.d.mts` story is internally consistent. `treeshake: false` is correct for an unbundled multi-entry package — treeshaking across siblings would cause lost re-exports.

**Watch-outs**: `walrus/build.ts` deliberately inlines its Dockerfile as a string and so doesn't need `copy`, but a future plugin adding a non-source asset will silently fail unless the maintainer remembers to update the `copy` array. Consider a glob-based copy (e.g. `src/plugins/**/{Dockerfile,entrypoint.sh}`) so this stays evergreen.

## Problem fit (does it consume?)

**In-workspace**: Yes. The exports map at `packages/devstack/package.json:26-63` covers all subpaths the four examples actually import — root, `/vite`, `/react`, `/playwright`, `/vitest`, `/runtime`, `/helpers`, `/cli` — and every consumer import resolves cleanly to a `dist/.../*.mjs` + `*.d.mts` pair.

**Published context**: Should also work. `files: ["dist", "README.md", "CHANGELOG.md", "LICENSE"]` ships everything needed, `bin: ./dist/cli/index.mjs` has a `#!/usr/bin/env node` shebang (verified), and `prepublishOnly: pnpm run build` guarantees `dist/` is fresh on publish. `engines.node: >=24.0.0` is honest given `node:` builtins and ESM-only runtime.

**Gap**: there is no internal export for the plugin assets path itself, but consumers don't reach for that — `import.meta.url` self-resolution makes it unnecessary.

## Integration

`workspace:*` resolution to `packages/devstack` is wired via `pnpm-workspace.yaml`. **Hot-reload story is the real friction point**: the example consumes `dist/*.mjs`, not source, so an iteration on devstack source requires running `pnpm --filter @mysten-incubation/devstack build:watch` in a sidecar terminal. There's no condition export pointing at `src/*.ts` for in-workspace consumers (a "development" condition would help). Turbo's `build` task cascades `^build` and inputs `tsdown.config.ts`, which is correct, but examples don't depend-fence on `^build` — `dev` does, so the first `pnpm dev` may race a stale dist.

**Peer deps**: `package.json:108-143` correctly marks all React/Vite/Playwright/Vitest/dapp-kit as optional peers and externalizes them in `tsdown.config.ts:38-44`. This is right — devstack core doesn't need React, only `/react` does. **Issue**: `@tanstack/react-query`, `react`, `react-dom`, `vite`, `vitest`, `@playwright/test` are also under `dependencies`/`devDependencies` via the catalog; they should only appear under `peerDependencies` + `devDependencies` to avoid double-install in published apps.

## Customizability + Gaps

- **No CJS output.** Anyone consuming devstack from a CJS app will get an `ERR_REQUIRE_ESM`. Acceptable today but should be documented.
- **`.d.mts` declarations** present for every `.mjs`. Good.
- **Source maps** present (verified: 73 `.mjs.map` files), so stack traces in published consumers point at original source.
- **Treeshaking** disabled by design (correct for unbundled). Consumers' bundlers (Vite) still treeshake at the import-graph level.

## Testing

**No build-output smoke test exists.** `prepublishOnly` runs the build but nothing verifies that a fresh consumer can `import { sui } from '@mysten-incubation/devstack'`, that `bin` is executable, that Dockerfiles landed under `dist/plugins/sui/`, or that subpath conditions resolve. Given the recent tsup-to-tsdown migration broke exactly this surface (and "tag bumped to -r6 to force rebuild" is fixing the symptom, not the cause), a **post-build verification** would be high-leverage: `node --input-type=module -e "import('./dist/index.mjs').then(m => console.log(Object.keys(m).length))"`, plus an `existsSync` check for `dist/plugins/sui/Dockerfile`, `entrypoint.sh`, `dist/plugins/seal/Dockerfile`, and the `bin` shebang. Wire it as `posttest` or a dedicated `test:dist` step.

## Top recommendations

1. **Glob-based `copy`** so new plugin assets aren't silently dropped.
2. **Post-build smoke script** asserting subpath resolution + asset presence (would have caught the tsup regression).
3. **Remove duplicate React/Vite/Vitest/Playwright entries** if currently double-listed in dependencies; keep only as peer + devDep.
4. **Document CJS-not-supported in README.**
5. **Optional: a `"development"` condition** mapping to `src/*.ts` for in-workspace hot-reload without a sidecar `build:watch`.
