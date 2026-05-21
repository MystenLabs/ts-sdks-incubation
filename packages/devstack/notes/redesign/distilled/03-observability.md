# 03 Observability (distilled)

## Purpose

The observability layer covers everything between "a failure or a log line happens inside some
primitive" and "the user sees a legible explanation of it". It owns the error taxonomy, the
multi-line pretty render of nested cause chains, the structured (`--json`) projection of those
chains, the subprocess-output capture surface every shell-out shares, the in-memory log buffer that
backs TUI and plain renderers, the span / annotation conventions, the lossless JSON BigInt codec,
and the path-display formatter. It is responsible for **shape** (what each error carries, what the
renderer emits) — not for **why** a particular per-service failure exists nor how the TUI renders
frames.

## Responsibilities

- Define a closed, tagged error taxonomy that flows through Effect's error channel and is catchable
  by string tag (no `instanceof`).
- Constrain each error's `phase` field to a closed literal union per service, with two explicit
  grandfathered open-string exceptions (subprocess wrappers).
- Render nested error chains (`OuterError ← MidError ← Cause ← Defect`) into a human-readable
  multi-line tree, surfacing per-layer phase, exitCode, stderr, stdout, detail.
- Project the same chain into a structured JSON tree for `--json` consumers.
- Provide a one-line cause stringifier for callers that need a short message label (transitional: a
  workaround for mandatory `message` fields).
- Capture stdout / stderr / exit-code of every subprocess through one helper family with four
  variants (capture-only, fail-on-non-zero, streaming-callback, streaming-fail-on-non-zero).
- Maintain a bounded in-memory log buffer with per-tag attribution that both TUI and plain renderers
  consume.
- Bridge Effect's logger pipeline into that buffer.
- Per-tag error summarization: turn a failure cause into a short row-fit string suitable for a TUI
  row.
- Stamp standard context annotations (`service.name`, `devstack.stack`, `devstack.app`) on every
  primitive's current span.
- Establish span-name + annotation-key conventions (PascalCase span names, dotted lowercase
  annotation keys with service prefix).
- Encode bigints losslessly as `{ __bigint: "<string>" }` for any persisted / hashed JSON the rest
  of the system writes.
- Relativize absolute filesystem paths against cwd / `$HOME` for readable log lines.
- Front-load a "Docker daemon unreachable" hint when the rendered chain contains known Docker-down
  tell strings.

## Event / error taxonomy

The taxonomy is the catalogue of failure modes; categories rather than class names:

- **Engine / config / manifest errors** — config-load failure, manifest discovery (walk-up not found
  / required-missing), manifest shape (parse / schema), manifest write.
- **Per-service primitive errors** — one envelope per service (Sui, Walrus, Seal, Deepbook +
  indexer + server, Pyth, Postgres, Account, Publish, WalletApp). Each carries a closed phase set
  covering its lifecycle (image acquire, port-alloc, network create, container up, ready probe,
  deploy / publish, per-component sub-phases).
- **Subprocess wrappers** — Docker invocations and arbitrary host scripts. These are the two
  **open-string phase** classes: their "phase" is the invocation/command string itself, because the
  set of possible commands is unbounded.
- **Fork-mode context errors** — three context-only classes with no phase field: an unsupported
  surface (a client method the fork can't serve), an incompatible factory (a primitive that can't
  coexist with a fork network), and a seed manifest mismatch (snapshot drift vs current config).
- **Capture error** — the universal subprocess-capture failure envelope: distinguishes spawn-itself
  failure (ENOENT / fork-limit / pipe setup) from non-zero-exit promotion. Always carries `op`,
  `stdout`, `stderr`; `exitCode` and `cause` are optional and mutually-exclusive in practice.
- **Plugin-author surface errors** — minted outside the central errors file (git-fetch,
  host-script-internal, docker-image / container / one-shot factories) but participate in the same
  render path via duck-typed `_tag` walking.
- **CLI / runtime errors** — already-reported sentinel (suppresses the outer pretty-printer when CLI
  already rendered), prune-stack guard, codegen pipeline failure, snapshot create/restore,
  file-watcher boot, faucet HTTP, state-store lock contention, state-store migration, dep-graph
  cycle, port-allocator, chain-probe, ready-probe, stage-and-swap, sui-cli wrapper, coin lookup
  (not-found / ambiguous), faucet request.

Each error has a stable string `_tag` so consumers `catchTag('<Tag>')` without importing the
concrete class. The render walker is class-agnostic: it duck-types on `_tag` and surfaces a fixed
set of fields (`phase`, `exitCode`, `stderr`, `stdout`, `detail`), recursing through `cause`.

## Lifecycle states

### Pretty-error walker

- Stateless / pure. Each invocation builds a string (or a JSON tree) from a single value.
- Bail states: `null` / `undefined` → empty.
- Recursion forms: Effect Cause (via `reasons` array, branching on `Fail` / `Die` / `Interrupt`),
  tagged error (via `_tag` and structural fields plus `cause:`), plain `Error` (stack-preferred),
  unknown (string-coerced).
- Per-layer truncation cap applied to oversized free-form strings.
- One post-render augmentation pass for the Docker-down hint.

### Capture-command effect

- States per call: scoped (spawn establishes a child handle, finalizer ensures cleanup), draining
  (stdout, stderr, exit-code drain concurrently), terminal (result fully resolved or CaptureError
  emitted).
- The streaming variant adds an extra state: per-line decode + callback invocation, with callback
  failure swallowed so observation cannot abort the capture.

### Log buffer

- States: empty (frozen initial state on engine boot), accumulating (each append → atomic
  `Ref.update` with trim), at-cap (oldest dropped first, hard cap = 200 entries).
- Per-tag `lastLog` projection: set on every `appendTagLog`; cleared on the tag's `markReady` /
  `markStopping` / `markStopped` transitions so a stale acquire-time line doesn't shadow a resolved
  status row.

### Spans

- Lifetimes scoped to the wrapping `Effect.withSpan` block.
- Annotations stamped via `annotateCurrentSpan` mutate the live span in-place; require an active
  span (no span → annotation is dropped).
- `service.name` / `devstack.stack` / `devstack.app` annotation helper is gated on the presence of
  an `Identity` service so standalone tests can short-circuit.

### Renderer

- Three kinds: `tui`, `plain`, `silent`.
- Each kind exposes mount (start) and flush (best-effort drain) phases.
- TUI mounts once on the outer (supervisor) scope and re-points an internal proxy at the per-cycle
  engine; plain mounts a diff loop on the outer scope; silent is a no-op.

## Inputs / dependencies

- Effect runtime: `Cause`, `Effect.gen` / `scoped` / `all` / `mapError` / `withSpan` /
  `annotateCurrentSpan` / `catchTag(s)` / `catchCause`, `Schema.TaggedErrorClass` +
  `Schema.Literals` for tagged-error classes, `Stream` for subprocess decoding, `Layer` for the
  logger bridge, `Ref` for the buffer, `Logger.make`.
- Effect's unstable platform: child-process spawner service, `Stdio` service for plain-renderer
  stderr writes, `Scope` for renderer mount lifetimes.
- Node: `node:path` / `node:os` for `displayPath`; `process.cwd`, `process.stdout.isTTY`,
  `process.env.DEVSTACK_JSON` / `DEVSTACK_NO_INPUT`. **No direct `child_process` imports** — every
  spawn goes through the Effect spawner service.
- An `Identity` service (engine-owned) for the standard span annotation triple.

External configuration is minimal:

- `DEVSTACK_JSON=1|true` flips CLI subcommands into JSON-envelope mode.
- `DEVSTACK_NO_INPUT=1|true` disables interactive prompts; affects observability indirectly via
  prompt-required failure envelopes.
- `--renderer` CLI flag overrides the auto-resolved renderer kind (default = TUI if stdout is a TTY,
  else plain).
- **No** verbosity / log-level / NO*COLOR / FORCE_COLOR / OTEL*\* / log-buffer-size env vars exist
  today.

## Outputs / capabilities provided

Consumed by:

- **CLI envelopes** (`--json` mode uses the structured JSON projection; human mode uses the
  multi-line tree).
- **TUI renderer** (reads the log buffer, the per-tag `lastLog`, the per-tag error summary).
- **Plain renderer** (reads the same buffer; writes diffs to stderr via the platform Stdio service).
- **Silent renderer** (no output; default Effect logger still fires on stderr inline).
- **Per-service primitives** — every primitive wraps `CaptureError` into its own envelope via
  `mapError`; every primitive calls `annotateDevstackContext` for the standard triple.
- **State store / manifest emitter / codegen / cache-key derivation** — every persisted-JSON site
  that may carry a bigint uses the codec.
- **Span consumers** — none by default; spans are emitted only when a user-supplied tracer Layer is
  provided.

## Invariants and constraints

- Every error class with a `phase` field has either a closed literal union OR is one of two
  grandfathered open-string exceptions (Docker, host-process). Enforced by a runtime AST walker
  test.
- Three context errors are explicitly grandfathered as having NO phase field (the three fork-mode
  context classes).
- Every error has a stable string `_tag`. Consumers catch by tag, not by class identity.
- Pretty-render output is bounded: per-field truncation cap (~8KB) suffixed with `[truncated]`.
- `captureCommand` (the base variant) does NOT auto-fail on non-zero exit; the caller branches. The
  `OrFail` variants promote non-zero exits.
- Subprocess streams drain concurrently (stdout, stderr, exit-code).
- Streaming variant's per-line callback failures are silently swallowed — narration is observation,
  never load-bearing.
- The streaming variant's folded `stdout` has no trailing newline (line-split consumes the final
  delimiter); this is pinned.
- Log buffer is bounded (cap = 200 entries); oldest dropped first. Cap is hard-coded; no env
  override.
- A single atomic `Ref.update` writes both the global log and the per-tag `lastLog` so the two views
  cannot drift.
- Per-tag error summary is capped at 80 chars with `…` suffix; uses a "stderr beats message" rule
  walking to the deepest non-empty stderr / message.
- BigInt codec is shape-strict: only `{ __bigint: <string> }` matches; look-alike tags pass through
  verbatim.
- Invalid `__bigint` payloads do NOT throw out of the reviver (historic: a thrown SyntaxError
  silently destroyed the state file).
- `displayPath` is irreversible (collapsed `~`/relative form cannot recover the absolute path
  without ambient `$HOME` / `cwd`).
- Render walker imports no concrete error classes (decoupled from taxonomy via duck-typing on `_tag`
  shape).
- Logger bridge runs synchronously inside the Effect logging pipeline (the sink cannot `yield*`);
  the `runSync` defect surface is narrowed to a `Ref.update` and wrapped in a catch-all so
  scope-close defects don't tear it down.
- Span-name convention: PascalCase service-domain names.
- Annotation-key convention: service-name prefix, dotted lowercase path (`sui.chainId`,
  `walrus.epoch`, `docker.op`, …).
- No on-disk log file is written by this layer; no error-tree dumps are persisted; no default tracer
  is wired.

## Edge cases and known failure modes

- **Spawn-itself failure** (ENOENT, fork limit, pipe setup): emits `CaptureError` with empty
  streams + `cause` set, `exitCode` undefined.
- **UTF-8 decode failure mid-stream** is not currently tested; would collapse into a CaptureError
  via stream-channel `mapError`.
- **Non-zero exit** is a value, not a failure — callers must branch. Only the `OrFail` variants
  raise.
- **Streaming callback failure**: silently swallowed; capture still resolves.
- **JSON BigInt reviver corruption**: a malformed payload returns the tagged shape unchanged instead
  of throwing (intentional; load-bearing).
- **`displayPath` `homedir()` throws**: home-relative branch is skipped, absolute fallback returned.
- **`annotateDevstackContext` missing `Identity` service**: surfaces as an R-channel type error;
  runtime call sites gate via `serviceOption(Identity)` so standalone tests skip annotation.
- **`TuiLoggerLayer` defect during scope-close**: caught and dropped; some final log lines may be
  lost.
- **Plain renderer EPIPE** on closed pipe: silently swallowed.
- **Docker-down hint string-match false positives**: a plain `Error` whose `message` happens to
  mention `docker` triggers the hint, with no error-class guard rail.
- **`causeToJson` unknown-value fallback** passes the raw `unknown` through under `{ value }`;
  subsequent `JSON.stringify` may reject cycles, functions, or bigints (the codec is NOT applied to
  `value`).
- **Per-service structured fields (e.g. `feed`, `database`, `account`, `keyServer`) are NOT surfaced
  by the pretty walker** — only by the JSON walker (and even then, implicitly). Pretty-printed
  output drops them.
- **Render walker walks a `detail` field** that no error in the central errors file declares —
  origin unclear, possibly a plugin author / test fixture, possibly dead code.
- **Tagged errors that live outside the central errors file** (15+ classes scattered across
  plugin-author, codegen, engine subsystems) are walked uniformly by virtue of duck-typing, but
  their schemas are documented per-subsystem, not centrally.

## Learnings from current implementation

- **Errors-as-values + closed phase unions is the right shape**: makes the error catalogue
  self-documenting and lets the pretty walker remain class-agnostic. The phase-conformance runtime
  test is a cheap and effective guard rail.
- **Two grandfathered open-string phase exceptions are unavoidable**: subprocess wrappers (Docker,
  host-script) genuinely have an unbounded command-string set; trying to enumerate would be wrong.
- **The render walker should NOT import concrete error classes**. Duck-typing on `_tag` lets new
  error classes (including from plugin-author / external modules) render for free, but: the fixed
  field set (`phase`, `exitCode`, `stderr`, `stdout`, `detail`) is the de facto contract — new
  structured fields are silently dropped unless walker is extended.
- **The single-walker-with-two-projections shape** (multi-line text vs structured JSON) is good; the
  structured projection is what `--json` consumers need, the text projection is what humans need.
- **Engine maintaining its OWN cause-walker (`summarizeCause`, `extractDeepestMessage`,
  `rawFailure`) is a drift hazard**. Pretty-error has no "deepest message" helper today, so engine
  rolls its own. Two walkers can disagree on tag detection, stderr-vs-message priority, or recursion
  shape.
- **The "stderr beats message" rule is load-bearing**: our tagged errors carry the real CLI output
  in `stderr`; `message` is the generic wrapper preamble. Any future row-summarizer must preserve
  this priority.
- **Subprocess capture should default to "non-zero exit is a value, not an error"**, with an
  `OrFail` sibling for the "treat as error" case. Forcing every caller through a try/catch when they
  want to inspect `exitCode === N` is the wrong default.
- **Concurrent draining of stdout, stderr, and exit-code is required** to avoid deadlock on large
  outputs.
- **Streaming narration must be unconditionally observation, never load-bearing** — silently swallow
  callback errors. Otherwise narration becomes a failure mode of the underlying capture.
- **The streaming variant's stdout has no trailing newline** after splitLines/runFold rejoin.
  Surprising; pinned by test; should be documented at the API boundary in the new design.
- **`stringifyCause` is a transitional workaround** for the mandatory `message: Schema.String`
  field. The deeper fix is optional / structured message handling on the error class.
- **`appendLog`/`appendTagLog` living on the EngineHandle conflates lifecycle control with log
  routing** — every consumer of the engine surface inherits log-write capability. The proxy in the
  TUI mount carries two log-related shims with different forwarding semantics, evidence of muddled
  responsibilities.
- **`TuiLoggerLayer` lives in `tui/` but has zero ink/React dependency** — it's a Logger sink that
  calls `engine.appendLog`. Co-located by accident.
- **Renderer factory mixing `mount` and `loggerLayer` is awkward**. Both TUI and plain use the same
  logger layer (route logs into engine buffer); only silent uses `Layer.empty`. A user wanting "no
  TUI but no Effect-default stderr dump" would need a fourth kind.
- **Docker-down augmentation is special-case observability knowledge that should arguably live with
  the Docker subsystem** (a `hint?: string` field on DockerError + a generic hint renderer would be
  the cleaner expression).
- **The JSON BigInt reviver's swallowed SyntaxError was a real outage cause once**: throwing-out
  bubbled into the state-store loader's IO error path, which silently rewrote the state file empty.
  Defensive recovery is load-bearing here.
- **169 span/annotation call sites with no default tracer Layer wired** is pure overhead. Spans
  should either have a default dev-mode sink (`DEVSTACK_TRACE=1` console-pretty span sink) or be
  pruned.
- **Path-display lives in observability but is used in ONE site** (codegen's primary URL). The
  shortening rules are over-engineered for their current use; could be lifted into every
  log-formatting call site, OR deleted, but should not stay one-off.
- **The error-class inventory used by the conformance test is hand-maintained and silently drifts**
  (one class — the manifest shape error — is currently omitted). A barrel + import-based inventory
  would eliminate this drift class.
- **Tests partially duplicate** between the non-streaming and streaming capture suites (8 cases
  verbatim repeated). Drift risk.

## Cross-component references

- **Engine core** owns the log buffer, the per-tag `lastLog` projection, the engine-side cause
  summarizer, the `LOG_BUFFER_LIMIT` constant, and the EngineHandle shape that exposes log-write
  methods. Engine core also owns the `Identity` service that the span annotation helper depends on.
- **Engine resources / scheduler** consume the renderer factory's `loggerLayer` per cycle, mount the
  renderer on the outer scope, resolve the renderer kind from CLI / config / TTY detection.
- **Sui (and every per-service primitive)** wraps `CaptureError` from the capture helpers into its
  own envelope, threads `cause:` through, calls `annotateDevstackContext` for the standard triple.
- **State store, manifest emitter, codegen emitter, cache-key derivation** consume the JSON BigInt
  codec for round-trippable persistence / hashing.
- **CLI** consumes the structured JSON projection for `--json` envelopes and the multi-line render
  at the top-level `tapCause`. CLI also owns the already-reported sentinel that suppresses the outer
  renderer.
- **TUI** consumes the log buffer, per-tag `lastLog`, per-tag error summary; provides the logger
  bridge (`TuiLoggerLayer`) that lives in the TUI module today but logically belongs with the engine
  / observability layer.
- **Plain renderer** consumes the log buffer via the same logger bridge as TUI; writes diff frames
  to the platform Stdio stderr.
- **Plugin-author surface** mints additional tagged errors that participate in the same render path
  automatically (no central registration required).

## Open questions / decisions deferred

- Should the per-service error classes live with their owning service (`services/<name>/errors.ts`)
  rather than in one central file? (Strong yes from current pain points; deferred to new design.)
- Should the closed-phase tuples co-locate with their error class, or with the service module that
  produces the phases?
- Should the runtime error-conformance test enumerate errors via a barrel rather than a
  hand-maintained list?
- Should `prettyError` be split into "deepest message" + "full tree" helpers so the engine's row
  summarizer can reuse the same walker?
- Should the Docker-down hint move onto `DockerError` as a structured `hint?: string` field, with a
  generic hint renderer in pretty-error?
- Should `stringifyCause` be removable by making `message: Schema.String` optional on every error
  class (or always-derived)?
- What owns the `detail` field that the walker reads but no central error declares?
- Should the log buffer cap be env-tunable (`DEVSTACK_LOG_BUFFER_LIMIT`) for long-running sessions?
- Should the renderer factory's `mount` and `loggerLayer` be split? (They are coupled today; a
  fourth "silent-mount + buffered-logger" kind would be needed otherwise.)
- Should `appendLog` / `appendTagLog` move off `EngineHandle` into a separate `LogSink` service?
- Should the renderer mount receive a narrow `engineRef` rather than the raw `tuiStateRef`
  (eliminates the asymmetry between TUI's proxy install and plain's direct ref-read)?
- Should a default tracer Layer be wired in dev mode so the 169 span call sites are observable
  without the user supplying one?
- Should `causeToJson`'s `{ value }` fallback apply the BigInt codec to defend against
  `JSON.stringify` throwing on bigints in user-thrown payloads?
- Should `displayPath` be lifted into every log-emitting / error- rendering call site, or deleted?
- Should the streaming variant guarantee a trailing newline in `result.stdout` (matching the
  non-streaming variant), or formally document the missing-trailing-newline difference at the API
  boundary?

## Opportunities noticed

- **Split the error catalogue along subsystem boundaries.** Per-service errors with their owning
  service; manifest/config errors with runtime; fork-mode context errors with the sui-fork
  subsystem; subprocess wrappers stay close to the engine. Closed-phase tuples follow the same
  split.
- **Replace the hand-maintained conformance inventory with a barrel re-export + glob-driven test.**
  Eliminates inventory drift.
- **Introduce a shared "deepest message / first-line" helper** in the observability layer that both
  the engine row summarizer and any short-string consumer can call. Drops the duplicate walker in
  the engine.
- **Move `TuiLoggerLayer` out of the TUI module** into the observability layer (or into the renderer
  factory). Zero ink/React dependency; co-located by accident.
- **Lift the Docker-down augmentation into the Docker subsystem** as a structured `hint?: string`
  field on its error envelope; render generically.
- **Provide a default span sink** (e.g. a dev-mode console-pretty tracer Layer gated on `--trace` /
  `DEVSTACK_TRACE=1`) so the 169 span call sites stop being pure overhead.
- **Deduplicate the capture-command test suites** by sharing fixtures between the streaming and
  non-streaming variants.
- **Hoist `LOG_BUFFER_LIMIT` next to other env-tunable defaults** and expose a
  `DEVSTACK_LOG_BUFFER_LIMIT` override.
- **Decouple `appendLog` / `appendTagLog` from `EngineHandle`** by introducing a separate `LogSink`
  service; the engine then consumes the sink for on-fail writes and per-tag projection. Lets the TUI
  proxy shed its log-shim forwarding.
- **Unify `RendererMountDeps` and the per-cycle engine handle** so there's one consistent way the
  renderer reads cycle state (currently TUI installs an engine proxy while plain reads the raw ref).
- **Decide on `stringifyCause`'s fate**: either delete (after making `message` optional / derived on
  the error classes) or formalize as a stable export.
- **Add walker support for additional structured fields per error class** (the `feed` / `database` /
  `account` / `keyServer` / `component` / `pool` / etc. fields that the pretty walker silently drops
  today). Either generic ("walk any string-valued field beyond the fixed set") or per-class ("class
  declares its renderable fields").
- **Document the `detail` field's owner — or remove it** from the walkers. Today it is silent
  surface area.
- **Lift `displayPath` into the rendering pipeline** so every path that surfaces in a log line or an
  error message is automatically shortened — OR delete it and inline the single consumer.
- **Reconsider whether plain mode should buffer through the engine log buffer at all**; today it
  does so only to share the `TuiLoggerLayer` with the TUI. A direct line-emitter would be simpler.
