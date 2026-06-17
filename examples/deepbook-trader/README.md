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
├── e2e/market-console.spec.ts # Playwright: connect wallet, swap, assert pool moved
└── src/                      # React UI: live pool depth + swap form
```

## Run

```
pnpm dev          # devstack up (the `deepbook-trader` dev stack); injects live ids automatically
pnpm codegen      # regenerate src/generated bindings after a Move source change (stack-free)
pnpm build        # tsc -b && vite build — stack-free, no Docker; works on a clean clone
pnpm test         # unit tests — fast, boots nothing
pnpm test:e2e     # Playwright swap flow on an isolated `e2e` stack (parallel-safe with `pnpm dev`)
```

`pnpm dev` injects live on-chain ids; the committed `src/generated/config.ts` resolves them
at runtime and never bakes them in. `pnpm build` is deterministic and stack-free — a build with
no injected ids throws `DevstackConfigMissingError` at runtime rather than silently shipping zeros.

## Deploy to a real network

The build needs a known deployment's id-config file (the same `devstack-ids.json` schema the
local stack writes). Either point the stack at the target network once and copy the file it
emits, or hand-author one:

```bash
# Option A: boot against the target network, then copy the emitted id-config
devstack up --network testnet
cp .devstack/stacks/main/devstack-ids.json config/testnet.ids.json
```

For the full id-config schema (Option B, hand-authoring) see the canonical
[Deploy to a real network](https://ts-sdks-incubation.vercel.app/devstack/features/codegen#deploy-to-a-real-network)
section in the devstack docs — for this example the `values` channel carries the deepbook pool
id, coin types, and endpoints. Commit the file, then point the build at it:

```bash
# via the Vite plugin option (vite.config.ts):
#   devstackVitePlugin({ ids: './config/testnet.ids.json' })
# or via env:
DEVSTACK_IDS_FILE=./config/testnet.ids.json pnpm build
```

Then deploy the static `dist/` bundle. A build with no ids throws `DevstackConfigMissingError`
at runtime — loud, not a silent zero.

## See also

- [examples/README.md](../README.md) — every runnable example.
- [DeepBook service docs](https://ts-sdks-incubation.vercel.app/devstack/features/services/deepbook) —
  DeepBook + Pyth plugin coverage.
