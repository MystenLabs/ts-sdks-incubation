# CLI cleanup plan — 2026-05-19

`packages/devstack/src/cli/` — 4,985 LoC of source (8,696 incl. tests) — Phase A
of `cli-redesign.md` shipped additive substrate (`envelope.ts`, `exit-codes.ts`,
`cli-prompt.ts`, `schema-emit.ts`, `already-reported.ts`, `loaders.ts`,
`stack-resolution.ts`) but left every pre-Phase-A pattern in place alongside
it. The result is a CLI that bills as "minimal Effect-CLI surface" yet runs
~5K lines of hand-written boilerplate. This plan identifies ~1,400 LoC of
deletions that preserve every advertised capability.

## Where the +2,109 LoC actually went

**Subcommand sprawl.** `fork.ts` (1,048 LoC) is 11 subcommands, each running a
6-line `startedAt/useJson/fs/path/resolveStack/resolveForkRuntimeCtx` preamble,
a 7-line `Effect.tryPromise → .pipe(Effect.catch(...failAlreadyReported))`
wrapper around every gRPC call, and a 15-25 line `if (useJson) emitEnvelope(...)
else { Console.log(...); Console.log(...); ...}` dual-renderer block. That
pattern repeats verbatim in `snapshot.ts` (4 subcommands), `doctor.ts`, and
`stack.ts`. Per subcommand the human/JSON split alone is ~30 LoC of dead
weight.

**The envelope substrate sits ALONGSIDE the old shape, not on top of it.** The
plan promised that `envelope.ts` + `exit-codes.ts` would replace ad-hoc error
construction. Instead, every "error" path now constructs an envelope by hand
(`errorEnvelope({ command, error: { code, exitCode, message, ... } })` — 6-12
lines per use), prints it under `useJson`, then ALSO calls
`failAlreadyReported(envelope.error!.message)` to fail the Effect. There are
**47 `failAlreadyReported` callsites** in CLI source, **17 `errorEnvelope`
calls**, and **42 `successEnvelope` calls**. Each envelope build is verbose
because the helpers force the caller to repeat `command:` / `elapsedMs:` /
`exitCode:` for every error rather than carrying them in scope.

**Engine-level concerns leaked into `cli/commands/`.** `_prune-stack.ts` (438
LoC) is a docker-orchestration module living under `cli/`; `_prune-ui.tsx` (303
LoC) is a real Ink component; `fork.ts:780-1015` is a 235-LoC sui-fork-cache
inventory pipeline. The "interactive prune Ink picker" is a defensible CLI
concern, but the cache walker and the docker label-filter pipeline aren't.

**Duplication that survived consolidation.** `collectReferencedChainIds` /
`safeStatSize` exist in `fork.ts`; the same `nodeFs.readdir('sui-fork-cache')`
walk re-appears in `prune.ts:332-389` (62 LoC); `safeDirSize` re-exists in
`snapshot.ts:170-185`; `safeDataDirSize` re-exists in `doctor.ts:389-404`.
Four implementations of "recursively sum a directory."

**Phase A's promise of "additive then collapse" never collapsed.** `cli/main.ts`
still maps every non-zero `Cause` to `exit(1)` (line 43) — it has zero
awareness of the `exitCode` field in the envelope. `EX_GENERIC`, `EX_NOINPUT`,
`EX_CANTCREAT`, `EX_TEMPFAIL`, `EX_CONFIG`, `EX_SUPERVISOR_LIVE` are exported
from `exit-codes.ts` but **never referenced** anywhere in `cli/`. The whole
exit-code-by-symbol promise is a fiction: a CI script that reads exit codes
sees `1` for everything except `EX_OK`.

## Per-file walk

### `cli/commands/fork.ts` (1,048 LoC)
- Largest functions: `seedDiffCommand` action (~135 LoC, lines 632-767),
  `cachePruneCommand` action (~75 LoC, 934-1005), `statusCommand` action (~75
  LoC, 146-219).
- 11 subcommands. Each one runs:
  ```
  const startedAt = Date.now();
  const useJson = jsonModeEnabled(json);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = yield* resolveStack(fs, path, stack);
  const ctx = yield* resolveForkRuntimeCtx(resolved);
  const client = makeForkClient(ctx);
  ```
  = 7 LoC × 6 admin subcommands (status, advance-clock, advance-checkpoint,
  replay-to, seed-list, seed-diff) = 42 LoC of literal copy-paste.
- 5 separate `Effect.tryPromise(...).pipe(Effect.catch((cause) =>
  Effect.gen(function* () { yield* failAlreadyReported(cause.message); return
  undefined as never; })))` blocks — 8 LoC each = **40 LoC** that should be one
  `wrapForkRpc(label, fn)` helper.
- `collectReferencedChainIds` (lines 838-865) + `collectCacheEntries`
  (807-831) + `safeStatSize` (790-805) — 75 LoC of cache-walk plumbing that
  duplicates the same walk in `prune.ts:332-389`.
- Bloat I'd cut: −250 to −350 LoC.
- After-cleanup estimate: ~700-800 LoC.

### `cli/commands/doctor.ts` (897 LoC)
- Largest functions: `doctorCommand` action (~230 LoC, 666-894),
  `findStaleLocks` (504-549), `listStaleMoveGitLocks` (598-638).
- 7 `checkX(...): Effect.Effect<Check>` functions with identical shape:
  shell-out → `Effect.catch` → return `{ name, ok, required, detail }`. Each
  is 15-30 LoC. A `Check` interface + a `runCheck(name, required, probe,
  detail)` helper collapses them to ~8 LoC each = **−80 to −100 LoC**.
- `discoverForkStacks` (201-225) duplicates the same `stacks/<stack>/sui-fork/`
  walk used by `fork.ts:838-865` and `prune.ts:336-355`.
- The dual JSON/human rendering at 785-893 is 110 LoC; the JSON branch builds
  a sub-object that is essentially `{ checks: all.map(c => c), inventory:
  rows.map(...) }` — building the same data twice with slight reshaping.
- Bloat I'd cut: −200 to −280 LoC.
- After-cleanup estimate: ~620-700 LoC.

### `cli/commands/snapshot.ts` (679 LoC)
- Largest functions: `saveCommand` action (~150 LoC, 223-339),
  `deleteCommand` action (~115 LoC, 559-672), `restoreCommand` action (~140
  LoC, 360-485).
- The error-envelope-then-fail pattern repeats 7 times in this file
  (lines 369-415, 567-637) — each instance is a 12-15 LoC block that
  builds an envelope, conditionally emits it, then calls
  `failAlreadyReported(envelope.error!.message)`.
- `safeDirSize` (170-185) duplicates `safeDataDirSize` in doctor.ts and
  `safeStatSize` in fork.ts.
- `findMatch` (71-93) is a useful util but lives mid-file; it's the
  duplicate-named local that snapshot/delete/restore each reach for.
- Bloat I'd cut: −150 to −200 LoC.
- After-cleanup estimate: ~480-530 LoC.

### `cli/commands/prune.ts` (633 LoC)
- Largest functions: `pruneCommand` action (~140 LoC, 491-628),
  `maybePruneForkCache` (327-389), `runBulkMode` (292-319).
- `maybePruneForkCache` (62 LoC) is a verbatim duplicate of
  `fork.ts`'s `collectReferencedChainIds + collectCacheEntries +
  cachePruneCommand` cache-walk except wrapped in `Effect.promise`
  closures.
- The flag definitions (lines 60-134) span **75 LoC across 14 flags**, many
  with single-purpose flag descriptions that could move to a shared
  `commonFlags.ts` (already half-done with `flags.ts`).
- `BulkModeArgs` (278-286) is duplicated structurally with `pruneCommand`'s
  args object — same five booleans.
- Bloat I'd cut: −120 to −180 LoC.
- After-cleanup estimate: ~450-510 LoC.

### `cli/commands/_prune-stack.ts` (438 LoC)
- Largest functions: `pruneStack` (367-438), `removeLabelledImagesNotInUse`
  (248-297), `ensureNoLiveHolder` (47-69).
- 4 near-identical `killDevstackContainers` / `removeDevstackNetworks` /
  `removeDevstackVolumes` / `removeDevstackImages` blocks (148 LoC total,
  lines 117-235). Each is "docker ps/network ls/volume ls/images with the
  same label filter, then iterate-and-rm." A single
  `removeByLabel(spawner, kind: 'container' | 'network' | 'volume' | 'image',
  app, stack)` would collapse those to ~30 LoC.
- This file is a docker-orchestration module that lives under
  `cli/commands/` because of `removeStateOnDisk`'s CLI-state-dir dependency.
  But `removeStateOnDisk` is only 40 LoC and could move to `engine/`
  with `resolveStateDir` as a parameter. (Out of scope per your
  instructions — flag only.)
- `ensureNoLiveHolder` + `readJsonOpt` + `PruneStackBlockedError` (37-69) =
  33 LoC of "lock check" that overlaps `doctor.ts:findStaleLocks` /
  `readLockBody`. Same `state.json.lock` format read in two places.
- Bloat I'd cut: −100 to −140 LoC.
- After-cleanup estimate: ~300-340 LoC.

### `cli/commands/_prune-ui.tsx` (303 LoC)
- One React component + one row sub-component + a router row. Mostly tight.
- Comment lines 1-26 are a 26-line block describing keyboard contract and
  visual model. Genuine context for the next person opening the file —
  **KEEP**.
- The "test-only" `selectableKeys` helper (300-301) and the
  `export { renderTotals }` re-export (303) are dead weight — neither is
  imported outside this file's test. Tests can import from `inventory.ts`
  directly.
- Bloat I'd cut: −10 LoC. This file is the closest thing to "correctly
  sized" in the directory.
- After-cleanup estimate: ~290 LoC.

### `cli/commands/graph.ts` (283 LoC)
- Three render functions (`renderText`/`renderMermaid`/`renderDot`) — each is
  20-30 LoC and serves real format options. Tight.
- `requireConfig` (48-62) replicates the `requireLayer` shape from
  `loaders.ts:80-95` — third copy of "validate the module's default export."
  loaders.ts has `requireLaunchEffect` + `requireLayer`; `graph.ts` adds
  `requireConfig` (just `.config.stack`). The right move is to lift
  `requireConfig` to `loaders.ts` next to its siblings — no LoC delta but
  it's a smell.
- The `Flag.string('format')` + manual validation at 144-149 + 228-232 has
  a literal comment claiming "Effect-CLI doesn't ship a `Flag.choice`
  helper here" — but `flags.ts:11,23` proves `Flag.choice` works fine. This
  is a stale comment + 5 LoC of unnecessary validation. **Migrate to
  `Flag.choice('format', ['text', 'mermaid', 'dot'] as const)` — saves ~8 LoC.**
- Bloat I'd cut: −15 LoC.
- After-cleanup estimate: ~270 LoC.

### `cli/commands/stack.ts` (271 LoC)
- 5 subcommands (`list`/`new`/`use`/`down`/`drop`), 1 helper
  (`takeDownContainers`).
- The `dropCommand` (201-228) duplicates a label-filter `docker rm` pass that
  `_prune-stack.ts` already exports — except `dropCommand` only clears the
  state dir, not docker. The split is subtle but the
  `_prune-stack.pruneStack({ ..., noStop: true })` path would do it. ~15 LoC
  savings if `dropCommand` delegates.
- `takeDownContainers` (243-266) is yet another `docker ps -aq --filter
  label=devstack.stack=<s>` + iterate-and-act loop. 5th instance after the
  four in `_prune-stack.ts`. Should fold into the same `removeByLabel`
  utility.
- Bloat I'd cut: −30 LoC.
- After-cleanup estimate: ~240 LoC.

### `cli/commands/status.ts` (245 LoC)
- Significant overlap with `manifest.ts`: the entire "render endpoints /
  packages / accounts" block (status.ts:205-244, ~40 LoC) is **the same
  code** as `manifest.ts:65-120` (~55 LoC). Verbatim duplication.
- `chainBlock` building (113-132) is the only real new behavior — pulls
  fork meta in addition to manifest.
- Bloat I'd cut: −40 LoC by extracting `renderManifestSummary(m,
  printedEps)` and calling it from both.

### `cli/commands/apply.ts` (222 LoC)
- `findSeedManifestMismatch` (29-44) — 16-line cause-walk that's load-bearing.
- `renderSeedMismatchRecipe` (46-70) — 25 LoC of nicely formatted recipe.
  Real product surface.
- The `reportAndRethrow` closure (146-203) is 58 LoC and contains BOTH the
  JSON envelope build AND the human-error render AND the seed-mismatch
  special case. It's tight enough for its responsibility — not bloat.
- `Effect.gen(function* () { yield* Layer.build(devstack.layer); }).pipe(
  Effect.scoped)` (136-138) — would benefit from being `Layer.build(
  devstack.layer).pipe(Effect.scoped)` directly. ~2 LoC.
- Bloat I'd cut: minimal. ~5 LoC.

### `cli/commands/manifest.ts` (138 LoC)
- `eps` building at line 56-57 — `const eps = Object.entries(m.services)
  .flatMap(([_svc, _block]) => [] as never[]); void eps; // structured
  rendering below` — **literal dead code with a "void" silencer**. Delete.
- The whole "human rendering" branch (53-130, ~78 LoC) duplicates the same
  shape in `status.ts:205-244`. If status is the source of truth,
  `manifest.ts` is a 10-line wrapper that delegates to it (passing
  `printRawManifest: true` for `--json`).
- Bloat I'd cut: −80 LoC if folded into shared renderer.

### `cli/loaders.ts` (185 LoC)
- Comments lines 1-29 — 29-line preamble. Half of it ("Before this
  consolidation, each subcommand reimplemented its own…") is a history
  lesson with no actionable value. Trim to 8 lines.
- `requireLaunchEffect` and `requireLayer` differ only in the validated
  field name. Could collapse to one
  `requireDefaultExport(configPath, mod, field)` — ~12 LoC saved.
- `findConfigUp` and `resolveConfigPath` are tight.
- Bloat I'd cut: −25 LoC.

### `cli/cli-prompt.ts` (182 LoC)
- `promptConfirm` and `promptTypeToConfirm` differ only in the
  clack call (`clack.confirm` vs `clack.text` + validate). The shared
  preamble (yes-bypass / noInput / TTY / clack-missing checks) is 22 LoC
  duplicated verbatim. Extract a `requireInteractiveClack(yes, noInput):
  PromptOutcome | undefined` predicate — saves ~25 LoC.
- `__setClackForTest` + `clackOverride` — test-only hook lives in production
  code. Defensible (no easier alternative under dynamic imports), but it's
  9 LoC of test plumbing in prod. Leave as-is.
- Bloat I'd cut: −20 LoC.

### `cli/schema-emit.ts` (164 LoC)
- The `SchemaEnvelope` interface (lines 41-60) hardcodes the envelope shape
  as string-typed fields (`ok: 'boolean'`, etc.) which then **only get
  consumed by `buildSchema`'s own return** (97-115) — the same shape
  appears twice. The whole interface is documentation-shaped duplication.
  Either inline (delete `SchemaEnvelope` and just emit the literal in
  `buildSchema`) or commit to actually deriving from `Schema` types.
- `globalEnv` (122-153) — hand-maintained list of env vars with prose
  descriptions. Real surface, but the format duplicates what's in
  the `stack-resolution.ts` JSDoc on `STATE_DIR_ENV` / `STACK_NAME_ENV` etc.
  Out of scope to fix but flag the smell.
- Bloat I'd cut: −20 LoC.
- USED: yes — `index.ts:91` and 5 test assertions. Don't delete the file.

### `cli/index.ts` (144 LoC)
- `upCommand` definition (43-66) is the only command that lives here
  (others live under `commands/`). Fine — `up` is the primary verb.
- The `Effect.tapCause` block (130-143) checks `causeHasAlreadyReported` and
  no-ops if true. Defensible. ~14 LoC.
- Bloat: ~5 LoC of comments that could be tighter.

### `cli/main.ts` (45 LoC)
- See "Phase A's broken promises" — this file's `teardown` collapses
  every non-success/non-interrupt to `exit(1)`. The whole `exit-codes.ts`
  module exists to populate `error.exitCode` in envelopes, but nothing
  consumes the field at exit time. **This is the single biggest broken
  promise.**

### `cli/envelope.ts` (125 LoC)
- `emitSuccess` (99-106) — defined and exported but **zero callsites**
  in the entire repo. 8 LoC of dead infra.
- Otherwise tight.

### `cli/exit-codes.ts` (150 LoC)
- 13 exit codes defined. **Only 7 are referenced** anywhere in CLI source
  (`EX_USAGE`, `EX_DATAERR`, `EX_UNAVAILABLE`, `EX_SNAPSHOT_NOT_FOUND`,
  `EX_SEED_MISMATCH`, `EX_CONFIRM_REQUIRED`, `EX_OK`). The other 6
  (`EX_GENERIC`, `EX_NOINPUT`, `EX_CANTCREAT`, `EX_TEMPFAIL`, `EX_CONFIG`,
  `EX_SUPERVISOR_LIVE`) appear ONLY in `exit-codes.ts` itself (definition,
  name lookup, description lookup, `ALL_EXIT_CODES` array).
- Either wire them up at points where they're meaningful (the
  prune-blocked path returns no exit code today — should be
  `EX_SUPERVISOR_LIVE`; transient docker errors should be `EX_TEMPFAIL`;
  etc.) OR delete them as YAGNI. **Decision: delete the unused ones.**
- Bloat I'd cut: ~30 LoC (definitions + name + description + array entries
  for 6 codes).

### `cli/stack-resolution.ts` (121 LoC)
- Tight. Every export is used. Keep as-is.

### `cli/flags.ts` (45 LoC)
- 2 flags + `applyNetworkOverride`. Tight.

### `cli/already-reported.ts` (47 LoC)
- Tight. Used 47 times. Keep.

---

## Cleanup targets (ordered by leverage)

### CC-1. Collapse `errorEnvelope({ … }) → if(useJson) emit → failAlreadyReported(env.error!.message)` into one helper
- Files: `snapshot.ts`, `wipe.ts`, `fork.ts`, `prune.ts`, `apply.ts`, `doctor.ts`.
- LoC delta: **−180 high-confidence**.
- What it preserves: every envelope shape, every exit code, every error message.
- Steps:
  1. Add `cli/envelope.ts`:
     ```
     export const failWithEnvelope = (input: {
         command: string;
         error: EnvelopeError;
         elapsedMs: number;
         json: boolean;
         dryRun?: boolean;
     }): Effect.Effect<never, AlreadyReportedError>
     ```
     Builds the envelope, conditionally emits it under `json`, then calls
     `failAlreadyReported(input.error.message)`. The 12-line block at every
     callsite collapses to 6.
  2. Replace 17 `errorEnvelope({...}); if(useJson) yield* emitEnvelope(env);
     return yield* failAlreadyReported(env.error!.message);` blocks.
- Risk: low — pure refactor, no behavior change.

### CC-2. Extract `wrapForkRpc(label, fn)` for `Effect.tryPromise(rpc).pipe(Effect.catch(failAlreadyReported))`
- Files: `fork.ts` (5 callsites + the cluster around `replay-to`'s loop).
- LoC delta: **−45**.
- Preserves: every error message, every `failAlreadyReported` exit semantics.
- Steps:
  1. Add to `fork.ts` top (or a new `cli/commands/_fork-shared.ts`):
     ```
     const wrapForkRpc = <T>(label: string, fn: () => Promise<T>) =>
         Effect.tryPromise({
             try: fn,
             catch: (cause) => new Error(`${label} — ${String(cause)}`),
         }).pipe(
             Effect.catch((cause) => failAlreadyReported(cause.message) as Effect.Effect<never>),
         );
     ```
  2. Replace 5 `Effect.tryPromise(...).pipe(Effect.catch(...))` blocks at
     lines 155, 280, 371, 440, 478.
- Risk: low.

### CC-3. Fold `manifest.ts` into `status.ts` as the JSON-shaped surface
- Files: `manifest.ts` (138 LoC), `status.ts` (245 LoC).
- LoC delta: **−90 to −110** (delete `manifest.ts:53-130`'s duplicate render +
  `manifest.ts:56-57`'s `void eps;` dead code; keep ~30 LoC `manifest.ts` as a
  thin wrapper that calls a shared `renderManifestSummary` from
  `status.ts`).
- Preserves: `devstack manifest`, `devstack manifest --json`,
  `devstack manifest <path>`, walk-up discovery.
- Steps:
  1. Extract `renderManifestSummary(manifest, printedEps): ReadonlyArray<string>`
     to a shared spot (either `status.ts` or `cli/commands/_manifest-render.ts`).
  2. Rewrite `manifest.ts` to call it.
  3. Delete `eps` dead code at `manifest.ts:56-57`.
- Risk: low — both commands output the same shape today.

### CC-4. Delete unused exit codes
- Files: `exit-codes.ts`.
- LoC delta: **−30**.
- Preserves: every used code. Test for `ALL_EXIT_CODES` length needs an
  update; check `schema-emit.test.ts`.
- Steps:
  1. Delete `EX_GENERIC`, `EX_NOINPUT`, `EX_CANTCREAT`, `EX_TEMPFAIL`,
     `EX_CONFIG`, `EX_SUPERVISOR_LIVE` const + their `exitCodeName` /
     `exitCodeDescription` cases + `ALL_EXIT_CODES` entries + `ExitCode`
     type union members.
- Risk: low. If we later DO want to thread them through (CC-5) we add
  them back at the callsite that uses them.

### CC-5. Wire exit-codes through `main.ts`'s teardown
- Files: `main.ts`, `envelope.ts`, every command that builds an `errorEnvelope`.
- LoC delta: **+15 net** (this is a behavior repair, not a deletion — but
  it's required to make CC-4's choice of "delete vs wire" defensible).
- Preserves: every envelope contract.
- Steps:
  1. Have `AlreadyReportedError` carry an optional `exitCode` field
     (defaults to `EX_GENERIC` / 1).
  2. In `main.ts:teardown`, check whether the cause has an
     `AlreadyReportedError` and use its `exitCode`.
  3. Update `failAlreadyReported` to accept an optional `exitCode`.
- Risk: medium — changes process exit codes in error paths. Need to audit
  tests.

### CC-6. Extract `removeDockerByLabel(kind, app, stack)` to collapse 4 docker-ls/rm loops
- Files: `_prune-stack.ts` (4 instances, ~150 LoC), `stack.ts:243-266`.
- LoC delta: **−110** (5 × ~22 LoC → 1 × 25 LoC + 5 × 5 LoC callsites).
- Preserves: every label filter, every best-effort error handling.
- Steps:
  1. Add to `_prune-stack.ts`:
     ```
     const removeByLabel = (
         spawner: Spawner,
         kind: 'container' | 'network' | 'volume' | 'image',
         app: string,
         stack: string,
     ): Effect.Effect<ReadonlyArray<string>>
     ```
     Build the `docker <kind>s ls/ps -q --filter` command from a tiny
     dispatch table; iterate `docker <kind> rm`.
  2. Replace 4 instances in `_prune-stack.ts`, 1 in `stack.ts`.
- Risk: low.

### CC-7. Extract `safeDirSize` to `engine/fs-utils.ts` (or `cli/_shared.ts`) — kill 3 duplicates
- Files: `snapshot.ts:170-185`, `doctor.ts:389-404`, `fork.ts:790-805`.
- LoC delta: **−30** (3 × 15 LoC → 1 × 17 LoC + 3 × 1 LoC import).
- Preserves: nothing user-facing.
- Steps:
  1. Pick the most idiomatic implementation (snapshot.ts's is cleanest).
  2. Move to `engine/fs-utils.ts` (read-only file walks aren't CLI-specific).
  3. Replace 3 callsites.
- Risk: low.

### CC-8. Extract `collectReferencedChainIds` + the cache-walk to a shared util
- Files: `fork.ts:807-865`, `prune.ts:332-389`.
- LoC delta: **−70** (the two copies share a 55-LoC pattern; one util +
  two thin callsites).
- Preserves: `--include-fork-cache` semantics in both `fork cache list/prune`
  and `prune --include-fork-cache`.
- Steps:
  1. Add a `collectForkCacheEntries({ cacheRoot, stateRoot })` helper to
     `engine/sui-fork/cache-inventory.ts` (new file) or just to `fork.ts`
     and re-exported.
  2. Replace `prune.ts`'s `maybePruneForkCache` body with a call.
- Risk: low.

### CC-9. Collapse `doctor.ts`'s 7 checks behind a `Check` builder
- Files: `doctor.ts` (897 LoC).
- LoC delta: **−120 to −160**.
- Preserves: every doctor row, every required/informational flag, every
  detail string format.
- Steps:
  1. Add:
     ```
     const runCheck = (name: string, required: boolean,
                       probe: () => Effect.Effect<{ ok: boolean; detail?: string }>): Effect.Effect<Check>
     ```
  2. Each check becomes a 5-8 line declaration of `name + required + probe`.
  3. Optional: build a `CHECK_TABLE: ReadonlyArray<CheckSpec>` and iterate.
- Risk: medium — doctor has many subtle conditional details (e.g. the
  drift warning in `checkSui`). Lift them carefully.

### CC-10. Drop dead `void Registry`, `_internal` export block at fork.ts:1037-1048
- Files: `fork.ts:1037-1048` (12 LoC).
- LoC delta: **−12**.
- The comment claims `_internal` keeps the Registry import chain
  reachable for downstream tooling, but `grep` for `_internal\.` in this
  repo returns only test files importing from `fork.ts` — and those
  import the genuine functions (`resolveForkRuntimeCtx` etc.), not `void
  Registry`. The `Registry` import + `void Registry` line is dead.
- Risk: low. Run tests after.

### CC-11. Migrate `Flag.string('format')` → `Flag.choice('format', [...])` in graph.ts
- Files: `graph.ts:144-149`, `graph.ts:228-232`.
- LoC delta: **−12**.
- Preserves: same set of legal formats; error message becomes
  Effect-CLI's standard wording.
- Steps:
  1. Replace `Flag.string('format').pipe(...)` with
     `Flag.choice('format', ['text', 'mermaid', 'dot'] as const).pipe(Flag.optional, …)`.
  2. Delete the manual `if (formatStr !== 'text' && …)` validation.
  3. Delete the stale comment claiming `Flag.choice` isn't available.
- Risk: low. `flags.ts` proves `Flag.choice` works.

### CC-12. Delete `emitSuccess` from `envelope.ts`
- Files: `envelope.ts:99-106`.
- LoC delta: **−9**.
- Preserves: nothing (zero callsites).
- Risk: zero.

### CC-13. Delete dead `eps` builder in `manifest.ts:56-57`
- Files: `manifest.ts:56-57`.
- LoC delta: **−2** (lines + the `void eps;` silencer).
- Risk: zero.

### CC-14. Delete test-only exports from `_prune-ui.tsx`
- Files: `_prune-ui.tsx:300-303`.
- LoC delta: **−5**.
- `selectableKeys` (used only in `prune.test.tsx`) — inline the trivial
  logic in the test. `export { renderTotals }` is a pass-through re-export
  with no consumer — test should import from `inventory.ts` directly.
- Risk: low — touches a test file (verify the test imports).

### CC-15. Dedup `resolveAppName` between `snapshot.ts:159` and `wipe.ts:73`
- Files: `snapshot.ts`, `wipe.ts`, `stack-resolution.ts`.
- LoC delta: **−10** (one function, two callsites).
- Steps:
  1. Add `resolveAppName(override): string` to `stack-resolution.ts`
     (it's already where `resolveAppDir` lives).
  2. Replace both copies with the import.
- Risk: low.

### CC-16. Extract shared `requireInteractiveClack` from cli-prompt.ts
- Files: `cli-prompt.ts`.
- LoC delta: **−20**.
- Both `promptConfirm` and `promptTypeToConfirm` have a 22-line preamble
  (yes-bypass / inputDisabled / TTY check / clack-missing branch) that's
  identical. Extract a helper that returns either `PromptOutcome` (to
  short-circuit) or the loaded clack module.
- Risk: low.

### CC-17. Trim `loaders.ts` preamble + collapse `requireLaunchEffect`/`requireLayer`
- Files: `loaders.ts`.
- LoC delta: **−25** (~15 from preamble, ~10 from validator dedup).
- Both validators differ only in field name. A
  `requireDefaultField<K extends string>(configPath, mod, field: K)` collapses
  both, and `requireLaunchEffect`/`requireLayer` become 2-line wrappers.
- Risk: low.

### CC-18. Replace verbose `Effect.gen(function* () { yield* Layer.build(...) })` in apply.ts
- Files: `apply.ts:136-138`.
- LoC delta: **−2**.
- `Layer.build(devstack.layer).pipe(Effect.scoped)` is equivalent and clearer.
- Risk: zero.

### CC-19. Hoist `manifest.ctx?.sui` endpoint projection out of status.ts
- Files: `status.ts:202-228`, `manifest.ts:65-92`.
- This is the same endpoint-extraction logic in two places. Folds naturally
  into CC-3. Listed separately so it's countable.
- LoC delta: counted in CC-3.

### CC-20. Tighten/trim history-only block comments
- Files: scattered (worst offenders: `loaders.ts:1-29`, `cli-redesign.md`
  references like `fork.ts:1-34`, `prune.ts:1-27`).
- LoC delta: **−40 to −60** if you actually do it. Risk: low — historical
  context can be reconstructed from git log.
- I list this last because tone-of-codebase is a judgment call. Some of
  these comments earn their keep (the prune.ts top-of-file `Mode` decision
  table) and some don't (the loaders.ts "before this consolidation…"
  paragraph).

---

## Phase A's broken promises

- **`failAlreadyReported` callsite count: 47** (vs the plan's intent that
  the envelope path would replace it). Half live in `fork.ts` (16 calls)
  and `snapshot.ts` (8 calls). Every one is a place where Phase A added an
  envelope path NEXT TO the old `failAlreadyReported` instead of replacing
  it.
- **`Console.log(JSON.stringify(...))` count: 1** — `fork.ts:210` in the
  `--follow` stream loop. Genuinely defensible (per-event JSON line, not
  envelope-able). Plan was correct on this point.
- **Raw `JSON.parse` reads of `meta.json` in CLI source: 3 separate
  callsites** that should all go through `readForkMeta` from
  `engine/sui-fork/meta.ts`:
  - `prune.ts:343` — reads meta.json by hand inside
    `maybePruneForkCache`. `readForkMeta` is RIGHT THERE in the engine.
  - `doctor.ts:484` — reads `state.json.lock` by hand. Different file but
    same anti-pattern; `_prune-stack.ts:37-45` has `readJsonOpt` that
    could be lifted.
  - `fork.ts:851` — reads meta.json by hand in `collectReferencedChainIds`.
    Same fix as `prune.ts`.
- **Hand-rolled error formatting alongside `cli/render-error.ts`**: there
  is no `cli/render-error.ts`. The plan named one but it never landed.
  Instead, `pretty-error.ts` lives under `engine/` and is called from
  `cli/index.ts:tapCause` AND `cli/main.ts:teardown` (via the cause
  reporter) AND `apply.ts:reportAndRethrow` directly. Three paths render
  the same cause tree.
- **Exit codes mapped to process exit: 0** — `main.ts:34-44` collapses
  everything non-success to 1. The 13 codes in `exit-codes.ts` exist only
  in JSON output. Either CC-5 wires them through, or CC-4 deletes the
  ones nobody can ever observe.
- **What can be deleted from Phase A substrate that turned out unused**:
  - `envelope.ts:emitSuccess` — 0 callsites.
  - `exit-codes.ts`: `EX_GENERIC`, `EX_NOINPUT`, `EX_CANTCREAT`,
    `EX_TEMPFAIL`, `EX_CONFIG`, `EX_SUPERVISOR_LIVE` — 0 callsites each.

## Dead Phase A features

- `EX_SUPERVISOR_LIVE` was intended for the live-supervisor refusal path
  (`prune.ts:553`, `_prune-stack.ts:ensureNoLiveHolder`). Both paths
  currently call `failAlreadyReported` (→ exit 1) and don't carry the
  exit code through. Either wire it (CC-5) or delete it (CC-4).
- `EX_TEMPFAIL` — intended for transient docker / port hiccups. No
  callsite identifies a failure as transient today.
- `EX_CONFIG` — intended for `--upstream foo` and similar invalid-value
  errors. The closest callsite (`fork.ts:680` for bad `--checkpoint`)
  uses `failAlreadyReported` with no exit code.
- `_internal` block at `fork.ts:1037-1048` — exposed for "downstream
  tooling" that doesn't exist. Mark dead in CC-10.
- `schema-emit.ts:SchemaEnvelope` interface — defines a shape literal
  that's then re-asserted in `buildSchema`'s body. Either delete the
  interface (the literal is the source of truth) or derive the
  literal from the interface.

---

## Tracking summary

| ID  | Title                                                                   | LoC Δ |   Risk | Preserves                          |
| --- | ----------------------------------------------------------------------- | ----: | -----: | ---------------------------------- |
| CC-1  | Collapse `errorEnvelope→emit→failAlreadyReported` into one helper    |  −180 |    low | every envelope, every exit code    |
| CC-2  | `wrapForkRpc` for fork.ts tryPromise pattern                         |   −45 |    low | every error message                |
| CC-3  | Fold `manifest.ts` into shared renderer with `status.ts`             |  −100 |    low | `devstack manifest [--json]`       |
| CC-4  | Delete unused exit codes (`EX_GENERIC`, `EX_NOINPUT`, …)             |   −30 |    low | every used code                    |
| CC-5  | Wire exit codes through `main.ts` teardown                           |   +15 | medium | every envelope; **enables** codes  |
| CC-6  | `removeDockerByLabel(kind, app, stack)` collapses 5 docker loops     |  −110 |    low | label filters + best-effort        |
| CC-7  | One `safeDirSize`, three deletions                                   |   −30 |    low | nothing user-facing                |
| CC-8  | Shared fork-cache walk between fork.ts + prune.ts                    |   −70 |    low | `--include-fork-cache`             |
| CC-9  | `runCheck(name, required, probe)` builder in doctor.ts               |  −140 | medium | every doctor row                   |
| CC-10 | Drop dead `void Registry` + `_internal` block                        |   −12 |    low | nothing                            |
| CC-11 | Migrate graph.ts `Flag.string('format')` → `Flag.choice`             |   −12 |    low | format options                     |
| CC-12 | Delete `emitSuccess` (0 callsites)                                   |    −9 |   zero | nothing                            |
| CC-13 | Delete dead `eps` in manifest.ts                                     |    −2 |   zero | nothing                            |
| CC-14 | Delete test-only exports from `_prune-ui.tsx`                        |    −5 |    low | nothing                            |
| CC-15 | Dedup `resolveAppName`                                               |   −10 |    low | nothing user-facing                |
| CC-16 | Extract `requireInteractiveClack` from cli-prompt.ts                 |   −20 |    low | both prompt outcomes               |
| CC-17 | Trim `loaders.ts` preamble + collapse validators                     |   −25 |    low | both validator semantics           |
| CC-18 | `Layer.build(...).pipe(Effect.scoped)` in apply.ts                   |    −2 |   zero | apply semantics                    |
| CC-19 | Fold into CC-3                                                       |     0 |      — | —                                  |
| CC-20 | Trim history-only block comments                                     |   −50 |    low | git history                        |

## Total addressable

- **High-confidence (CC-1, CC-2, CC-3, CC-4, CC-6, CC-7, CC-8, CC-10, CC-11, CC-12, CC-13, CC-14, CC-15, CC-16, CC-17, CC-18): −665 LoC**.
- **Medium-confidence (CC-9 doctor builder, CC-20 comment sweep): −190 LoC**.
- **Net `cli/`** after high+medium: from current **+2,109 net LoC** down to
  about **+1,250 net LoC**. With CC-9 done carefully and the CC-20 comment
  sweep, getting under **+1,100 net LoC** is realistic.
- Plus CC-5 (+15 LoC) to actually deliver Phase A's exit-code promise, so
  the substrate stops being dead weight.

## Sequencing recommendation

**PR 1 — Substrate consolidation (mechanical, no behavior change).**
CC-1 + CC-2 + CC-6 + CC-7 + CC-15 + CC-17 + CC-12 + CC-13 + CC-14 + CC-18 +
CC-10 + CC-11. Target: **−440 LoC**. 4-6 hours. Risk: low — each is a
straightforward extract-then-replace. No tests should change semantics; a
few may need import updates.

**PR 2 — Render fold + exit-code wiring (behavior touches).**
CC-3 (`manifest.ts` → thin wrapper over `status.ts`) + CC-5 (`main.ts`
teardown reads `AlreadyReportedError.exitCode`) + CC-4 (delete the
exit codes we don't end up using). Target: **−115 net LoC** but resolves
the "exit codes are fiction" smell. 3-5 hours. Risk: medium — need to
audit tests that assert process exit code.

**PR 3 — Doctor refactor + dead `_internal` + comment sweep.**
CC-9 (`runCheck` builder in doctor.ts) + CC-16 (cli-prompt dedup) +
CC-20 (block-comment trim). Target: **−210 LoC**. 4-6 hours. Risk: low to
medium — doctor's check details are subtle, so this is the PR where careful
review matters.

After all three PRs, `cli/` should be **~3,400 LoC of source** (down from
4,985), with a clean substrate and no Phase A leftover scaffolding.

---

## Opportunities noticed

- **`engine/sui-fork/meta.ts:readForkMeta` is the right home for the
  `JSON.parse(meta.json)` pattern but only 1 of the 3 CLI callsites uses
  it.** `prune.ts:343` and `fork.ts:851` both read `meta.json` by hand
  inside `Effect.promise(async () => {...})` blocks. CC-8 covers this
  but the broader pattern is "the CLI imports engine helpers when it's
  convenient and reinvents them when it isn't." Worth a follow-up sweep.
- **`pretty-error.ts` lives under `engine/` but is consumed only by `cli/`**
  (`cli/index.ts:tapCause`, `cli/loaders.ts:wrapCause`,
  `cli/commands/apply.ts:reportAndRethrow`). Wrong location — should be
  under `cli/`. Engine doesn't and shouldn't depend on it.
- **`_prune-stack.ts:438` is an engine module living in `cli/commands/`.**
  Audit E58 called it out and was right. The dependencies on `cli/`
  utilities are tiny (`resolveStateDir` only) — passing the resolved
  state dir as an option would invert the import direction and let the
  module live next to its siblings (`engine/docker/inventory.ts`,
  `engine/registry.ts`). Out of scope for this plan, but flag for the
  next engine-side refactor.
- **`_prune-ui.tsx`'s exit semantics are coupled to `prune.ts`'s
  `runInteractivePicker`** through an `Effect.callback` + `inkApp.exit()`
  inside the input handler. Works, but it's the only place in the whole
  CLI where Ink and Effect mix. If a future contributor adds another
  Ink-driven command, that contract needs to be documented better than a
  comment in `prune.ts:443-468` (it should probably be a tiny utility).
- **The `Registry` service is imported into `fork.ts`, `prune.ts`, and
  `_prune-stack.ts`** even though `fork.ts` never reads it (CC-10). The
  imports increase the layer requirement of every fork subcommand for no
  reason. Worth verifying after CC-10 that the `Layer` requirements of
  the `forkCommand` subtree actually shrink.
- **The `DEVSTACK_JSON=1` env override is documented in `schema-emit.ts`
  and implemented in `envelope.ts:jsonModeEnabled`,** but every single
  callsite of `jsonModeEnabled(json)` passes a literal `--json` boolean
  parameter that the user might or might not set. The fact that you need
  to call `jsonModeEnabled(json)` instead of just reading `json` is
  noise — `--json` could `.withDefault(jsonEnvDefault())` and then every
  callsite just reads the flag value. Probably 29 callsites simpler.
- **`flags.ts` is the right home for shared flag defs but it's
  almost-empty** (45 LoC, 2 flags). The 14 flags in `prune.ts` and the
  flags repeated across `wipe.ts`/`snapshot.ts`/`fork.ts` (`--yes`,
  `--no-input`, `--dry-run`, `--json`, `--stack`, `--app`) belong here.
  Hoisting them is a separate plan but it would save another ~80 LoC
  across the commands directory.
- **`schema-emit.ts:SchemaEnvelope` and the literal in `buildSchema` are
  the same shape twice.** Either delete the interface or `satisfies`-bind
  the literal to it. Tiny but typifies the "Phase A felt obligated to
  define types for every shape" smell.
