# ts-sdks-incubation

Incubation TypeScript packages for the [Sui](https://sui.io) blockchain ecosystem. Some
packages are published to npm under the `@mysten-incubation` scope; **devstack and the
related packages are still prototypes — they live in this monorepo only and are not
published to npm yet, with no near-term plan to publish.** The public surface of the
prototype packages breaks freely as we iterate; pin nothing from outside this monorepo.

## Packages

| Package                                                                  | Description                                                                                              | Status                                                                                                                            |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [`@mysten-incubation/dev-wallet`](packages/dev-wallet)                   | Modular dev wallet for Sui dApp development and testing                                                  | [![npm](https://img.shields.io/npm/v/@mysten-incubation/dev-wallet)](https://www.npmjs.com/package/@mysten-incubation/dev-wallet) |
| [`@mysten-incubation/devstack-rewrite`](packages/devstack-rewrite)       | Ground-up Effect v4 rewrite of devstack (active dev focus; will replace `packages/devstack/` at cutover) | Prototype — actively developed                                                                                                    |
| [`@mysten-incubation/devstack`](packages/devstack)                       | Original devstack package — spec source for the rewrite; new work goes into `devstack-rewrite/`          | Prototype — frozen pending cutover                                                                                                |
| [`@mysten-incubation/create-devstack-app`](packages/create-devstack-app) | Scaffolder for new devstack-backed apps                                                                  | Prototype — not published to npm                                                                                                  |

## Examples

Worked example apps live under [`examples/`](examples). Each example brings up its own
local stack via the devstack CLI, publishes Move packages, and serves a Vite frontend.

The repo currently carries paired example sets — `<name>/` against the original devstack
and `<name>-rewrite/` against the rewrite. The rewrite set is the one to read for
current API shape. See [`examples/README.md`](examples/README.md) for the curated tour.

Fastest way in:

```bash
pnpm --filter @mysten-incubation/hello-world-rewrite dev
```

## Documentation

https://ts-sdks-incubation.vercel.app

For contributors working on the devstack rewrite, the living docs are:

- [`packages/devstack-rewrite/notes/orchestrator-guide.md`](packages/devstack-rewrite/notes/orchestrator-guide.md) — single entry point covering project status, locked decisions, and how work is dispatched.
- [`packages/devstack-rewrite/STYLE_GUIDE.md`](packages/devstack-rewrite/STYLE_GUIDE.md) — code-level patterns and explicit bans (Effect v4 idioms, tagged errors, atomic writes, span vocabulary, etc.).
- [`packages/devstack-rewrite/ARCHITECTURE.md`](packages/devstack-rewrite/ARCHITECTURE.md) — layer / capability-contract boundaries; the answer to "is this the right place for X?".

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

See [AGENTS.md](AGENTS.md) for repo-wide development guidance.

## License

Apache-2.0
