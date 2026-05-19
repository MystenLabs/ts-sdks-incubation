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

# Optional: clone reference repos (Effect v4 source) for agent grounding.
# Required by the `writing-effect` skill; safe to skip if you're not editing
# Effect-TS code. `.repos/` is gitignored — never committed, never published.
pnpm setup:repos

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

## Engineering style

Three layers of guidance, in order:

1. **Tool-usage skills** — invoke these whenever the trigger matches; they're
   not optional reading.
   - `.claude/skills/running-vitest/SKILL.md` — how to run `pnpm test`, filter
     to a single file/case, iterate on failures without re-running the whole
     suite, and read browser-test output. Use any time you invoke vitest — the
     idiomatic flags here are not the vitest defaults.
2. **Package-specific style** — each package has its own `AGENTS.md` covering
   its substrate, public-surface rules, and cookbooks. Currently:
   [`packages/devstack/AGENTS.md`](packages/devstack/AGENTS.md). Read the one
   for the package you're editing before opening a PR. Package-specific
   AGENTS.md files name the further skills (e.g. `writing-effect`) that apply
   inside that package.
3. **Repo-wide habits** — the short list below. Anything more concrete belongs
   in a package AGENTS.md, not here.

### Repo-wide habits

- **Reuse before re-implementation.** Grep for the concept first; search costs
  less than a duplicate. If two callsites already do the same thing inline,
  extract before adding a third.
- **Structured errors with identity context.** Errors crossing a module
  boundary identify _which named thing_ they're about (account name, package
  name, etc.) so the catcher doesn't have to parse the message. The concrete
  shape (tagged classes, exception subclasses, …) is up to each package's
  AGENTS.md.
- **Shared strings are constants.** Any string two modules must agree on
  becomes an exported constant or a literal-union type, and the value is
  pinned by a test so a rename surfaces as a test failure.
- **Validate at boundaries.** File reads, env vars, HTTP bodies, inter-process
  decodes go through a validator. Internal calls trust their types.
- **Version persisted state.** Anything written to disk and read back carries
  a version (in the key, the filename, or a `version` field). New sites start
  at `v1`. Decode failure becomes a miss + warn, not a crash.
- **Browser-safe means browser-safe.** No `node:*` imports — direct or
  transitive — from anything a browser bundle can reach. Split via
  `package.json` `exports` subpaths, not via docstring claims.
- **Tests verify contracts.** Round-trip every encode/decode pair. For
  generated code, have at least one test that actually imports a generated
  symbol — string-match assertions alone don't prove it compiles.
- **Prototype-stage discipline.** As covered in "Project status" above: no
  shims, no `@deprecated`, no v2-alongside-v1. Renames are atomic.
