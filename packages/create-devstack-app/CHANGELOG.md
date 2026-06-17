# @mysten-incubation/create-devstack-app

## 0.2.0

### Minor Changes

- 9e1e1be: Rebuild the scaffold around a minimal, survives-into-production template.

  The generated app is no longer a demo-panel gallery: it is the smallest real app that exercises
  the full devstack loop — one `counter` Move package, one screen (or, for the new `--template ts`
  headless variant, one module) calling it through the generated bindings, and one vitest spec that
  runs against the live stack. Every generated file is meant to be edited and kept, not deleted.
  Rich demos live in `examples/` instead.

  Optional services (walrus, seal) are now config lines, not file sets: selecting one adds its
  factory call to the rendered `devstack.config.ts` and keeps its SDK dependency — nothing else.
  DeepBook is no longer offered by the scaffolder: devstack stopped auto-synthesizing a local
  DeepBook (it needs vendored Move packages and explicit pool config), so the generated README
  points to `examples/deepbook-trader` instead. The app-local plugin framework (`src/devstack/`
  contribution modules and the generated `app-panels.ts`/`plugins.ts` barrels) is gone; the config
  is straight-line `defineDevstack({ members })`, exactly like the documented API.

  Scaffolder changes: prompts rebuilt on @clack/prompts (Ink/React dropped); `--template app|ts`
  selects the variant; non-interactive/`--yes` now defaults to no optional services (was: all);
  generated apps carry no `DEVSTACK_APP=` tokens (the CLI infers the app name from
  `package.json#name`) and no pinned `stackName`; Playwright and Tailwind are no longer scaffolded.
  CI now installs and typechecks scaffolded apps against packed workspace tarballs and boot-smokes
  one end to end.

  This supersedes the unreleased demo-panels/plugin-picker template rebuild; its pending changeset
  was folded into this one.

### Patch Changes

- 9e1e1be: Scaffolded apps now install and boot on pnpm 11. The templates ship a
  `pnpm-workspace.yaml` with an `allowBuilds` map — the key pnpm 11+ reads, since it no longer reads
  the `pnpm` field in `package.json` — plus the mirrored `pnpm.onlyBuiltDependencies` in
  `package.json` for pnpm 10, approving the `esbuild` / `msgpackr-extract` / `protobufjs` native
  build scripts. Previously a stock pnpm-11 user's `pnpm install` / `pnpm dev` failed with
  `ERR_PNPM_IGNORED_BUILDS` before the app ever started.

## 0.1.3

### Patch Changes

- 7cfef58: Scaffolded apps now pin the matching-latest SDK versions automatically. The scaffolder
  injects its own (publish-time-resolved) `@mysten-incubation/devstack` and
  `@mysten-incubation/dev-wallet` versions into the generated `package.json` at scaffold time —
  mirroring `create-dapp` — instead of relying on the build-time template snapshot, which could
  drift from the published release. The scaffolder lists these as `workspace:^` devDependencies, so
  `pnpm`'s publish-time workspace-protocol rewrite keeps them in lockstep with the release, and
  `pnpm create @mysten-incubation/devstack-app@latest` always resolves the newest scaffolder. The
  committed template carries the synced versions as a fallback for dev checkouts.

## 0.1.2

### Patch Changes

- Restore the generated app `.gitignore` from the packed template so scaffolded projects do not
  commit `node_modules` or devstack runtime output.

## 0.1.1

### Patch Changes

- 133fb14: Add the signer package required by the dev-wallet adapters barrel to scaffolded apps,
  align the generated Vitest version with devstack's published peer range, and update the devstack
  install docs.
- 133fb14: Switch to trusted publishing.
