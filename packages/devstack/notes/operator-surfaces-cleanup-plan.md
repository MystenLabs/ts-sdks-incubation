# Operator surfaces cleanup plan

Last updated: 2026-05-22.

## 1. Context and goals

This plan covers the human/operator-facing surfaces:

- `packages/devstack/src/surfaces/cli`
- `packages/devstack/src/surfaces/tui`
- projection/read-model files that feed status output and renderers
- docs under `packages/docs/content/devstack/reference/cli.mdx`, `internals/lifecycle.mdx`, and
  `features/state-and-snapshots.mdx`.

The goal is to make CLI, TUI, and plain renderer behavior derive from stable projection contracts
without leaking stale engine vocabulary or hardcoding plugin internals in the surfaces.

Release proof for TUI/manual lifecycle is tracked in `UNRESOLVED-BLOCKERS.md`. This plan is for
remaining API/architecture cleanup of the surfaces themselves.

## Current status

Completed on 2026-05-22:

- TUI row grouping now uses a renderer-owned classifier table keyed by stable row-key prefixes in
  `surfaces/tui/display-derivation.ts`, rather than keyword substring buckets such as `wallet`,
  `faucet`, `vite`, or `server`.
- `test/surfaces/tui/display-derivation.test.ts` pins the expected section for each built-in plugin
  family: Sui, wallet, Walrus, Seal, DeepBook, Postgres, faucet, host-service, package, account,
  action, coin, and app rows.
- `test/surfaces/cli/docs-drift.test.ts` now treats `COMMAND_TREE` as the CLI docs source of truth
  by requiring every public command, nested command, lifecycle, side-effect class, Docker
  requirement, argument, and option to appear in `packages/docs/content/devstack/reference/cli.mdx`.
- The CLI reference now includes a command index matching `COMMAND_TREE`.

Current verification:

- `pnpm --filter @mysten-incubation/devstack exec vitest run test/surfaces/tui/display-derivation.test.ts test/surfaces/cli/docs-drift.test.ts`
  passed.
- `pnpm --filter @mysten-incubation/devstack exec vitest run test/surfaces/tui/display-derivation.test.ts test/surfaces/tui/dashboard.test.tsx test/surfaces/tui/plain-renderer.test.ts test/surfaces/tui/no-display-vocab.test.ts test/cli/main.test.ts test/cli/flags.test.ts test/surfaces/cli/dispatch.test.ts test/surfaces/cli/envelope.test.ts test/surfaces/cli/docs-drift.test.ts test/substrate/runtime/projection/persisted.test.ts test/substrate/runtime/projection/update.test.ts`
  passed (11 files / 104 tests).
- Review feedback on `docs-drift.test.ts` was resolved by tightening section boundaries to the next
  H2/H3 and comparing exact parsed `Arguments:`/`Options:` lists. Focused rerun passed:
  `pnpm --filter @mysten-incubation/devstack exec vitest run test/surfaces/cli/docs-drift.test.ts test/surfaces/tui/display-derivation.test.ts test/plugins/action/discriminator.test.ts`
  (3 files / 37 tests).
- `pnpm --filter @mysten-incubation/devstack typecheck` passed again after the parallel boundary
  lane settled.
- `pnpm --filter @mysten-incubation/docs build` passed.
- `pnpm --filter @mysten-incubation/devstack build` passed.

Remaining P1 cleanup:

- `status` still needs an explicit product decision: curated operator summary vs generic projection
  dump. Current behavior is not newly regressed by this cleanup.
- Plain renderer and TUI still use different streaming models. Existing tests cover shared account,
  package, endpoint, lifecycle, and error facts, but there is no single cross-renderer golden test.
- Projection persistence stayed at the current serialized shape; no version bump was needed for the
  renderer-only classifier change.

## 2. Audit findings

### Status output exposes partial plugin-specific state

Current shape:

- `devstack status` emits rows, endpoints, accounts, and packages.
- Account/package state is useful, but other plugin state such as Walrus/Seal/DeepBook/Postgres is
  only visible through rows/endpoints/codegen.

Target shape:

- Decide whether `status` is a generic projection dump or a curated operator summary.
- If curated, add explicit sections for service state that are already in projection/codegen.
- If generic, keep account/package detail but document why only these plugin-specific projections
  exist.

### Plain renderer is event-shaped, TUI is projection-shaped

Current shape:

- Plain renderer writes one line per `EngineEvent`.
- TUI derives display from `SubscribableState`.
- Both contain formatting rules for accounts/packages/endpoints but through different data paths.

Target shape:

- Keep the different streaming models if they are intentional.
- Share pure formatting helpers for common account/package/endpoint summaries where possible.
- Add tests that prove the same event/projection facts render equivalent operator information.

### Projection versioning needs a cleanup checkpoint after row shape changes

Current shape:

- Persisted projection uses `projection.v3.json`.
- Recent cleanup removed display fields and changed strategy/projection events.
- Status tolerates malformed/missing state, but old snapshots may persist in local worktrees.

Target shape:

- Bump projection persistence only when the serialized shape changes.
- Document the current projection version and the expected missing/malformed behavior.
- Add a residue scan for deleted display fields in projection persistence tests.

## 3. Specific public API changes

- Do not expose renderer-specific display fields on projection rows.
- If a row category/classification field is added, name it as lifecycle/operator metadata, not
  `title`, `primary`, `extras`, or another display-only term.
- Keep `runStack(...).state` returning the projection shape until a separate programmable API plan
  replaces it.

## 4. Internal implementation changes

- Share pure formatting helpers between plain renderer and TUI where it removes duplication without
  coupling the renderers.
- Audit projection persistence after any row/category changes and bump version only if serialized
  shape changes.

## 5. Built-in plugin/component migration steps

1. Decide whether `status` is a curated operator summary or a generic projection dump.
2. Add cross-renderer tests for shared account, package, endpoint, lifecycle, and error facts.
3. Audit projection persistence after any row/category changes and bump the version only if the
   serialized shape changes.
4. Re-run status/plain/TUI tests and the manual release proof listed in `UNRESOLVED-BLOCKERS.md`.

## 6. Docs, examples, and test updates

Docs to update:

- `packages/docs/content/devstack/reference/cli.mdx`
- `packages/docs/content/devstack/internals/lifecycle.mdx`
- `packages/docs/content/devstack/features/state-and-snapshots.mdx`
- `packages/devstack/ARCHITECTURE.md` if projection/category shape changes.

Tests to update:

- `test/surfaces/tui/display-derivation.test.ts`
- `test/surfaces/tui/dashboard.test.tsx`
- `test/surfaces/tui/plain-renderer.test.ts`
- `test/surfaces/tui/no-display-vocab.test.ts`
- `test/cli/main.test.ts`
- `test/cli/flags.test.ts`
- `test/surfaces/cli/dispatch.test.ts`
- `test/surfaces/cli/envelope.test.ts`
- `test/substrate/runtime/projection/persisted.test.ts`
- `test/substrate/runtime/projection/update.test.ts`

## 7. Verification commands

```bash
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack exec vitest run \
	test/surfaces/tui/display-derivation.test.ts \
	test/surfaces/tui/dashboard.test.tsx \
	test/surfaces/tui/plain-renderer.test.ts \
	test/surfaces/tui/no-display-vocab.test.ts \
	test/cli/main.test.ts \
	test/cli/flags.test.ts \
	test/surfaces/cli/dispatch.test.ts \
	test/surfaces/cli/envelope.test.ts \
	test/substrate/runtime/projection/persisted.test.ts \
	test/substrate/runtime/projection/update.test.ts
pnpm --filter @mysten-incubation/devstack build
```

Residue scans:

```bash
rg -n "title|primary|extras|displayHint" packages/devstack/src/substrate packages/devstack/src/surfaces packages/devstack/test
rg -n "package|account|wallet|faucet|vite|server" packages/devstack/src/surfaces/tui/display-derivation.ts
rg -n "devstack (up|apply|status|doctor|config|schema|snapshot|prune|wipe)" packages/docs/content/devstack/reference/cli.mdx
```

## 8. Acceptance criteria

- Plain renderer and TUI show equivalent key facts for lifecycle, endpoint, account, and package
  events.
- Projection persistence behavior is documented and versioned correctly.
- Focused CLI/TUI/projection tests and build pass.

## 9. Explicit out-of-scope items

- Historical live TUI/manual lifecycle proof logs.
- Changing terminal UI design beyond data classification and drift-proofing.
- Adding a new programmable API distinct from `runStack(...).state`.
