# ts-sdks-incubation

Incubation TypeScript packages for the [Sui](https://sui.io) blockchain ecosystem. Some
packages are published to npm under the `@mysten-incubation` scope; **devstack and the
related packages are still prototypes — they live in this monorepo only and are not
published to npm yet, with no near-term plan to publish.** The public surface of the
prototype packages breaks freely as we iterate; pin nothing from outside this monorepo.

## Packages

| Package                                                                        | Description                                                                    | Status                                                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| [`@mysten-incubation/dev-wallet`](packages/dev-wallet)                         | Modular dev wallet for Sui dApp development and testing                        | [![npm](https://img.shields.io/npm/v/@mysten-incubation/dev-wallet)](https://www.npmjs.com/package/@mysten-incubation/dev-wallet) |
| [`@mysten-incubation/devstack`](packages/devstack)                             | Producer-graph engine + plugins for fully-seeded Sui local development         | Prototype — actively developed                                                                                                    |
| [`@mysten-incubation/devstack-wallet-panels`](packages/devstack-wallet-panels) | Devstack-aware Faucet / Packages / Network panels for the dev-wallet panel API | Prototype — not published to npm                                                                                                  |
| [`@mysten-incubation/create-devstack-app`](packages/create-devstack-app)       | Scaffolder for new devstack-backed apps                                        | Prototype — not published to npm                                                                                                  |

## Examples

Worked example apps live under [`examples/`](examples). Each example brings up its own local stack via `pnpm localnet:up`, publishes Move packages, and serves a Vite frontend.

| Example                                       | Demonstrates                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`arena`](examples/arena)                     | Shared-object Connect Four — matchmaking via `Lobby` objects, gameplay via shared `Game`. |
| [`private-content`](examples/private-content) | Walrus blob storage + Seal threshold-encryption + capability-gated decrypt.               |
| [`token-studio`](examples/token-studio)       | Move `Coin` module, `TreasuryCap` management, mint / burn / transfer.                     |
| [`wallet`](examples/wallet)                   | Multi-coin balances + send/receive, DeepBook v3 swap UI against locally-published pools.  |

## Documentation

https://ts-sdks-incubation.vercel.app

## Getting Started

```bash
pnpm install
pnpm turbo build
```

## Development

```bash
# Run tests
pnpm test

# Lint and format
pnpm lint
pnpm lint:fix

# Build a specific package
pnpm turbo build --filter=@mysten-incubation/dev-wallet

# Run docs site locally
pnpm --filter @mysten-incubation/docs dev
```

## Contributing

For published packages (dev-wallet), changes require [changesets](https://github.com/changesets/changesets)
for version management — run `pnpm changeset` to create one. Prototype packages
(devstack and friends) don't use changesets day-to-day; breaking changes go in directly
without deprecation cycles.

See [AGENTS.md](AGENTS.md) for detailed development guidance.

## License

Apache-2.0
