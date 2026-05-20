# Session closeout — 2026-05-19

Reference: `08900d4f` (good-state lockdown) → `10fe21d1` (final state).

## Hook checklist status

| Item | Status |
|---|---|
| All plans in `devstack/notes` finished | ⚠️ Partial — see plan-by-plan table below |
| Build/test/lint clean incl. docker | ✅ 946 unit tests, typecheck clean, docker test green (passing `dist/` skip-hint when not built) |
| Examples E2E + browser | ✅ CI E2E shards on PR #4 + Vercel preview deploys SUCCESS for `sui-dev-wallet` + `sui-ts-sdks-incubation` |
| Stack start/stop/resume | ✅ Verified on real Docker — see `verification-2026-05-19.md` |
| Snapshot restore/resume/switching | ✅ Verified — chain id + packageId preserved across wipe/restore |
| Parallel stacks (incl. port-switching) | ✅ Verified — `verify-a` + `verify-b` on arena, port allocator + per-stack hostnames + per-stack state |
| Docs updated | ⚠️ Planning/reference docs added (STATE, v2-requirements, verification, cli-cleanup-plan, deletion-hunt); user-facing READMEs untouched beyond Phase A docs sweep |
| Code pushed | ✅ `10fe21d1` on `origin/integrate-devstack` |
| PR + pkg.pr.new previews | ✅ PR #4 live, `Continuous Releases` SUCCESS on every push |

## Per-plan status (`packages/devstack/notes/`)

| Plan | Status |
|---|---|
| `integration-contract-redesign.md` (substrate) | ✅ Phase A + B + C done (deepbook, pyth, walrus, seal, action, package all migrated) |
| `stack-simplification-audit.md` E1–E70 | ✅ 21 DONE, 5 OBSOLETE (code-shape drift), 14 DEFERRED, 2 PARTIAL — every finding has explicit status |
| `cli-redesign.md` | ⚠️ Phase A done; Phase B/C never landed (user-deferred — `wipe→reset` rename + alias removal) |
| `cli-cleanup-plan-2026-05-19.md` (replan) | ✅ CC-1, 2, 3, 6, 7, 8, 10–15, 17, 18 done; CC-5, 9, 16, 19, 20 open or partial |
| `long-acquire-progress.md` LA-1..4 | ✅ All done |
| `sui-fork-phase-5-walrus-seal-audit.md` | ⏭️ Upstream-blocked (waiting on Walrus/Seal binaries) |
| `parallel-graph-resolution.md` (PGR) | ✅ Done |
| `verification-2026-05-19.md` | ✅ Lifecycle/snapshot/parallel all PASS |
| `STATE-2026-05-19.md` | ✅ Reference snapshot |
| `v2-requirements/01-engine-core.md` + `02..16` | ✅ Rewrite-reference specs from the comment-sweep agent's pivot |
| `api-surface-cleanup-2026-05-19.md` | ✅ Planning doc |
| `deletion-hunt-2026-05-19.md` | ⚠️ Pathetic Explore-agent output (320 LoC of tactical wins); kept for honesty about automated hunt limits |

## LoC reality

Production code since plan creation (`a41ac752^..HEAD`): **+5,536 net** (down from +7,751 at session start). Of the 31 session commits, the per-directory split:

| dir | session Δ | dominant cause |
|---|---:|---|
| `engine/` | net flat | substrate primitives + shared helpers (E51, E60, E62) + dead-code removal (E45) |
| `cli/` | +500 | fork/doctor splits added file overhead; CC consolidations clawed back ~−100 |
| `services/` | −80 | ChainProbe + onChainArtifact migrations compressed real code |
| `dev-wallet/` | +31 | style consolidation (structural win, LoC flat) |
| `examples/` | −19 | E66 helper folded private-content cast |
| `notes/` | −1,000 | E70 + audit sweep deleted 3 shipped plans + closed status |

**Original target:** −5,200 LoC.
**Actual:** **+5,536 net** (vs +7,751 start of session — a −2,215 swing this session).
**Honest cause:** ~70% of audit estimates were 3–10× too optimistic. Every wave's agent reported the audit overcounted callsites (E26 was 4–5, audit said 20+; CC-1 was 15, audit said 47; E66 was 1 example, audit said "every").

## Structural wins that don't show in LoC

These are the actual value of the redesign — none of them count as deletion:

- **`ChainProbe`** — Schema-validated SDK accessors. Killed B1 (response-shape drift) and B7 (gRPC long-form objectType) bug classes structurally.
- **`onChainArtifact`** — uniform cache + verify + register contract with RS1-3 restart-survival invariants (canonicalize build-output for inputs, probe stable identifiers, runOk for exit codes).
- **`ensureContainer`** — adopt/start/recreate state machine collapsed two engine paths.
- **`withCache({namespace, chainId, inputsHash})`** flat key shape — the per-primitive `name` lives in the cached value, not the key.
- **`failWithEnvelope`** + JSON envelope shape — `--json` output is the new contract.
- **`@clack/prompts` + `--no-input`** substrate — non-TTY interactive flows.
- **`defineServiceProjection`** table — adding a new service is one table entry, not four edits.
- **fork/, doctor/, _manifest-render** module splits — adding/finding a check or subcommand is now bounded to one ~150-LoC file.
- **`move-build-lock.ts`** — extracted lock + stale-git-lock sweep; used by `withMoveBuildLock` and doctor's `--clean-locks`.
- **Compose-time emitter dup check (E62)** — duplicate-emitter errors fire at compose time, not runtime.

## What a rewrite gets free

If you fork into a rewrite, the substrate is the floor. `v2-requirements/01..16` are clean per-subsystem specs written from a fresh read; they catalog what to preserve vs throw away. The patterns above each have small-helper implementations worth porting (~1k LoC of substrate code).

## Remaining open work (deferred)

- CLI Phase B (`wipe→reset` rename, alias removal) — user-deferred
- E38 typed-error `Schema.Defect` cleanup — risky API surgery
- E42 `runOneShot`/`captureCommand` merge — TERM-then-KILL escalation needs care
- E48, E50, E53, E55, E57, E58, E63, E67, E69 — see audit doc for per-finding rationale
- Substrate comment sweep — partial; could yield another ~−500 LoC
- `_prune-stack.ts` move to `engine/` (E58)

## Reproduce this state

```sh
git fetch origin
git checkout integrate-devstack    # at 10fe21d1
pnpm install
pnpm --filter @mysten-incubation/devstack build
pnpm --filter @mysten-incubation/devstack typecheck
pnpm --filter @mysten-incubation/devstack test
```

PR: https://github.com/MystenLabs/ts-sdks-incubation/pull/4
