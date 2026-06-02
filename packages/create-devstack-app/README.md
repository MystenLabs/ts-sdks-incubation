# @mysten-incubation/create-devstack-app

Scaffold a new devstack-backed Sui app from the canonical template.

The published package is `@mysten-incubation/create-devstack-app`; package managers resolve the
create alias below to this package.

```bash
pnpm create @mysten-incubation/devstack-app@latest my-app
cd my-app
pnpm dev
```

The scaffolder:

1. Prompts for which optional plugins to include (walrus, seal, deepbook), then
   copies the canonical
   [`template/`](https://github.com/MystenLabs/ts-sdks-incubation/tree/main/packages/create-devstack-app/template)
   directory into `<cwd>/<name>/`, stripping the plugins you didn't select.
2. Substitutes the app name into `package.json`, `devstack.config.ts`, and `playwright.config.ts`,
   and injects resolved SDK versions.
3. Runs `pnpm install`.
4. Runs `git init` + an initial commit.

## Options

```
pnpm create @mysten-incubation/devstack-app@latest <name> [options]

  <name>              App name. Lowercase, dash-separated, starts with a letter.

  --target-dir <dir>  Where to create the app directory. Default: cwd.
  --no-install        Skip pnpm install.
  --no-git            Skip git init + initial commit.
```

## What you get

A self-contained app with a `counter` Move package, a panel-based UI (a core counter panel plus a
panel for each optional plugin you selected — walrus, seal, deepbook), unit tests, and a Playwright
e2e spec. Same `pnpm dev` / `pnpm test` / `pnpm test:e2e` / `pnpm build` scripts as the in-tree
examples.

For the full file tree and per-file walkthrough see the
[template's README](https://github.com/MystenLabs/ts-sdks-incubation/blob/main/packages/create-devstack-app/template/README.md).
