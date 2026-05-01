# ts-sdks-incubation

Incubation TypeScript packages for the [Sui](https://sui.io) blockchain ecosystem, published under the `@mysten-incubation` npm scope.

## Packages

| Package                                                                        | Description                                                                    | npm                                                                                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@mysten-incubation/dev-wallet`](packages/dev-wallet)                         | Modular dev wallet for Sui dApp development and testing                        | [![npm](https://img.shields.io/npm/v/@mysten-incubation/dev-wallet)](https://www.npmjs.com/package/@mysten-incubation/dev-wallet)                         |
| [`@mysten-incubation/devstack`](packages/devstack)                             | Declarative reconciler + plugin harness for fully-seeded Sui local development | [![npm](https://img.shields.io/npm/v/@mysten-incubation/devstack)](https://www.npmjs.com/package/@mysten-incubation/devstack)                             |
| [`@mysten-incubation/devstack-wallet-panels`](packages/devstack-wallet-panels) | Devstack-aware Faucet / Packages / Network panels for the dev-wallet panel API | [![npm](https://img.shields.io/npm/v/@mysten-incubation/devstack-wallet-panels)](https://www.npmjs.com/package/@mysten-incubation/devstack-wallet-panels) |

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

## Preview releases

Every pull request publishes per-commit tarballs of each public package to
[pkg.pr.new](https://pkg.pr.new). The `pkg.pr.new` bot comments on the PR with
install URLs — they look like:

```bash
pnpm add https://pkg.pr.new/@mysten-incubation/dev-wallet@<commit-or-pr-sha>
```

Use these to try a change in a downstream app before it lands on `main`.

## Contributing

Changes require [changesets](https://github.com/changesets/changesets) for version management. Run `pnpm changeset` to create one.

See [AGENTS.md](AGENTS.md) for detailed development guidance.

## License

Apache-2.0
