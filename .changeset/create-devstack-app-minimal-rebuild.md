---
'@mysten-incubation/create-devstack-app': minor
---

Rebuild the scaffold around a minimal, survives-into-production template.

The generated app is no longer a demo-panel gallery: it is the smallest real app that exercises the full devstack loop — one `counter` Move package, one screen (or, for the new `--template ts` headless variant, one module) calling it through the generated bindings, and one vitest spec that runs against the live stack. Every generated file is meant to be edited and kept, not deleted. Rich demos live in `examples/` instead.

Optional services (walrus, seal) are now config lines, not file sets: selecting one adds its factory call to the rendered `devstack.config.ts` and keeps its SDK dependency — nothing else. DeepBook is no longer offered by the scaffolder: devstack stopped auto-synthesizing a local DeepBook (it needs vendored Move packages and explicit pool config), so the generated README points to `examples/deepbook-trader` instead. The app-local plugin framework (`src/devstack/` contribution modules and the generated `app-panels.ts`/`plugins.ts` barrels) is gone; the config is straight-line `defineDevstack({ members })`, exactly like the documented API.

Scaffolder changes: prompts rebuilt on @clack/prompts (Ink/React dropped); `--template app|ts` selects the variant; non-interactive/`--yes` now defaults to no optional services (was: all); generated apps carry no `DEVSTACK_APP=` tokens (the CLI infers the app name from `package.json#name`) and no pinned `stackName`; Playwright and Tailwind are no longer scaffolded. CI now installs and typechecks scaffolded apps against packed workspace tarballs and boot-smokes one end to end.

This supersedes the unreleased demo-panels/plugin-picker template rebuild; its pending changeset was folded into this one.
