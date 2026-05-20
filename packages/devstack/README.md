# @mysten-incubation/devstack

Hermetic local Sui development stack. Composes a Sui localnet + Walrus + Seal +
DeepBook + your Move packages as Effect Layers, with a TUI runner and the same
primitives reachable as embeddable services.

> Status: unreleased / incubation. APIs and CLI surface may change.

## Quickstart

In a project that defines a `devstack.config.ts`:

```sh
pnpm dev
```

This runs `devstack up` under the hood — boots every service in the config,
mounts Move package sources, publishes them, runs codegen, and renders a TUI
with each primitive's lifecycle phase. Ctrl-C shuts down cleanly.

A minimal config:

```ts
// devstack.config.ts
import { defineDevstack, Sui } from '@mysten-incubation/devstack';

export default defineDevstack({
  stack: [
    Sui({}),
  ],
});
```

See `examples/` in the monorepo root for runnable apps (`arena`, `wallet`,
`private-content`, `deepbook-full`, `token-studio`, `effect-app`,
`fork-greeting`, `plugin-author-redis`).

## CLI surface

| Verb                       | Purpose                                                       |
|----------------------------|---------------------------------------------------------------|
| `up`                       | Boot + render TUI. Default when `pnpm dev` runs.              |
| `apply`                    | Boot, write manifest, exit. Non-interactive (CI / agents).    |
| `status`                   | Print resolved manifest for the current stack.                |
| `manifest`                 | Print/emit the full manifest envelope.                        |
| `snapshot save/restore/list/delete` | Capture or restore chain-state + container layer.    |
| `wipe`                     | Tear down a stack's containers, networks, volumes, state.     |
| `prune`                    | Sweep stale stacks across apps.                               |
| `stack list/new/use/down/drop` | Manage named stacks (parallel-stack workflows).           |
| `fork status/advance-*/replay-to/seed/cache` | Fork-mode controls.                         |
| `doctor`                   | Environment + lock + port checks.                             |
| `graph`                    | Render the dep-graph (text/mermaid/dot).                      |
| `version`                  | Print version. `--schema --json` dumps the CLI schema.        |

Global flags every command honors:

- `--json` — JSON envelope on stdout (success or `{ ok: false, error: {...} }`)
- `--no-input` — Disable interactive prompts; emit `CONFIRM_REQUIRED` envelope instead
- `--dry-run` — Plan only, no mutations (where applicable)
- `--yes` — Bypass interactive prompts (where applicable)
- `--schema --json` — Discovery surface for tools / agents

Exit codes follow sysexits conventions (0/1/64/65/69/73/75/78 +
domain 40-43). See `cli/exit-codes.ts`.

## Subpath exports

- `@mysten-incubation/devstack` — services (`Sui`, `Walrus`, `Seal`, `Deepbook`,
  `Postgres`, `Pyth`, `Faucet`, `Account`, `Package`, `Wallet`, `Action`, …) and `defineDevstack`
- `@mysten-incubation/devstack/advanced` — plugin-author primitives
  (`dockerContainer`, `containerPrimitive`, `dockerImage`, `gitFetch`,
  `LayeredTag`, `provide`, `tag`, `composeLayers`, …)
- `@mysten-incubation/devstack/vitest` — `defineDevstackVitestConfig`
- `@mysten-incubation/devstack/playwright` — `webServer({ ... })` for
  `playwright.config.ts`
- `@mysten-incubation/devstack/vite` — `devstackVitePlugin`

## Development

```sh
pnpm --filter @mysten-incubation/devstack build
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack test
```

Docker tests (snapshot lifecycle on real Docker) require `pnpm build` first so
the CLI binary exists at `dist/cli/main.mjs`. They skip with a hint when `dist/`
is missing.

## See also

- `AGENTS.md` — load-bearing conventions for contributors (and agents)
- `notes/integration-contract-redesign.md` — substrate plan (Phase A+B+C)
- `notes/stack-simplification-audit.md` — E1–E70 finding catalog
- `notes/cli-redesign.md` — CLI design proposal (Phase A shipped)
- `notes/STATE-2026-05-19.md` + `notes/SESSION-CLOSEOUT-2026-05-19.md` — current state snapshot
- `notes/verification-2026-05-19.md` — lifecycle + snapshot + parallel-stack test report
- `notes/v2-requirements/` — per-subsystem rewrite-reference specs
