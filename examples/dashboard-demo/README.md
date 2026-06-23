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

For apps that ship a frontend, the production deploy flow (a committed typed
`deployments/<network>.ts` auto-discovered by `devstackVitePlugin()`) is covered by the canonical
[Going to production](https://ts-sdks-incubation.vercel.app/devstack/going-to-production) guide.
