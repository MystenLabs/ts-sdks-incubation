# Devstack notes

The notes have been reduced to a compact current set. Historical plans and review snapshots were
migrated into `CURRENT-HANDOFF.md` and `UNRESOLVED-BLOCKERS.md`, then deleted.

## First-read set for a clean orchestrator

Read only these files before planning work:

1. `/Users/michaelhayes/code/ts-sdks-incubation/AGENTS.md`
2. `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/README.md`
3. `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/notes/README.md`
4. `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/notes/CURRENT-HANDOFF.md`
5. `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/notes/UNRESOLVED-BLOCKERS.md`
6. `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/STYLE_GUIDE.md`
7. `/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/ARCHITECTURE.md`

After reading, first derive the design principles and core architecture. Only then plan subagent
fanout, phase order, and acceptance evidence.

## Current sources of truth

- `CURRENT-HANDOFF.md` - current state, design-first orchestration guidance, compact live checks,
  checkpoint plan, and a clean-session prompt.
- `UNRESOLVED-BLOCKERS.md` - live blocker ledger. Do not remove an item unless it is fixed,
  verified, and the verification evidence is recorded.
- `../STYLE_GUIDE.md` and `../ARCHITECTURE.md` - implementation rules and layer boundaries.

## Reference-only notes

These are not first-read documents. Open one only when the current blocker or implementation task
specifically needs it:

- `api-surface-design.md` - design rationale for API ergonomics and plugin-author symmetry.
- `phase-f-manual-scenarios.md` - manual scenario runbook after P0 blockers are closed.
- `pr7-cutover-plan.md` - historical package cutover reference; use the blocker ledger for current
  remaining release work.

## Deleted historical notes

Do not look for or recreate deleted review/planning files. Their unresolved live facts were migrated
into the current handoff and blocker ledger. Deleted files include `PHASE-3-NOTES.md`,
`api-comparison.md`, `critical-assessment.md`, `opportunities-backlog.md`, `orchestrator-guide.md`,
`orphan-delete-inventory.md`, `parity-matrix.md`, `phase-f-e2e-plan.md`, `phase-f-infra.md`,
`substrate-fix-plan.md`, `pr2-verification.md`, and `reviews/*.md`.

If `STYLE_GUIDE.md` or `ARCHITECTURE.md` cites a deleted historical file, treat that citation as
provenance only, not required reading.

## Cleanup rule

Do not add another parallel plan. New findings either land in `UNRESOLVED-BLOCKERS.md`, close with
evidence, or become a short focused note only when they are too detailed for the ledger.
