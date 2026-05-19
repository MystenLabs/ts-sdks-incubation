# Long-acquire progress narration

**Status:** Design proposal, READ-ONLY. No source touched. **Author:** Claude (Opus 4.7),
2026-05-19. **Scope:** the `plain` renderer (`packages/devstack/src/tui/plain.ts`), the docker
image plugin-author primitive (`packages/devstack/src/advanced/plugin-author/docker-image.ts`),
the docker pull/build wrappers (`packages/devstack/src/engine/docker/image.ts`), the
shared subprocess capture (`packages/devstack/src/engine/capture-command.ts`), the
supervisor's signal handlers (`packages/devstack/src/engine/supervisor.ts`), and the
`fork-greeting` example's playwright timeout
(`examples/fork-greeting/playwright.config.ts`).

This is a **user-facing observability** plan, not a structural refactor. It does not change
behaviour beyond what stderr lines (and a single playwright config field) say.

---

## 0. TL;DR

Operator ran `pnpm test:e2e` against `examples/fork-greeting` and saw exactly this:

```
[WebServer] [14:07:14] sui.fork.image               init → acquiring
[WebServer]
[WebServer] devstack: force-killed 0 container(s) on second SIGTERM — exiting.
Error: Timed out waiting 300000ms from config.webServer.
```

300 seconds of complete silence between the two emitted lines. The acquiring tag was almost
certainly `docker pull mysten/sui-tools:...` running through `runCapturingOrFail`, which
buffers all output until exit. Playwright's default 300s webServer timeout fired during the
pull, sent SIGTERM, then a second SIGTERM hit the hard-kill handler, which reported "0
containers" (correct — no container had spawned yet because the pull hadn't finished).

**Four phases** restore signal to the operator. Each is independently shippable:

1. **Plain renderer heartbeat** (§3.1) — emit a "still acquiring(phase?) [Ns]" line every 15s
   while a tag stays in `acquiring`. Universal; works for every primitive without touching
   their bodies. ~75 LoC + a new test file.
2. **Docker pull/build phase streaming** (§3.2) — push `setPhase('pulling <image>')` from
   `dockerImage`, and stream `docker pull`'s stdout to surface "pulling 3/8 layers". Requires
   a streaming variant of `captureCommand` (see §4 — coordinates with
   `stack-simplification-audit.md §E2`). ~150 LoC + parser tests.
3. **`fork-greeting` playwright timeout bump** (§3.3) — fork-mode's first-run cold-start can
   blow past the 300s default; raise to 900s in the example's config. 4 LoC. Optional
   companion: detect fork-mode in `defineDevstackPlaywrightConfig` and bump the default
   automatically.
4. **Shutdown summary on SIGTERM** (§3.4) — on first SIGTERM, list the tags still in
   `acquiring` (with their phase) before the supervisor's teardown begins. On second SIGTERM,
   include the same summary alongside the force-kill count. ~40 LoC.

Projected net: +**~270 LoC** (renderer + tests + small primitives). No structural deletions
expected.

---

## 1. Motivation

### 1.1 The failure mode, reproduced

The operator's output (above) is the visible symptom. The invisible cause: every
`dockerImage({pull})` call routes through `Docker.pull` → `runCapturingOrFail` →
`captureCommand`, which `Stream.mkString`s stdout and stderr into a single string drained
once the process exits (`packages/devstack/src/engine/capture-command.ts:154-172`). Until
exit, **no caller observes anything from the subprocess.**

For `mysten/sui-tools` (hundreds of MB compressed), a fresh cache + slow upstream link can
push that exit out past 300 seconds. The plain renderer has nothing to render: the engine
state didn't change after the initial `pending → acquiring` flip, because no primitive ever
called `setPhase`.

The hard-kill handler (`engine/supervisor.ts:1813-1860`) fires on the second SIGTERM and
prints `force-killed 0 container(s)` — accurate, but the operator has no way to tell whether
"0 containers" means "everything was cleanly torn down" or "the pull was still running and
no container had even been created yet". Both look the same from outside.

### 1.2 What primitives _can_ already do

`engine/engine.ts:55-63` defines `setPhase(key, phase)` and `tag.ts:73-80` exposes the
ambient-key helper. The plain renderer (`tui/plain.ts:110-115`) already emits a line
whenever `entry.phase` changes inside `acquiring`. So the substrate for phase narration
exists — the gap is that `dockerImage` doesn't use it, and there's no heartbeat for
primitives whose phase doesn't change for minutes.

`sui.ts` is well-instrumented (we counted 14 `setPhase` / `phase:` sites at lines
441–1844) — the fork path emits `sui-up`, `network-create`, `postgres-up`, `ready-probe`,
`fork-status`, etc. But all of those fire **after** the image is on disk; the image pull
itself is the silent prefix.

### 1.3 Why heartbeat alone is not enough

A heartbeat without phase information says "I'm alive" but not "why I'm slow". For
`sui.fork.image`'s pull case specifically (which the operator called out), the operator
wants to know:

- _What_ is being pulled (image name)
- _How far through_ (layer count or bytes if available)
- That progress is being made (heartbeat as fallback)

Heartbeat covers (c). Phase streaming covers (a) and (b). They're complementary.

### 1.4 Why phase streaming alone is not enough

A phase-stream without heartbeat fires lines as the docker pull layers tick over. But:

- The first layer can take 60+ seconds before the first "Pull complete" — the operator still
  stares at one line for a minute.
- Other primitives without phase tracking (long sui-genesis, long postgres init, slow
  upstream fetches) get nothing.

Heartbeat is the universal floor. Phase streaming is the targeted narration on top.

---

## 2. Current state

### 2.1 Plain renderer

`packages/devstack/src/tui/plain.ts`:

- Polls `TuiState` every 500ms (`REFRESH = Schedule.spaced('500 millis')`).
- `diffState(prev, next, now)` returns `{ lines }` — emits one line per status transition
  (`init → acquiring`, `acquiring → ready`, etc.), one line per phase change inside
  `acquiring`, and one line per new log entry.
- Closure state is `previous: TuiState | undefined`. No timer state.
- Writes via `stdio.stderr()` through `Stream.run`, all wrapped in `Effect.ignore` so EPIPE
  doesn't kill the supervisor.
- No existing test file (`plain.test.ts` does not exist).

### 2.2 Docker pull/build

`packages/devstack/src/engine/docker/image.ts:20-45` — `Docker.pull(image)`:

```
yield* runCapturingOrFail(spawner, ChildProcess.make('docker', ['pull', image]), 'docker pull');
```

Single shell-out. Output goes nowhere visible until exit.

`packages/devstack/src/engine/docker/image.ts:87-140` — `Docker.build(opts)`: same pattern.

`packages/devstack/src/advanced/plugin-author/docker-image.ts` — the
`dockerImage({pull})`/`dockerImage({build})` factory. Imports `tag` from `../tag.js` (which
also exports `setPhase`) but does not call `setPhase` anywhere in the build body.

### 2.3 Subprocess capture

`packages/devstack/src/engine/capture-command.ts:144-172` — `captureCommand`:

```ts
const [stdoutText, stderrText, code] = yield* Effect.all(
  [
    decodeStream(handle.stdout).pipe(Effect.mapError(mapSpawn)),
    decodeStream(handle.stderr).pipe(Effect.mapError(mapSpawn)),
    handle.exitCode.pipe(Effect.mapError(mapSpawn)),
  ],
  { concurrency: 'unbounded' },
);
```

`decodeStream` is `Stream.mkString(Stream.decodeText(stream))` (line 115). Whole-string
drain; no per-line callback hook. The `op` field on `CaptureError` lets callers attribute
the failure, but there's no live observation surface.

`stack-simplification-audit.md §E2` already proposes consolidating this with
`engine/sui-cli.ts::runWithCapture` and `engine/snapshot.ts::runTar` into one shared
`engine/subprocess.ts`. **This plan must coordinate with E2** — see §4.

### 2.4 Supervisor signal handling

`packages/devstack/src/engine/supervisor.ts:1813-1870`:

- First SIGINT/SIGTERM: handled by Effect's `NodeRuntime.runMain` — interrupts the supervisor
  fiber, triggers scope teardown.
- Second SIGINT/SIGTERM: the `installHardKillHandler` closure fires. Runs `docker ps -q
  --filter label=devstack.app=… --filter label=devstack.stack=…` synchronously, then `docker
  kill <ids>` synchronously, then `process.exit(130)`.
- The message printed: `\ndevstack: force-killed ${ids.length} container(s) on second ${sig}
  — exiting.\n`. No reference to which tags were acquiring.

### 2.5 Playwright timeout

`packages/devstack/src/playwright/define-config.ts:13-46`:

```
readonly timeout?: number;
const timeout = options.timeout ?? 300_000;
```

Default 300s. Comments at lines 13-16 explicitly call out "Bump to ~`900_000` for apps with
walrus/seal cold-start (first-image pull)" — but the same applies to fork-mode's
`sui-fork-image` pull.

`examples/fork-greeting/playwright.config.ts:7` — uses the bare
`defineDevstackPlaywrightConfig()` with no options. Comment says "playwright's 300s default
webServer timeout is already generous enough" — written before first-time image-pull cases
were observed.

---

## 3. Proposal

### 3.1 Phase 1 — Plain renderer heartbeat

**Where:** `packages/devstack/src/tui/plain.ts`, new
`packages/devstack/src/tui/plain.test.ts`.

**Mechanism.** Extend the renderer's closure state with two mutable maps keyed by tag name:

- `acquiringSince: Map<string, number>` — set on transition into `acquiring` (or first
  sighting of an entry already in `acquiring`); cleared on transition out.
- `nextHeartbeatAt: Map<string, number>` — initialised to `acquiringSince[key] + 15_000`;
  bumped by `+= 15_000` each heartbeat (so a tick that fires late catches up by exactly one
  line, not many).

In `diffState` (or a new sibling pass run from the same tick body), after emitting any
transition lines:

- For each entry currently in `acquiring` that did **not** emit a transition this tick AND
  `now >= nextHeartbeatAt[key]`: emit one heartbeat line, bump the schedule.

**Line format.** Match the existing column width (`pad(key, 28)`) and timestamp format:

```
[14:07:29] sui.fork.image               still acquiring [15s]
[14:07:29] sui.fork.image               still acquiring(pulling mysten/sui-tools:1.45) [15s]
```

`[15s]` is `Math.floor((now - acquiringSince[key]) / 1000)`. With phase, the phase string
slots into the same `(...)` form `formatEntryLine` already uses for `acquiring(phase)`.

**Suppression rules** (avoid double-emission):

- If a phase change emits a transition line this tick, skip the heartbeat for the same key.
- If status changes out of `acquiring` (to `ready` / `failed` / `stopping` / `stopped`),
  delete both map entries.

**Tests** (new file `plain.test.ts`). Pure-function tests against the heartbeat pass:

| #   | Case                                                                         |
| --- | ---------------------------------------------------------------------------- |
| 1   | Tag entering acquiring → no heartbeat at t=0                                 |
| 2   | After 15s same state → exactly one heartbeat                                 |
| 3   | After 30s → two heartbeats total                                             |
| 4   | Phase change at t=10s does NOT reset the 15s clock                           |
| 5   | Transition to ready clears state — no further heartbeats                     |
| 6   | Heartbeat with phase: `still acquiring(phase) [Ns]`                          |
| 7   | Heartbeat without phase: `still acquiring [Ns]`                              |
| 8   | Multiple concurrent acquires get independent schedules                       |
| 9   | Entry first observed already in `acquiring` still heartbeats 15s later       |
| 10  | A 90s-late tick emits exactly ONE catch-up heartbeat, not many               |

**LoC Δ:** +~75 to `plain.ts`, +~230 in the new test file. No deletions.

**Sequencing:** Independent. Can ship in isolation; gives universal floor of "I'm alive"
narration.

### 3.2 Phase 2 — Docker pull/build phase streaming

Two layers:

**(A) Coarse phase from `dockerImage`** (~6 LoC).

In `packages/devstack/src/advanced/plugin-author/docker-image.ts`:

- Before `Docker.pull(options.pull)`: `yield* setPhase(\`pulling ${options.pull}\`)`.
- Before `Docker.build(buildOpts)`: `yield* setPhase(\`building ${options.name}\`)`.
- **NOT** before the `imageExists` short-circuit branch (no work to narrate).

This alone produces a usable line: `sui.fork.image  acquiring(pulling mysten/sui-tools:1.45)`
appears within milliseconds of the pull starting.

**(B) Layer-level progress from `Docker.pull`** (~150 LoC).

`docker pull <image>` without TTY emits one line per layer status change:

```
abc123def456: Pulling fs layer
def456abc789: Pulling fs layer
abc123def456: Downloading [==>                 ] 1.234MB/45.67MB
abc123def456: Pull complete
def456abc789: Pull complete
Digest: sha256:...
Status: Downloaded newer image for mysten/sui-tools:...
```

We need to stream stdout line-by-line and call `setPhase` as layer counts change. The
existing `captureCommand` API can't do this — it `Stream.mkString`s.

**New streaming variant** (`captureCommandStreaming` in `capture-command.ts`, or a new
module — see §4 for alignment with E2). Signature sketch:

```ts
captureCommandStreaming(
  spawner,
  cmd,
  {
    op,
    onStdoutLine: (line: string) => Effect.Effect<void>,
    stderrTruncate?: number,
    stdoutBufferCap?: number, // for error envelope, cap at ~STREAM_TRUNC_BYTES
  }
): Effect.Effect<CaptureResult, CaptureError>
```

Internally: `Stream.decodeText(handle.stdout).pipe(Stream.splitLines,
Stream.runForEach(onStdoutLine))` forked alongside stderr drain + exit-code wait. Captured
stdout is held in a small ring buffer (cap matches `STREAM_TRUNC_BYTES = 1024`) so the error
envelope still works.

**Pure parser** (`parseDockerPullLine`) in `engine/docker/image.ts`. Given a sequence of
lines, maintain `{ totalLayers, completedLayers }` and emit phase strings only when those
counts change. Format:

- `pulling 2 layers` (before any completion)
- `pulling 1/2 layers (mysten/sui-tools)` (after first "Pull complete")
- `pulling 2/2 layers` (just before exit)

This parser is plain-old-data and easy to test (input: list of lines; output: list of phase
strings). No Effect required for the test.

`Docker.pull` wires the parser to `onStdoutLine` and calls `setPhase` from the callback. Since
`setPhase` reads `CurrentTagKey` and is a noop outside an engine-wrapped build, the
indirection is safe.

**`Docker.build` is lower priority.** BuildKit progress is harder to parse and changes
across docker versions. Ship (A) for build — the coarse `setPhase('building <name>')` — and
defer fine-grained step parsing to a later iteration. (Optional: a tiny parser for legacy
`/^Step (\d+)\/(\d+)/` lines, but only if it's a small addition.)

**Tests:**

- Pure parser: empty input → no phase; 2 "Pulling fs layer" → "pulling 2 layers"; 2 pulls +
  1 "Pull complete" → "pulling 1/2 layers"; out-of-order events stay sensible.
- Streaming helper: stub spawner emits lines, assert they arrive in order at `onStdoutLine`,
  assert exit code surfaces, assert stderr capture.
- **No** end-to-end docker test — too slow and depends on the daemon.

**LoC Δ:** +~150 for streaming helper + parser + tests, +6 for `dockerImage` callsites. No
deletions.

**Sequencing:** Coordinates with §E2 of `stack-simplification-audit.md`. See §4 below.

### 3.3 Phase 3 — `fork-greeting` playwright timeout

Tiny but real. Two parts:

**(A) Example bump.** `examples/fork-greeting/playwright.config.ts`:

```ts
export default defineDevstackPlaywrightConfig({ timeout: 900_000 });
```

Replace the current "300s default is already generous enough" comment with a one-line
acknowledgement that fork-mode's first-run image pull + system-state warm can blow past 300s.

**(B) (optional) Smart default in `defineDevstackPlaywrightConfig`.** Today the function has
no signal that the stack includes a fork primitive. Two options:

- Add a `coldStart?: 'short' | 'long'` option that bumps the default. `short` = 300s, `long`
  = 900s. Apps with fork-mode / walrus / seal pass `long`.
- Read the manifest at config-evaluation time (it's eager, before `webServer` runs) and bump
  if it contains `services.sui` with a fork config block. Plumbing-heavy and probably
  fragile — manifest may not exist on first ever boot.

Recommend the explicit `coldStart: 'long'` knob — discoverable, no manifest dependency.

**LoC Δ:** +4 in the example. +~10 in `define-config.ts` if (B) lands.

**Sequencing:** Independent. (B) is a docs/UX improvement; (A) is a one-line bug-fix.

### 3.4 Phase 4 — Shutdown summary on SIGTERM

Two surfaces:

**(A) First-SIGTERM summary** (~25 LoC).

Today the first SIGTERM goes through `NodeRuntime.runMain`'s interrupt → scope teardown.
There's no point where the supervisor prints "shutting down — N tags were still acquiring".
Add one.

Hook: install a sibling SIGTERM/SIGINT listener (alongside `installHardKillHandler`, but
running on the FIRST signal) that:

1. Reads `engine.tuiState` (already a `Ref.Ref<TuiState>`).
2. Filters entries with `status === 'acquiring'`.
3. Writes one line to stderr summarising them: `devstack: SIGTERM received — N tag(s)
   still acquiring: sui.fork.image (pulling mysten/sui-tools, 287s), faucet (waiting on
   sui)`.
4. Lets Effect's normal interrupt path proceed.

This must run **before** the `forkScoped(launchLoop)` interrupt fires, OR concurrently — the
worst case is the message lands after teardown begins, which is still strictly more useful
than today.

**(B) Hard-kill message enrichment** (~15 LoC).

Extend the existing `force-killed N container(s)` line to include the still-acquiring tags
captured at first SIGTERM:

```
devstack: force-killed 0 container(s) on second SIGTERM — 1 tag still acquiring (sui.fork.image: pulling mysten/sui-tools, 297s) — exiting.
```

Store the first-SIGTERM snapshot in the closure variable so the second-signal handler can
read it.

**LoC Δ:** +~40 in `supervisor.ts`. No deletions.

**Sequencing:** Independent — touches one file. Could ship alongside (1) or (2), or alone.

---

## 4. Sequencing & alignment with other plans

| Phase | Touches                                                                       | Depends on                            | Touched by                                              |
| ----- | ----------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| 3.1   | `tui/plain.ts` + new `plain.test.ts`                                          | nothing                               | nothing                                                 |
| 3.2A  | `advanced/plugin-author/docker-image.ts`                                      | nothing                               | nothing                                                 |
| 3.2B  | `engine/capture-command.ts`, `engine/docker/image.ts`                         | **see below — E2 alignment**          | `stack-simplification-audit.md §E2`                     |
| 3.3   | `examples/fork-greeting/playwright.config.ts`, optional `playwright/define-config.ts` | nothing                               | nothing                                                 |
| 3.4   | `engine/supervisor.ts`                                                        | nothing                               | nothing                                                 |

### 4.1 §E2 alignment (the only real coupling)

`stack-simplification-audit.md §E2` proposes consolidating `engine/docker/core.ts::runCapturing`,
`engine/sui-cli.ts::runWithCapture`, and `engine/snapshot.ts::runTar` into one
`engine/subprocess.ts`. Phase 3.2B adds a streaming variant to the same surface.

Two acceptable sequences:

- **E2 first.** The new `subprocess.ts` from E2 exposes `captureCommandStreaming` as a
  sibling of `captureCommand`. Phase 3.2B lands on top, one-touch — no migration.
- **Phase 3.2B first.** The streaming variant lands in `capture-command.ts`. When E2 runs,
  the consolidation absorbs the streaming surface into the new `subprocess.ts`. E2 already
  needs to touch all three callers — adding "and the streaming variant moves too" is a small
  delta to their already-planned work.

**Recommendation:** Don't block on E2. Land Phase 3.2B in `capture-command.ts` now (the
ergonomics are good and the work is contained), then let E2 absorb it as part of the
consolidation. The substrate-finding pattern from
`feedback_propagate_findings_to_substrate.md` applies: lift the "we need streaming, not
just whole-string" finding into E2's plan so the redesign doesn't re-erase it.

### 4.2 Integration-contract redesign

`integration-contract-redesign.md` covers `services/**` + the two long-lived container
plugins. It does NOT touch `dockerImage` (which is image-layer, not container-layer) or the
plain renderer. No conflict.

### 4.3 Other plans

- `cli-redesign.md` — orthogonal (operator-facing CLI verbs, not the running-supervisor TUI).
- `dirs-dapp-kit-compose-audit.md` — orthogonal.
- `dirs-images-consolidation.md` — moves `*-image/` dirs but doesn't change the docker pull
  call sites. No conflict.
- `sui-fork-phase-5-walrus-seal-audit.md` — explains why walrus/seal on-fork are
  upstream-blocked. Orthogonal; the `sui.fork.image` pull is the same regardless.
- `versioning-shim-audit.md` — orthogonal.

---

## 5. LoC delta

| Phase  | Δ                |
| ------ | ---------------- |
| 3.1    | +75 src, +230 test |
| 3.2A   | +6               |
| 3.2B   | +150 (incl. tests) |
| 3.3A   | +4               |
| 3.3B   | +10 (optional)   |
| 3.4    | +40              |
| **Total** | **~+515 LoC** (+230 of which is test) |

No structural deletions. The work is additive.

---

## 6. Open questions

1. **15s heartbeat interval.** Defensible (matches "look something is happening every few
   tens of seconds" intuition), but configurable would be friendlier for CI vs interactive
   use. Defer to a follow-up if anyone complains.
2. **Phase string truncation.** A very long phase (`pulling registry.example.com/very/long/path:tag`) blows
   the column width. Today's `formatEntryLine` doesn't truncate; heartbeat shouldn't
   either. If it becomes a problem, truncate to e.g. 60 chars with `…`.
3. **Whether to expose layer-byte progress** (e.g. `42.3MB / 530MB`). The line-parser sees
   it; choosing not to surface for noise reasons. Reconsider after operators see the layer
   count and tell us whether bytes would help.
4. **Smart playwright timeout from manifest** (3.3B). Plumbing-heavy and probably fragile
   given the manifest may not exist on first-ever boot. Recommend the explicit `coldStart`
   knob instead.

---

## 7. Provenance / artifacts

- The failure-case stderr was captured by the operator on 2026-05-19 during a
  `pnpm test:e2e` run in `examples/fork-greeting`. Reproduced in `notes/long-acquire-progress.md`
  §0 verbatim.
- The heartbeat prototype was implemented in a separate exploratory pass (general-purpose
  agent) and then reverted before this plan was written. Implementation matched §3.1 closely;
  all 10 listed test cases passed. Diff was 73 lines in `plain.ts` + a 230-line `plain.test.ts`.
  Source is not preserved (reverted via `git checkout`) — re-implementation can follow §3.1
  directly.
- No source has been modified in this branch by this plan. All file/line references are
  against `699c6ec3` (the branch's HEAD at writing).
