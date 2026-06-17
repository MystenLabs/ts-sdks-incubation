# dashboard-demo

A minimal, config-only devstack: a local Sui node, two funded accounts, and the
dashboard plugin. No Move packages, no codegen, no frontend — it boots fast and
stays up for poking at the web dashboard.

## Run

```bash
pnpm dev    # devstack up (the `dashboard-demo` stack); prints the dashboard URL
pnpm test   # unit test — asserts the stack config composes; boots nothing
```

There's no `pnpm test:e2e`: this example ships no app/UI to drive in a browser.
For a browser e2e example, see `connect-four`, `deepbook-trader`, `private-content`, or `token-studio`.

## Deploy to a real network

This example is config-only — no Move packages, no codegen, no frontend bundle — so there's
nothing to build or deploy. To point the stack at a public network for poking the dashboard,
boot it with `--network`:

```bash
devstack up --network testnet
```

The apps that do ship a frontend (`connect-four`, `deepbook-trader`) cover the full deploy flow:
`pnpm dev` injects live ids automatically, `pnpm build` is stack-free, and production builds read
a committed `devstack-ids.json`-schema file via `devstackVitePlugin({ ids: './config/<network>.ids.json' })`
or `DEVSTACK_IDS_FILE`. See the canonical
[Deploy to a real network](https://ts-sdks-incubation.vercel.app/devstack/features/codegen#deploy-to-a-real-network)
docs for the id-config schema and the loud `DevstackConfigMissingError` thrown when no ids are
injected.
