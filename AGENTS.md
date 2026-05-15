# AGENTS.md

This file provides guidance to AI agents working with code in this repository.

## Project status — prototype, not released

Nothing in this repo is published to npm yet, and we are **not publishing anytime soon**.
There are no consumers outside the monorepo, no compatibility surface to honor, no
deprecation cycle. **Break the API directly when something is wrong** — rename, restructure,
delete; update every callsite in the same commit. Don't ship shims, fallbacks, `@deprecated`
markers, or "v2 alongside v1" exports. We get one shot to set the public surface right before
anyone depends on it.

## Overview

This is a monorepo containing prototype TypeScript packages for the Sui blockchain ecosystem
under the `@mysten-incubation` namespace. It uses pnpm workspaces and turbo for build
orchestration. The `@mysten-incubation/*` scope is reserved for an eventual release; until
then the packages are workspace-only.

## Common Commands

### Setup and Build

```bash
# Initial setup
pnpm install
pnpm turbo build

# After a package rename (e.g. devstack-effect → devstack), node_modules/.bin shims
# can stay pinned to the old name and surface as `Cannot find module
# '@mysten-incubation/<old-name>/dist/cli/main.mjs'`. Refresh with:
pnpm install --force

# Build a specific package with dependencies
pnpm turbo build --filter=@mysten-incubation/dev-wallet
```

### Testing

```bash
# Run unit tests
pnpm test

# Run unit tests for a specific package
pnpm --filter @mysten-incubation/dev-wallet test
```

### Linting and Formatting

```bash
# Check lint and formatting
pnpm lint

# Auto-fix lint and formatting issues
pnpm lint:fix
```

### Package Management

Changesets are present in the repo but unused day-to-day — nothing is published yet
(see "Project status" above). Don't add changesets to PRs unless you're explicitly
preparing for a release.

## Architecture

### Repository Structure

- **packages/** - Published incubation packages and shared internal config
  - **dev-wallet/** - Development wallet for Sui dApp testing (Lit UI, multi-adapter, popup wallet)
  - **devstack/** - Declarative reconciler + plugin harness for fully-seeded Sui local development
  - **devstack-wallet-panels/** - Lit panels (Faucet/Packages/Network) for the dev-wallet panel API
  - **docs/** - Documentation site (fumadocs + Next.js); content under `content/<package>/`
  - **tsconfig/** - Shared internal TypeScript configurations (not published)
- **apps/** - First-party consumer apps (e.g. the hosted dev-wallet)
- **examples/** - Worked example apps that exercise the packages end-to-end
  - **arena**, **private-content**, **token-studio**, **wallet**

### Documentation

- Docs site: https://ts-sdks-incubation.vercel.app
- Auto-deployed via Vercel on push to `main`
- Content lives in `packages/docs/content/<package>/` as MDX files (one section per package)
- Each package can generate LLM-friendly markdown docs via `build:docs` script
- Run docs locally: `pnpm --filter @mysten-incubation/docs dev`

### Package management

- pnpm 10 workspaces with a catalog (`pnpm-workspace.yaml`) for `@mysten/*`, React, build tooling
- `minimumReleaseAge: 2880` enforces a 2-day quarantine on newly-published packages
- `pnpm.onlyBuiltDependencies` allows `esbuild` build scripts (used by tsup)

### Build System

- Uses Turbo for monorepo task orchestration with dependency-aware builds
- Each package can have its own test configuration (typically using Vitest)
- Common build outputs: `dist/` for compiled code

### Development Workflow

1. Turbo ensures dependencies are built before dependents.
2. Biome (lint + format) is enforced across the codebase.
3. Tests must pass before changes are merged.
4. Breaking changes don't need a deprecation cycle (see "Project status" above) —
   rename/restructure/delete in place and update every callsite in the same commit.

### Pull Requests

When creating PRs, follow the template in `.github/PULL_REQUEST_TEMPLATE.md`:

- Include a description of the changes
- Check the appropriate checkbox in the AI Assistance Notice section
