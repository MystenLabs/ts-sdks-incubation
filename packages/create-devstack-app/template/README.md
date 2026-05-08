# Your devstack app

A minimal-but-real devstack-backed Sui app, scaffolded by
`pnpm create @mysten-incubation/devstack-app`.

```
.
├── devstack.config.ts        # plugins + accounts + setup actions
├── package.json              # dev/build/test/e2e scripts
├── playwright.config.ts      # via defineDevstackPlaywrightConfig
├── tsconfig.json             # composite refs to app + node
├── tsconfig.app.json         # extends @mysten-incubation/tsconfig/react
├── tsconfig.node.json        # for vite/vitest/playwright configs
├── vite.config.ts            # vite + devstack vite plugin + tailwind
├── vitest.config.ts          # via defineDevstackVitestConfig
├── index.html
├── e2e/mint.spec.ts          # connect-and-mint flow
├── move/hello/               # one Move package with one entry function
└── src/
    ├── App.tsx               # Card + ConnectButton + mint button
    ├── main.tsx              # <DAppKitProvider> wiring
    ├── dapp-kit.ts           # createDevstackDappKit({ manifest })
    ├── index.css             # tailwind import + theme
    └── vite-env.d.ts         # /// <reference types="vite/client" />
```

## Get started

```sh
pnpm install
pnpm dev
```

`pnpm dev` runs `devstack up`, which spins up a hermetic localnet (Sui +
optional Walrus/Seal containers), publishes the Move package under `move/`,
runs codegen into `src/generated/`, and serves the Vite dev server. The
typed manifest the frontend consumes lives at
`.devstack/stacks/main/manifest.json`.

## Customize

- **Add Move packages** under `move/<package>/` and reference them from
  `devstack.config.ts` via `publishMove({ path: 'move/<package>' })`.
- **Pick non-conflicting port hints** in `devstack.config.ts` and
  `vite.config.ts` if you run multiple devstack apps side-by-side; the
  per-stack port allocator handles runtime collisions, but pinned
  preferences are kinder to operators.
- **Run e2e** with `pnpm test:e2e` (Playwright; uses the `test` stack so
  it doesn't share state with `pnpm dev`).
