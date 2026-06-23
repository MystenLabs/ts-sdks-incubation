# Token Studio

Single managed coin example: one Move package exports a coin with a
`TreasuryCap`, the stack publishes the package, and the UI exercises
mint and transfer flows gated by the cap.

```
token-studio/
├── devstack.config.ts    # sui-localnet + managed-coin publish + wallet + vite
├── move/                 # Move package: coin module + TreasuryCap-gated entry fns
├── tests/                # unit (tests/unit) + Playwright browser specs (tests/browser)
└── src/                  # React UI: cap-gated mint/transfer
```

## Run

```
pnpm dev          # devstack up (the `token-studio` dev stack); injects live ids automatically
pnpm codegen      # regenerate src/generated bindings after a Move source change (stack-free)
pnpm build        # tsc -b && vite build — stack-free, no Docker; works on a clean clone
pnpm test         # unit tests — fast, boots nothing
pnpm test:browser # Playwright mint → transfer on an isolated `e2e` stack (parallel-safe with `pnpm dev`)
```

`pnpm dev` injects live on-chain ids; the committed `src/generated/config.ts` resolves them
at runtime and never bakes them in. The published coin's discovery-only object ids (the
`TreasuryCap` / metadata) likewise resolve at runtime — the committed coin table omits them.
`pnpm build` is deterministic and stack-free — a build with no injected ids throws
`DevstackConfigMissingError` at runtime rather than silently shipping zeros.

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
- [Coins and funding](https://ts-sdks-incubation.vercel.app/devstack/configure/coins-and-funding) —
  managed-coin and funding-spec guidance the stack relies on.
