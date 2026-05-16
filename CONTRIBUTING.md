# Contributing

Thanks for your interest in this repo. A few practical notes before you open a PR.

## Project status

Most of this monorepo is **prototype code that has not been published to npm**, with no
near-term plan to publish (`@mysten-incubation/dev-wallet` is the exception). See
[AGENTS.md](AGENTS.md) for the full breakdown. Practically:

- **Break the API directly** when something is wrong. Rename, restructure, delete; update
  every callsite in the same commit. No shims, `@deprecated` markers, or "v2 alongside v1"
  exports for the prototype packages.
- For the published packages, follow the changeset workflow described below.

## Setup

Requires **Node.js 24+** and **Docker** (the latter only for devstack workflows).

```bash
pnpm install
pnpm turbo build
```

## Tests

```bash
pnpm test                                # unit tests across all packages
pnpm --filter @mysten-incubation/devstack test   # one package only
pnpm turbo run typecheck                 # full repo typecheck
```

End-to-end tests for the example apps live in `examples/<app>/e2e/` and run via Playwright
against a real localnet — see each example's README.

## Linting

Biome handles lint + format. Configuration at the repo root applies everywhere.

```bash
pnpm lint
pnpm lint:fix
```

## Commits + PRs

- Imperative mood subject line, ≤ 70 chars (`fix: …`, `feat: …`, etc. optional).
- Body explains the _why_ — the diff already tells the _what_.
- For changes that touch the published packages (`@mysten-incubation/dev-wallet`), add a
  changeset: `pnpm changeset` (see [the changesets docs](https://github.com/changesets/changesets)
  for the version-bump conventions).
- Prototype-package changes do **not** require a changeset.

When you open a PR, fill in the template at `.github/PULL_REQUEST_TEMPLATE.md` and tick the
AI-assistance disclosure where it applies.

## Reporting issues

- Bugs / feature requests: GitHub Issues on this repo.
- Security issues: see [SECURITY.md](SECURITY.md) — please do not open public issues for
  vulnerabilities.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
