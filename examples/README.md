# Examples

Each example is a self-contained Sui app that consumes
`@mysten-incubation/devstack` for localnet bring-up + Move publish +
codegen + dev-wallet wiring.

## Apps

| App | What it shows |
|---|---|
| [arena](./arena) | On-chain Connect Four. Matchmaking via shared Lobby; gameplay via shared Game. |
| [private-content](./private-content) | Seal-encrypted file vault on top of walrus + a single Open-mode seal key server. |
| [token-studio](./token-studio) | Single managed coin with TreasuryCap-gated minting. |
| [wallet](./wallet) | Multi-coin wallet UI + DeepBook v3 swap. Imports deepbook from upstream. |

Run any one:

```bash
pnpm --filter <app> dev
```

The first `pnpm dev` builds heavy local images (sui-localnet always;
walrus + seal for `private-content`) — 5-10 minutes on a cold cache.
Subsequent runs hit Docker layer cache and complete in seconds.

## Adding a new example

The `_template/` directory carries the canonical boilerplate every
new example needs:

```
_template/
├── devstack.config.ts        # plugins + accounts
├── package.json              # dev/build/test/e2e scripts
├── playwright.config.ts      # via defineDevstackPlaywrightConfig
├── tsconfig.json             # extends @mysten-incubation/tsconfig
├── tsconfig.app.json
├── tsconfig.node.json
├── vite.config.ts            # vite + devstack vite plugin + tailwind
├── vitest.config.ts          # via defineDevstackVitestConfig
├── index.html
└── src/
    ├── App.tsx
    ├── main.tsx              # <DevstackProvider> wiring
    ├── index.css
    ├── vite-env.d.ts         # /// reference to @mysten-incubation/devstack/manifest
    └── dapp-kit.ts           # createDevstackDappKit + dev-wallet initializer
```

To stand up a new app:

1. Copy `_template/` to `<your-app>/`.
2. Replace `_template` with your app name in `package.json` and
   `devstack.config.ts`.
3. Pick non-conflicting ports for the sui RPC + faucet + wallet-server
   + vite dev-server (other examples occupy 9000-9999 + 5173-5176;
   pick ranges outside those).
4. Add a Move package under `<your-app>/move/<package_name>/` and
   declare a Publish action via your own `<appName>Plugin()`.
5. `pnpm install` then `pnpm dev`.

A future `pnpm create devstack-app` scaffolder will automate steps
1-3; until then the template is the canonical recipe.
