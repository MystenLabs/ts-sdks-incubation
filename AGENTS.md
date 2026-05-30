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

# If node_modules/.bin shims get out of sync after a workspace package rename,
# refresh with:
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
  - **devstack/** - Effect v4 supervisor for fully-seeded Sui local development
    (localnet, Walrus, Seal, DeepBook, Pyth, Move publish, codegen, dev wallet,
    dev server). New devstack work goes here.
  - **create-devstack-app/** - Scaffolder for new devstack-backed apps
  - **docs/** - Documentation site (fumadocs + Next.js); content under `content/<package>/`
  - **tsconfig/** - Shared internal TypeScript configurations (not published)
- **apps/** - First-party consumer apps (e.g. the hosted dev-wallet)
- **examples/** - Worked example apps that exercise the packages end-to-end against
  `packages/devstack/`; see `examples/README.md` for the curated tour.

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
2. oxlint and Prettier (lint + format) are enforced across the codebase.
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
2. **Package-specific style** — each package has its own guidance covering
   its substrate, public-surface rules, and cookbooks. For devstack, read
   [`packages/devstack/STYLE_GUIDE.md`](packages/devstack/STYLE_GUIDE.md) and
   [`packages/devstack/ARCHITECTURE.md`](packages/devstack/ARCHITECTURE.md)
   before opening a PR. These docs name the further skills (e.g. `writing-effect`)
   that apply inside that package.
3. **Repo-wide habits** — the short list below. Anything more concrete belongs
   in a package AGENTS.md, not here.

### Sui SDK documentation (read before guessing)

**Never hand-roll Sui RPC — always go through the SDK.** Any time you talk to a
Sui node (reads or writes, runtime or dev scripts), use the `@mysten/sui` SDK
client — `SuiGrpcClient` and its `client.core.*` methods (`listCoins`,
`getObject`, `executeTransaction`, `waitForTransaction`, …). Do NOT build raw
JSON-RPC requests (no `fetch` to a fullnode with a `{ jsonrpc, method:
'suix_*' | 'sui_*' }` body) and do NOT use the legacy JSON-RPC transport — the
gRPC client is the only sanctioned path, and `sui-fork` doesn't serve JSON-RPC
at all. The runtime already standardizes on `SuiGrpcClient`; any helper or
script that reaches a Sui node must do the same.

Every `@mysten/*` package ships LLM-optimized documentation in its own
`docs/` directory. Before writing or modifying code that touches a `@mysten/*`
package, find and read the relevant docs locally — **don't guess at API shape,
don't grep `node_modules/**/\*.d.ts`for type names, don't search the web**.
The shipped docs are the ground truth for the version installed in this repo
(currently`@mysten/sui`2.x;`experimental` and other 1.x surfaces are gone).

Workflow:

1. Locate the index in `node_modules/`:
   `find . -path '*@mysten/*/docs/llms-index.md' | head` (or the specific
   package: `node_modules/.pnpm/@mysten+sui*/node_modules/@mysten/sui/docs/llms-index.md`).
2. Read `llms-index.md` first — it's a routing table mapping each doc page
   to a one-line description.
3. Read the specific page(s) (`clients/core.md`, `transaction-building/basics.md`,
   `migrations/sui-2.0/sui.md`, etc.) before touching code.

Common entries you'll need:

- `clients/core.md` — `ClientWithCoreApi` / `CoreClient`, the shape `Transaction.build({ client })` accepts and every `client.core.*` method routes through.
- `clients/grpc.md` — `SuiGrpcClient`, the gRPC transport (preferred over JSON-RPC).
- `transaction-building/basics.md` — `Transaction` construction, `tx.build({ client })`, gas configuration.
- `transactions/signing-and-execution.md` — `client.core.executeTransaction` / `client.core.waitForTransaction` instead of bespoke wrappers.
- `migrations/sui-2.0/sui.md` — what moved where between 1.x and 2.x (the `experimental` subpath is gone; `ClientWithCoreApi` now lives at `@mysten/sui/client`).

When you do reach across the SDK boundary, **import published types instead
of redeclaring narrowed shapes**. `Parameters<typeof tx.build>[0] extends { client?: infer C } | undefined ? C : never`-style extractors are a code smell — the
SDK already exports the type (e.g. `ClientWithCoreApi`); re-export from the
plugin barrel and consumers cast to that.

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
