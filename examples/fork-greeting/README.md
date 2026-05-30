# Fork Greeting

Fork mode against testnet with the impersonation **fork faucet**: a Move
package (`greeting::board`) published by an *ephemeral* account that is
auto-funded from a large-reserve "whale" address — **no pre-funded
addresses and no environment variables required**.

```
fork-greeting/
├── devstack.config.ts    # sui fork (testnet) + greeting package + dev-wallet
└── move/greeting/        # Move package: a shared Board of greetings
```

## Run

```
pnpm dev          # devstack up: fork testnet, faucet-fund accounts, publish greeting
pnpm test         # typecheck
```

First boot compiles the bundled `sui-fork` image from source (~10+ min, one
time; the content-addressed image is cached afterward, and the supervisor row
narrates progress). The fork faucet then funds the ephemeral `publisher`
from the default testnet whale and publishes `greeting`, capturing the shared
`Board` id.

To use your own funding source instead of the default whale, set
`faucet: { whale: '0x…' }` on the `sui({ mode: 'fork' })` member. To drive a
specific on-chain address, use `account(name, { kind: 'impersonate', address })`.

## See also

- [examples/README.md](../README.md) — overview of every runnable app.
- [Live & fork networks](https://ts-sdks-incubation.vercel.app/devstack/features/live-networks) —
  fork mode, the fork faucet, and impersonation.
