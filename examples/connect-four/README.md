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

The build needs a known deployment's deployment file (the same `deployment.json` schema the
local stack writes). Either point the stack at the target network once and copy the file it
emits, or hand-author one:

```bash
# Option A: boot against the target network, then copy the emitted deployment
devstack up --network testnet
cp .devstack/stacks/main/deployment.json config/testnet.ids.json
```

For the full deployment schema (Option B, hand-authoring) see the canonical
[Deploy to a real network](https://ts-sdks-incubation.vercel.app/devstack/features/codegen#deploy-to-a-real-network)
section in the devstack docs. Commit the file, then point the build at it:

```bash
# via the Vite plugin option (vite.config.ts):
#   devstackVitePlugin({ ids: './config/testnet.ids.json' })
# or via env:
DEVSTACK_DEPLOYMENT_FILE=./config/testnet.ids.json pnpm build
```

Then deploy the static `dist/` bundle. A build with no ids throws `DevstackConfigMissingError`
at runtime — loud, not a silent zero.

## See also

- [examples/README.md](../README.md) — every runnable example.
- [Actions feature page](https://ts-sdks-incubation.vercel.app/devstack/features/actions) —
  background on the post-publish action wired into this stack.
