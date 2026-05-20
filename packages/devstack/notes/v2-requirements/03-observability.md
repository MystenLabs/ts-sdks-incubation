# observability

## Purpose

The observability surface of devstack covers everything between "a failure
or a log line happens in some primitive build" and "the user sees a legible
explanation of it". It is the single source of truth for:

1. **Error taxonomy** — tagged `Schema.TaggedErrorClass` classes that flow
   through `Effect`'s error channel so callers can `catchTag('SuiError')` /
   `catchTag('DockerError')` without `instanceof` checks. The taxonomy
   doubles as the documentation of every lifecycle phase ("acquire sui
   localnet container", "pull walrus image", "publish package", …).
2. **Pretty-printing** — the multi-line walker that turns a nested
   `DockerError → SuiError → Effect Cause` chain into a human-readable
   tree with `phase`, `exitCode`, `stderr`, `stdout` surfaced per layer.
   The only thing standing between the user and a bare
   `devstack run failed: SuiError: ...` line.
3. **Cause-tree JSON projection** — the same walker but emitting a
   structured `CauseJson` shape so `--json` CLI consumers can branch on
   `_tag` / `exitCode` / `stderr` without parsing a multi-line string.
4. **Subprocess output capture** — `captureCommand` and its streaming /
   or-fail siblings. Every subprocess in devstack (docker CLI, sui CLI,
   tar, host-scripts, …) drains stdout + stderr + exit code through this
   single helper; per-callsite wrappers `Effect.mapError` into their own
   `DockerError` / `SuiCliError` / `SnapshotError` envelope.
5. **Log buffer + per-tag attribution** — the `LOG_BUFFER_LIMIT`-bounded
   ring of `TuiLog` entries that backs both the TUI dashboard and the
   plain-mode line emitter. `appendLog` / `appendTagLog` are the engine
   surface every primitive uses to push log lines into one shared
   buffer; the renderer factory decides where those lines surface.
6. **Spans / tracing annotations** — `Effect.withSpan` calls and
   `annotateCurrentSpan` annotations, plus the
   `annotateDevstackContext(service)` helper that stamps the
   `service.name` / `devstack.stack` / `devstack.app` triple every
   primitive's build effect inherits.
7. **JSON BigInt codec** — lossless `{ __bigint: "<string>" }` tagged
   shape used by every component that persists or hashes state (state
   store, manifest emitter, codegen emitter, cache key derivation).
8. **Path-display formatting** — relativize absolute filesystem paths
   against `cwd` / `$HOME` so log rows aren't dominated by machine-
   specific path prefixes.
9. **Cause stringification** — one-line summary helper that wraps
   `prettyError` for callers that want a short label on a log line or
   on their outer `message` field.

Other docs cover the engine state machine, scheduler, per-service
semantics, and TUI rendering. This doc covers the **shape** of the
observability surface — what each error class carries, what
`prettyError` emits, what `captureCommand` returns — without
re-documenting why a particular `SuiError` gets thrown (per-service docs)
or how the TUI lays out the log panel (TUI doc).

## Current implementation

File-by-file inventory of the observability surface. Line counts are
approximate (current `wc -l`).

### Errors (taxonomy + closed-set phase registry)

| File | LOC | Summary |
|------|-----|---------|
| `engine/errors.ts` | 413 | The 20 exported `Schema.TaggedErrorClass` definitions. Mixes engine-level errors (`ConfigLoadError`, `ManifestDiscoveryError`, `ManifestShapeError`, `ManifestError`) with per-service errors (`SuiError`, `WalrusError`, `SealError`, `DeepbookError`, `DeepbookIndexerError`, `DeepbookServerError`, `PythError`, `PostgresError`, `AccountError`, `PublishError`, `WalletAppError`), subprocess wrappers (`DockerError`, `HostProcessError`), fork-mode context errors (`ForkUnsupportedError`, `ForkIncompatibleError`, `SeedManifestMismatchError`). Imports `*Phases` constants from `phases.ts`. |
| `engine/phases.ts` | 211 | Closed-set tuples of phase literals (`SuiPhases`, `AccountPhases`, `PublishPhases`, `WalrusPhases`, `SealPhases`, `DeepbookPhases`, `PythPhases`, `PostgresPhases`, `DeepbookIndexerPhases`, `DeepbookServerPhases`, `WalletAppPhases`, `ManifestPhases`, `ManifestDiscoveryPhases`, `ConfigLoadPhases`, `SuiCliPhases`, `CodegenPhases`). Two explicit open-string exceptions documented: `DockerError`, `HostProcessError`. |
| `engine/errors.test.ts` | 150 | AST walker that asserts every `*Error.fields.phase.ast` is either missing (3 grandfathered no-phase errors), a `Schema.Literals(...)` closed union, or one of the two grandfathered open-string exceptions (`DockerError`, `HostProcessError`). The AGENTS.md rule turned into a runtime guard. |

### Pretty-error + cause stringify

| File | LOC | Summary |
|------|-----|---------|
| `engine/pretty-error.ts` | 261 | Two public functions: `prettyError(value: unknown) → string` (multi-line tree) and `causeToJson(value: unknown) → CauseJson` (structured JSON projection). Walks tagged errors (via `_tag` duck-typing), Effect `Cause` (via `reasons` array duck-typing), and plain `Error` (via `instanceof`). Truncates `stderr`/`stdout`/`detail` to 8192 bytes. Front-loads a "Docker daemon unreachable" hint when the tree contains one of four docker-down tell strings. |
| `engine/pretty-error.test.ts` | 219 | 8 `prettyError` cases + 5 `causeToJson` cases (see Test coverage section). |
| `engine/stringify-cause.ts` | 17 | One-liner: `stringifyCause(cause) = prettyError(cause).split('\n')[0] ?? ''`. Retained ONLY for services that still wrap inner failures into a single message string (per the file's own header comment). |

### Subprocess capture

| File | LOC | Summary |
|------|-----|---------|
| `engine/capture-command.ts` | 328 | Four exported functions (`captureCommand`, `captureCommandOrFail`, `captureCommandStreaming`, `captureCommandStreamingOrFail`) + one error class (`CaptureError`) + one stream-decoder helper (`decodeStream`). Spawns via Effect's `ChildProcessSpawner.spawn`, drains stdout/stderr concurrently, captures exit code. Streaming variant uses `Stream.splitLines` for the per-line callback. Default stderr truncation is 500 bytes; stdout default is `Infinity`. |
| `engine/capture-command.test.ts` | 202 | 6 `captureCommand` cases + 2 `captureCommandOrFail` cases. Uses a fake `ChildProcessSpawner` layer with canned responses. |
| `engine/capture-command.streaming.test.ts` | 409 | Duplicates the non-streaming tests (6 + 2) and adds 7 streaming cases + 2 `captureCommandStreamingOrFail` cases. The duplicated non-streaming tests are a near-copy of `capture-command.test.ts`. |

### JSON BigInt + display path

| File | LOC | Summary |
|------|-----|---------|
| `engine/json-bigint.ts` | 30 | Two functions: `jsonBigintReplacer` (encodes `bigint` → `{ __bigint: "<string>" }`) and `jsonBigintReviver` (decodes back; swallows `BigInt('foo')` SyntaxError and returns the tagged shape verbatim instead of bubbling out). |
| `engine/json-bigint.test.ts` | 59 | 5 round-trip cases — BigInt edges, mixed payloads, invalid `__bigint`, look-alike tags. |
| `engine/display-path.ts` | 72 | `displayPath(input: string) → string`. Relativizes to cwd if within ≤3 parent climbs; else home-relative with `~`; else absolute. Cross-platform via `node:path`. |

### Spans + renderer routing

| File | LOC | Summary |
|------|-----|---------|
| `engine/observability.ts` | 34 | Single export: `annotateDevstackContext(service: string)` — stamps three keys (`service.name`, `devstack.stack`, `devstack.app`) on the current span via `Effect.annotateCurrentSpan`. Requires `Identity` in R. |
| `engine/renderer.ts` | 84 | Three types (`RendererKind`, `RendererMount`, `RendererFactory`) + one resolver type (`RendererResolver`) + one concrete factory (`silentRendererFactory`). Contract the supervisor consumes for status rendering. |

### Log buffer + attribution (data flow only — TUI presentation is OUT of scope)

| File | LOC | Summary |
|------|-----|---------|
| `engine/engine.ts` | 820 | Owns the `LOG_BUFFER_LIMIT = 200` constant, the `appendLog` / `appendTagLog` methods on `EngineHandleShape`, the `ERROR_SUMMARY_MAX = 80` cap on per-tag error summaries, and the `extractDeepestMessage` / `summarizeCause` walker that turns a `Cause<unknown>` into the one-line row summary. Engine state-machine details are out of scope for THIS doc. |
| `engine/tui-state.ts` | 140 | Defines the `TuiLog` shape (`{ ts: number; level: string; message: string }`) and the wider `TuiState` shape that holds the log buffer. Read-only-here; TUI doc covers the presentational types. |

## Configuration

The observability surface has **almost no env-var configuration**. The few
present are:

| Env var | Effect | Default | Source |
|---------|--------|---------|--------|
| `DEVSTACK_JSON` | `'1'` or `'true'` flips every CLI subcommand into JSON-envelope mode (uses `causeToJson` for the `error.cause` field instead of `prettyError`). Honored alongside the `--json` flag. | unset → human output | `cli/envelope.ts:104` (`jsonModeEnabled`) |
| `DEVSTACK_NO_INPUT` | `'1'` or `'true'` disables interactive prompts. Affects observability indirectly by routing prompt-required failures into the JSON envelope as `code: 'CONFIRM_REQUIRED'`. | unset → prompts allowed | `cli/envelope.ts:113` (`inputDisabled`) |

CLI `--renderer` flag selects the renderer kind directly; defaults to
`'tui'` when `process.stdout.isTTY === true`, `'plain'` otherwise.
Source: `engine/supervisor.ts:271-273` (`resolveRendererKind`).

There are **no** observability env vars for:
- Verbosity (no `DEVSTACK_VERBOSE`, no `DEBUG`, no `--quiet`)
- Color (no `NO_COLOR` / `FORCE_COLOR` handling in any pretty-error or
  renderer module — `grep -rn` returns zero hits in `src/`)
- Log levels (every `Effect.log*` call routes through the same logger
  layer; the engine's `appendLog` records `level` as a string but does
  no filtering)
- Trace sampling (no `OTEL_*` reads in any module under `engine/` or
  `tui/`)

The renderer is the only observability axis that can be overridden at
runtime; everything else is hard-coded in source.

## Capabilities CONSUMED

The observability surface depends on the following capabilities. Each
citation is `file:line` from the current codebase.

### From Effect

- `Cause` (the `Cause.Cause<E>` value type, `Cause.pretty`,
  `Cause.fail`, `Cause.die`, `Cause.prettyErrors`).
  - `engine/pretty-error.ts:13` (`import { Cause } from 'effect'`)
  - `engine/pretty-error.ts:122, 135` (`Cause.pretty(...)`)
  - `engine/engine.ts:23` (imports `Cause`)
  - `engine/engine.ts:381, 386` (`Cause.prettyErrors`, `Cause.pretty`)
- `Effect.gen` + `Effect.scoped` + `Effect.all` + `Effect.mapError` +
  `Effect.fail` + `Effect.flip` + `Effect.serviceOption` +
  `Effect.provide` + `Effect.annotateCurrentSpan` + `Effect.withSpan` +
  `Effect.ignore` + `Effect.catchCause`.
  - Pervasive across all observability files.
- `Schema.TaggedErrorClass`, `Schema.String`, `Schema.Number`,
  `Schema.optional`, `Schema.Defect`, `Schema.Literals`, `Schema.Struct`.
  - `engine/errors.ts:1` (`import { Schema } from 'effect'`)
  - All 20 error classes use `Schema.TaggedErrorClass<X>()('X', { … })`.
  - `engine/capture-command.ts:30` (`import { Effect, Schema, Stream } from 'effect'`)
  - `engine/capture-command.ts:60` (`CaptureError` uses the same pattern)
- `Stream` (decode UTF-8 bytes, fold lines, split lines, tap).
  - `engine/capture-command.ts:30, 138-139` (`Stream.mkString`, `Stream.decodeText`)
  - `engine/capture-command.ts:240-242` (`Stream.splitLines`, `Stream.tap`)
  - `engine/capture-command.ts:251-255` (`Stream.runFold`)
- `Layer` (the renderer factory's `loggerLayer` returns
  `Layer.Layer<never, never, never>`; the silent factory returns
  `Layer.empty`).
  - `engine/renderer.ts:23, 77`
  - `tui/index.ts:285-303` (`TuiLoggerLayer` builds a `Logger.layer`)
- `Logger.make` + `Logger.layer` — the bridge between Effect's
  `Effect.log*` calls and the engine's `appendLog`.
  - `tui/index.ts:17, 286, 302`
- `Ref.Ref<TuiState>` — the engine's mutable log buffer is a `Ref`.
  - `engine/engine.ts:23, 412-820`

### From Effect's unstable platform

- `effect/unstable/process` — `ChildProcess.Command`,
  `ChildProcessSpawner` (`spawn`, `makeHandle`, `ProcessId`, `ExitCode`,
  `make`).
  - `engine/capture-command.ts:31`
- `effect/Stdio` — the `Stdio.Stdio` service the plain renderer writes
  stderr through.
  - `engine/renderer.ts:23` (`type Stdio` in `RendererMountServices`)
  - `tui/plain.ts:35, 262`
- `effect/Scope` — the renderer factory's `mount` returns inside a
  `Scope` so its lifetime can be tied to the supervisor scope.
  - `engine/renderer.ts:23, 52`

### From Node.js

- `node:path` — used by `displayPath` (`path.isAbsolute`, `path.relative`,
  `path.sep`).
  - `engine/display-path.ts:24`
- `node:os` — `homedir()` for the `~`-relative rule.
  - `engine/display-path.ts:25, 30-34`
- `process.cwd()`, `process.stdout.isTTY`, `process.env.DEVSTACK_JSON`,
  `process.env.DEVSTACK_NO_INPUT`.
  - `engine/display-path.ts:46`
  - `engine/supervisor.ts:273` (`process.stdout.isTTY === true`)
  - `cli/envelope.ts:104, 113`
- **No direct Node `child_process` imports** — every spawn goes through
  Effect's `ChildProcessSpawner` service. Confirmed by `grep -rn
  "child_process"` returning zero hits inside `engine/`.

### Terminal / TTY detection

- `process.stdout.isTTY` — sole TTY check, lives in
  `engine/supervisor.ts:273` (renderer-kind defaulting).
- No `tty.isatty(...)`, no `process.stderr.isTTY` reads anywhere in
  the observability surface.

### ANSI color libs

- **None imported.** `grep -rn "chalk\|kleur\|picocolors\|colorette\|ansi-"`
  in `engine/` and `tui/` returns no consumers in the observability
  modules. The TUI uses ink's own color attributes; `pretty-error.ts`
  emits zero ANSI escape sequences.

### Other engine modules

- `engine/phases.ts` ← imported by `engine/errors.ts` for every closed-
  set phase tuple.
- `engine/identity.ts` ← imported by `engine/observability.ts:17` for
  the `Identity` service that `annotateDevstackContext` reads
  `stack` / `app` from.
- `engine/engine.ts` ← imports `engine/tui-state.ts` (the `TuiLog` /
  `TuiState` types) and `advanced/tag.ts` (the `TagKind` / `TuiDisplay`
  types) but does NOT import any of the pretty-error / cause-stringify
  helpers. The engine's `summarizeCause` is a private helper that
  walks `.cause` chains itself rather than calling `prettyError`. See
  Pain points below.
- `engine/renderer.ts` ← imports `engine/engine.ts` (the
  `EngineHandleShape` type for `loggerLayer`'s parameter) and
  `engine/tui-state.ts` (the `TuiState` type for `tuiStateRef`).
- `engine/stringify-cause.ts` ← imports `engine/pretty-error.ts`
  (`prettyError`) and produces a single-line projection.
- `advanced/tag.ts` ← imports `engine/observability.ts`
  (`annotateDevstackContext`) and `engine/pretty-error.ts`
  (`prettyError`).

## Capabilities PRODUCED

### Error taxonomy (exhaustive inventory)

The complete list of `Schema.TaggedErrorClass` definitions exported from
`engine/errors.ts`. **20 classes total.** Each row lists the tag string
that `_tag` produces (used by `catchTag('<tag>')`), every field with its
type, which files construct it, and which files catch it. Catches found
via `grep -rn "catchTag('<TagName>'"` in `src/`.

#### `ForkUnsupportedError`

- **Tag:** `'ForkUnsupportedError'`
- **Fields:**
  - `surface: Schema.String` — the unsupported method name (`'getBalance'`, `'listBalances'`, `'getCoinInfo'`, `'simulate_transaction'`, …).
  - `message: Schema.String`
  - `hint?: Schema.String` — one-line workaround text.
  - `cause?: Schema.Defect`
- **Phase field:** none (grandfathered into `NO_PHASE_FIELD`).
- **Thrown by:** Sui-fork client proxy wrapping (`services/sui/impersonate.ts`, `services/sui.fork.test.ts` adjacent code).
- **Caught by:** No `catchTag('ForkUnsupportedError')` in `src/`. Falls through to top-level `cli/index.ts:cli` `tapCause` pretty-printer.
- **Source:** `engine/errors.ts:34-42`

#### `SeedManifestMismatchError`

- **Tag:** `'SeedManifestMismatchError'`
- **Fields:**
  - `metaPath: Schema.String` — the on-disk `.devstack/stacks/<stack>/sui-fork/meta.json` path.
  - `message: Schema.String`
  - `previous?: Schema.Struct({ upstream?, checkpoint?, configHash? })` — the on-disk snapshot.
  - `current?: Schema.Struct({ upstream?, checkpoint?, configHash? })` — the current-config snapshot.
  - `cause?: Schema.Defect`
- **Phase field:** none (grandfathered into `NO_PHASE_FIELD`).
- **Thrown by:** `engine/sui-fork/meta.ts` (apply-time mismatch gate); rethrow path in `services/sui.ts:1704` (`Effect.catchTag('SeedManifestMismatchError', (cause) => Effect.fail(cause))`).
- **Caught by:** `cli/commands/apply.fork-seed-mismatch.test.ts` (test); `cli/commands/fork.ts:118` (`Effect.catchTags`).
- **Source:** `engine/errors.ts:66-87`

#### `ForkIncompatibleError`

- **Tag:** `'ForkIncompatibleError'`
- **Fields:**
  - `variant: Schema.String` — offending factory name (`'walrusLocalCluster'`, `'sealLocalKeygen'`).
  - `network: Schema.String` — `*-fork` literal.
  - `message: Schema.String`
  - `hint?: Schema.String`
  - `cause?: Schema.Defect`
- **Phase field:** none (grandfathered into `NO_PHASE_FIELD`).
- **Thrown by:** Walrus + Seal local-cluster factory time guards (`services/walrus/local-cluster.ts`, `services/seal/internal.ts`).
- **Caught by:** No `catchTag('ForkIncompatibleError')` in `src/`. Surfaces via tapCause.
- **Source:** `engine/errors.ts:112-121`

#### `SuiError`

- **Tag:** `'SuiError'`
- **Fields:**
  - `phase?: Schema.Literals(SuiPhases)` — closed set of 14 literals: `'network-create'`, `'postgres-up'`, `'sui-up'`, `'ready-probe'`, `'fetch-chainId'`, `'indexer-ready'`, `'wait-for-transactions-ready'`, `'fork-lock'`, `'fork-status'`, `'fork-advance-clock'`, `'fork-advance-checkpoint'`, `'fork-impersonate'`, `'fork-unsupported'`, `'fork-meta'`.
  - `message: Schema.String`
  - `stderr?: Schema.String` — captured subprocess stderr.
  - `stdout?: Schema.String` — captured subprocess stdout.
  - `exitCode?: Schema.Number`
  - `cause?: Schema.Defect`
- **Thrown by:** `services/sui.ts` (many sites: ~530, 888, 926, 935, 1036, 1045, 1704, 1718, 1780, 1789, …), `services/sui/impersonate.ts`, `engine/sui-fork/control.ts`, `engine/sui-fork/file-lock.ts`, `engine/sui-fork/meta.ts`, `engine/sui-fork.testkit.ts`, `engine/sui-fork.container.docker.test.ts`.
- **Caught by:** `services/account.ts:498` (catches `SuiError` from `Sui` build), `services/account.ts:966`.
- **Source:** `engine/errors.ts:123-138`

#### `AccountError`

- **Tag:** `'AccountError'`
- **Fields:**
  - `phase: Schema.Literals(AccountPhases)` — required closed set: `'load-key'`, `'decode-key'`, `'write-key'`, `'fund'`.
  - `account?: Schema.String` — account ref the failure was for.
  - `message: Schema.String`
  - `cause?: Schema.Defect`
- **Thrown by:** `services/account.ts`, `services/account.fork.test.ts`, `services/account.test.ts`.
- **Caught by:** No `catchTag('AccountError')` in `src/`. Surfaces via tapCause.
- **Source:** `engine/errors.ts:140-149`

#### `PublishError`

- **Tag:** `'PublishError'`
- **Fields:**
  - `phase?: Schema.Literals(PublishPhases)` — closed set: `'hash'`, `'scrub'`, `'build'`, `'publish-tx'`, `'parse'`, `'register-coins'`.
  - `packageName?: Schema.String`
  - `sourcePath?: Schema.String` — on-disk path of the Move sources.
  - `message: Schema.String`
  - `cause?: Schema.Defect`
- **Thrown by:** the package publish pipeline (`services/sui.ts`, `services/coin.ts` adjacent code).
- **Caught by:** No `catchTag('PublishError')` in `src/`. Surfaces via tapCause.
- **Source:** `engine/errors.ts:151-165`

#### `HostProcessError`

- **Tag:** `'HostProcessError'`
- **Fields:**
  - `phase?: Schema.String` — **open-string** (grandfathered): the host-script command string (`'sui move build'`, `'sui client publish'`, `'pnpm dev'`, …).
  - `message: Schema.String`
  - `stderr?: Schema.String`
  - `stdout?: Schema.String`
  - `exitCode?: Schema.Number`
  - `cause?: Schema.Defect`
- **Thrown by:** `advanced/plugin-author/host-script.ts`.
- **Caught by:** No `catchTag('HostProcessError')` in `src/`. Surfaces via tapCause.
- **Source:** `engine/errors.ts:167-187`

#### `DockerError`

- **Tag:** `'DockerError'`
- **Fields:**
  - `phase?: Schema.String` — **open-string** (grandfathered): the docker invocation (`'docker run'`, `'docker rm'`, `'docker pull'`, …), router-internal labels (`'router.dynamic-dir'`), or interpolated network names.
  - `message: Schema.String`
  - `stdout?: Schema.String` — truncated to ~1KB upstream by the captureCommand wrappers.
  - `stderr?: Schema.String`
  - `exitCode?: Schema.Number`
  - `cause?: Schema.Defect`
- **Thrown by:** every `engine/docker/*.ts` module (`core.ts`, `image.ts`, `network.ts`, `wrap.ts`, `router.ts`, `logs.ts`, `exec.ts`, `ensure-container.ts`); `advanced/plugin-author/docker-image.ts`, `advanced/plugin-author/docker-container.ts`, `advanced/plugin-author/docker-one-shot.ts`; `engine/sui-build-container.ts`.
- **Caught by:** ~25 `catchTag('DockerError', ...)` sites across `services/*` and `advanced/plugin-author/*` — every primitive that uses Docker wraps the inner `DockerError` into its own envelope (`SuiError`, `WalrusError`, `SealError`, `PostgresError`, …). Also `engine/docker/core.ts` and `engine/docker/router.ts` swallow `DockerError` to `Effect.succeed(null)` for opportunistic operations (e.g. "remove if exists").
- **Source:** `engine/errors.ts:189-213`

#### `WalletAppError`

- **Tag:** `'WalletAppError'`
- **Fields:**
  - `phase: Schema.Literals(WalletAppPhases)` — required closed set: `'listen'`.
  - `message: Schema.String`
  - `cause?: Schema.Defect`
- **Thrown by:** `services/wallet/internal.ts`.
- **Caught by:** No `catchTag('WalletAppError')` in `src/`. Surfaces via tapCause.
- **Source:** `engine/errors.ts:215-221`

#### `ManifestError`

- **Tag:** `'ManifestError'`
- **Fields:**
  - `phase: Schema.Literals(ManifestPhases)` — required closed set: `'write'`.
  - `message: Schema.String`
  - `cause?: Schema.Defect`
- **Thrown by:** `runtime/manifest-emit.ts`.
- **Caught by:** No `catchTag('ManifestError')` in `src/`. Surfaces via tapCause.
- **Source:** `engine/errors.ts:223-229`

#### `ManifestDiscoveryError`

- **Tag:** `'ManifestDiscoveryError'`
- **Fields:**
  - `phase: Schema.Literals(ManifestDiscoveryPhases)` — required closed set: `'walk-up'`, `'required-missing'`.
  - `path?: Schema.String` — the candidate walk-up path.
  - `message: Schema.String`
  - `cause?: Schema.Defect`
- **Thrown by:** `runtime/discover-manifest.ts`.
- **Caught by:** `cli/commands/status.ts:68, 73` (`Effect.catchTag('ManifestDiscoveryError', ...)`); `cli/commands/manifest.ts:131` (`Effect.catchTags`).
- **Source:** `engine/errors.ts:243-255`

#### `ManifestShapeError`

- **Tag:** `'ManifestShapeError'`
- **Fields:**
  - `phase: Schema.Literals(['parse', 'shape'])` — required closed set.
  - `path: Schema.String` — required absolute path of the manifest.
  - `message: Schema.String`
  - `cause?: Schema.Defect`
- **Thrown by:** `runtime/read-stack-context.ts`.
- **Caught by:** No `catchTag('ManifestShapeError')` in `src/`. Surfaces via tapCause / Schema decoder boundary.
- **Source:** `engine/errors.ts:269-280`
- **OPEN QUESTION:** This class is **not in the `allErrors` table** in `errors.test.ts:73-93` — the test does not run the phase-conformance check against it. The class still passes by construction (closed `Schema.Literals(['parse', 'shape'])`), but it's an inventory omission in the test.

#### `ConfigLoadError`

- **Tag:** `'ConfigLoadError'`
- **Fields:**
  - `phase: Schema.Literals(ConfigLoadPhases)` — required closed set: `'load'`, `'validate'`, `'missing-default-export'`, `'invoke'`.
  - `configPath?: Schema.String` — resolved absolute path.
  - `expected?: Schema.String` — one-line description of the expected shape.
  - `message: Schema.String`
  - `cause?: Schema.Defect`
- **Thrown by:** `cli/loaders.ts`.
- **Caught by:** No explicit `catchTag('ConfigLoadError')`. Surfaces via tapCause.
- **Source:** `engine/errors.ts:299-305`

#### `WalrusError`

- **Tag:** `'WalrusError'`
- **Fields:**
  - `phase?: Schema.Literals(WalrusPhases)` — closed set: `'image'`, `'network'`, `'deploy'`, `'exchange'`, `'nodes'`, `'proxy'`, `'seed'`.
  - `component?: Schema.String` — `'aggregator'`, `'publisher'`, `'storage'`, `'admin'`, …
  - `message: Schema.String`
  - `stderr?: Schema.String`
  - `stdout?: Schema.String`
  - `exitCode?: Schema.Number`
  - `cause?: Schema.Defect`
- **Thrown by:** `services/walrus/*` (`image.ts`, `deploy.ts`, `nodes.ts`, `local-cluster.ts`, `internal.ts`).
- **Caught by:** No `catchTag('WalrusError')` in `src/`. Surfaces via tapCause.
- **Source:** `engine/errors.ts:307-323`

#### `SealError`

- **Tag:** `'SealError'`
- **Fields:**
  - `phase?: Schema.Literals(SealPhases)` — closed set: `'port-alloc'`, `'image'`, `'keygen'`, `'publish'`, `'register'`, `'config-render'`, `'container'`, `'ready'`, `'rotate'`, `'seal'`.
  - `keyServer?: Schema.String`
  - `message: Schema.String`
  - `stderr?: Schema.String`
  - `stdout?: Schema.String`
  - `exitCode?: Schema.Number`
  - `cause?: Schema.Defect`
- **Thrown by:** `services/seal/internal.ts` (many sites).
- **Caught by:** `services/seal/internal.ts:1092` (`Effect.catchTag('SealError', Effect.fail)` — re-fail pattern keeping the typed channel).
- **Source:** `engine/errors.ts:325-341`

#### `DeepbookError`

- **Tag:** `'DeepbookError'`
- **Fields:**
  - `phase?: Schema.Literals(DeepbookPhases)` — closed set: `'publish'`, `'create-pools'`, `'market-maker-tick'`, `'deepbook'`, `'deepbookMarketMaker'`, `'margin-publish'`, `'margin-setup'`, `'margin-pools'`, `'margin-seed'`.
  - `pool?: Schema.String`
  - `marginAsset?: Schema.String` — `'USDC'`, `'SUI'`, …
  - `feed?: Schema.String` — Pyth feed hex id.
  - `message: Schema.String`
  - `cause?: Schema.Defect`
- **Thrown by:** `services/deepbook/*` (`internal.ts`, `market-maker.ts`, `margin.ts`, `margin-seed.ts`).
- **Caught by:** `services/deepbook/market-maker.ts:519, 562`, `services/deepbook/margin.ts:519`, `services/deepbook/margin-seed.ts:175` — all `Effect.catchTag('DeepbookError', Effect.fail)` re-fail patterns.
- **Source:** `engine/errors.ts:343-360`

#### `PythError`

- **Tag:** `'PythError'`
- **Fields:**
  - `phase?: Schema.Literals(PythPhases)` — closed set: `'publish'`, `'create-feeds'`, `'pusher-fetch'`, `'pusher-update'`, `'pyth'`.
  - `feed?: Schema.String` — Pyth feed hex id.
  - `message: Schema.String`
  - `cause?: Schema.Defect`
- **Thrown by:** `services/pyth/*` (`local-deploy.ts`, `mid.ts`, `pusher.ts`).
- **Caught by:** `services/pyth/pusher.ts:422` (re-fail pattern).
- **Source:** `engine/errors.ts:362-372`

#### `PostgresError`

- **Tag:** `'PostgresError'`
- **Fields:**
  - `phase?: Schema.Literals(PostgresPhases)` — closed set: `'image'`, `'port-alloc'`, `'container'`, `'ready'`, `'createdb'`, `'postgres'`.
  - `database?: Schema.String` — `'deepbook'`, …
  - `message: Schema.String`
  - `stderr?: Schema.String`
  - `stdout?: Schema.String`
  - `exitCode?: Schema.Number`
  - `cause?: Schema.Defect`
- **Thrown by:** `services/postgres.ts`, `services/postgres/internal.ts`.
- **Caught by:** `services/postgres.ts:282` (re-fail pattern).
- **Source:** `engine/errors.ts:374-386`

#### `DeepbookIndexerError`

- **Tag:** `'DeepbookIndexerError'`
- **Fields:**
  - `phase?: Schema.Literals(DeepbookIndexerPhases)` — closed set: `'image'`, `'port-alloc'`, `'container'`, `'ready'`, `'indexer'`.
  - `message: Schema.String`
  - `stderr?: Schema.String`
  - `stdout?: Schema.String`
  - `exitCode?: Schema.Number`
  - `cause?: Schema.Defect`
- **Thrown by:** `services/deepbook/indexer.ts`.
- **Caught by:** `services/deepbook/indexer.ts:218` (re-fail pattern).
- **Source:** `engine/errors.ts:388-398`

#### `DeepbookServerError`

- **Tag:** `'DeepbookServerError'`
- **Fields:**
  - `phase?: Schema.Literals(DeepbookServerPhases)` — closed set: `'image'`, `'port-alloc'`, `'container'`, `'ready'`, `'server'`.
  - `message: Schema.String`
  - `stderr?: Schema.String`
  - `stdout?: Schema.String`
  - `exitCode?: Schema.Number`
  - `cause?: Schema.Defect`
- **Thrown by:** `services/deepbook/server.ts`.
- **Caught by:** `services/deepbook/server.ts:268` (re-fail pattern).
- **Source:** `engine/errors.ts:400-412`

### Tagged errors that live OUTSIDE `engine/errors.ts`

`pretty-error.ts` walks tagged errors structurally via `_tag` duck-typing
(`engine/pretty-error.ts:45-48`), so any class minted with
`Schema.TaggedErrorClass` is automatically rendered. The complete list of
**other** tagged errors that participate in the observability tree (i.e.
will get walked by `prettyError` and surfaced by the row's
`extractDeepestMessage`):

| Class | Tag | File | Notes |
|-------|-----|------|-------|
| `GitFetchError` | `'GitFetchError'` | `advanced/plugin-author/git-fetch.ts:24` | Plugin-author surface for `gitFetch(...)`. |
| `AlreadyReportedError` | `'AlreadyReportedError'` | `cli/already-reported.ts:11` | Sentinel that suppresses the top-level pretty-printer (CLI already rendered the error). |
| `PruneStackBlockedError` | `'PruneStackBlockedError'` | `cli/commands/_prune-stack.ts:21` | CLI prune-stack guard. |
| `CodegenError` | `'CodegenError'` | `codegen/errors.ts:9` | Wraps a codegen pipeline failure with `phase: Literals(CodegenPhases)`. |
| `SnapshotError` | `'SnapshotError'` | `engine/snapshot.ts:80` | Wraps snapshot-restore/create failures. |
| `FileWatcherError` | `'FileWatcherError'` | `engine/file-watcher.ts:29` | Wraps `chokidar`-style watcher boot failures. |
| `SuiHttpFaucetError` | `'SuiHttpFaucetError'` | `engine/faucet.ts:32` | Faucet HTTP failure mode. |
| `CaptureError` | `'CaptureError'` | `engine/capture-command.ts:60` | THE subprocess-capture error (covered above + below). |
| `StateStoreLockedError` | `'StateStoreLockedError'` | `engine/state-store.ts:73` | Concurrent state-store lock contention. |
| `StateStoreMigrationError` | `'StateStoreMigrationError'` | `engine/state-store.ts:83` | Migration during load. |
| `DepGraphError` | `'DepGraphError'` | `engine/dep-graph.ts:117` | Cycle / unresolvable upstream. |
| `PortAllocatorError` | `'PortAllocatorError'` | `engine/port-allocator.ts:35` | Port reservation failure. |
| `ProbeError` | `'ProbeError'` | `engine/chain-probe.ts:118` | Chain probe failure (recent migration from per-service code). |
| `ReadyProbeError` | `'ReadyProbeError'` | `engine/ready-probe.ts:58` | Generic ready-probe timeout. |
| `StageAndSwapError` | `'StageAndSwapError'` | `engine/stage-and-swap.ts:40` | Codegen output stage-and-swap failure. |
| `SuiCliError` | `'SuiCliError'` | `engine/sui-cli.ts:57` | Sui-CLI subprocess wrapping. |
| `CoinNotFoundError` | `'CoinNotFoundError'` | `services/coin.ts:49` | Coin lookup. |
| `CoinAmbiguousError` | `'CoinAmbiguousError'` | `services/coin.ts:68` | Coin lookup. |
| `FaucetRequestError` | `'FaucetRequestError'` | `services/faucet/index.ts:68` | Faucet request envelope. |

These are explicitly **not** documented exhaustively in THIS doc — their
schemas live with their owning subsystem. The pretty-error walker
handles them all uniformly because it doesn't import any of them by
name; it just checks for `_tag`-shaped objects (see Pain points below).

### Pretty-error API

```ts
export const prettyError = (value: unknown): string
```

- **Source:** `engine/pretty-error.ts:118-142`
- **Behaviour:** Multi-line tree. For each layer:
  - Header line: `<_tag> (<phase>): <message>` when `phase` is a string,
    else `<_tag>: <message>`.
  - One line for `exitCode: <n>` when present.
  - One line for `stderr: <trimmed-and-truncated>` when non-empty.
  - One line for `stdout: <trimmed-and-truncated>` when non-empty.
  - One line for `detail: <trimmed-and-truncated>` when non-empty.
  - If `cause` present and the rendered cause-block is non-empty AND not
    a one-line restatement of the header, emits `  caused by:` followed
    by the cause-block indented by 4 spaces.
- **Cause-walking algorithm:**
  - `null`/`undefined` → empty string.
  - `isCause(value)` (has `reasons: ReadonlyArray<...>`) → recurses into
    each reason:
    - `{ _tag: 'Fail', error: X }` → `prettyError(X)`.
    - `{ _tag: 'Die', defect: X }` → `prettyError(X)`.
    - `{ _tag: 'Interrupt' }` → string `'Interrupted'`.
    - empty `reasons` array → defers to `Cause.pretty(value)`.
    - Joined with `\n`.
  - `isTaggedError(value)` (has string `_tag`) → `renderTaggedError(value)`.
  - `value instanceof Error` → `value.stack` if non-trivial, else
    `<name>: <message>`.
  - Otherwise → `String(value)`.
- **Truncation:** `RENDER_FIELD_TRUNC = 8192` bytes; appended with
  `…[truncated]`. Cited at `engine/pretty-error.ts:19`.
- **Docker-down augmentation:** If the rendered text contains any of
  `'Cannot connect to the Docker daemon'`,
  `'connect ENOENT /var/run/docker.sock'`, `'Is the docker daemon running'`,
  or `'docker: command not found'`, prepends a two-line "Docker daemon
  unreachable. Start Docker Desktop / colima / your daemon and re-run."
  hint. Source: `engine/pretty-error.ts:152-169`.

### Cause-tree JSON API

```ts
export interface CauseJson {
  readonly _tag?: string;
  readonly message?: string;
  readonly phase?: string;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly stdout?: string;
  readonly detail?: string;
  readonly stack?: string;
  readonly cause?: CauseJson;
  readonly reasons?: ReadonlyArray<CauseJson>;
  readonly value?: unknown;
}
export const causeToJson = (value: unknown): CauseJson
```

- **Source:** `engine/pretty-error.ts:179-260`
- Mirrors `prettyError`'s structure but emits an object instead of a
  string. Used by `cli/commands/apply.ts:193` for the `--json` envelope.
- Same truncation rules (`RENDER_FIELD_TRUNC`, `…[truncated]`).
- For `Cause`: emits `{ _tag: 'Cause', reasons: [...] }`. Each reason is
  `{ _tag: 'Fail' | 'Die' | 'Interrupt', cause?: CauseJson }`.
- For unknown values: `{ value: <raw> }` (passes the raw `unknown`
  through — round-trip via `JSON.stringify` may lose precision for
  BigInt etc.; observability does NOT apply `jsonBigintReplacer` to
  `value`).
- For `Error` with own `cause`: includes `stack` field; recurses into
  the Node-standard `error.cause` field if present.

### Cause stringify API

```ts
export const stringifyCause = (cause: unknown): string
```

- **Source:** `engine/stringify-cause.ts:14-17`
- Returns `prettyError(cause).split('\n')[0] ?? ''` — i.e. ONLY the
  first line of the pretty render.
- Consumers (15+ sites): seal/pyth/wallet/coin/codegen/stage-and-swap.
  Used for `message:` fields where the structured render would blow up
  the row width — the actual structured chain is still threaded through
  `cause:` so the eventual `prettyError` walker can dig further.

### Capture-command APIs

#### `captureCommand`

```ts
export interface CaptureResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
export interface CaptureOptions {
  readonly op?: string;            // default = cmd.command (or 'piped-command')
  readonly stderrTruncate?: number; // default 500, Infinity disables
  readonly stdoutTruncate?: number; // default Infinity
}
export const captureCommand: (
  spawner: SpawnerService,
  cmd: ChildProcess.Command,
  opts?: CaptureOptions,
) => Effect.Effect<CaptureResult, CaptureError>
```

- **Source:** `engine/capture-command.ts:168-196`.
- **Failure modes:**
  - Spawn-itself failure (ENOENT, fork limit): `CaptureError({ op, stdout: '', stderr: '', cause: <spawner-error> })` with `exitCode` undefined.
  - Successful run (any exit code, zero or non-zero): resolves to `CaptureResult`. **Does NOT auto-fail on non-zero exit**; the caller branches on `result.exitCode`.
- **Drain semantics:** Uses `Effect.all([stdout-decode, stderr-decode, exitCode], { concurrency: 'unbounded' })` — all three drain concurrently. Each drain is `decodeStream(handle.stream)` = `Stream.mkString(Stream.decodeText(stream))`.

#### `captureCommandOrFail`

```ts
export const captureCommandOrFail: (
  spawner, cmd, opts?,
) => Effect.Effect<CaptureResult, CaptureError>
```

- **Source:** `engine/capture-command.ts:307-327`.
- Same as `captureCommand` but a non-zero exit becomes `CaptureError({ op, exitCode, stdout, stderr })` with `cause` undefined.

#### `captureCommandStreaming`

```ts
export interface CaptureStreamingOptions extends CaptureOptions {
  readonly onStdoutLine: (line: string) => Effect.Effect<void>;
}
export const captureCommandStreaming: (
  spawner, cmd, opts: CaptureStreamingOptions,
) => Effect.Effect<CaptureResult, CaptureError>
```

- **Source:** `engine/capture-command.ts:225-271`.
- **Drain semantics:** stdout goes through `Stream.decodeText() → Stream.splitLines → Stream.tap(onStdoutLine via Effect.ignore)` then folds back into a `\n`-joined string via `Stream.runFold`. Stderr drains via the same whole-string path as `captureCommand`. Callback errors are silently swallowed by `Effect.ignore` — narration must never abort the capture.
- **Captured stdout does NOT include a trailing newline** if the child's last write happens to have one (consumed by `splitLines`). This is documented behaviour; tests pin it (`capture-command.streaming.test.ts:279-298`).

#### `captureCommandStreamingOrFail`

- **Source:** `engine/capture-command.ts:280-300`.
- Composition: `captureCommandStreaming` + non-zero-exit promotion to `CaptureError`.

#### `decodeStream` (helper)

```ts
export const decodeStream: <E>(
  stream: Stream.Stream<Uint8Array, E>,
) => Effect.Effect<string, E>
```

- **Source:** `engine/capture-command.ts:138-139`.
- Exported because `engine/docker/exec.ts` needs it directly for a per-line / one-shot branching path that doesn't fit `captureCommand`'s "both streams at once" shape.

#### `CaptureError`

- **Tag:** `'CaptureError'`
- **Fields:**
  - `op: Schema.String` — required.
  - `exitCode?: Schema.Number`
  - `stdout: Schema.String` — required (empty string when spawn failed).
  - `stderr: Schema.String` — required (empty string when spawn failed).
  - `cause?: Schema.Defect`
- **Source:** `engine/capture-command.ts:60-71`.
- **Thrown by:** every `captureCommand*` function path (spawn-failure or non-zero-exit-promote).
- **Caught by:** Every per-callsite wrapper (`engine/docker/core.ts::runCapturing`, `engine/sui-cli.ts::runWithCapture`, `engine/snapshot.ts::runTar`, …) `Effect.mapError`s `CaptureError` into its own envelope.

### JSON BigInt API

```ts
export const jsonBigintReplacer: (key: string, value: unknown) => unknown
export const jsonBigintReviver: (key: string, value: unknown) => unknown
```

- **Source:** `engine/json-bigint.ts:5-29`.
- **Encoded shape:** `{ __bigint: "<bigint-as-string>" }`.
- **Reviver corruption-tolerance:** A `BigInt('foo')` `SyntaxError` is
  caught; the reviver returns the tagged shape **untouched** rather than
  bubbling out. Documented motivation: pre-fix, the throw bubbled out of
  `JSON.parse`, the state-store loader caught the IO failure as a load
  error, and silently rewrote the entire state file to an empty payload
  (`engine/json-bigint.ts:13-26`).
- **Look-alike resistance:** Only exact `{ __bigint: <string> }`
  matches; `{ __bigint: 42 }` (wrong value type) and `{ __bigint_other:
  '...' }` (wrong key) pass through verbatim.
- **Consumers:**
  - `engine/state-store.ts:417, 477` — load / save state on disk.
  - `runtime/manifest-emit.ts:124` — manifest write.
  - `codegen/emitters/stack-handle.ts:46` — codegen `jsonLiteral`.
  - `engine/cache.ts:123` — cache-key input hashing.
  - `services/seal/internal.ts:346` — seal-inputs hash.

### Display path API

```ts
export const displayPath: (input: string) => string
```

- **Source:** `engine/display-path.ts:43-59`.
- **Behaviour:**
  1. If `input.length === 0`, returns input unchanged.
  2. If not absolute (`!nodePath.isAbsolute(input)`), returns unchanged.
  3. Computes `rel = path.relative(cwd, input)` and counts `..`/sep
     prefixes:
     - If ≤ `MAX_PARENT_CLIMBS` (3), returns `rel` (with `.` for the
       cwd === input case).
     - Else if `input` is inside `$HOME`, returns `~` + tail.
     - Else returns the absolute input.
- **Consumers:**
  - `services/codegen.ts:304` (`primary: displayPath(s.outputDir)` for
    the TUI row's primary URL).
  - That's the only consumer today.
- **NOT reversible:** Once collapsed to `~/foo`, the consumer cannot
  recover the absolute path without ambient `$HOME`. No click-to-open
  protocol implemented (terminal-link or OSC-8) — the display string is
  for human reading only.

### Spans API

```ts
export const annotateDevstackContext: (
  service: string,
) => Effect.Effect<void, never, Identity>
```

- **Source:** `engine/observability.ts:25-33`.
- **Behaviour:** Yields `Identity` from the context and calls
  `Effect.annotateCurrentSpan({ 'service.name': service,
  'devstack.stack': identity.stack, 'devstack.app': identity.app })`.
- **Sole caller:** `advanced/tag.ts:325` (inside `withEngineLifecycle`'s
  ambient setup, gated on `Effect.serviceOption(Identity)` so standalone
  tests without Identity short-circuit). Every primitive's build effect
  inherits these three annotations.

### Span / annotation conventions

- **Span-name convention** (AGENTS.md, paraphrased into
  `engine/observability.ts:5-9`): PascalCase service-domain names. New
  code uses this form; `Effect.withSpan` callsites swept to PascalCase
  in a single batch. `Effect.fn(...)` span labels migrate as files are
  touched.
- **Annotation-key convention** (`engine/observability.ts:11-14`):
  service-name prefix, dot-separated path. Examples: `sui.chainId`,
  `walrus.epoch`, `package.name`, `account.address`, `service.name`,
  `devstack.stack`, `devstack.app`, `snapshot.id`, `state.key`,
  `stage.target`, `docker.image`, `docker.op`, `docker.tag`,
  `cache.outcome`, `signal`, `path`, `app`, `stack`, `configPath`,
  `seal.hostname`.

### Span call sites (sampling — 169 total spans/annotations across `src/`)

| Site | Span / Annotation |
|------|-------------------|
| `tui/index.ts:262` | `Effect.withSpan('Tui.startOnce')` |
| `engine/snapshot.ts:377,597,796,891` | `SnapshotPreCleanupApp`, `SnapshotCreate`, `SnapshotRestore`, `SnapshotList` |
| `engine/faucet.ts:218,259` | `annotateCurrentSpan(...)`, `Effect.withSpan('Faucet.requestFunds')` |
| `engine/state-store.ts:519,527` | `StateStore.put`, `StateStore.remove` with `state.key` annotation |
| `engine/stage-and-swap.ts:243` | `stageAndSwap` with `stage.target` annotation |
| `engine/cache.ts:129,139,143,150` | `cache.outcome` annotation (`hit` / `verify-fail` / `miss`) |
| `engine/supervisor.ts:522,937,1786` | `Devstack.signalRestart` (with `signal`), `Devstack.watch` (with `path`), `Devstack.launch` |
| `engine/docker/image.ts:165,188,260` | `Docker.pull`, `Docker.imageExists`, `Docker.build` |
| `engine/file-watcher.ts:134` | `FileWatcher.watch` with `path` annotation |
| `cli/loaders.ts:136` | `CliLoadConfig` with `configPath` annotation |
| `cli/commands/_prune-stack.ts:350` | `PruneStack` with `app` + `stack` annotations |
| `services/codegen.ts:297` | `Codegen(${name})` |
| `services/seal/internal.ts:652,675,1076` | `SealImage`, `SealPublish`, `SealRotate(${name})` |
| `services/pyth/mid.ts:210` | `PythMid(${name})` |
| `advanced/plugin-author/git-fetch.ts:268` | `GitFetch(${options.name})` |
| `advanced/plugin-author/docker-image.ts:177` | `DockerImage(${options.name})` |
| `advanced/plugin-author/host-script.ts:126` | `HostScript(${options.name})` |
| `advanced/plugin-author/docker-container.ts:835` | `DockerContainer(${name})` |
| `advanced/plugin-author/docker-one-shot.ts:149` | `DockerOneShot(${options.name})` |
| `runtime/manifest-emit.ts:146,156,162` | `ManifestWrite`, `ManifestWatch`, `ManifestFinalize` |

### Renderer factory

```ts
export type RendererKind = 'tui' | 'plain' | 'silent';
export interface RendererMount {
  readonly install: (engine: EngineHandleShape) => Effect.Effect<void>;
  readonly flush: Effect.Effect<void>;
}
export interface RendererMountDeps {
  readonly tuiStateRef: Ref.Ref<TuiState>;
}
export type RendererMountServices = Stdio.Stdio | Scope.Scope;
export interface RendererFactory {
  readonly kind: RendererKind;
  readonly mount: (
    deps: RendererMountDeps,
  ) => Effect.Effect<RendererMount, never, RendererMountServices>;
  readonly loggerLayer: (
    engine: EngineHandleShape,
  ) => Layer.Layer<never, never, never>;
}
export type RendererResolver = (kind: RendererKind) => RendererFactory;
export const silentRendererFactory: RendererFactory; // built-in
```

- **Source:** `engine/renderer.ts:27-78`.
- **Three kinds:**
  - `'tui'` — concrete factory in `compose/devstack.ts:54-65`. Mounts ink ONCE via `startTuiOnce`. `loggerLayer = TuiLoggerLayer(engine)` routes `Effect.log*` into `engine.appendLog`.
  - `'plain'` — concrete factory in `compose/devstack.ts:72-89`. Starts the plain-text diff loop on the supervisor's outer scope. `loggerLayer = TuiLoggerLayer(engine)` (same as TUI — routes `Effect.log*` into `engine.appendLog`, and the plain renderer reads the buffer from the same `TuiState.logs`).
  - `'silent'` — built-in `silentRendererFactory` in `engine/renderer.ts:70-78`. No-op mount, `Layer.empty` logger.
- **Resolution at runtime:**
  - `engine/supervisor.ts:271-273` defaults via `process.stdout.isTTY` (TUI on TTY, plain elsewhere).
  - `engine/supervisor.ts:282-293` (`resolveRendererFactory`) picks from per-run overrides, config, and resolver. Missing resolver short-circuits to `silentRendererFactory`.
- **TUI factory mounts ink ONCE** for the supervisor's lifetime; subsequent cycles call `install(cycleEngine)` to redirect the proxy. The proxy implementation is in `tui/index.ts:47-120` (`makeNoopProxy`). The proxy forwards only the methods `<App>` calls directly: `tuiState` (read), `requestRestart`, `setBuildStatus`, `appendLog`, `requestShutdown`. Everything else is a noop.

### Log buffer

#### Data shape (read-only here; TUI doc covers presentation)

```ts
export interface TuiLog {
  readonly ts: number;
  readonly level: string;
  readonly message: string;
}
```

- **Source:** `engine/tui-state.ts:107-111`.
- Holds an epoch-ms timestamp, a free-form level string (`'info'`,
  `'error'`, plus whatever Effect's `LogLevel` stringifies to), and the
  message text.

#### Engine surface

```ts
readonly appendLog: (entry: TuiLog) => Effect.Effect<void>;
readonly appendTagLog: (name: string, entry: TuiLog) => Effect.Effect<void>;
```

- **Source:** `engine/engine.ts:108-118` (interface), `561-576` (impl).
- **Trim policy:** Both append into `state.logs` and then
  `next.length > LOG_BUFFER_LIMIT ? next.slice(-LOG_BUFFER_LIMIT) :
  next` — i.e. drop oldest, keep newest 200. (`engine/engine.ts:564,
  573`.)
- **`LOG_BUFFER_LIMIT = 200`** — `engine/engine.ts:276`. Hard-coded; not
  env-tunable.
- **`appendTagLog` semantics:** Single atomic `Ref.update` that appends
  to `s.logs` (with trim) AND sets `entry.message` on the tag row's
  `lastLog` field. One write so the global log and the per-row tail
  cannot drift.
- **Per-tag "lastLog" cleared** automatically on `markReady` /
  `markStopping` / `markStopped` (`engine/engine.ts:478-526`) so a
  stale acquire-time line doesn't shadow the resolved primary URL.

#### Per-tag error summary

```ts
readonly markFailed: (
  name: string, cause: Cause.Cause<unknown>,
) => Effect.Effect<void>;
```

- **Source:** `engine/engine.ts:69-70` (interface), `492-500` (impl).
- **Internal walker:** `summarizeCause(cause)` at `engine/engine.ts:380-390`:
  1. `Cause.prettyErrors(cause)` → `Error[]`.
  2. `extractDeepestMessage(head)` — walks `.cause` chain to deepest
     non-empty `.stderr` (preferred) or `.message`.
  3. Fallback to `extractDeepestMessage(rawFailure(cause))` — walks raw
     `Fail` / `Die` payloads directly to dodge `Cause.prettyErrors`'s
     `Object.keys`-only projection that strips `_tag` + `stderr` from
     non-Error objects (the `SignAndExecuteError` discriminated-union
     case).
  4. Fallback to `head.message` or `Cause.pretty(cause)`.
  5. First line only (`.split('\n')[0]`).
  6. Truncate to `ERROR_SUMMARY_MAX = 80` chars (with `…`).
- **Constants:**
  - `ERROR_SUMMARY_MAX = 80` (`engine/engine.ts:338`).
  - The walker is documented as the "stderr beats message" rule —
    `engine/engine.ts:343-370` (`extractDeepestMessage` JSDoc + body).

#### `TuiLoggerLayer` bridge

```ts
export const TuiLoggerLayer = (
  engine: EngineHandleShape,
) => Layer.Layer<never, never, never>
```

- **Source:** `tui/index.ts:285-303`.
- **Mechanism:** `Logger.make(({ logLevel, message, date }) => { ...
  Effect.runSync(engine.appendLog({ ts: date.getTime(), level:
  logLevel, message: text })) })`. Wrapped in
  `Effect.catchCause(() => Effect.void)` so a synchronous defect during
  scope-shutdown can't tear the logger down.
- **Sync call rationale:** `Logger.make`'s sink is synchronous;
  Effect's logging pipeline calls it inside fiber context, not Effect
  context, so the sink cannot `yield*`. The `runSync` defect surface
  is narrowed to `Ref.update` (no finalizers).

## Lifecycle

### Initialization

- **`pretty-error.ts`** — pure module. No init. `prettyError` /
  `causeToJson` are pure functions on any value.
- **`stringify-cause.ts`** — pure module. No init.
- **`capture-command.ts`** — pure module. Each call constructs a
  `Effect.scoped(...)` block. The spawner service (`ChildProcessSpawner.
  ChildProcessSpawner`) is provided by the platform Layer up-stream;
  no observability-owned Layer for it.
- **`json-bigint.ts`** — pure module. No init.
- **`display-path.ts`** — module-level constant `home` is computed
  once at import time via `homedir()`. `home = ''` on failure.
  `engine/display-path.ts:29-35`.
- **`observability.ts`** — exports `annotateDevstackContext` which
  internally `yield*`s `Identity`. Initialization happens
  per-invocation; no Layer to set up.
- **`renderer.ts`** — exports types + the `silentRendererFactory`
  built-in. Concrete factories live in `compose/devstack.ts` (TUI,
  plain).
- **`engine.ts`** — provides `EngineLive: Layer.Layer<EngineHandle>`.
  Built once per `defineDevstack` (outer launch scope, NOT per cycle).
  See `engine/engine.ts:412-789`. Initial `tuiState` is the deep-frozen
  `emptyState` constant (`engine/engine.ts:297-302`).
- **Errors** — every class is module-scope; available immediately on
  import.

### Log routing wiring

```
+----------------+    Effect.log*    +-----------------+   appendLog
|  build effect  | -----------------> | Logger (provided | -----------> EngineHandle.tuiState (Ref<TuiState>)
+----------------+                    | by loggerLayer)  |                  |
                                      +-----------------+                  | reads at 50ms tick
                                                                            v
                              +---------------------+               +---------------+
                              | TuiLoggerLayer      |               | TUI / plain   |
                              | (tui/index.ts:285)  |               | renderer      |
                              +---------------------+               +---------------+
                                                                            |
                                                                            v
                                                                  rendered frame
                                                                  (TUI ink) /
                                                                  formatLogLine (plain)
```

- **Selection happens per-cycle:** `engine/supervisor.ts:1481`
  resolves a `RendererFactory`; `engine/supervisor.ts:1545` calls
  `rendererFactory.loggerLayer(engine)` to produce a `Layer.Layer` that
  intercepts every `Effect.log*` call inside the cycle.
- **TUI/plain both use `TuiLoggerLayer`** (`compose/devstack.ts:64, 88`)
  — `Effect.log*` calls route through `engine.appendLog`.
- **Silent uses `Layer.empty`** (`engine/renderer.ts:77`) — Effect's
  default logger is used (stderr inline).
- **Build-time direct calls:** Primitives can also call
  `engine.appendLog` / `engine.appendTagLog` directly (e.g.
  `withEngineLifecycle`'s on-fail branch at `advanced/tag.ts:373-378`
  pushes the full `prettyError` walk to the global log buffer).

### Capture-command attribution

- **`op` parameter** is the attribution key:
  - Caller can pass `opts.op` (e.g. `'docker run'`, `'sui move build'`).
  - Default (when `opts.op` is absent): `cmd.command` for
    `StandardCommand`, `'piped-command'` otherwise.
    Source: `engine/capture-command.ts:146-152` (`opOf`).
- The `op` string lives on the resulting `CaptureError.op`. Wrappers
  route it into their own `phase` / context strings via
  `Effect.mapError`. E.g. `engine/docker/wrap.ts:49`'s `makeError(cause)`
  receives a `DockerError` whose `phase` is the same docker invocation
  the caller named.
- **No process attribution beyond `op`** — there is no PID / parent-PID
  / depth annotation. The cause-chain encodes "which primitive built
  this" implicitly: `SuiError(phase='sui-up') ← DockerError(phase='docker
  run') ← CaptureError(op='docker run', cause=ENOENT)`.

### Pretty-error cause-walking algorithm

`engine/pretty-error.ts:118-142` (`prettyError`):

1. Bail on `undefined` / `null` (empty string).
2. **Cause-shape check** (`isCause`): does `value` have a `reasons:
   ReadonlyArray<...>` field?
   - Empty reasons → `Cause.pretty(value)`.
   - Non-empty: map each reason; recurse into `.error` (Fail) or
     `.defect` (Die); `'Interrupted'` for Interrupt; join with `\n`.
3. **Tagged-error shape check** (`isTaggedError`): does `value` have
   a string `_tag`?
   - Build header line.
   - Append per-field lines for `exitCode`, `stderr`, `stdout`,
     `detail` (when set + non-empty after trim).
   - If `cause` present and non-degenerate, append `caused by:` block
     with indented `prettyError(cause)`.
   - Augment with docker-down hint if applicable.
4. **`instanceof Error`**: render `stack` (or `name: message` if no
   stack). Augment with docker-down hint.
5. **Else**: `String(value)`.

## Hard requirements / invariants

Each pinned by test (`file:line`) or by an explicit invariant in source.

### Errors

- **Every error class with a `phase` field has either a closed `Schema.Literals(...)` phase OR is one of the two grandfathered open-string exceptions (`DockerError`, `HostProcessError`).** Enforced as a runtime test: `engine/errors.test.ts:129-148`. The test walks the AST of every error class's `phase` field and classifies it as `literals` / `string` / `other`; only `literals` passes by default. `OPEN_STRING_PHASE_GRANDFATHERED = ['DockerError', 'HostProcessError']` is closed (`engine/errors.test.ts:47`).
- **Three classes have no phase field** (context errors): `ForkUnsupportedError`, `SeedManifestMismatchError`, `ForkIncompatibleError` (`engine/errors.test.ts:51-55`).
- **Every error has stable string `_tag`** — derived from
  `Schema.TaggedErrorClass<X>()('X', { … })` — so consumers can
  `catchTag('<Tag>')` without `instanceof` (which would tie the
  consumer to the concrete class import).
- **`ManifestShapeError` is the one error class omitted from the test
  inventory** (`engine/errors.test.ts:73-93`) — it conforms by
  construction but doesn't get walked. Inventory hole.

### Pretty-error

- **Tagged error renders with `(phase): message` header AND
  `exitCode` AND `stderr` lines.** `engine/pretty-error.test.ts:13-24`
  (`'renders a tagged error with op + stderr + exitCode'`).
- **`cause` recursion surfaces inner tagged-error structured fields.**
  `engine/pretty-error.test.ts:26-44`.
- **Three-level chain does not flatten the middle hop.**
  `engine/pretty-error.test.ts:46-68` (Sui → Walrus → Docker; each
  layer's `phase` + structured fields preserved).
- **Plain `Error` renders with stack.**
  `engine/pretty-error.test.ts:70-75`. Stack includes the test file
  path (i.e. JS engine's standard stack, not synthesized).
- **`Cause.fail(taggedError)` recurses into the `Fail` reason.**
  `engine/pretty-error.test.ts:77-89`.
- **`Cause.die(defect)` recurses into the defect.**
  `engine/pretty-error.test.ts:91-95`.
- **Unknown values render via `String(value)`.**
  `engine/pretty-error.test.ts:97-100` (`prettyError(42) === '42'`,
  `prettyError('boom') === 'boom'`).
- **Oversized stderr truncates to `…[truncated]` at 8192 bytes.**
  `engine/pretty-error.test.ts:102-113`. `rendered.length <
  big.length` (where `big = 'x'.repeat(20_000)`).
- **Inner cause threaded via `cause:` field is walked.**
  `engine/pretty-error.test.ts:115-143`. The inner DockerError's
  structured fields surface; the outer SuiError's `message` does NOT
  contain the inner's class name (i.e. callers are NOT expected to
  pre-flatten by string concat).

### Cause-tree JSON

- **Preserves full structured chain** across DockerError → SuiError
  wrapping. `engine/pretty-error.test.ts:147-168`.
- **Walks `Cause.fail` by recursing into the Fail reason.**
  `engine/pretty-error.test.ts:170-185`. Output shape:
  `{ _tag: 'Cause', reasons: [{ _tag: 'Fail', cause: {...} }] }`.
- **Truncates oversized stderr the same way as `prettyError`.**
  `engine/pretty-error.test.ts:187-193`.
- **Falls back to `{_tag: 'Error', message}` for plain `Error`s.**
  `engine/pretty-error.test.ts:195-199`.
- **Survives `JSON.stringify → JSON.parse` round trip.**
  `engine/pretty-error.test.ts:201-217`. Critical for the
  `cli/commands/apply.ts:193` `--json` envelope path.

### Capture-command

- **Zero-exit run returns captured streams verbatim.**
  `engine/capture-command.test.ts:78-88` and `capture-command.streaming.test.ts:83-94`.
- **Non-zero exit does NOT auto-fail; the caller branches.**
  `engine/capture-command.test.ts:90-108`. `result.exitCode = 125`,
  `result.stderr` carries the daemon error.
- **`stderrTruncate` truncates AT exactly the configured cap with
  `…[truncated]` suffix.** `engine/capture-command.test.ts:110-126`.
  `length === 500 + '…[truncated]'.length`. First 500 chars survive
  unchanged.
- **`stderrTruncate: Infinity` preserves the full stream.**
  `engine/capture-command.test.ts:128-140`.
- **Spawn failure → `CaptureError({ op, stdout: '', stderr: '',
  exitCode: undefined, cause: <spawner-error> })`.**
  `engine/capture-command.test.ts:142-155`.
- **`op` defaults to `cmd.command` when no override.**
  `engine/capture-command.test.ts:157-165`.
- **`captureCommandOrFail` promotes non-zero exit to CaptureError carrying the streams; cause is undefined.**
  `engine/capture-command.test.ts:168-184`.
- **Zero-exit success passes through unchanged.**
  `engine/capture-command.test.ts:185-200`.

### Capture-command streaming

- **`onStdoutLine` invoked once per line, in order.**
  `capture-command.streaming.test.ts:243-261`. With chunked stdout
  `['line 1\nline 2\n', 'line 3\n']`, callback sees
  `['line 1', 'line 2', 'line 3']`.
- **Lines glued across chunk boundaries via `splitLines`.**
  `capture-command.streaming.test.ts:263-277`. Stdout chunks
  `['ab', 'c\nde', 'f\n']` resolve to lines `['abc', 'def']`.
- **Full stdout still folded into `CaptureResult.stdout`** —
  joined with `\n`, no trailing newline (the trailing `\n` is
  consumed by `splitLines`).
  `capture-command.streaming.test.ts:279-298`.
- **Stderr drains via whole-string path** (same as `captureCommand`).
  `capture-command.streaming.test.ts:300-316`.
- **Non-zero exit returns the CaptureResult without auto-failing.**
  `capture-command.streaming.test.ts:318-333`.
- **Callback failure does NOT abort the capture.**
  `capture-command.streaming.test.ts:335-352`. Narration is
  observation, never load-bearing.
- **Spawn failure → CaptureError with empty streams.**
  `capture-command.streaming.test.ts:354-371`.
- **`captureCommandStreamingOrFail` promotes non-zero exit.**
  `capture-command.streaming.test.ts:374-407`.
- **Streams drain concurrently** (`Effect.all { concurrency: 'unbounded' }`).
  Implicit invariant from `engine/capture-command.ts:181-188` — no test
  pins ordering of stdout/stderr against each other (deliberately:
  the byte streams are independent, and the test fixture emits both
  whole-string).

### Log buffer

- **`LOG_BUFFER_LIMIT = 200`; appends past the cap drop the oldest.**
  `engine/engine.ts:276, 564, 573`. No test pins this number directly
  in observability tests; engine-test coverage lives elsewhere.
- **`appendLog` and `appendTagLog` BOTH apply the trim** (`engine/
  engine.ts:561-576`). A single atomic `Ref.update` per append.
- **`appendTagLog` writes BOTH `logs` (appended + trimmed) and the
  tag's `lastLog` field in a single `Ref.update`** so the two views
  cannot drift mid-cycle.

### Misc

- **`extractDeepestMessage` prefers `stderr` over `message`** at every
  walked layer. `engine/engine.ts:347-370`. Documented motivation: our
  tagged errors carry the real CLI output in `stderr`; `message` is the
  generic wrapper preamble.
- **`stringifyCause` returns ONLY the first line.**
  `engine/stringify-cause.ts:16`. Multi-line walks must use `prettyError`.
- **JSON BigInt round-trips losslessly across all tested edges**:
  `0n`, `±1n`, `BigInt(Number.MAX_SAFE_INTEGER)`, `1n << 64n`,
  `-(1n << 64n)`, plus nested in arrays + objects.
  `engine/json-bigint.test.ts:11-38`.
- **Invalid `{ __bigint: <non-numeric> }` returns the tagged value
  unchanged** (does NOT throw). `engine/json-bigint.test.ts:40-50`.
- **Look-alike tags pass through verbatim.**
  `engine/json-bigint.test.ts:52-57`.

## Failure modes

| Piece | What can fail | Recovery |
|-------|----------------|----------|
| `prettyError` | Pure function over an `unknown` — cannot fail; any unexpected shape falls through to `String(value)`. | n/a |
| `causeToJson` | Same as `prettyError` — pure. Unknown values land in `{ value }` with the raw `unknown` (which `JSON.stringify` may reject for cycles / functions). | Caller responsibility to sanitize before stringify. |
| `stringifyCause` | Pure; same fallback as `prettyError`. | n/a |
| `captureCommand` | (a) Spawner fails (ENOENT, fork limit, pipe setup): emits `CaptureError` with `cause` set. (b) UTF-8 decode failure mid-stream: not currently tested; Effect's `Stream.decodeText` would error in the Stream channel, which `Effect.mapError(mapSpawn)` collapses into a `CaptureError`. | Caller `catchTag('CaptureError', ...)`. |
| `captureCommandStreaming` | Same plus the `onStdoutLine` callback can fail — silently swallowed by `Effect.ignore`. | n/a (by design). |
| `jsonBigintReplacer` | Pure; only emits `{ __bigint: <string> }` for `bigint` values. | n/a |
| `jsonBigintReviver` | `BigInt('foo')` SyntaxError → returns tagged shape unchanged. | Caller / downstream decides what to do with the unrecovered tagged shape. |
| `displayPath` | `homedir()` throws → `home = ''`; the `~` branch is skipped. | Falls back to absolute. |
| `annotateDevstackContext` | Requires `Identity` in context. Missing → R-channel surfaces as a type error; at runtime, the call site gates on `Effect.serviceOption(Identity)` (`advanced/tag.ts:322-328`). | Standalone tests skip annotation. |
| `TuiLoggerLayer` | `Effect.runSync` could in theory observe a defect during scope-close. Wrapped in `Effect.catchCause(() => Effect.void)` (`tui/index.ts:299`). | Best-effort; logs in scope-close window may be dropped. |
| `appendLog` / `appendTagLog` | Internal `Ref.update` — never fails in practice. | n/a |
| Plain renderer stderr write | EPIPE on a closed pipe → `Effect.ignore` swallows (`tui/plain.ts:291`). | Best-effort; consumer just sees fewer lines. |
| Renderer factory `mount` | Type-channel `never` for errors (`engine/renderer.ts:61`). | n/a |

## Persistence model

- **Logs do NOT persist beyond the in-memory buffer.** `LOG_BUFFER_LIMIT
  = 200`; oldest dropped first. No on-disk log file is written by the
  observability surface. Confirmed via `grep -rn "fs.write\|fs.append"`
  inside `engine/engine.ts` / `engine/pretty-error.ts` / `tui/`.
- **Errors are values; not persisted.** Tagged errors flow through the
  Effect error channel for the duration of the failing fiber and are
  rendered into stderr / TUI panel / `--json` envelope at the boundary.
- **No structured trace / span export.** Despite 169 `withSpan` +
  `annotateCurrentSpan` callsites, the supervisor does not provide an
  `OtlpHttp` / Jaeger / Zipkin tracer. Spans are emitted only when an
  external `Tracer` Layer is provided; no default sink is wired.
- **JSON BigInt is used in state-store / manifest persistence**, but
  those files are owned by the state-store and manifest subsystems
  respectively — observability provides the codec, not the persistence
  driver.
- **No error-tree dumps.** `cli/commands/apply.ts:193` is the closest
  thing — it embeds `causeToJson(cause)` into the JSON envelope under
  `error.cause`. That JSON lands on stdout; it is not persisted to a
  separate `.devstack/errors/<id>.json` file.

## Modes & variants

### Renderer kinds

| Aspect | `tui` | `plain` | `silent` |
|--------|-------|---------|----------|
| TTY required? | No (will mount anyway; can tear stdout if not TTY — see Pain points) | No | No |
| Log output target | Ink-rendered panel inside engine's `tuiState.logs` buffer; ink writes to `process.stdout` | `process.stderr` via Effect's `Stdio.stderr()` sink | None (Layer.empty) |
| Color | ink color attributes (no ANSI in observability source) | None | n/a |
| What's filtered | Nothing — every `appendLog` lands in the buffer; rendering shows only the trailing tail visible in the panel | Nothing — every `Effect.log*` becomes a `TuiLog` and is emitted via `formatLogLine`. Status / phase transitions emit one line per diff tick. Heartbeats every 15s for long-running `acquiring` rows | Everything (no output) |
| Logger layer | `TuiLoggerLayer(engine)` | `TuiLoggerLayer(engine)` (same) | `Layer.empty` (Effect default logger; stderr inline) |
| Mount-once vs per-cycle | Mount once on outer scope (`startTuiOnce`); `install(engine)` re-points proxy per cycle | Mount once on outer scope (`startPlainRenderer`); `install` is no-op | No-op mount; `install` no-op |
| Perf | ink owns the diff loop; 50ms polling tick syncs engine state to ink proxy; reference-equality short-circuit on no-change | 500ms diff tick + 15s heartbeat scan; one concatenated stderr write per tick | Zero overhead |
| `flush` semantics | Snapshot engine.tuiState → stableState; sleep 20ms for React commit | Re-runs the tick effect | `Effect.void` |
| Source | `compose/devstack.ts:54-65`, `tui/index.ts` | `compose/devstack.ts:72-89`, `tui/plain.ts` | `engine/renderer.ts:70-78` |

### Capture-command modes

| Aspect | `captureCommand` | `captureCommandOrFail` | `captureCommandStreaming` | `captureCommandStreamingOrFail` |
|--------|------------------|-------------------------|----------------------------|----------------------------------|
| Non-zero exit | Returns `CaptureResult` | Promotes to `CaptureError` | Returns `CaptureResult` | Promotes to `CaptureError` |
| Stdout drain | Whole-string via `Stream.mkString(Stream.decodeText(stdout))` | Same | `Stream.splitLines` + per-line callback + `Stream.runFold` joining with `\n` (no trailing newline) | Same |
| Stderr drain | Whole-string | Same | Whole-string | Same |
| Per-line callback | n/a | n/a | `opts.onStdoutLine` (errors swallowed by `Effect.ignore`) | Same |
| Concurrency | All three (stdout, stderr, exitCode) drain concurrently | Same | Same (foldStdout in place of plain stdout decode) | Same |
| Default truncation | stderr 500B, stdout `Infinity` | Same | Same | Same |
| Source | `engine/capture-command.ts:168-196` | `307-327` | `225-271` | `280-300` |

## Test coverage

### `engine/errors.test.ts`

| Describe | It | Assertion |
|----------|----|----|
| `errors — phase-field conformance` | `<each of 19 listed error classes> conforms to the phase-field rule` | AST walker checks `phase` field is missing (only for `NO_PHASE_FIELD` set), open-string (only for `OPEN_STRING_PHASE_GRANDFATHERED` set), or closed `Schema.Literals(...)`. Iterates `allErrors` array (19 entries — `ManifestShapeError` missing from this list, which is documented above as an inventory hole). |

### `engine/pretty-error.test.ts`

| Describe | It | Assertion |
|----------|----|----|
| `prettyError` | `renders a tagged error with op + stderr + exitCode` | Output contains `DockerError (docker run):`, `exitCode: 125`, `stderr: pull access denied for mystenlabs/sui-tools`. |
| `prettyError` | `recurses into the cause chain so wrappers expose root details` | SuiError → DockerError chain: header + `caused by:` + inner DockerError fields. |
| `prettyError` | `chains three levels deep without flattening the middle hop` | Sui → Walrus → Docker chain; all three classes + phases + rate-limit stderr appear. |
| `prettyError` | `falls back to Error rendering with stack for plain Errors` | `new Error('boom')` → contains `Error: boom` and the test file path in the stack. |
| `prettyError` | `renders Effect Cause.fail by recursing into the Fail reason` | `Cause.fail(docker)` → contains DockerError fields. |
| `prettyError` | `renders Cause.die by recursing into the defect` | `Cause.die(new Error('panicked'))` → contains `Error: panicked`. |
| `prettyError` | `renders unknown values via String` | `prettyError(42) === '42'`, `prettyError('boom') === 'boom'`. |
| `prettyError` | `truncates oversized stderr to keep the render bounded` | 20_000-char stderr → output contains `[truncated]`; render length < input length. |
| `prettyError` | `renders an inner cause whose chain came through cause: on the tagged error (no flattened message)` | Confirms callers do NOT need to pre-flatten by string-concat — the walker surfaces the inner structured fields. |
| `causeToJson` | `preserves the full structured chain (DockerError wrapping a SuiError)` | `{_tag: 'SuiError', phase: 'sui-up', message, cause: {_tag: 'DockerError', phase: 'docker run', exitCode: 125, stderr: 'unauthorized'}}`. |
| `causeToJson` | `walks Effect Cause.fail by recursing into the Fail reason` | `{_tag: 'Cause', reasons: [{_tag: 'Fail', cause: {_tag: 'DockerError', ...}}]}`. |
| `causeToJson` | `truncates oversized stderr the same way prettyError does` | Same 20_000-char stderr; output truncated with `[truncated]`. |
| `causeToJson` | `falls back to {_tag, message} for plain Errors` | `{_tag: 'Error', message: 'boom'}`. |
| `causeToJson` | `returns the structured walk through JSON.stringify/parse round-trip` | `JSON.parse(JSON.stringify(causeToJson(sui)))` round-trips with `_tag` / `cause._tag` / `cause.exitCode` preserved. |

### `engine/capture-command.test.ts`

| Describe | It | Assertion |
|----------|----|----|
| `captureCommand` | `returns the captured streams verbatim on a zero-exit run` | `result = {exitCode: 0, stdout: 'hello world\n', stderr: ''}`. |
| `captureCommand` | `does NOT auto-fail on a non-zero exit (caller branches on result.exitCode)` | `result.exitCode = 125`, `result.stderr = 'docker: error during connect\n'`. |
| `captureCommand` | `applies stderr truncation when stderrTruncate is set` | 1500-char stderr truncated to `500 + '…[truncated]'.length`; first 500 chars unchanged. |
| `captureCommand` | `Infinity truncation preserves the full stream verbatim` | 2000-char stderr returned as-is. |
| `captureCommand` | `spawn failure becomes a CaptureError with empty streams + the spawner cause` | Spawn fails → `CaptureError({op: 'docker ps', stdout: '', stderr: '', exitCode: undefined, cause: FakeSpawnFailure})`. |
| `captureCommand` | `falls back to cmd.command for op when no override is provided` | No `opts.op` → `CaptureError.op === 'docker'`. |
| `captureCommandOrFail` | `promotes a non-zero exit into a CaptureError carrying the streams` | `result.op = 'docker build'`, `result.exitCode = 1`, `result.stderr = 'Error: missing tag\n'`, `result.cause = undefined`. |
| `captureCommandOrFail` | `passes through a zero-exit success unchanged` | Identical to plain `captureCommand` happy-path. |

### `engine/capture-command.streaming.test.ts`

NB: this file **duplicates** the 8 cases from `capture-command.test.ts`
verbatim under the same describe headers, then adds the streaming
cases. Listed only the new cases here.

| Describe | It | Assertion |
|----------|----|----|
| `captureCommandStreaming` | `invokes onStdoutLine once per stdout line, in order` | Chunked stdout `['line 1\nline 2\n', 'line 3\n']` → callback sees `['line 1', 'line 2', 'line 3']`. |
| `captureCommandStreaming` | `glues lines across chunk boundaries via splitLines` | Chunks `['ab', 'c\nde', 'f\n']` → `['abc', 'def']`. |
| `captureCommandStreaming` | `still folds the full stdout into CaptureResult.stdout` | `result.stdout === 'line 1\nline 2\nline 3'` (no trailing newline). |
| `captureCommandStreaming` | `passes stderr through whole-string drain (matches captureCommand)` | Stderr fixture string returned verbatim. |
| `captureCommandStreaming` | `non-zero exit returns the CaptureResult without auto-failing` | `result.exitCode = 125`. |
| `captureCommandStreaming` | `a callback that fails does NOT abort the capture` | Callback that `Effect.fail`s → capture still resolves with `result.stdout = 'line 1\nline 2'`. |
| `captureCommandStreaming` | `spawn failure becomes a CaptureError with empty streams` | Same shape as non-streaming spawn-failure path. |
| `captureCommandStreamingOrFail` | `promotes a non-zero exit into a CaptureError carrying the streams` | Mirrors `captureCommandOrFail`. |
| `captureCommandStreamingOrFail` | `passes through a zero-exit success unchanged` | Mirrors `captureCommandOrFail`. |

### `engine/json-bigint.test.ts`

| Describe | It | Assertion |
|----------|----|----|
| `json-bigint` | `round-trips BigInts at edges (0, ±, MAX_SAFE_INTEGER, 2^64)` | `0n`, `1n`, `-1n`, `BigInt(Number.MAX_SAFE_INTEGER)`, `1n << 64n`, `-(1n << 64n)` round-trip equal. |
| `json-bigint` | `round-trips plain JSON scalars and containers unchanged` | String / number / null / true / array / object preserved. |
| `json-bigint` | `round-trips mixed payloads (BigInts nested in objects + arrays)` | Deeply nested mix preserved by `toEqual`. |
| `json-bigint` | `returns the tagged value untouched on invalid {__bigint: <non-numeric>}` | `{__bigint: 'not-a-number'}` → reviver returns `{__bigint: 'not-a-number'}` unchanged (does NOT throw). |
| `json-bigint` | `leaves look-alike tags untouched (only exact __bigint:string matches)` | `{__bigint_other: 'xyz'}` and `{__bigint: 42}` pass through. |

### No standalone tests for

- `engine/pretty-error.ts::augmentDockerDownHint` — only exercised
  transitively by callers that happen to include the docker-down
  string.
- `engine/stringify-cause.ts` — relies on `pretty-error.test.ts` to
  pin the first-line behaviour.
- `engine/display-path.ts` — no `display-path.test.ts` in `engine/`.
- `engine/observability.ts` — no `observability.test.ts`; the
  three-key annotation surface is exercised by spans the supervisor
  emits (no unit-level test pins the keys).
- `engine/renderer.ts` — the `silentRendererFactory` and the type
  contract; no direct test for the resolver wiring (covered
  transitively by `compose/devstack` and supervisor integration tests).
- `engine/engine.ts::LOG_BUFFER_LIMIT` trim policy — no observability-
  surface test pins the 200 cap directly; engine tests cover it.

## Pain points today

### `errors.ts` is a junk drawer

- **20 error classes in one file**, mixing engine-level (`ConfigLoadError`,
  `ManifestDiscoveryError`, `ManifestShapeError`, `ManifestError`),
  fork-mode (`ForkUnsupportedError`, `ForkIncompatibleError`,
  `SeedManifestMismatchError`), subprocess wrappers (`DockerError`,
  `HostProcessError`), and **eleven** per-service errors that
  semantically belong in `services/<name>/errors.ts`:
  `SuiError`, `AccountError`, `PublishError`, `WalletAppError`,
  `WalrusError`, `SealError`, `DeepbookError`, `PythError`,
  `PostgresError`, `DeepbookIndexerError`, `DeepbookServerError`.
- The errors-test inventory has **one omission** (`ManifestShapeError`)
  — the `allErrors` table at `errors.test.ts:73-93` is hand-maintained
  and silently drifts.
- The closed-set phase tuples live in `phases.ts`, but that file is also
  cross-service — `SuiPhases` (with all 7 fork-mode phases),
  `WalrusPhases`, etc. all coexist. Moving an error class out of
  `errors.ts` without also moving its phase tuple would split a unit.
- `errors.ts` imports from `phases.ts` to wire the `Schema.Literals`;
  consumers of an error import from `errors.ts`. Decoupling them
  requires renaming the export site.
- The two grandfathered open-string phase classes (`DockerError`,
  `HostProcessError`) are explicit exceptions, encoded into both
  `phases.ts:8-16` (rationale comments) AND
  `errors.test.ts:47` (`OPEN_STRING_PHASE_GRANDFATHERED` constant) —
  the rule lives in two files.

### `pretty-error.ts` special-cases per-service shapes

- **`pretty-error.ts` does NOT import any specific error class** —
  every field surfaced (`stderr`, `stdout`, `exitCode`, `phase`,
  `detail`) is read via duck-typing on the `_tag` shape (`engine/
  pretty-error.ts:34-48`, the `TaggedErrorLike` interface). So in one
  sense it does NOT special-case per-service shapes.
- But: the FOUR per-layer fields the walker surfaces (`exitCode`,
  `stderr`, `stdout`, `detail`) are de facto a fixed set that every
  service-error must mint to be debuggable. Every error in `errors.ts`
  that carries subprocess output emits exactly these three plus
  `phase`. New errors that wanted to surface other structured fields
  (e.g. `feed: 'hex'` on `PythError`, `database: 'deepbook'` on
  `PostgresError`, `account: 'alice'` on `AccountError`) are NOT
  rendered by `prettyError` — they live in `causeToJson` (only
  implicitly, because that walker also only emits the same fixed
  set).
- The result: `prettyError(new PythError({feed: 'abc...', message: '...'}))`
  prints `PythError: <message>` and silently drops `feed`. The user
  must read the structured chain via `--json` to see `feed`.
- **`detail` is a foreign field** — it's not on any error in
  `errors.ts`. `engine/pretty-error.ts:43, 79-81` walks `detail` because
  some non-`errors.ts` tagged error (likely from a plugin author or a
  test fixture) carries it. Unclear which class actually mints `detail`.

### Docker-down augmentation is a magic-string special case

- `engine/pretty-error.ts:152-169` (`augmentDockerDownHint`) hard-codes
  four tell strings. This is observability-specific knowledge that
  should arguably live with the docker subsystem (a `DockerError.hint`
  field would be discoverable via the same render path).
- Currently the augmentation fires on `Error.message` matches too —
  e.g. a plain `Error('Cannot connect to the Docker daemon')` thrown
  from somewhere unrelated would get the hint prepended. Not
  guard-railed by error class.

### Log routing is on the EngineHandle surface

- `appendLog` and `appendTagLog` are part of the EngineHandle shape
  (`engine/engine.ts:108-118`) — every consumer of the engine has
  access to push log lines into the buffer.
- This mixes "engine lifecycle control" (`markAcquiring`, `markReady`,
  `markFailed`) with "observability log routing" — two concerns on
  one type.
- `tui/index.ts:47-120` (`makeNoopProxy`) has to forward `appendLog`
  but no-op `appendTagLog`, because the q-handler in `<App>` calls
  `appendLog` directly on the proxy. The proxy carries TWO log-related
  shims with different forwarding semantics, encoded into the same
  shape that the supervisor's real engine satisfies.
- `TuiLoggerLayer` lives in `tui/index.ts:285-303` — file `tui/`
  exports a logger Layer, but the logger sink only writes through
  `engine.appendLog`. Could equally live in `engine/`.

### `stringifyCause` is a retained workaround

- `engine/stringify-cause.ts:8-10` (file header): "This module is
  retained ONLY because services that still wrap their inner failures
  into a single message string consume it. New code should prefer
  threading `cause:` through tagged errors."
- 15+ consumers still call it.
- The reason callers reach for it is that the error class's `message`
  field is `Schema.String` (mandatory) and they want SOMETHING short
  to put there. The deeper fix is to lift `message` to `optional` or
  enrich it with a structured field, both of which require error-class
  schema changes.

### `summarizeCause` in engine.ts duplicates pretty-error's walker

- `engine/engine.ts:380-410` re-implements a cause-walker
  (`summarizeCause`, `extractDeepestMessage`, `rawFailure`) tailored
  for the 80-char per-row error summary.
- `pretty-error.ts`'s `prettyError` walker is structurally similar but
  emits multi-line output. There's no shared helper. Two walkers can
  drift on:
  - Tag-shape detection logic.
  - Stderr-vs-message priority order.
  - Cause-chain recursion (engine walks `.cause` directly; pretty-error
    walks `Cause` reasons + tagged `.cause`).
- The engine walker exists because `pretty-error` always returns the
  full multi-line tree; there's no "first deepest message" helper.
  Adding one would let the engine drop ~30 lines.

### Renderer factory mixes "what to render" with "how to log"

- `RendererFactory` carries both `mount(...)` (start a renderer) AND
  `loggerLayer(engine)` (a `Layer.Layer<never, never, never>` that
  intercepts `Effect.log*`). The two are coupled in
  `compose/devstack.ts:54-89`: TUI + plain BOTH use
  `TuiLoggerLayer(engine)` even though plain doesn't render via ink
  at all — the layer just funnels logs into the engine buffer so the
  plain diff loop can pick them up.
- Silent renderer's `loggerLayer = () => Layer.empty` means Effect's
  default logger runs (stderr inline). If a user wanted "no TUI but
  also no log dump on stderr" they'd need a fourth renderer kind.

### Capture-command tests are partially duplicated

- `engine/capture-command.streaming.test.ts:83-207` duplicates
  `engine/capture-command.test.ts:77-201` line-for-line under the same
  describe headers. Maintaining two copies risks drift; the two should
  share fixtures.

### No structured trace export

- 169 `Effect.withSpan` / `Effect.annotateCurrentSpan` callsites
  produce telemetry that, by default, nobody consumes. There's no
  `OtlpHttp` / Jaeger / Zipkin / Honeycomb Layer wired anywhere in
  `engine/` or `cli/`. To observe spans, the user must provide a
  Tracer Layer themselves. The annotation convention is documented but
  not enforced — a primitive that forgets `annotateDevstackContext`
  emits spans without `service.name`.

### `displayPath` is used in ONE place

- Despite the elaborate path-shortening rules (~3 climbs, home-relative
  with `~`, absolute fallback), `displayPath` is called only from
  `services/codegen.ts:304`. No log line, no error message body, no
  TUI render passes a path through it. The TUI's "primary URL" column
  for codegen is its sole consumer.

## Open questions

- **OPEN QUESTION:** What class mints the `detail` field that
  `pretty-error.ts:43, 79-81, 211` walks? No error in `errors.ts`
  declares it. Possibly a tagged error from a plugin author or a test
  fixture; possibly dead code.
- **OPEN QUESTION:** Why is `ManifestShapeError` excluded from the
  `allErrors` table in `errors.test.ts:73-93`? It exists in
  `errors.ts:269-280` with a closed `Schema.Literals(['parse',
  'shape'])` phase, so it would pass the test by construction. Almost
  certainly an inventory oversight at the time the class landed.
- **OPEN QUESTION:** Is there a default Tracer Layer wired in any
  example app or test harness? `grep -rn "OtlpHttp\|Tracer.layer"` in
  `packages/devstack/src/` returns no hits inside this package; spans
  may be black-holed in production runs.
- **OPEN QUESTION:** Should `LOG_BUFFER_LIMIT = 200` be env-tunable?
  No env-var override exists today; the constant is hard-coded.
- **OPEN QUESTION:** The Docker-down augmentation fires on any string
  match — including, in theory, an error from a non-Docker call that
  happens to mention `'docker'` in its `message`. No reported false
  positives, but the guard rail is purely string-based.
- **OPEN QUESTION:** `causeToJson` falls back to `{ value: <raw> }`
  for unknown values, with no `jsonBigintReplacer` applied. If a
  caller passes `causeToJson(123456789012345678901234567890n)`, the
  subsequent `JSON.stringify` may emit `value` as a stringified bigint
  (BigInt → JSON.stringify throws in standard ECMAScript). Untested.
- **OPEN QUESTION:** `tuiStateRef` parameter on `RendererMountDeps`
  (`engine/renderer.ts:43`) — why does the renderer factory receive
  the raw `Ref` rather than reading from the cycle engine via
  `install(engine)`? Plain renderer uses it directly; TUI does not.
  Looks like an asymmetry — the plain factory could equally read from
  the engine on each tick.
- **OPEN QUESTION:** The `RendererMountServices = Stdio.Stdio |
  Scope.Scope` union (`engine/renderer.ts:52`) is the narrowed R-channel
  for `mount`. Was the previous shape `any`? The comment hints at a
  past `any` that defeated `Exclude<...>` narrowing.

## Opportunities noticed

- **Split `errors.ts` along subsystem lines.** The 11 per-service
  errors should live with their owning service. The 4 manifest /
  config errors (`ConfigLoadError`, `ManifestError`,
  `ManifestDiscoveryError`, `ManifestShapeError`) could group under
  `runtime/errors.ts`. The 3 fork-mode context errors
  (`ForkUnsupportedError`, `ForkIncompatibleError`,
  `SeedManifestMismatchError`) group under `engine/sui-fork/errors.ts`.
  `DockerError` and `HostProcessError` stay close to engine — they're
  the universal subprocess wrappers. The phase tuples in `phases.ts`
  follow the same split.
- **Replace the inventory hand-list in `errors.test.ts`** with a
  globbed import from a barrel. Re-export every error class from a
  central index; the test iterates the index. Eliminates the
  `ManifestShapeError` omission class of bug.
- **Add a `prettyErrorFirstLine` / `deepestMessage` helper** in
  `pretty-error.ts` that the engine's `summarizeCause` can call.
  Eliminates `extractDeepestMessage` + `rawFailure` duplication in
  `engine/engine.ts:347-410`. Single walker; single fallback policy.
- **Lift `TuiLoggerLayer` out of `tui/index.ts`** into
  `engine/logger.ts` (or fold it into the renderer factory). It has
  zero ink / React dependency — it's a `Logger.make` sink that calls
  `engine.appendLog`. Today it lives next to the ink mount only by
  accident.
- **Lift `displayPath` into the pretty-error / log-format pipelines.**
  Today only `services/codegen.ts:304` uses it; every path that
  surfaces in an error `message` or a log line could pass through it
  to keep TUI rows readable. Costs ~one `displayPath(...)` wrap per
  log-emitting call site.
- **Document the `detail` field's owner**, or remove it from the
  walkers. Today it's silent surface area.
- **Move the Docker-down augmentation off `pretty-error.ts`** —
  ideally into a `DockerError.hint?: string` field the docker
  subsystem fills in when it sees the connect tells. Pretty-error
  then renders the `hint` field generically.
- **Provide a default tracer Layer** in dev mode (e.g. a console-
  pretty span sink under `--trace` or `DEVSTACK_TRACE=1`). The 169
  span call sites are pure overhead today.
- **Deduplicate the non-streaming tests** between
  `capture-command.test.ts` and `capture-command.streaming.test.ts`.
  Either share fixtures or trim the streaming file to its
  streaming-only cases.
- **Hoist `LOG_BUFFER_LIMIT` next to the env-var defaults** so it can
  be plumbed via `DEVSTACK_LOG_BUFFER_LIMIT` for users running long
  sessions. Today it's a `const` inside `engine.ts`.
- **Decouple `appendLog` / `appendTagLog` from `EngineHandle`** —
  introduce a separate `LogSink` service that owns the buffer; the
  engine consumes it for the on-fail `prettyError` write and for the
  per-tag `lastLog` projection. The proxy in `tui/index.ts` would then
  not need to carry a shim for both methods.
- **The `RendererMountDeps` shape (`tuiStateRef: Ref.Ref<TuiState>`)
  is the same as one half of `EngineHandle`.** Could be replaced
  with `engineRef: Ref.Ref<EngineHandleShape | undefined>` — same
  forwarding semantics, removes the asymmetry where TUI uses
  `install(engine)` but plain reads `tuiStateRef` directly.
- **`stringifyCause` could be inlined or deleted** if the message
  field on every error class were made `Schema.optional` (callers
  stop needing a short string fallback). Today it's a 4-line file
  retained as a transitional layer.
- **The proxy engine in `tui/index.ts:47-120` is 60+ lines of
  forwarding shims.** Most could collapse if the `EngineHandle`
  surface were narrower. (Engine-core doc covers this; flagged here
  because the observability shims — `appendLog`, `setBuildStatus` —
  are part of the surface that complicates the proxy.)
