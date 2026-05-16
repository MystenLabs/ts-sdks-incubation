# Devstack template

The minimal-but-real starting point for a new devstack-backed Sui app.

```
_template/
├── devstack.config.ts        # Refs: accounts, packages, actions, wallet, dev
├── package.json              # dev/build/test/e2e scripts
├── playwright.config.ts      # stock playwright + setupDevstack global setup
├── tsconfig.json             # composite refs to app + node
├── tsconfig.app.json         # extends @mysten-incubation/tsconfig/react
├── tsconfig.node.json        # for vite/vitest/playwright configs
├── vite.config.ts            # vite + devstack vite plugin + tailwind
├── vitest.config.ts          # stock vitest + withDevstack fixture
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

## Stand up a new app from this template

1. Copy the directory: `cp -r examples/_template examples/<your-app>`.
2. Replace `_template` with your app name in `package.json` and
   `devstack.config.ts`.
3. Pick non-conflicting port hints in `devstack.config.ts` and
   `vite.config.ts` (other examples occupy 9000-9999 + 5173-5176; the
   per-stack port allocator handles collisions at runtime, but pinned
   preferences are kinder to operators).
4. Rename `move/hello/` to your package name and update the address in
   `move/<pkg>/Move.toml`.
5. `pnpm install` then `pnpm dev`.

For a guided scaffold, run
`pnpm create @mysten-incubation/devstack-app <your-app>` instead.
