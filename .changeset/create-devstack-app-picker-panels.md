---
'@mysten-incubation/create-devstack-app': minor
---

Rebuild the scaffolded template as per-plugin demo panels with an interactive plugin picker.

The template app is now a set of working demo panels — an on-chain counter (core), walrus blob upload and read-back, seal encrypt/decrypt, and a deepbook pool with a live order — instead of the no-op greeting. `create-devstack-app` now prompts which plugins to include (core is always present; seal / walrus / deepbook are optional and default to all) and strips the unselected ones, producing a clean, dangling-ref-free app for any subset. Non-interactive `--plugins` / `--all` / `--minimal` flags are available for scripted use.

The dev-wallet wiring is confined to a dev-only module so the template is deployable to a real network (no dev accounts in the production bundle). Tests run on a separate `test` stack so end-to-end tests work while `pnpm dev` is running, the template ships real e2e and unit tests (so `pnpm test` is no longer empty), and the generated app consumes the reshaped devstack codegen (`@generated/config.js`, plugin siblings, and the `@devstack-dev` dev surface).
