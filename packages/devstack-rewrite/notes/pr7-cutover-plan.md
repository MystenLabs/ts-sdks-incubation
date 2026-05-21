# PR7 cutover plan (2026-05-20)

> **Current-state warning (2026-05-21):** do not execute this cutover plan until the P0 ledger in
> `UNRESOLVED-BLOCKERS.md` is closed and the plan is refreshed. The current tree is not
> release-ready and has no checkpoint commits yet.

> Step-by-step playbook for the final rename: `packages/devstack-rewrite/` → `packages/devstack/`.
> Read top-to-bottom. Do not execute until **all** pre-conditions are green.

## TL;DR

- **~115 consumer files** to update (63 example files, 9 example originals to delete, 13 example
  rewrites to rename, 14 doc files, 3 dev-wallet adapter files, 1 CI workflow, 1 create-devstack-app
  template, 1 oxlint override, root README + AGENTS.md, internal rewrite self-refs in 6 source
  files).
- **Sequence: PRE → MIGRATE NOTES → DELETE old → RENAME → INTERNAL SELF-REF SWEEP → EXAMPLE RENAMES
  → DOCS/CI → REGEN LOCKFILE → VALIDATE → COMMIT.**
- **One mega-commit recommended** — workspace graph is broken between commits if split (the rewrite
  has `@mysten-incubation/devstack-rewrite`, examples consume that name, deleting old package severs
  originals). Series only if a worktree is used per intermediate step.
- **CLI gap is the dominant risk**: `.github/workflows/devstack-e2e.yml` invokes
  `node ../../packages/devstack/dist/cli/main.mjs apply` — the rewrite has no `apply` verb yet.
  Cutover is blocked on CLI parity OR a CI workflow rewrite.

---

## Pre-conditions (must be true before PR7 dispatches)

These gates come from `notes/parity-matrix.md` (cutover gate) + `notes/opportunities-backlog.md` (🔴
LOAD-BEARING entries) + `notes/orchestrator-guide.md` §12.

- [ ] **PR1 (substrate primitives)** shipped — verified at `notes/orchestrator-guide.md:151`.
- [ ] **PR1.5 (per-stack-registries delete)** shipped — verified at
      `notes/orchestrator-guide.md:152`.
- [ ] **PR2-A (harvest loop / CapabilitySinks)** shipped — verified at `notes/pr2-verification.md`
      (7/8 fully landed).
- [ ] **PR2-B (CrossProcessLock flock + atomic-write dedup)** shipped — verified at
      `notes/orchestrator-guide.md:154`.
- [ ] **PR3 plugin wave** complete — coin/wallet/package/action/walrus/seal/deepbook SDK wiring all
      green. **STATUS**: open per `notes/orchestrator-guide.md:160`.
- [ ] **PR4 (root barrel + 11 examples migrated)** shipped — verified at
      `notes/orchestrator-guide.md:155`.
- [ ] **PR5 (subpath deletion + root-barrel expansion)** complete — backlog slug `api.root-barrel`
      closed.
- [ ] **PR6 e2e Wave 2-4** green: `wallet-rewrite`, `postgres-mini-rewrite`,
      `private-content-rewrite`, `plugin-author-redis-rewrite`, `effect-app-rewrite`,
      `fork-greeting-rewrite` all have passing playwright suites (plan at
      `notes/phase-f-e2e-plan.md`).
- [ ] **User has executed `notes/phase-f-manual-scenarios.md` and signed off** (parallel stacks
      per-service, port reassignments, doctor probes, cleanups, cross-host PID runbooks).
- [ ] **Opportunities backlog: 0 🔴 LOAD-BEARING entries remaining** (or each has documented
      user-approved deferral). Currently **31** load-bearing entries open per
      `notes/opportunities-backlog.md` (grep count). The cutover-blocking top 5 from
      `parity-matrix.md`:
  1. `up`-time CLI verb IPC wiring (slug `cli.up-time-ipc`).
  2. `doctor` probes wired (slug `cli.doctor-probes`).
  3. `Stack` runnable handle / `runStack()` (slug `api.run-stack`, O17).
  4. `Action.body` `ctx.signAndExecute(account, build)` sugar (slug `api.action-sugar`, S5).
  5. `apply` + `stack {list,new,use,drop,drop-fork}` + `wipe` CLI verbs (slug `cli.missing-verbs`).
- [ ] **Parity matrix: 0 CLOSE rows remaining.** Currently **25** CLOSE rows per `parity-matrix.md`
      grep count. Each must reach WIN / PARITY / ACCEPT_GAP, or be re-classified with explicit
      deferral in this plan's "Items NOT in PR7" section.
- [ ] **CLI parity gate**: `apply`, `up`, `snapshot save`, `snapshot restore` all work end-to-end
      against `examples/arena-rewrite` (required by `devstack-e2e.yml`).
- [ ] **Lockfile** has no merge conflicts and reflects current `package.json` set.
- [ ] **CI green on main** (`pkg-pr-new.yml`, `turborepo.yml`, `changesets*.yml`,
      `validate-ai-assistance.yml`) — these survive the rename but should not be already-red before
      cutover.

---

## Consumer audit (every file PR7 touches)

Numbers below are from monorepo greps run 2026-05-20.

### Category A: examples consuming `@mysten-incubation/devstack-rewrite` (63 files)

The 13 `-rewrite` example directories all carry the rewrite package-name string. Per-example file
lists:

- `examples/_template-rewrite/`: `package.json`, `devstack.config.ts`, `vite.config.ts`,
  `vitest.config.ts`, `playwright.config.ts`, `e2e/mint.spec.ts`
- `examples/arena-rewrite/`: `package.json`, `devstack.config.ts`, `vite.config.ts`
- `examples/deepbook-full-rewrite/`: `package.json`, `devstack.config.ts`
- `examples/effect-app-rewrite/`: `package.json`, `devstack.config.ts`
- `examples/fork-greeting-rewrite/`: `package.json`, `devstack.config.ts`, `vite.config.ts`
- `examples/hello-world-rewrite/`: `package.json`, `devstack.config.ts`
- `examples/plugin-author-redis-rewrite/`: `package.json`, `devstack.config.ts`, `redis-plugin.ts`
- `examples/postgres-mini-rewrite/`: `package.json`, `devstack.config.ts`
- `examples/private-content-rewrite/`: `package.json`, `devstack.config.ts`, `playwright.config.ts`,
  `vite.config.ts`
- `examples/seal-mini-rewrite/`: `package.json`, `devstack.config.ts`
- `examples/token-studio-rewrite/`: `package.json`, `devstack.config.ts`, `vite.config.ts`,
  `vitest.config.ts`, `playwright.config.ts`, `e2e/create-coin.spec.ts`
- `examples/wallet-rewrite/`: `package.json`, `devstack.config.ts`, `vite.config.ts`,
  `playwright.config.ts`, `e2e/send-sui.spec.ts`
- `examples/walrus-mini-rewrite/`: `package.json`, `devstack.config.ts`

Each file changes:

- `package.json`: `"@mysten-incubation/devstack-rewrite": "workspace:*"` →
  `"@mysten-incubation/devstack": "workspace:*"`.
- `*.ts` / `*.spec.ts` / `*.config.ts`: `from '@mysten-incubation/devstack-rewrite'` →
  `from '@mysten-incubation/devstack'` (incl. subpaths like `/vitest`, `/playwright`,
  `/plugins/sui`).

### Category B: v3 originals to delete (9 directories)

Every v3 example consumes the OLD `@mysten-incubation/devstack` (which gets deleted in step 3). They
cannot survive cutover without a workspace graph error.

```
examples/_template/
examples/arena/
examples/deepbook-full/
examples/effect-app/
examples/fork-greeting/
examples/plugin-author-redis/
examples/private-content/
examples/token-studio/
examples/wallet/
```

### Category C: package-name self-references inside the rewrite (1 file source + multiple docs)

- `packages/devstack-rewrite/src/index.ts:1` — header comment "Public API surface for
  `@mysten-incubation/devstack-rewrite`."

### Category D: path-based references to `packages/devstack-rewrite/` inside the rewrite (7 files)

- `packages/devstack-rewrite/src/plugins/coin/discovery.ts:17` — comment.
- `packages/devstack-rewrite/src/plugins/seal/lifted-siblings/cargo-image.ts:161` —
  `packages/devstack-rewrite/images/seal/` (Dockerfile path).
- `packages/devstack-rewrite/test/e2e/walrus-real-boot.test.ts:3` —
  `packages/devstack-rewrite/images/walrus/Dockerfile`.
- `packages/devstack-rewrite/test/e2e/seal-real-boot.test.ts:58-59` — two
  `packages/devstack-rewrite/images/seal/...` paths.
- `packages/devstack-rewrite/tsdown.config.ts:6` — comment referencing old
  `packages/devstack/tsdown.config.ts`.
- (Doc files separately listed below.)

### Category E: load-bearing self-name strings (must be flipped together with the rename)

From `notes/orchestrator-guide.md` §12 + `CUTOVER-PLAN.md` Step 4. These are RUNTIME setup-file
specifiers, not comments:

- `packages/devstack-rewrite/src/build-integrations/vitest/config.ts:75` — **load-bearing**
  setup-file specifier string used at runtime. Must become
  `@mysten-incubation/devstack/build-integrations/vitest/setup` (or subpath shape chosen, see step
  4).
- `packages/devstack-rewrite/src/build-integrations/vitest/config.ts:92` — JSDoc + (verify) related
  setup-file specifier.
- `packages/devstack-rewrite/src/build-integrations/vitest/setup.ts:141` — JSDoc example.
- `packages/devstack-rewrite/src/build-integrations/playwright/stack-context.ts:230, 246` — error
  messages.
- `packages/devstack-rewrite/src/build-integrations/vite/index.ts` — verify self-name references.
- `packages/devstack-rewrite/src/build-integrations/browser/config.ts` — verify.
- `packages/devstack-rewrite/src/build-integrations/browser/index.ts` — verify.
- `packages/devstack-rewrite/src/build-integrations/vite/config.ts` — verify.
- `packages/devstack-rewrite/src/plugins/wallet/protocol.ts` — verify (grep hit).

(Orchestrator guide §12 documents the load-bearing risk explicitly. Per
`notes/opportunities-backlog.md:526` slug `build-int.vitest-setup-module-name-drift` is 🔴
LOAD-BEARING for exactly this reason — browser preset and vitest preset disagree on the name today.)

### Category F: CI workflows (1 file, multiple sites)

- `.github/workflows/devstack-e2e.yml`:
  - Lines 53, 66, 130 (job names): `Build devstack` step uses
    `pnpm turbo build --filter @mysten-incubation/devstack` — package-name filter; works post-rename
    (the rewrite would then be `@mysten-incubation/devstack`).
  - Lines 80, 109, 162:
    `node ../../packages/devstack/dist/cli/main.mjs apply|snapshot save|snapshot restore` —
    **path-based, survives rename**. Requires the rewrite to produce a `dist/cli/main.mjs` binary
    with `apply` / `snapshot save` / `snapshot restore` verbs. Currently the rewrite's
    `tsdown.config.ts` only builds CLI (`bin: devstack`), but the verbs `apply` / `wipe` / `stack`
    are missing per parity-matrix CLI section.
  - Lines 53, 130, 192: matrix `[arena, private-content, deepbook-full]` — references **directory
    names** (`examples/arena/`). Post-rename of `examples/arena-rewrite/` → `examples/arena/`, this
    matrix continues to work.
  - Line 195 (filter):
    `pnpm --filter @mysten-incubation/${{ matrix.example }} exec playwright install` — depends on
    the example's `package.json` name. Currently rewrite example names are
    `@mysten-incubation/example-arena-rewrite` etc.; post-rename they should become
    `@mysten-incubation/arena` (matching v3) or `@mysten-incubation/example-arena` (per
    CUTOVER-PLAN.md Risk 5).
  - Line 238-241: `packages/devstack/test-results/`, `packages/devstack/.devstack/` paths — survive
    rename.
  - Line 251: `cd packages/devstack && pnpm vitest run --testNamePattern docker --shard ...` —
    survives rename. Tests must exist in rewrite's `test/` to be matched.

Other workflows (`.github/workflows/pkg-pr-new.yml`, `turborepo.yml`, `changesets-ci.yml`,
`changesets.yml`, `changesets-ci-comment.yml`, `validate-ai-assistance.yml`) are
package-name-agnostic and survive.

### Category G: create-devstack-app template (5 files)

- `packages/create-devstack-app/template/package.json` — `"@mysten-incubation/devstack": "^0.0.0"`
  (already correct final name) but the template body is a snapshot of v3 `examples/_template/`. Must
  be re-generated from post-rename `examples/_template/` via
  `packages/create-devstack-app/scripts/sync-template.ts`.
- `packages/create-devstack-app/template/devstack.config.ts`
- `packages/create-devstack-app/template/vite.config.ts`
- `packages/create-devstack-app/template/vitest.config.ts`
- `packages/create-devstack-app/template/playwright.config.ts`
- `packages/create-devstack-app/template/e2e/mint.spec.ts`
- `packages/create-devstack-app/template/README.md`

(The package's `package.json` + `src/bin.ts` + `src/index.ts` reference the scaffolder verb
`pnpm create @mysten-incubation/devstack-app`, NOT the devstack package itself — no rename needed
there.)

### Category H: dev-wallet adapter (3 files)

- `packages/dev-wallet/src/adapters/devstack-adapter.ts` — header references
  `@mysten-incubation/devstack`'s `services/wallet/protocol.ts`. Rewrite has it at
  `plugins/wallet/protocol.ts`. Update comment.
- `packages/dev-wallet/src/adapters/devstack-paths.ts:1, 3, 9, 26` — multiple comments referring to
  v3 paths `packages/devstack/src/services/wallet/{protocol,internal}.ts`. Update to rewrite paths
  `packages/devstack/src/plugins/wallet/{protocol,server}.ts` post-rename.
- `packages/dev-wallet/src/adapters/fork-relay.ts:13, 16` — similar v3 path comments.
- `packages/dev-wallet/src/ui/dev-wallet-fork-panel.ts:9` — references
  `packages/devstack/notes/sui-fork-phase-5.md` (v3 historical note, not migrated). Either update to
  corresponding rewrite note OR delete the reference.

### Category I: docs (16 files in packages/docs/content/devstack/)

All `.mdx` files reference `@mysten-incubation/devstack` (the rewrite's final name) in
import-example snippets — already correct final form, no rename needed. BUT they may reference:

- `packages/devstack/src/engine/...` paths (v3) → must update to rewrite paths post-rename, OR docs
  internally point at `packages/devstack/src/plugins/...` / `substrate/...` paths.
- `packages/devstack/notes/...` paths → may need updating.
- `packages/devstack/test-setup/snapshot-smoke/README.md` is referenced from
  `packages/docs/content/devstack/features/state-and-snapshots.mdx` (lines 208, 298 per
  CUTOVER-PLAN.md). Either port the runbook to rewrite OR update doc link.

Files (per grep):

```
packages/docs/content/devstack/index.mdx
packages/docs/content/devstack/quickstart.mdx
packages/docs/content/devstack/features/{local-dev,coins-and-funding,plugins,codegen,services,testing-vitest,live-networks,testing-playwright,state-and-snapshots,dapp-kit,accounts-and-wallet}.mdx
packages/docs/content/devstack/internals/refs-and-tags.mdx
packages/docs/content/devstack/reference/{cli,codegen,services,advanced,faucet}.mdx
```

### Category J: top-level + meta files

- `/Users/michaelhayes/code/ts-sdks-incubation/README.md:14` — `@mysten-incubation/devstack` package
  table row. Path link `packages/devstack` survives.
- `/Users/michaelhayes/code/ts-sdks-incubation/AGENTS.md:35, 76, 78, 133` — multiple devstack
  references; line 133 specifically points at `packages/devstack/AGENTS.md` (which the rewrite must
  replicate or the cross-ref deleted).
- `/Users/michaelhayes/code/ts-sdks-incubation/CONTRIBUTING.md` — `devstack` mentioned; verify any
  path refs.
- `/Users/michaelhayes/code/ts-sdks-incubation/examples/README.md` — describes 6 v3 example apps;
  needs full rewrite post-cutover to describe new set (`_template`, `arena`, `deepbook-full`,
  `deepbook-mini`, `effect-app`, `fork-greeting`, `hello-world`, `plugin-author-redis`,
  `postgres-mini`, `private-content`, `seal-mini`, `token-studio`, `wallet`, `walrus-mini`).
- `/Users/michaelhayes/code/ts-sdks-incubation/.oxlintrc.json` — line ~61 has override
  `packages/devstack/src/**/*.ts` with `no-restricted-imports` rule banning `@mysten/sui/jsonRpc`.
  Re-evaluate whether the rule still applies (rewrite doesn't import jsonRpc per grep). Either keep,
  remove the rule, or remove the override.
- `/Users/michaelhayes/code/ts-sdks-incubation/.changeset/devstack-wallet-server.md`
- `/Users/michaelhayes/code/ts-sdks-incubation/.changeset/dev-wallet-devstack-adapter.md` — both
  refer to feature names, not package paths; survive.

### Category K: package metadata internal references (3 files inside rewrite)

- `packages/devstack-rewrite/README.md` lines 30-33 (and ~7 other devstack-rewrite mentions per
  grep) — sweep + update.
- `packages/devstack-rewrite/STYLE_GUIDE.md` — `@mysten-incubation/devstack-rewrite` references.
- `packages/devstack-rewrite/CUTOVER-PLAN.md` — keep until after cutover (audit reference); then
  DELETE per `feedback_completed_plans_should_be_deleted`.
- `packages/devstack-rewrite/PHASE-3-NOTES.md` — type-system findings doc; sweep + update.
- `packages/devstack-rewrite/notes/*.md` — multiple files reference the rewrite path; sweep in step
  4 final pass.
- `packages/devstack-rewrite/ARCHITECTURE.md` — minor grep hit; sweep.

### Category L: notes preservation (must mv before old-package delete)

Per CUTOVER-PLAN.md Step 3:

- `packages/devstack/notes/redesign/` — **untracked + load-bearing**. Move to
  `packages/devstack-rewrite/notes/redesign/`.
- `packages/devstack/notes/v2-requirements/` — **untracked + load-bearing**. Move to
  `packages/devstack-rewrite/notes/v2-requirements/`.
- `packages/devstack/AGENTS.md` — referenced from root `AGENTS.md:133`. Either preserve (move to
  rewrite) or remove cross-ref.
- `packages/devstack/test-setup/snapshot-smoke/README.md` — referenced from
  `packages/docs/content/devstack/features/state-and-snapshots.mdx`. Port to rewrite OR update doc
  link.

All other `packages/devstack/notes/*.md` files (`STATE-2026-05-19.md`,
`cli-cleanup-plan-2026-05-19.md`, `cli-redesign.md`, `deletion-hunt-2026-05-19.md`,
`verification-2026-05-19.md`, `SESSION-CLOSEOUT-2026-05-19.md`, `api-surface-cleanup-2026-05-19.md`,
`stack-simplification-audit.md`, `long-acquire-progress.md`, `integration-contract-redesign.md`,
`sui-fork-phase-5-walrus-seal-audit.md`) — session artifacts for v3; **delete with the package** per
`feedback_completed_plans_should_be_deleted` and `feedback_no_compat_for_never_cases`. Git history
preserves them.

---

## Step-by-step sequence

### Step 1 — PRE: final clean state (operator)

Run from repo root.

```bash
# Verify pre-conditions checklist above is fully green.

# Clean working tree.
git status
# Working tree must be clean OR every WIP file must be intentional + scoped to PR7.

# Validation sweep against current (pre-cutover) state.
pnpm --filter @mysten-incubation/devstack-rewrite typecheck
pnpm --filter @mysten-incubation/devstack-rewrite vitest run
pnpm -r typecheck

# Snapshot the pre-cutover sha for rollback reference.
git rev-parse HEAD > /tmp/pr7-pre-cutover-sha
```

**Stop if anything is red.** PR7 ships from a known-green tree.

### Step 2 — MIGRATE NOTES (preserves load-bearing inputs before old-package delete)

The redesign + v2-requirements directories are LOAD-BEARING SOURCE-OF-TRUTH for the rewrite. They
must survive the old-package delete.

```bash
# v2-requirements/ files are untracked per git status — stage them first
# OR use plain mv so git pickup at new location.
git add packages/devstack/notes/v2-requirements/
git add packages/devstack/notes/redesign/  # may already be tracked; idempotent

# Migrate.
git mv packages/devstack/notes/redesign/ packages/devstack-rewrite/notes/redesign/
git mv packages/devstack/notes/v2-requirements/ packages/devstack-rewrite/notes/v2-requirements/

# Decide: keep `integration-contract-redesign.md`? Move if still referenced.
# Recommendation: read its content + decide based on whether the rewrite has
# absorbed the contract.

# Migrate AGENTS.md (if keeping cross-ref from root).
git mv packages/devstack/AGENTS.md packages/devstack-rewrite/AGENTS.md
# OR: edit root AGENTS.md:133 to remove the cross-reference, then git rm
# packages/devstack/AGENTS.md as part of step 3.

# Port snapshot-smoke README if doc cross-ref matters (lines 208, 298 of
# packages/docs/content/devstack/features/state-and-snapshots.mdx).
git mv packages/devstack/test-setup/snapshot-smoke/README.md \
       packages/devstack-rewrite/notes/snapshot-smoke-runbook.md
# (Update the docs cross-ref in step 7.)
```

### Step 3 — DELETE old package

```bash
# After step 2's preservation moves, the old directory is safe to remove.
git rm -r packages/devstack/
```

This removes ~900 v3 source files + tests + dist + notes. The originals in `examples/*` (Category B)
will now have broken workspace links — that's expected; we delete them in step 5.

### Step 4 — RENAME rewrite directory → canonical

```bash
git mv packages/devstack-rewrite/ packages/devstack/
```

### Step 5 — UPDATE package.json metadata + internal self-refs

Operations on the renamed `packages/devstack/`:

**5a. `packages/devstack/package.json`:**

- `"name": "@mysten-incubation/devstack-rewrite"` → `"name": "@mysten-incubation/devstack"`.
- Add stripped metadata that a published package needs (cf. old `packages/devstack/package.json`):
  ```json
  "description": "Hermetic local Sui development stack — composes localnet + Walrus + Seal + DeepBook + your Move packages as Effect Layers, with a TUI runner and the same primitives reachable as embeddable services.",
  "keywords": ["sui", "devstack", "effect", "developer-experience"],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/MystenLabs/ts-sdks-incubation.git",
    "directory": "packages/devstack"
  },
  "homepage": "https://github.com/MystenLabs/ts-sdks-incubation/tree/main/packages/devstack#readme",
  "bugs": { "url": "https://github.com/MystenLabs/ts-sdks-incubation/issues" }
  ```
- **Version policy**: keep `"version": "0.0.0"`. Per `feedback_no_compat_for_never_cases` the
  rewrite is unreleased; no bump needed. Changesets continue from `0.0.0`.
- **Subpath export shape decision** (see `CUTOVER-PLAN.md` Risk 2): rewrite ships nested subpaths
  (`./build-integrations/vitest`, `./build-integrations/playwright`, `./plugins/*`). Decision:
  **keep the nested shape** per `feedback_no_compat_for_never_cases` (no compat for unreleased
  package; docs adapt to the canonical new shape). Examples already use the nested form.
- Confirm `bin: { devstack: "./dist/cli/main.mjs" }` is intact.

**5b. Internal self-reference flips (Category C+E):**

For each file in Category E above, replace `@mysten-incubation/devstack-rewrite` with
`@mysten-incubation/devstack`. Mechanical search-and-replace inside `packages/devstack/`:

```bash
# Dry-run first.
grep -rln "@mysten-incubation/devstack-rewrite" packages/devstack/
# Then apply (use sed -i or your editor's project replace).
# Example targets confirmed by grep:
#   src/index.ts:1
#   src/build-integrations/vitest/config.ts:75, 92 (LOAD-BEARING line 75)
#   src/build-integrations/vitest/setup.ts:141
#   src/build-integrations/playwright/stack-context.ts:230, 246
#   src/build-integrations/{vite,browser}/{index,config}.ts
#   src/plugins/wallet/protocol.ts (verify)
```

**5c. Path-based self-refs (Category D):**

For each `packages/devstack-rewrite/...` string inside the renamed package, replace with
`packages/devstack/...`:

```bash
grep -rln "packages/devstack-rewrite" packages/devstack/
# Confirmed targets:
#   src/plugins/coin/discovery.ts:17
#   src/plugins/seal/lifted-siblings/cargo-image.ts:161
#   test/e2e/walrus-real-boot.test.ts:3
#   test/e2e/seal-real-boot.test.ts:58, 59
#   tsdown.config.ts:6
#   README.md (multiple)
#   STYLE_GUIDE.md, ARCHITECTURE.md, PHASE-3-NOTES.md
#   notes/*.md (sweep)
#   CUTOVER-PLAN.md (mark obsolete; will delete in step 11)
```

### Step 6 — UPDATE rewrite-flavored examples (Category A: 13 dirs, 63 files)

For each `examples/*-rewrite/` directory:

```bash
# Per example NAME (replace NAME):
git mv examples/NAME-rewrite/ examples/NAME/
```

(For pairs in Category B, the original `examples/NAME/` was deleted as a side-effect of step 3's
old-package delete + step 5's example originals delete — do step 5 first OR rename to interim name
`examples/NAME-new/` then rename to `examples/NAME/` after deletion. Recommendation: do the
originals delete in step 7 FIRST, then come back here.)

Inside each renamed dir:

- `package.json`:
  - `"name": "@mysten-incubation/example-NAME-rewrite"` → `"name": "@mysten-incubation/NAME"`
    (matching v3 convention).
  - Exceptions: `_template-rewrite` is named `@mysten-incubation/_template-rewrite` (no `example-`
    prefix) — rename to `@mysten-incubation/_template`. Standardize.
  - `"@mysten-incubation/devstack-rewrite": "workspace:*"` →
    `"@mysten-incubation/devstack": "workspace:*"`.
  - Replace the `scripts.dev` placeholder
    (`"echo 'devstack-rewrite supervisor not yet wired — Phase 5'"`) with `"devstack up"` (v3
    convention). Same for `test`, `test:e2e` if currently echo-stubbed.
- `devstack.config.ts`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`,
  `e2e/*.spec.ts`, `redis-plugin.ts`:
  - All `from '@mysten-incubation/devstack-rewrite'` → `from '@mysten-incubation/devstack'` (incl.
    subpaths).
  - Sweep `stackName: 'foo-rewrite'` → `stackName: 'foo'` if S4 (stackName inference) hasn't
    auto-resolved it.
  - Per `notes/parity-matrix.md` "Opportunities" + `feedback_no_compat_for_never_cases`: strip
    "Differences from v3" header comments + Phase-N markers.

### Step 7 — DELETE v3 originals (Category B: 9 dirs)

```bash
git rm -r examples/_template/
git rm -r examples/arena/
git rm -r examples/deepbook-full/
git rm -r examples/effect-app/
git rm -r examples/fork-greeting/
git rm -r examples/plugin-author-redis/
git rm -r examples/private-content/
git rm -r examples/token-studio/
git rm -r examples/wallet/
```

These were paired with rewrite versions; deletion blocked by step 6's rename (must happen first to
avoid name collision). Sequence: rename `examples/NAME-rewrite/` to `examples/NAME-new/` (interim) →
delete originals → rename `examples/NAME-new/` to `examples/NAME/`. OR delete originals first then
rename rewrite directly. Recommendation: **delete first, then rename** — fewer steps.

Revised ordering: step 7 should run BEFORE step 6 (rename in place after originals are gone). Treat
this section as Step 6.0.

### Step 8 — UPDATE CI workflow + create-devstack-app template (Category F+G)

**8a. `.github/workflows/devstack-e2e.yml`:**

- Matrix items (`arena`, `private-content`, `deepbook-full`) survive — they reference example
  directory names.
- Line 195's `pnpm --filter @mysten-incubation/${{ matrix.example }} exec playwright install` —
  requires post-rename example names match. If standardised on `@mysten-incubation/NAME` (Step 6),
  this works.
- Verify CLI verbs `apply`, `snapshot save`, `snapshot restore` exist in rewrite's
  `dist/cli/main.mjs` (pre-condition gate).
- **Required pre-PR** (per CUTOVER-PLAN.md Risk 1): rewrite this workflow against the rewrite's
  test/CLI shape AHEAD of PR7, while old package still exists, so main stays green between PRs.

**8b. `packages/create-devstack-app/template/`:**

After step 6, `examples/_template/` is the new canonical template. Re-sync:

```bash
cd packages/create-devstack-app
pnpm run sync-template  # invokes scripts/sync-template.ts
```

Verify:

- `template/package.json` deps reflect `@mysten-incubation/devstack@workspace:*` (or `^0.0.0` for
  published shape).
- `template/devstack.config.ts` matches the new examples' import shape.

### Step 9 — UPDATE peripheral consumers (Categories H, I, J)

**9a. dev-wallet adapter comments (3 files):**

- `packages/dev-wallet/src/adapters/devstack-paths.ts:3, 9, 26`: update path comments from
  `packages/devstack/src/services/wallet/{protocol,internal}.ts` to
  `packages/devstack/src/plugins/wallet/{protocol,server}.ts` (post-rename, the rewrite path IS
  `packages/devstack/src/plugins/...`).
- `packages/dev-wallet/src/adapters/fork-relay.ts:13, 16`: same.
- `packages/dev-wallet/src/adapters/devstack-adapter.ts:1`: header comment.
- `packages/dev-wallet/src/ui/dev-wallet-fork-panel.ts:9`: update
  `packages/devstack/notes/sui-fork-phase-5.md` reference (note is v3-only; either delete the
  comment line or point at the corresponding rewrite note location).

**9b. docs (Category I, 16 files):**

- All `.mdx` snippets importing `@mysten-incubation/devstack` are already correct.
- Sweep for `packages/devstack/src/engine/...` paths → update to rewrite paths
  (`packages/devstack/src/plugins/...`, `substrate/...`, `runtime/...`).
- `packages/docs/content/devstack/features/state-and-snapshots.mdx` lines 208, 298 → update target
  if `snapshot-smoke/README.md` was moved in step 2.
- Snippets in `reference/services.mdx`, `reference/advanced.mdx` may reference v3 module shapes;
  verify against new exports.

**9c. Top-level meta (Category J):**

- `/Users/michaelhayes/code/ts-sdks-incubation/AGENTS.md:35, 76, 78, 133` — verify references;
  update path on line 133 if `packages/devstack/AGENTS.md` was moved/created in step 2.
- `/Users/michaelhayes/code/ts-sdks-incubation/CONTRIBUTING.md` — sweep `devstack` mentions for
  stale paths.
- `/Users/michaelhayes/code/ts-sdks-incubation/examples/README.md` — REWRITE: lists 6 v3 example
  apps; needs updating to the 14 new examples (or curated subset).
- `/Users/michaelhayes/code/ts-sdks-incubation/.oxlintrc.json` — decision: remove the
  `packages/devstack/src/**/*.ts` override entirely (rewrite doesn't import jsonRpc per grep).
  Alternative: keep + verify rule still applies.

### Step 10 — REGENERATE lockfile

```bash
pnpm install
```

Expect a large `pnpm-lock.yaml` diff: every renamed package + every dep flip. Commit as part of the
cutover.

### Step 11 — DELETE the cutover-plan itself + obsolete rewrite docs

Per `feedback_completed_plans_should_be_deleted`:

```bash
git rm packages/devstack/CUTOVER-PLAN.md
git rm packages/devstack/notes/pr7-cutover-plan.md  # this file
git rm packages/devstack/PHASE-3-NOTES.md           # IF fully absorbed into ARCHITECTURE.md
```

(Verify `PHASE-3-NOTES.md` is dead-letter before deleting.)

### Step 12 — VALIDATE

```bash
# Workspace resolves cleanly.
pnpm install

# Typecheck everything.
pnpm -r typecheck

# Test devstack itself.
pnpm --filter @mysten-incubation/devstack test

# Build the CLI.
pnpm turbo build --filter @mysten-incubation/devstack

# Grep clean (Goal: zero hits).
grep -rln "@mysten-incubation/devstack-rewrite" \
  --exclude-dir=node_modules --exclude-dir=.git \
  --exclude=pnpm-lock.yaml .
grep -rln "packages/devstack-rewrite" \
  --exclude-dir=node_modules --exclude-dir=.git .
# Both must return empty.

# At least one docker-backed e2e boots end-to-end.
cd examples/arena
pnpm devstack apply
pnpm devstack snapshot save baseline
pnpm devstack snapshot restore baseline
pnpm test:e2e  # at minimum first spec passes
```

### Step 13 — COMMIT

**Recommendation: SINGLE COMMIT** (or one tight commit + one lockfile commit).

Why single: the workspace graph is broken between any intermediate states (old package gone +
rewrite still named `-rewrite` → 13 example link errors; partial example renames → mixed name set).
Splitting the rename across commits creates non-bisectable intermediate failures.

When to split: only if using a worktree-per-step strategy where each commit is independently green.
The orchestrator's `feedback_no_inline_validation_in_parallel_agents` discipline suggests one big
sweep + one validation step.

Suggested commit message structure:

```
feat(devstack): cutover rewrite → canonical (PR7)

Rename packages/devstack-rewrite/ to packages/devstack/, delete the v3
package and 9 paired v3 example directories, rename the 13 -rewrite
examples to their canonical names. Migrate the rewrite source-of-truth
notes (notes/redesign/, notes/v2-requirements/) into the renamed package
ahead of the v3 delete.

Renamed packages:
  packages/devstack-rewrite/ → packages/devstack/
    package.json#name: @mysten-incubation/devstack-rewrite → @mysten-incubation/devstack

Renamed examples (13):
  examples/_template-rewrite/        → examples/_template/
  examples/arena-rewrite/            → examples/arena/
  examples/deepbook-full-rewrite/    → examples/deepbook-full/
  examples/effect-app-rewrite/       → examples/effect-app/
  examples/fork-greeting-rewrite/    → examples/fork-greeting/
  examples/hello-world-rewrite/      → examples/hello-world/
  examples/plugin-author-redis-rewrite/ → examples/plugin-author-redis/
  examples/postgres-mini-rewrite/    → examples/postgres-mini/
  examples/private-content-rewrite/  → examples/private-content/
  examples/seal-mini-rewrite/        → examples/seal-mini/
  examples/token-studio-rewrite/     → examples/token-studio/
  examples/wallet-rewrite/           → examples/wallet/
  examples/walrus-mini-rewrite/      → examples/walrus-mini/

Deleted (v3 originals replaced by rewrite counterparts):
  packages/devstack/ (v3)
  examples/{_template,arena,deepbook-full,effect-app,fork-greeting,
            plugin-author-redis,private-content,token-studio,wallet}/

Consumers swept (63 example files + 16 doc files + 1 CI workflow +
5 create-devstack-app template files + 4 dev-wallet adapter files +
internal rewrite self-refs).

Lockfile regenerated.
```

---

## Risks / rollback

### Top 5 risks

1. **CLI gap is load-bearing for CI** (per `CUTOVER-PLAN.md` Risk 1). The rewrite's
   `tsdown.config.ts` builds `bin: devstack` to `dist/cli/main.mjs` but the verbs `apply`,
   `stack {list,new,use,drop,drop-fork}`, `wipe` are missing per `parity-matrix.md` CLI section.
   `.github/workflows/devstack-e2e.yml:80` invokes
   `node ../../packages/devstack/dist/cli/main.mjs apply` — cutover cannot ship until either (a) the
   rewrite implements `apply` + `snapshot save` + `snapshot restore`, or (b) the workflow is
   rewritten. **Mitigation**: gate PR7 on PR6 cli.missing-verbs slug closure.

2. **Vitest setup-file specifier divergence** (`src/build-integrations/vitest/config.ts:75`). This
   string is the runtime module specifier; a missed flip breaks every example's vitest setup
   silently. **Mitigation**: explicit greps in step 12 + run an example's `pnpm test` end-to-end
   before declaring green.

3. **Lockfile churn corrupts workspace** if `pnpm install` runs between intermediate states.
   **Mitigation**: do step 10 (`pnpm install`) only AFTER all renames + content edits land. Verify
   `pnpm install` exits clean before committing.

4. **`create-devstack-app/template/` regeneration miss**. If `sync-template.ts` fails or is skipped,
   the template still ships v3 shape and `pnpm create @mysten-incubation/devstack-app` produces
   broken apps. **Mitigation**: verify template e2e
   (`cd /tmp && pnpm create @mysten-incubation/devstack-app foo && cd foo && pnpm install && pnpm dev`)
   post-cutover, before PR merges.

5. **Stale `.devstack/` runtime artifacts on disk** for users mid-flight. Per `CUTOVER-PLAN.md` Risk
   4: existing snapshots / state.json captured against v3 won't restore into the rewrite.
   **Mitigation**: document in cutover release notes; the `.devstack/` directory is already
   gitignored so commit-side is clean.

### Rollback strategy

- **Step 1-2 (pre + notes migration) failure**: `git restore` is sufficient.
- **Step 3 (old-package delete) failure**: `git restore packages/devstack/` from `HEAD~1` if
  committed; else `git checkout HEAD -- packages/devstack/`.
- **Step 4 (rename) failure**: `git mv packages/devstack/ packages/devstack-rewrite/` to undo.
  Re-run grep sweeps to verify state.
- **Step 5-9 (consumer updates) partial**: keep editing; the cutover is "atomic per PR" — don't push
  until step 12 green.
- **Step 10 (lockfile) regeneration fails**: investigate before commit. `pnpm install` should never
  fail in isolation.
- **Step 12 (validate) fails on typecheck**: do NOT roll back; FIX FORWARD. Failures here are
  signals that the consumer sweep missed a file. Use `pnpm tsc -b` output to find the missed import.
- **Step 12 fails on docker e2e**: same — fix forward; docker failures are likely substrate-level,
  not rename-level.

### Full-revert (worst case)

```bash
# If the cutover commit is merged + needs reverting:
git revert <PR7-merge-sha>
# Restores v3 packages/devstack/ + originals + lockfile. Examples
# go back to *-rewrite naming. Rewrite users may break.
```

Avoid full-revert if at all possible — fix forward.

---

## Items NOT in PR7 (deferred)

Per `feedback_no_compat_for_never_cases` + `notes/orchestrator-guide.md` §3 (locked decisions):

- **Fork-mode CLI verbs**
  (`fork status / advance-clock / advance-checkpoint / replay-to / seed / cache`). Per locked
  decision #6, `fork-greeting-rewrite` is "illustrative; do NOT block cutover on it." Document
  `fork` subcommands as experimental in release notes. If cutover scope includes fork mode, port the
  6 subcommands as a follow-up PR.

- **Pyth as top-level plugin**. Per memory `project_pyth_inside_deepbook`, Pyth lives inside
  deepbook. Surfaced as ACCEPT_GAP in parity-matrix.

- **`Dev()` host-process plugin**. Per parity-matrix Composer/API row, replaced by vite preset
  auto-start. ACCEPT_GAP if vite story holds.

- **Example naming standardisation reconciliation**. If `@mysten-incubation/example-NAME` vs
  `@mysten-incubation/NAME` is debated, ship cutover with v3 names (`@mysten-incubation/arena`,
  etc.) and re-litigate later as a smaller PR.

- **`engine/`-flavored doc paths in `packages/docs/`** that don't actively break post-rename can be
  swept in a follow-up doc PR if they're cosmetic. Load-bearing snippet imports must flip in PR7.

- **Subpath-export reshape to old flat shape**. Per locked decision (CUTOVER-PLAN.md Step 4): keep
  nested shape; rewrite docs adapt. Don't re-litigate.

- **PHASE-3-NOTES.md fate**. Defer to post-cutover audit — keep if still useful as a type-system
  reference; delete with `feedback_completed_plans_should_be_deleted` if absorbed.

- **`integration-contract-redesign.md` migration**. Audit at step 2 — if absorbed into rewrite
  ARCHITECTURE.md, delete with the old package; if still referenced as a forward-looking doc, move.

- **Removing `engine/sui-fork-phase-5.md` reference in `dev-wallet-fork-panel.ts:9`**. Inline
  cleanup; can ship in PR7 OR a follow-up dev-wallet PR.

- **`examples/README.md` full rewrite**. The current file describes 6 v3 apps; the new set is 14. A
  from-scratch rewrite of the file is in scope BUT can ship as a follow-up doc PR if PR7 is large.

---

## Cutover gate sign-off (operator runs this checklist)

Final pre-merge checklist. Each box must be ticked by the operator running the cutover commit.

- [ ] All pre-conditions above are green (especially PR3 + PR6).
- [ ] `pnpm --filter @mysten-incubation/devstack typecheck` green post-rename.
- [ ] `pnpm --filter @mysten-incubation/devstack vitest run` green post-rename.
- [ ] `pnpm -r typecheck` green across the whole workspace.
- [ ] `pnpm turbo build --filter @mysten-incubation/devstack` green (produces `dist/cli/main.mjs`
      with `apply` / `snapshot save` / `snapshot restore` verbs).
- [ ] `grep -rln "@mysten-incubation/devstack-rewrite" --exclude-dir=node_modules --exclude-dir=.git --exclude=pnpm-lock.yaml .`
      returns empty.
- [ ] `grep -rln "packages/devstack-rewrite" --exclude-dir=node_modules --exclude-dir=.git .`
      returns empty.
- [ ] At least 1 docker-backed e2e booted end-to-end against `examples/arena/` (apply → snapshot
      save → snapshot restore → playwright).
- [ ] `create-devstack-app` template regenerated + smoke-tested:
      `cd /tmp && pnpm create @mysten-incubation/devstack-app foo && cd foo && pnpm install && pnpm dev`
      succeeds.
- [ ] Notes migration verified: `packages/devstack/notes/redesign/` +
      `packages/devstack/notes/v2-requirements/` present + content matches pre-cutover.
- [ ] `pnpm-lock.yaml` regenerated cleanly.
- [ ] `.oxlintrc.json` override decision made (keep / remove / re-scope).
- [ ] Root `AGENTS.md:133` cross-ref to `packages/devstack/AGENTS.md` either resolved (file moved)
      or removed.
- [ ] Commit message accurate (matches actual files touched).
- [ ] `.github/workflows/devstack-e2e.yml` matrix examples (`arena`, `private-content`,
      `deepbook-full`) have working playwright suites — confirmed locally per
      `feedback_use_local_docker`.
- [ ] Release notes draft mentions the breaking nature of the cutover + `.devstack/` snapshot
      incompatibility (per Risk 5).

When all boxes are ticked, push + open the PR. The PR title:

```
feat(devstack): PR7 cutover — rewrite → canonical
```
