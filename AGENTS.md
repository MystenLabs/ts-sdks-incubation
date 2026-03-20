# AGENTS.md

This file provides guidance to AI agents working with code in this repository.

## Overview

This is a monorepo containing incubation TypeScript packages for the Sui blockchain ecosystem under the `@mysten-incubation` npm scope. It uses pnpm workspaces, turbo for build orchestration, and changesets for versioning.

## Common Commands

### Setup and Build

```bash
# Initial setup
pnpm install
pnpm turbo build

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

```bash
# Add a changeset for version updates
pnpm changeset

# Version packages
pnpm changeset-version
```

## Architecture

### Repository Structure

- **packages/** - All incubation packages
  - **dev-wallet/** - Development wallet for Sui dApp testing

### Build System

- Uses Turbo for monorepo task orchestration with dependency-aware builds
- Each package can have its own test configuration (typically using Vitest)
- Common build outputs: `dist/` for compiled code

### Changeset Conventions

- **`patch`**: Bug fixes that don't change the public API shape
- **`minor`**: New fields, methods, or types added to the public API
- **`major`**: Breaking changes to existing public API

### Development Workflow

1. Changes require changesets for version management
2. Turbo ensures dependencies are built before dependents
3. OXLint and Prettier are enforced across the codebase
4. Tests must pass before changes can be merged

### Pull Requests

When creating PRs, follow the template in `.github/PULL_REQUEST_TEMPLATE.md`:

- Include a description of the changes
- Check the appropriate checkbox in the AI Assistance Notice section
