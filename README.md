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
| [`@mysten-incubation/devstack-next`](packages/devstack-next)                   | Producer-graph engine + plugins for fully-seeded Sui local development         | Prototype — actively developed (replaces `devstack`)                                                                              |
| [`@mysten-incubation/devstack`](packages/devstack)                             | **Legacy** action-graph predecessor of `devstack-next`. New apps should use `devstack-next`; see [MIGRATION](packages/devstack-next/MIGRATION.md). | Prototype — being phased out                                                |
| [`@mysten-incubation/devstack-wallet-panels`](packages/devstack-wallet-panels) | Devstack-aware Faucet / Packages / Network panels for the dev-wallet panel API | Prototype — not published to npm                                                                                                  |
| [`@mysten-incubation/create-devstack-app`](packages/create-devstack-app)       | Scaffolder for new devstack-backed apps                                        | Prototype — not published to npm                                                                                                  |

### Why two devstack packages?

`devstack-next` is a parallel rebuild of `devstack` from first
principles — same goals (fully-seeded local Sui dev: chain, walrus
committee, seal key-server, deepbook pools, accounts, packages,
manifest), redesigned plumbing (typed Provides Deps instead of a
string-keyed registry; producer graph instead of action graph;
docker-commit snapshots that actually round-trip chain state through
`docker rm`).

The old `devstack` continues to work for the existing
`examples/*` apps; new apps and integrations should target
`devstack-next`. See
[`packages/devstack-next/MIGRATION.md`](packages/devstack-next/MIGRATION.md)
for the API mapping.

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

For published packages (dev-wallet), changes require [changesets](https://github.com/changesets/changesets)
for version management — run `pnpm changeset` to create one. Prototype packages
(devstack and friends) don't use changesets day-to-day; breaking changes go in directly
without deprecation cycles.

See [AGENTS.md](AGENTS.md) for detailed development guidance.

## License

Apache-2.0
