# v2-requirements doc template

This file is the shared template every requirements doc follows. Do not modify it — your assignment will reference it. Read this, then write your doc to the assigned target path.

## What you are doing

You are producing ONE requirements document for ONE component of the existing `packages/devstack` codebase. You document what the code DOES and DEPENDS ON today. You do NOT design the new architecture, NOT write code, NOT recommend rewrites. The output of all 24 docs together is the input to the architecture-design phase that follows.

## Hard rules (mandatory)

1. **READ-ONLY for source code.** Use Read, Grep, Bash (ls/find/wc/grep only), Glob. NEVER edit any file other than your single target doc.
2. **NEVER `git stash` / `git checkout` / `git reset` / `git restore` / `git clean`.** NEVER amend commits. Multiple sibling agents are running in the same working tree; destructive git operations will corrupt their work.
3. **NEVER run validators.** No `pnpm typecheck`, no `pnpm test`, no `pnpm build`, no `pnpm lint`, no `tsc`, no `vitest`, no `eslint`. Sibling agents are writing other docs concurrently — your validation would observe their WIP and trigger destructive cycles.
4. **Don't `cd`.** Use absolute paths.
5. **One Write call.** Write the doc as a SINGLE Write call to the target path after all reading is done.
6. **Cite file:line.** Every non-obvious claim should reference the file:line that backs it.
7. **Open questions are explicit.** Where you don't know, write `OPEN QUESTION: <q>`. Never guess and never silently omit.
8. **Define terms.** Reader has zero project context. Project-specific terms must be defined the first time they appear.

## Required document structure (headings VERBATIM, in this order)

```
# <component-name>

## Purpose
One paragraph: what this is and why it exists.

## Current implementation
File-by-file list of every IN-SCOPE source file with LOC count and one-line summary. Group by sub-component if applicable. Totals: src LOC, test LOC.

## Configuration
Every knob a caller can set affecting this component: defineDevstack config keys, CLI flags, env vars. Defaults + accepted values. Cite file:line where each is read.

## Capabilities CONSUMED
EXHAUSTIVE list. Include EVERY category that applies:
- Other services / components (by capability not name where possible)
- Engine resources (ports, leases, locks, state-store, identity, paths, file-watcher, cache)
- Runtime resources (container runtime, host process, fs)
- Surfaces (TUI updates, log sink, event bus, command queue)
- External (HTTP, RPC endpoints, system binaries, ports, sockets)
- Effect/Layer/Context machinery
- Imports from other workspace packages
- npm dependencies
Cite file:line for every dependency.

## Capabilities PRODUCED
What this exposes to others:
- Endpoints (URL/host/port shapes)
- State-store entries (key shape + value shape)
- Events emitted (name + payload)
- Files written (path + content type)
- CLI commands registered
- Routes registered
- TypeScript exports consumed elsewhere
- Container images / volumes produced

## Lifecycle
- Startup: ordered sequence of steps, what blocks what, what runs in parallel
- Ready criteria: how does anyone know this is ready?
- Restart behavior: what's idempotent vs needs cleanup
- Teardown: ordered shutdown sequence, grace windows, what survives

## Hard requirements / invariants
Load-bearing constraints — especially those that broke things historically. Each cited to file:line or a test that asserts it. The "this MUST happen or X fails" list.

## Failure modes
For each thing that can fail: trigger, current behavior, recovery path.

## Persistence model
- What survives restart (state-store entries, on-disk paths)
- What survives snapshot (subset of persisted)
- What gets wiped on `devstack wipe`
- What is process-local only

## Modes & variants
If the component has >1 mode (e.g. local/live/fork; single/cluster; streaming/batch), this section MUST be a table with one column per mode and one row per lifecycle dimension (container, startup sequence, ready criteria, persistence, teardown, failure modes, dependencies, hard requirements). Filling in "same" cells is acceptable; merged "all modes" prose is NOT — every row × column cell must be addressed explicitly. If single-mode, brief paragraph.

## Test coverage
For each test file in scope: list every `describe` / `it` block (or near-equivalent) and what it asserts in 1-2 lines. This is the encoded spec — agents reading these docs later use this section to know which existing tests cover which requirements.

## Pain points today
Where current implementation is awkward, leaky, or fights the architecture. Cite specific files/lines.

## Open questions
Things unresolvable from code or tests. Be explicit — don't guess and don't omit.

## Opportunities noticed
Adjacent cleanup/dedup/wrong-abstraction observations from your reading. **Mandatory section.**
```

## Style notes

- Be EXHAUSTIVE. Better to over-document than miss a requirement.
- Cite file:line for every non-obvious claim.
- Expected length: 1500-3000 lines for non-trivial components; shorter for small ones.
- The doc is read by humans before being used as input to architecture design.
- If you find that a file you were told to scope is actually owned by another component, note it in `Open questions` and `Opportunities noticed` — but still document what's there.

## At the end

Return a brief 5-line summary of what you found — totals, biggest finding, top open question, top opportunity. Do NOT include the doc body in your summary.
