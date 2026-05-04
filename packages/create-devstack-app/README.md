# @mysten-incubation/create-devstack-app

Scaffold a new devstack-backed Sui app from the canonical template.

```bash
pnpm create @mysten-incubation/devstack-app my-app
cd my-app
pnpm dev
```

The scaffolder:

1. Copies the canonical
   [`examples/_template/`](https://github.com/MystenLabs/ts-sdks-incubation/tree/main/examples/_template)
   directory into `<cwd>/<name>/`.
2. Substitutes the app name into `package.json` and `devstack.config.ts`.
3. Runs `pnpm install`.
4. Runs `git init` + an initial commit.

## Options

```
pnpm create @mysten-incubation/devstack-app <name> [options]

  <name>              App name. Lowercase, dash-separated, starts with a letter.

  --target-dir <dir>  Where to create the app directory. Default: cwd.
  --no-install        Skip pnpm install.
  --no-git            Skip git init + initial commit.
```

## What you get

A self-contained app with one Move package (`hello`), a single-Card UI with a "Send greeting"
button, and an e2e spec exercising the connect-and-mint flow. Same `pnpm dev` / `pnpm test:e2e` /
`pnpm build` scripts as the in-tree examples.

For the full file tree and per-file walkthrough see the
[template's README](https://github.com/MystenLabs/ts-sdks-incubation/blob/main/examples/_template/README.md).
