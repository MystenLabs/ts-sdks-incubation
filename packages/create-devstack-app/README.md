# @mysten-incubation/create-devstack-app

Scaffold a new devstack-backed Sui app.

The published package is `@mysten-incubation/create-devstack-app`; package managers resolve the
create alias below to this package.

```bash
pnpm create @mysten-incubation/devstack-app@latest my-app
cd my-app
pnpm dev
```

The scaffolder:

1. Prompts for an app name, what you are building (**Web dapp** or **TypeScript only**), and which
   optional services to include (walrus, seal, deepbook, pyth — default: none).
2. Copies the matching template —
   [`templates/app/`](https://github.com/MystenLabs/ts-sdks-incubation/tree/main/packages/create-devstack-app/templates/app)
   or
   [`templates/ts/`](https://github.com/MystenLabs/ts-sdks-incubation/tree/main/packages/create-devstack-app/templates/ts)
   — **verbatim** into `<cwd>/<name>/`.
3. Renders `devstack.config.ts` from the service selection: the Sui localnet is always present, and
   each selected service adds its config (`walrus()`/`seal()` are one factory line each; `deepbook`,
   optionally with `pyth`, adds a small self-contained block — see Design principles below).
4. Sets the app name in `package.json`, prunes the dependencies of unselected services, and injects
   resolved SDK versions. No other file is touched.
5. Runs `pnpm install` and `git init` + an initial commit, performs a non-fatal Docker preflight,
   and prints next steps.

## Options

```
pnpm create @mysten-incubation/devstack-app@latest <name> [options]

  <name>              App name. Lowercase, dash-separated, starts with a letter.

  --template <t>      Skip the "What are you building?" prompt: `app` (Web dapp)
                      or `ts` (TypeScript only).
  --services <list>   Comma-separated services to include: walrus,seal,deepbook,pyth
                      (pyth implies deepbook).
  --all               Include every optional service (walrus, seal, deepbook, pyth).
  --minimal           Include no optional services.
  --yes               Non-interactive; defaults apply for anything not flagged
                      (Web dapp, no services).
  --target-dir <dir>  Where to create the app directory. Default: cwd.
  --no-install        Skip pnpm install.
  --no-git            Skip git init + initial commit.
```

## What you get

Both templates are small, complete apps — a `counter` Move package plus a vitest spec that runs
against the booted stack. The `app` template adds the browser half: vite, dapp-kit, the dev wallet,
and a single screen wired to the counter package.

```
my-app/
  devstack.config.ts   # rendered from your service selection; the rest is verbatim template
  move/counter/        # one Move package, published on boot
  src/                 # app template: one screen on vite + dapp-kit + dev wallet
  package.json         # name + service deps + SDK versions set at scaffold time
  ...                  # tsconfig, vite config (app), vitest spec
```

Scripts:

- `pnpm dev` — `devstack up` (boots the stack; the app template serves the UI as a stack member).
- `pnpm apply` — `devstack apply` (one-shot reconcile: CI, or to re-emit live ids without serving).
- `pnpm typecheck` — `tsc -b --noEmit` (app) / `tsc --noEmit` (ts); deliberately stack-free, boots
  nothing.
- `pnpm test` — `vitest run` (unit specs; `pnpm test:e2e` boots a throwaway `test` stack).
- `pnpm build` — app template only (`tsc -b && vite build`); stack-free, no Docker.

There are no `DEVSTACK_APP=` tokens in the generated files: the devstack CLI infers the app from the
`package.json` name. The generated `devstack.config.ts` sets `stackName: 'dev'` explicitly.

Looking for a richer end-to-end demo? Those live in
[`examples/token-studio`](https://github.com/MystenLabs/ts-sdks-incubation/tree/main/examples/token-studio),
not in the scaffold.

## Design principles

- **Every generated file survives into a real app.** No demo gallery to delete on day two.
- **Services are config lines, not file sets.** Selecting walrus/seal adds one factory line each to
  `devstack.config.ts` (plus their npm deps). DeepBook adds a small self-contained block: it pulls
  its Move package from the upstream repo (`localPackage({ git })` — no vendored tree) and omits the
  pool list, so `deepbook(...)` synthesizes a default DEEP/SUI pool. Selecting **pyth** adds local
  price feeds for that pool (a git-sourced mock-Pyth package + DEEP/SUI feeds) and implies deepbook.
  No service ever adds or removes source files. See
  [`examples/deepbook-trader`](https://github.com/MystenLabs/ts-sdks-incubation/tree/main/examples/deepbook-trader)
  for the full multi-pool + multi-feed setup.
- **One rendered file.** `devstack.config.ts` is the only file generated from the selection;
  everything else is copied verbatim from the template.
- **One `package.json` mutation.** App name, pruning unselected-service deps, and injecting resolved
  SDK versions — nothing else.

## Template maintenance

`templates/app/` and `templates/ts/` are authored as real, runnable apps and copied verbatim at
scaffold time — keep them working as apps. Their `package.json` files are excluded from the pnpm
workspace (see the root `pnpm-workspace.yaml`) so they do not register as workspace projects.

Adding a service:

1. Add one entry to [`src/services.ts`](./src/services.ts) (its config factory line and the deps it
   owns).
2. Add its deps to both template `package.json`s.
3. Add a snippet for it to this README.

## Testing

- Render tests snapshot `devstack.config.ts` for every template × service combination.
- Scaffold tests generate into a temp dir and assert the produced file set and `package.json`
  mutations.
- CI (`.github/workflows/create-devstack-app.yml`) scaffolds real apps from the built package,
  installs freshly packed workspace tarballs into them, and runs each app's `pnpm typecheck`. A boot
  smoke in `.github/workflows/devstack-e2e.yml` brings a scaffolded app up with `devstack up` and
  runs its vitest spec against the live stack.
