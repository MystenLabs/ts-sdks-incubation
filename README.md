# ts-sdks-incubation

Incubation TypeScript packages for the [Sui](https://sui.io) blockchain ecosystem. Some
packages are published to npm under the `@mysten-incubation` scope; **devstack and the
related packages are still prototypes — they live in this monorepo only and are not
published to npm yet, with no near-term plan to publish.** The public surface of the
prototype packages breaks freely as we iterate; pin nothing from outside this monorepo.

## Packages

| Package                                                                  | Description                                                                                                        | Status                                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| [`@mysten-incubation/dev-wallet`](packages/dev-wallet)                   | Modular dev wallet for Sui dApp development and testing                                                            | [![npm](https://img.shields.io/npm/v/@mysten-incubation/dev-wallet)](https://www.npmjs.com/package/@mysten-incubation/dev-wallet) |
| [`@mysten-incubation/devstack`](packages/devstack)                       | Hermetic local Sui dev stack — localnet + Walrus + Seal + DeepBook + your Move packages, composed as Effect Layers | Prototype — actively developed                                                                                                    |
| [`@mysten-incubation/create-devstack-app`](packages/create-devstack-app) | Scaffolder for new devstack-backed apps                                                                            | Prototype — not published to npm                                                                                                  |

## Examples

Worked example apps live under [`examples/`](examples). Each example brings up its own local stack via `pnpm localnet:up`, publishes Move packages, and serves a Vite frontend.

| Example                                               | Demonstrates                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`_template`](examples/_template)                     | Minimal-but-real starting point. One Move package, one publish, one mint button.          |
| [`arena`](examples/arena)                             | Shared-object Connect Four — matchmaking via `Lobby` objects, gameplay via shared `Game`. |
| [`deepbook-full`](examples/deepbook-full)             | Full DeepBook v3 + margin + Pyth + Postgres indexer + market-maker stack.                 |
| [`effect-app`](examples/effect-app)                   | Pure-Effect consumer: same `Effect.gen` program runs localnet (dev) and testnet (prod).   |
| [`fork-greeting`](examples/fork-greeting)             | Minimal `Sui({network:'testnet-fork'})` harness — publish + impersonate + greeting board. |
| [`plugin-author-redis`](examples/plugin-author-redis) | Out-of-tree plugin author: wraps `redis:7-alpine` as a devstack service via `/advanced`.  |
| [`private-content`](examples/private-content)         | Walrus blob storage + Seal threshold-encryption + capability-gated decrypt.               |
| [`token-studio`](examples/token-studio)               | Move `Coin` module, `TreasuryCap` management, mint / burn / transfer.                     |
| [`wallet`](examples/wallet)                           | Multi-coin balances + send/receive, DeepBook v3 swap UI against locally-published pools.  |

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

For published packages (dev-wallet), changes require [changesets](https://github.com/changesets/changesets)
for version management — run `pnpm changeset` to create one. Prototype packages
(devstack and friends) don't use changesets day-to-day; breaking changes go in directly
without deprecation cycles.

See [AGENTS.md](AGENTS.md) for detailed development guidance.

## License

Apache-2.0
