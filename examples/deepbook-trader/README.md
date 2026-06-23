# Deepbook Trader

Localnet DeepBook market-maker example. Publishes DeepBook-v3 straight
from its upstream git repos (no vendored Move tree — `localPackage` clones
and caches them), mints a DEEP managed coin, seeds a DEEP/SUI pool with
configurable depth, and ships a React UI that swaps SUI for DEEP through
the live pool. Pyth is wired in as a DeepBook implementation detail
(price-feed integration).

The DeepBook, DUSDC, and Pyth-sandbox packages come from
`github.com/MystenLabs/deepbookv3` and `.../deepbook-sandbox` via
`localPackage('…', { git: { url, subdir, rev } })`; only the app-authored
demo coins remain a local Move package. Pin `rev` to a tag/SHA to freeze
the demo.

```
deepbook-trader/
├── devstack.config.ts        # sui-localnet + deepbook publish (git sources) + pool seeding + wallet + vite
├── move/demo_coins/          # local app-authored demo coins (DBTC/DETH)
├── tests/browser/market-console.spec.ts # Playwright: connect wallet, swap, assert pool moved
└── src/                      # React UI: live pool depth + swap form
```

## Run

```
pnpm dev          # devstack up (the `deepbook-trader` dev stack); injects live ids automatically
pnpm codegen      # regenerate src/generated bindings after a Move source change (stack-free)
pnpm build        # tsc -b && vite build — stack-free, no Docker; works on a clean clone
pnpm test         # unit tests — fast, boots nothing
pnpm test:browser # Playwright swap flow on an isolated `e2e` stack (parallel-safe with `pnpm dev`)
```

`pnpm dev` injects live on-chain ids; the committed `src/generated/config.ts` resolves them
at runtime and never bakes them in. `pnpm build` is deterministic and stack-free — a build with
no injected ids throws `DevstackConfigMissingError` at runtime rather than silently shipping zeros.

## Deploy to a real network

Publish the Move packages to the target network, then scaffold a typed, committed
`deployments/<network>.ts` (`devstack dump-deployment --network <net>`). The bare
`devstackVitePlugin()` in `vite.config.ts` auto-discovers `deployments/*.ts`; a production
`pnpm build` ships only the committed networks. There is no `ids` Vite option and no
`config/<net>.ids.json` file. See the canonical
[Going to production](https://ts-sdks-incubation.vercel.app/devstack/going-to-production) guide
for the full flow.

## See also

- [examples/README.md](../README.md) — every runnable example.
- [DeepBook service docs](https://ts-sdks-incubation.vercel.app/devstack/deepbook) —
  DeepBook + Pyth plugin coverage.
