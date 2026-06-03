# Devstack follow-ups

## Verify how external/bundled deepbook Move assets load in real stacks

**What we observed.** The deepbook e2e fails in a fresh checkout with "bundled Move package is
missing at `src/plugins/deepbook/bootstrap-assets/move/deepbookv3/deepbook`. Run
`pnpm build:deepbook-assets`" (thrown by `src/plugins/deepbook/bootstrap-assets/index.ts:47-50`).
The deepbook Move sources are **build-time artifacts**, not vendored in git — `.gitignore:6-16`
ignores both `move-assets/` and `src/plugins/deepbook/bootstrap-assets/move/deepbookv3/`.

**Mechanism today.** Two-stage pipeline. (1) `scripts/fetch-deepbook-move.mjs:38-39` shallow-clones
deepbookv3 at pinned SHA `378f71bb…` into `src/plugins/deepbook/bootstrap-assets/move/deepbookv3/`.
(2) `scripts/build-deepbook-assets.mjs:18-19,35-46` copies that tree into `move-assets/deepbook/`
(filtering build/, Move.lock, Published.toml). `package.json:68` runs `build:deepbook-assets` before
`tsdown`. At runtime, `bootstrap-assets/index.ts:21-34` resolves `SHIPPED_ROOT`
(`../../../../move-assets/deepbook` relative to dist) first, falling back to `SOURCE_ROOT`
(in-source `./move`) for monorepo dev. There is **no external/override path** —
`synthesize.ts:125-126,180-181` calls `bundledDeepbookSource()`/`bundledPythSource()` with hardcoded
paths only; `DeepbookLocalOptions` (`index.ts:145-172`) has no `sourcePath` field. (The
`examples/deepbook-trader/devstack.config.ts` vendors its own `move/vendor/` and passes explicit
`sourcePath`, but that is an in-repo example, not a consumer affordance.)

**THE CRUX.** Verdict: **confirmed-ships**. The published npm tarball DOES include the assets, so a
consumer's real stack can boot deepbook with zero build steps. Evidence: `package.json:59-66`
"files" array whitelists `move-assets` with no `.npmignore` override; `npm pack --dry-run` lists 34
files under `move-assets/deepbook/` including `deepbookv3/deepbook/Move.toml`, `token/`, `dusdc/`,
`deepbook-sandbox/pyth/Move.toml`, and full `.move` sources (`pool.move`, `balance_manager.move`,
etc.). The e2e error only occurs in a fresh monorepo checkout where `pnpm build` has not run — it is
a dev-environment issue, NOT a consumer packaging defect.

**Verification checklist.**

1. Inspect the published tarball: `npm pack --dry-run` (or fetch the actual published version) and
   confirm `move-assets/deepbook/**/Move.toml` + source files are present and non-empty.
2. Run `scripts/packed-consumer-typecheck.mjs` (packs + installs into a temp consumer) and extend it
   to exercise a real `deepbook()` boot / `devstack apply`, asserting no "bundled Move package is
   missing".
3. Confirm there is NO `prepare`/`postinstall`/`prepublishOnly` hook in `package.json` — assets ship
   as static files; verify CI runs `pnpm build` before publish so `move-assets/` exists at pack
   time.
4. Add a CI guard that fails publish if `move-assets/deepbook/deepbookv3/deepbook/Move.toml` is
   absent or empty before packing.
5. Decide the long-term policy: keep build-on-build + ship-via-files (current), vs. commit assets to
   git, vs. fetch-at-runtime. Document the chosen invariant and the pinned-SHA
   re-pin/garbage-collection risk (`378f71bb…`).
6. Improve the runtime error in `bootstrap-assets/index.ts:47-50` to name BOTH the shipped path
   (consumer) and source path (dev) so failures self-diagnose by context.
