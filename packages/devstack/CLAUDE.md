# CLAUDE.md

Conventions for AI assistants working in this repo. Apply alongside any IDE-specific configs in
`.cursor/`, `.claude/`, `.opencode/`.

## Project status — prototype, not released

Devstack is a **prototype**. Nothing is published to npm yet, and we are **not publishing
anytime soon**. There are no consumers outside this monorepo, no compatibility surface, no
deprecation cycle to honor. This shapes how we work:

- **Break the API freely.** If a name, shape, or contract is wrong, change it directly — don't
  ship a shim, alias, or "v2" alongside the old one. We get one chance to set the surface
  correctly before anyone depends on it; squander it and we live with the wart for the lifetime
  of the project.
- **No backwards compatibility.** No `@deprecated`, no fallback paths for old config formats, no
  legacy export re-exports. Rename, restructure, delete; update every callsite in the same
  commit.
- **Surface every paper-cut now.** When something feels awkward (verbose, easy to misuse,
  needlessly leaky), capture it in `notes/friction.md` and fix the root cause rather than
  papering over it. Prototype phase is the only time the cost of a redesign is just code edits.
- **Migration helpers and version-detection logic are anti-patterns** in this phase. If you
  catch yourself adding either, stop — the right move is a hard break.

Initial release is a future event with its own design pass. Until then, treat the public API as
in flux.

## What this repo is

A monorepo of high-quality Sui example apps + a devstack for fully-seeded local development. The bar
is "scaffold-eth-2 for Sui." Build quality matters; cute matters.

## Methodology: build-then-extract

We are deliberately **not** designing the devstack upfront. Phase 1 builds the `token-studio` app
end-to-end with intentionally ad-hoc supporting infrastructure. Friction encountered along the way
is captured in `notes/friction.md`. Phase 2 extracts the devstack from that journal.

**If you find yourself designing a new shared abstraction for a problem we've only seen once:
stop.** Add a journal entry instead. We extract from evidence, not anticipation.

## Code conventions

- **TypeScript strict everywhere.** `noUncheckedIndexedAccess`, `noUnusedLocals`, no `any` without
  comment justifying it.
- **Tabs for indentation** (Biome enforces). Single quotes, semicolons, trailing commas.
- **Imports**: `import type` for type-only imports (Biome enforces). Use `node:` protocol for
  built-ins.
- **No comments** unless they explain a non-obvious _why_. Don't narrate code.
- **Friction journal**: when something hurts (hardcoded port, copy-paste, manual step), add a short
  entry to `notes/friction.md` with file path + one-line description. Do not silently work around
  pain — the pain is the data.

## File / package conventions

- Examples live in `examples/<name>/`. Each app self-contained: own Vite config, own Move package(s)
  under `move/`, own runtime state under `.devstack/`, own e2e under `e2e/`.
- Shared code in `packages/<name>/`. Use `workspace:*` for in-monorepo deps. Use `catalog:` for
  `@mysten/*`, React, build tools so versions stay aligned across apps.
- Move package layout: `examples/<app>/move/<package_name>/{Move.toml,sources/}`. Use snake_case for
  package and module names (Move convention). Always use `--json` when invoking `sui client publish`
  from scripts.

## Testing

- **Unit/integration**: Vitest, in `src/**/*.test.ts(x)` or sibling `__tests__/` folders.
- **E2E**: Playwright, in each app's `e2e/` folder. Real localnet, real wallet adapter — not mocks.
  Mocks for unit tests only.
- **Fresh localnet per test file** via testcontainers (Phase 1+). Pre-fund accounts in
  `globalSetup`, claim from a pool — never faucet-per-test.

## Anti-patterns we will not repeat

From `MystenLabs/deepbook-sandbox`:

- Hardcoded ports anywhere outside the port allocator
- Long-running processes that `process.exit(1)` on transient errors with no restart
- `git checkout` to restore mutated config files (generate, don't mutate)
- Always-on services that can't be opted out per-app

From `MystenLabs/ts-sdks` (specialized, not bad — but don't copy wholesale):

- Copy-pasted `globalSetup.ts` across multiple packages
- Faucet-per-test in the hot path (5–10s per call)
- Mock-only tests for hooks that need a real chain to verify

## Setup design — the action graph IS the lifecycle

App-level setup (`DevstackConfig.setup: [...]`) is a list of actions
synthesized into a per-app plugin. We deliberately do not expose
parallel lifecycle-hook APIs (`afterStackUp`, `afterPublish`, etc.)
because the action graph already covers the use cases:

- **Ordering** — express via `needs:` (`needs: ['sui.accounts']`,
  `needs: ['my-package']`).
- **Idempotence** — express via `getStatus`. `runTransaction` defaults
  to a marker file at `<stackDir>/setup/<name>.done` whose CONTENT is
  `stableHash` of the action's inputs (signer, build callback source,
  scope, needs); editing the build callback re-runs.
- **Snapshot composition** — markers live in `<stackDir>` so
  `snapshot save` captures them; restore brings them back; setup skips.
- **Same-signer serialization** — `runsAs:` (defaulted by
  `publishMove`/`runTransaction` from `publisher`/`signer`; passed
  explicitly on raw `seed()` whose body signs through
  `ctx.accounts.get(...)`). The reconciler runs at most one inflight
  action per distinct `runsAs` value so two same-account actions don't
  equivocate on the gas object — apps don't need to thread synthetic
  `needs:` edges between them.

A separate hook system would either duplicate this or coordinate
poorly with snapshots (re-running on every restore wastes work; not
re-running collapses into the same action-graph idempotence). Setup
actions ARE the lifecycle.

## Helpers vs raw factories

`publishMove()` and `runTransaction()` are sugar over the raw
`definePublishAction` / `seed` factories. They cover the 90% case;
they will not grow into a catalog. Anything outside drops into the
raw factories directly inside `setup: [...]` — both forms are
first-class. If you find yourself wanting a third helper, add a
friction journal entry first.

## When invoking the Sui CLI from scripts

Always:

- `--json` flag, parse with proper TypeScript types (no `any`).
- Pre-set `~/.sui/sui_config/client.yaml` so no interactive prompts.
- Wrap in retries with exponential backoff + jitter; don't use flat polling.
- Fail loudly with an actionable message if Docker / RPC / faucet aren't ready.

## Memory + planning

- Update plans rather than starting new ones for the same effort.
- Use `notes/friction.md` for cross-session observations about pain points; that file is the input
  to Phase 2 design.
- Don't write speculative architecture docs. Write code, capture friction, then design.
