# ts-sdks-incubation

Incubation TypeScript packages for the [Sui](https://sui.io) blockchain ecosystem. Some
packages are published to npm under the `@mysten-incubation` scope. Devstack is installable
from npm, but it is still prototype-stage: the public surface can break freely as we
iterate toward a stable release.

## Packages

| Package                                                                  | Description                                                                                   | Status                                                                                                                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@mysten-incubation/dev-wallet`](packages/dev-wallet)                   | Modular dev wallet for Sui dApp development and testing                                       | [![npm](https://img.shields.io/npm/v/@mysten-incubation/dev-wallet)](https://www.npmjs.com/package/@mysten-incubation/dev-wallet)                   |
| [`@mysten-incubation/devstack`](packages/devstack)                       | Effect v4 devstack for local Sui app development, seeded services, codegen, and product tests | [![npm](https://img.shields.io/npm/v/@mysten-incubation/devstack)](https://www.npmjs.com/package/@mysten-incubation/devstack)                       |
| [`@mysten-incubation/create-devstack-app`](packages/create-devstack-app) | Scaffolder for new devstack-backed apps                                                       | [![npm](https://img.shields.io/npm/v/@mysten-incubation/create-devstack-app)](https://www.npmjs.com/package/@mysten-incubation/create-devstack-app) |
| [`@mysten-incubation/tsconfig`](packages/tsconfig)                       | Shared TypeScript configuration for the published packages and scaffolded apps                | [![npm](https://img.shields.io/npm/v/@mysten-incubation/tsconfig)](https://www.npmjs.com/package/@mysten-incubation/tsconfig)                       |

## Examples

Worked example apps live under [`examples/`](examples). Each example brings up its own
local stack via the devstack CLI, publishes Move packages, and serves a Vite frontend.

See [`examples/README.md`](examples/README.md) for the curated tour.

Fastest way in:

```bash
pnpm create @mysten-incubation/devstack-app@latest my-app
cd my-app
pnpm dev
```

Add devstack to an existing app:

```bash
pnpm add @mysten-incubation/devstack @mysten-incubation/dev-wallet @mysten/signers
pnpm add -D @mysten-incubation/tsconfig
```

## Documentation

https://ts-sdks-incubation.vercel.app

For contributors working on devstack, the living docs are:

- [`packages/devstack/STYLE_GUIDE.md`](packages/devstack/STYLE_GUIDE.md) — code-level patterns and explicit bans (Effect v4 idioms, tagged errors, atomic writes, span vocabulary, etc.).
- [`packages/devstack/ARCHITECTURE.md`](packages/devstack/ARCHITECTURE.md) — layer / capability-contract boundaries; the answer to "is this the right place for X?".

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

Packages that go through normal versioned releases require
[changesets](https://github.com/changesets/changesets) for version management — run
`pnpm changeset` to create one. Prototype packages may still ship manually while APIs churn;
breaking changes go in directly without deprecation cycles.

See [AGENTS.md](AGENTS.md) for repo-wide development guidance.

## License

Apache-2.0
