---
'@mysten-incubation/create-devstack-app': minor
'@mysten-incubation/devstack': minor
'@mysten-incubation/dev-wallet': patch
---

Fix scaffolded-app build/dev breakages and dashboard reporting; reshape codegen + tests.

- **create-devstack-app**: declare `lit` + `@mysten/signers` (fix `vite build` "failed to resolve lit" and the dev-wallet injection crash); run `pnpm codegen` after install when `sui` is on PATH (`--no-codegen` to skip); move tests to `tests/unit` · `tests/e2e` · `tests/browser` with a standalone `tsconfig.test.json`.
- **devstack**: the Vite plugin now dedupes only Lit packages hoisted at the app root (phantom packages no longer break the production build); `devstack codegen` requires a host `sui` CLI (the Docker fallback is removed) and fails fast when it's missing; the vitest/Playwright presets adopt the `tests/unit`/`tests/e2e`/`tests/browser` layout; the dashboard surfaces Pyth price feeds (`DeepbookInfo.pythFeeds`) and renames `marketMakerRunning` → `hasSeedLiquidity`; fix a bug where `devstack up`'s extras emit clobbered the committed `src/generated/.gitignore` with an ignore-all policy.
- **dev-wallet**: the WebCrypto adapter is loaded lazily and gated on the optional `@mysten/signers` peer, so an app without it still gets a working dev wallet instead of a hard inject crash.
