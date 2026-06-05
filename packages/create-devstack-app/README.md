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

1. Prompts for which optional plugins to include (walrus, seal, deepbook), then copies the canonical
   [`template/`](https://github.com/MystenLabs/ts-sdks-incubation/tree/main/packages/create-devstack-app/template)
   directory into `<cwd>/<name>/` and **composes** it down to the plugins you selected (see "Plugin
   composition" below).
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

## Plugin composition

The authored `template/` is a **superset** that includes every optional plugin and typechecks as-is
(the default scaffold is "all plugins"). Selection is **composition, not text-stripping** — there
are no comment fences and no line parser. Each optional plugin is self-contained:

- a panel in `template/src/panels/<Panel>.tsx` (+ its `src/lib/<plugin>.ts`),
- a stack-wiring module in `template/src/devstack/<plugin>.ts` exporting a `PluginModule` whose
  `setup()` returns its contribution (extra account funding, dev-wallet accounts, `after:` deps),
- an optional Move package and e2e spec,
- its npm deps in `template/package.json`.

Two generated barrels tie it together: `template/src/app-panels.ts` lists the panels and
`template/src/devstack/plugins.ts` lists the wiring modules. Core `devstack.config.ts` and `App.tsx`
import those barrels and never reference a specific plugin.

At scaffold time, [`src/compose.ts`](./src/compose.ts) for the selected subset:

1. deletes each unselected plugin's owned files/dirs,
2. **regenerates** the two barrels from the selected plugins only (plain whole-file writes — no
   splicing of authored source), and
3. deletes each unselected plugin's deps from `package.json`.

Every subset is clean by construction: a barrel only ever imports modules that still exist, and no
authored file references a removed plugin. A defensive guard re-asserts "no dangling references"
after composing.

### Adding a new plugin

1. Add `template/src/panels/<Panel>.tsx` and `template/src/lib/<plugin>.ts`.
2. Add `template/src/devstack/<plugin>.ts` exporting a `PluginModule` (`{ id, setup(ctx) }`)
   returning its `PluginContribution`.
3. Add the plugin's deps to `template/package.json`, and (optionally) a Move package and an
   `e2e/<plugin>.spec.ts`.
4. Register it in the two authored barrels (`template/src/app-panels.ts`,
   `template/src/devstack/plugins.ts`) so the default scaffold includes it.
5. Add one entry to `PLUGIN_MANIFEST` in [`src/plugin-manifest.ts`](./src/plugin-manifest.ts) (panel
   symbol, wiring symbol, owned files/dirs, deps).

No changes to `compose.ts` are needed — it is data-driven by the manifest.
