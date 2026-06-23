# Connect Four

On-chain Connect Four lobby, join, and move flow over sui-localnet.
Demonstrates managed accounts, a published Move package, an
`action(...)` member that opens the lobby after publish, and dev-wallet
signing for two players (alice + bob).

```
connect-four/
├── devstack.config.ts    # sui-localnet + connect_four package + openLobby action + wallet + vite
├── move/connect_four/    # Move package: game, lobby, and move logic
├── tests/browser/        # Playwright: two-account match
└── src/                  # React UI: lobby + game board
```

## Run

```
pnpm dev          # devstack up (the `connect-four` dev stack); injects live ids automatically
pnpm codegen      # regenerate src/generated bindings after a Move source change (stack-free)
pnpm build        # tsc -b && vite build — stack-free, no Docker; works on a clean clone
pnpm test         # unit tests — fast, boots nothing
pnpm test:browser # Playwright on an isolated `e2e` stack (parallel-safe with `pnpm dev`)
```

`pnpm dev` injects live on-chain ids; the committed `src/generated/config.ts` resolves them
at runtime and never bakes them in. `pnpm build` is deterministic and stack-free — a build with
no injected ids throws `DevstackConfigMissingError` at runtime rather than silently shipping zeros.

## Deploy to a real network

A real-network deployment is a committed, typed file under `deployments/`. The directory is a
convention: drop a `deployments/<net>.ts` that exports
`export const deployment = { … } satisfies AppNetworkDeployment` and that network is supported.
`localnet` is implicit (the live local stack); any committed `deployments/*.ts` is merged in
alongside it. This repo already ships [`deployments/devnet.ts`](./deployments/devnet.ts) — the
real devnet package id, completeness-checked against this app's packages so a missing/typo'd id
fails `tsc`.

To add a network, publish the Move package to it, then scaffold the typed file:

```bash
# publish to the target network (writes the real package id)
sui client switch --env devnet
sui client publish move/connect_four --gas-budget 100000000

# scaffold a typed deployments/<net>.ts from a resolved envelope
pnpm exec devstack dump-deployment --network devnet
#   ↳ writes deployments/devnet.ts (export const deployment = {…} satisfies AppNetworkDeployment)
```

Edit the scaffolded file to carry the published id (or hand-author it directly — that's how the
committed `deployments/devnet.ts` was produced), then commit it. No Vite option or env file is
needed: the devstack Vite plugin (`devstackVitePlugin()` in [`vite.config.ts`](./vite.config.ts))
auto-discovers `deployments/*.ts` and merges them with the live local stack. A production
`pnpm build` drops the local-mode networks and ships only the committed ones; a build with no
ids throws `DevstackConfigMissingError` at runtime — loud, not a silent zero.

At runtime the app switches between every network it supports (`localnet` plus each committed
`deployments/*.ts`) via dApp Kit. [`src/dapp-kit.ts`](./src/dapp-kit.ts) lists
`config.networkNames` and resolves each per-network client off `config.forNetwork(net)`, so a
`switchNetwork(...)` repoints rpc + package ids in lockstep.

Then deploy the static `dist/` bundle. For the canonical reference, see the
[Going to production](https://ts-sdks-incubation.vercel.app/devstack/going-to-production) page in
the devstack docs.

## See also

- [examples/README.md](../README.md) — every runnable example.
- [Actions](https://ts-sdks-incubation.vercel.app/devstack/configure/actions) —
  background on the post-publish action wired into this stack.
