# tui

## Purpose

The `tui` component is devstack's **terminal-UI presentation layer** — the in-terminal dashboard a
user sees while `pnpm exec devstack up` is running. It owns:

1. **Ink dashboard** (`tui/components.tsx`, `tui/index.ts`) — a React tree mounted via the
   [`ink`](https://github.com/vadimdemedes/ink) library that renders a header, a single grouped node
   table, and a global log tail from the engine's `TuiState` Ref. Ink owns all cursor/clear/diff
   plumbing; devstack hand-rolls no ANSI.
2. **Plain-mode line renderer** (`tui/plain.ts`) — a polling-loop alternative that emits one line
   per status transition, one line per new endpoint, and one line per new log entry to `stderr`,
   plus a per-tag "still acquiring [Ns]" heartbeat. Used in non-TTY contexts (CI, piped output) and
   behind the `--renderer plain` flag.
3. **Logger bridge** (`tui/index.ts::TuiLoggerLayer`) — an Effect `Logger` layer that redirects all
   `Effect.log*` calls into `engine.appendLog` so they land in the same `Ref` the dashboard's
   `<Static>` component reads from. Without this, default Effect logging on stderr races ink's frame
   writes and tears the layout.

This doc captures the CURRENT terminal-UI surface — what `tui/` reads, what it writes, how the user
drives it (`q`, `r`, Ctrl-C), and how the three modes (`tui` / `plain` / `silent`) differ. It does
NOT cover the engine state machine that produces `TuiState` (see `01-engine-core.md`), the log
buffer ring (see `03-observability.md`), or the renderer factory selection logic (also
`03-observability.md`).

## Project-specific terms (defined on first use)

For a reader with zero project context:

- **Engine** — the long-lived in-memory service (`engine/engine.ts`) that owns the canonical
  `TuiState` Ref. Every primitive's lifecycle event (`markAcquiring`, `markReady`, `markFailed`, …)
  mutates this Ref.
- **TuiState** — the immutable snapshot the renderers consume; defined in `engine/tui-state.ts`.
  Fields: `entries` (per-primitive rows), `header` (app/stack/network/buildStatus/cycle), `logs`
  (bounded ring of log lines), `endpoints` (currently unused at present), `depTreeLevels` (optional
  pre-flight build-plan preview).
- **Primitive / tag** — a single declared piece of dev infra (e.g. a Sui localnet container, a
  published Move package, an account). Each primitive has a stable string `key` and a lifecycle
  status (`pending` → `acquiring` → `ready` | `failed`, plus terminal `stopping` → `stopped`).
- **TuiEntry** — one row in the dashboard, projected from a primitive's engine-recorded state.
- **TuiEntryKind** — section classification (`service` | `package` | `account` | `action` | `app` |
  `other`). Set by a primitive's wrapping `tag()` / `provide()` factory; `'other'` is the catch-all.
- **Renderer / RendererKind** — `'tui' | 'plain' | 'silent'`; selected at supervisor mount time by
  the user's `--renderer` flag or by autodetection (TTY → tui, non-TTY → plain).
- **Cycle** — one launch iteration. A `r` keypress, SIGUSR2, or file-watch trigger increments the
  cycle counter and rebuilds the user-stack layer in place; the ink mount is NOT re-created.
- **Phase** — a sub-status narration set on an `acquiring` entry via `engine.setPhase` (e.g.
  `'pulling layer 1/3'`, `'awaiting rpc + faucet + graphql'`). Promoted to the status column as a
  single verb.
- **Plugin** — the publisher of a primitive (`sui`, `walrus`, `seal`, `deepbook`, …). Drives the
  `[plugin]` chip and the row's plugin color.

## Current implementation

All source files live under
`/Users/michaelhayes/code/ts-sdks-incubation/packages/devstack/src/tui/`.

### Source files

| File                 | LOC | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tui/components.tsx` | 916 | Ink React tree. Exports `App` (root component), `SHUTDOWN_LOG_MESSAGE` (string constant duplicated in supervisor). Internally defines `Header`, `NodeTable`, `GroupSection`, `CollapsedReadyRow`, `NodeRow`, `LogLine`, `Footer`. Owns all visual styling: status glyphs, status colors, build-status colors, section colors, plugin colors, layout (NAME_WIDTH=32, STATUS_WIDTH=11, DETAIL_COLUMN_INDENT=1+3+32+11=47), truncation rules (MAX_DETAIL_LEN=60, INFO_LOG_MAX_CHARS=240, MAX_LOG_CONTINUATION_LINES=12). |
| `tui/index.ts`       | 315 | Two public entry points: `startTuiOnce()` — mounts ink ONCE per `runMain` lifetime, returns a `{proxy, install, flush}` `TuiMount`; and `TuiLoggerLayer(engine)` — Effect `Logger` layer that pipes `Effect.log*` into `engine.appendLog`. Houses the **engine proxy** that lets the supervisor swap the per-cycle engine into the stable ink mount without re-rendering. Re-exports `SHUTDOWN_LOG_MESSAGE` from components plus the `Tui*` types from `engine/tui-state.ts`.                                         |
| `tui/plain.ts`       | 304 | Plain-text renderer. Exports `startPlainRenderer(source)` (Effect.fn forking a 500ms-tick fiber on the current scope) plus three test-only internals (`HEARTBEAT_INTERVAL_MS`, `HeartbeatEntry`, `computeHeartbeats`). Diff-and-emit on tag status / phase changes + new log appends, plus a per-tag "still acquiring [Ns]" heartbeat every 15 s. Writes through the Effect `Stdio` service so tests can swap in a fake sink.                                                                                         |

**src LOC total:** 1535 (counted: 916 + 315 + 304).

### Test files

| File                      | LOC | Summary                                                                                                                                                             |
| ------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tui/components.test.tsx` | 722 | Ink-testing-library coverage of `App`. 22 `it(...)` cases. Drives a real `EngineLive` engine (no fake) and asserts `lastFrame()` strings + `engine.tuiState` state. |
| `tui/plain.test.ts`       | 357 | Direct unit coverage of `computeHeartbeats`. 13 `it(...)` cases. Pure-function tests — no fiber, no real time, no `startPlainRenderer` invocation.                  |
| `tui/logger.test.ts`      | 28  | One `it.effect` case — confirms `Effect.logInfo` / `Effect.logError` calls land in `engine.tuiState.logs` when wrapped in `TuiLoggerLayer(engine)`.                 |

**test LOC total:** 1107 (counted: 722 + 357 + 28).

**Grand total under `tui/`:** 2642 LOC.

## Configuration

### CLI flags

| Flag         | Source            | Values                         | Default                     | Effect                                                                                                                   |
| ------------ | ----------------- | ------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--renderer` | `cli/flags.ts:11` | `'tui' \| 'plain' \| 'silent'` | none → engine auto-resolves | Threads through `cli/index.ts:55` as `RunOverrides.renderer`; overrides any value set in `defineDevstack({ renderer })`. |

### `defineDevstack` config keys (read by the supervisor at mount time)

| Key                | Source                     | Type                                            | Default                                                                   | Effect                                                                                                                                                                                 |
| ------------------ | -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderer`         | `engine/supervisor.ts:238` | `RendererKind` (`'tui' \| 'plain' \| 'silent'`) | `process.stdout.isTTY ? 'tui' : 'plain'` (`engine/supervisor.ts:272-273`) | Picks the renderer kind. CLI `--renderer` wins.                                                                                                                                        |
| `rendererResolver` | `engine/supervisor.ts:246` | `(kind: RendererKind) => RendererFactory`       | `defaultRendererResolver` wired by `compose/devstack.ts:94-98`            | Maps a kind to a concrete factory. Required for the supervisor to actually mount anything (missing resolver short-circuits to `silentRendererFactory` per `engine/supervisor.ts:292`). |
| `rendererFactory`  | `engine/supervisor.ts:254` | `RendererFactory`                               | unset                                                                     | Pre-resolved factory; wins over `renderer` / `rendererResolver`. Used by tests that want a fully fake renderer.                                                                        |
| `hotRestart`       | `engine/supervisor.ts:268` | `boolean`                                       | `true` when `watch` is set                                                | NOT renderer-specific but affects `r`/SIGUSR2 semantics — see "Keypress handlers" below.                                                                                               |

### Environment & process knobs read directly by tui/

| Knob                   | Source                                       | Effect                                                                                                                                           |
| ---------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `process.stdout.isTTY` | `engine/supervisor.ts:273`                   | Drives the auto-renderer-kind decision. NOT read by `tui/*` itself — the supervisor decides BEFORE mounting.                                     |
| `process.pid`          | `tui/index.ts:168`, `tui/components.tsx:429` | Target for the `SIGINT` fallback paths (q-handler if requestShutdown hasn't unblocked the supervisor; Ctrl-C / Ctrl-D in the ink input handler). |

### Internal-only constants (not user-configurable today)

These live in `tui/*` as `const`s with no env or config knob.

| Constant                     | Source                                 | Value                                                                                                                  | Effect                                                                                                              |
| ---------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `NAME_WIDTH`                 | `tui/components.tsx:48`                | 32                                                                                                                     | Width of the row's name column.                                                                                     |
| `STATUS_WIDTH`               | `tui/components.tsx:49`                | 11                                                                                                                     | Width of the row's status-word column.                                                                              |
| `MAX_DETAIL_LEN`             | `tui/components.tsx:63`                | 60                                                                                                                     | Char cap on truncated detail-column text.                                                                           |
| `INFO_LOG_MAX_CHARS`         | `tui/components.tsx:776`               | 240                                                                                                                    | Char cap on a single INFO/WARN log line; ERROR/FATAL uncapped.                                                      |
| `MAX_LOG_CONTINUATION_LINES` | `tui/components.tsx:765`               | 12                                                                                                                     | Cap on continuation lines per multi-line log entry.                                                                 |
| `COLLAPSED_SECTIONS`         | `tui/components.tsx:537`               | `Set(['actions'])`                                                                                                     | Sections whose `ready` rows fold into a `(N) done, names…` summary.                                                 |
| `COLLAPSE_THRESHOLD`         | `tui/components.tsx:538`               | 2                                                                                                                      | Minimum number of `ready` rows in a collapsible section before folding fires.                                       |
| `PHASE_STATUS_OVERRIDES`     | `tui/components.tsx:213-217`           | Map: `'awaiting rpc + faucet + graphql' → 'waiting'`, `'awaiting ready' → 'waiting'`, `'requesting funds' → 'funding'` | Three explicit phrase-to-verb mappings; everything else takes the first word of `phase`.                            |
| `UNGROUPED`                  | `tui/components.tsx:53`                | `'Other'`                                                                                                              | Bucket name for `'other'`-kind entries whose key doesn't carry a `<group>.<name>` shape.                            |
| `PLUGIN_COLOR_MAP`           | `tui/components.tsx:139-155`           | 13 entries (sui, walrus, seal, deepbook, coin, wallet, move, codegen, pyth, postgres, account, action, dev)            | Stable color per in-tree plugin.                                                                                    |
| `SECTION_COLORS`             | `tui/components.tsx:106-114`           | 7-element palette (cyan, green, yellow, magenta, blue, cyanBright, greenBright; red deliberately omitted)              | Pool for section headers + plugin-color fallback.                                                                   |
| `LOG_BUFFER_LIMIT`           | `engine/engine.ts:276` (NOT in `tui/`) | 200                                                                                                                    | Cap on the global log ring the TUI reads. Owned by the engine, not tui.                                             |
| `HEARTBEAT_INTERVAL_MS`      | `tui/plain.ts:105`                     | 15000                                                                                                                  | "Still acquiring [Ns]" cadence for plain mode.                                                                      |
| `REFRESH`                    | `tui/plain.ts:38`                      | `Schedule.spaced('500 millis')`                                                                                        | Plain renderer poll interval.                                                                                       |
| Ink poll interval            | `tui/components.tsx:360`               | default 100 ms, overridable via `App` prop `pollIntervalMs`                                                            | Ink's poll of `engine.tuiState`. Tests pass 10 ms for determinism.                                                  |
| Sync-fiber tick              | `tui/index.ts:228`                     | 50 ms                                                                                                                  | Outer-scope fiber that mirrors `currentEngine.tuiState` into the proxy's `stableState`.                             |
| `flush` settle delay         | `tui/index.ts:191`                     | 20 ms                                                                                                                  | Time the `flush` Effect sleeps after writing to `stableState` so React commits before the caller's finalizers fire. |

**OPEN QUESTION:** Should any of `NAME_WIDTH` / `STATUS_WIDTH` / `MAX_DETAIL_LEN` /
`INFO_LOG_MAX_CHARS` / `LOG_BUFFER_LIMIT` be user-configurable? Today none are.

## Capabilities CONSUMED

### From the engine (via `EngineHandleShape`)

The TUI consumes the engine in two distinct shapes:

**A. Reads** — the rendered tree polls the engine for state.

| Method / field               | Source in tui                                                                                                                                                                                                                                                              | What it reads                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `engine.tuiState` (Ref read) | `tui/components.tsx:370,374` (`Effect.runPromise(Ref.get(props.engine.tuiState))` inside `useEffect`); `tui/index.ts:189,231,255` (sync fiber + flush + install); `tui/plain.ts:259-261` (`source` arg, set up in `compose/devstack.ts:76` as `Ref.get(deps.tuiStateRef)`) | Whole `TuiState` snapshot: `entries`, `header`, `logs`. Polled at 100 ms (ink), 500 ms (plain), 50 ms (sync fiber). |

**B. Writes** — the user's keypresses turn into engine mutations.

| Engine method                            | Trigger in tui                                                                                                                                                                                                                                       | Path                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `engine.setBuildStatus('shutting-down')` | `q`-keypress in `tui/components.tsx:400`; forwarded by proxy via `tui/index.ts:66-70`                                                                                                                                                                | Tints header `yellow` + flips footer copy to "Shutting down — …".                                       |
| `engine.appendLog({ts, level, message})` | `q`-keypress in `tui/components.tsx:401-405`; forwarded by proxy via `tui/index.ts:71-75`; AND used by `TuiLoggerLayer`'s sink (`tui/index.ts:292-300`)                                                                                              | Push a teardown narration line into the global log buffer; appears in `<Static>` scrollback.            |
| `engine.requestShutdown`                 | `q`-keypress in `tui/components.tsx:406`; forwarded by proxy via `tui/index.ts:79-82`                                                                                                                                                                | Resolves the supervisor's `awaitShutdown` Deferred so the launch loop exits cleanly.                    |
| `engine.requestRestart`                  | `r`/`R`-keypress in `tui/components.tsx:422`; forwarded by proxy via `tui/index.ts:56-59`                                                                                                                                                            | Offers `void` into the engine's restart `Queue.dropping(1)` so the supervisor's `awaitRestart` returns. |
| `engine.markStopping` / `markStopped`    | NOT called from tui (they're called by primitive stop finalizers) — but the TUI READS them via `entry.status` to render `stopping`/`stopped` glyphs and exclude them from the Footer's "waiting on N services" count (`tui/components.tsx:875-877`). | —                                                                                                       |

**Critical coupling note:** Today the engine is directly accessed via method calls from inside the
React tree (`engine.setBuildStatus(...)`, `engine.requestShutdown`, `engine.appendLog(...)`). The
handle is passed as a React prop (`AppProps.engine`). No queue, no command bus — direct invocation
through the proxy. This is the "TUI fed by direct method calls" coupling the assignment flags as
load-bearing.

### From Effect / Layer / Context machinery

| Dependency                              | Source                                            | Use                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Effect`, `Layer`, `Ref`, `Logger`      | `tui/index.ts:17`                                 | Engine proxy plumbing + logger layer factory.                                                                                       |
| `Effect`, `Stdio`, `Stream`, `Schedule` | `tui/plain.ts:35`                                 | Plain renderer's tick + stderr write + repeat schedule.                                                                             |
| `Stdio` service                         | `tui/plain.ts:262` (`stdio = yield* Stdio.Stdio`) | Stderr sink for plain-mode writes. Tests can replace via `Stdio.layerTest({ stderr: ... })` (header comment, `tui/plain.ts:24-25`). |
| `Effect`, `Ref` from React              | `tui/components.tsx:12`                           | Ink components call `Effect.runPromise(Ref.get(...))` inside `useEffect` to poll the engine.                                        |
| `Scope`                                 | `tui/index.ts:18`, `tui/plain.ts:295`             | Both renderers fork tick fibers via `Effect.forkScoped` so they're tied to the supervisor's outer (`longLived`) scope.              |

### Workspace / engine module imports

| Module                                                                                                                     | Source                                                                                                           | Use                                                           |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `../engine/engine.js::EngineHandleShape`                                                                                   | `tui/index.ts:21`, `tui/components.tsx:11`                                                                       | Type of the engine handle passed to `App` / `TuiLoggerLayer`. |
| `../engine/tui-state.js` types (`TuiState`, `TuiEntry`, `TuiHeader`, `TuiLog`, `TagStatus`, `BuildStatus`, `TuiEntryKind`) | `tui/components.tsx:13-21`, `tui/plain.ts:36`, `tui/index.ts:146` (also re-exported from `tui/index.ts:307-315`) | Data contract between engine and renderers.                   |

The TUI imports NOTHING from `runtime/`, `compose/`, `cli/`, or any plugin (`services/sui/*`,
`services/walrus/*`, …). The dependency goes the other way: `compose/devstack.ts:40-41` imports
`startPlainRenderer` and `startTuiOnce` / `TuiLoggerLayer` to wire them up as `RendererFactory`
instances; `engine/supervisor.ts` does NOT import `tui/*` (it goes through the abstract
`RendererFactory` contract).

### npm dependencies

| Package                      | Source                                                                                                                 | Use                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ink` ^7.0.0                 | `package.json:64`; imported in `tui/components.tsx:9` (`Box, Static, Text, useInput`) and `tui/index.ts:19` (`render`) | React-for-terminal: VDOM-based render, cursor / clear / diff, keypress handler, automatic stdout-write batching.                                     |
| `react`                      | `tui/components.tsx:10`, `tui/index.ts:20`                                                                             | JSX runtime + hooks (`useState`, `useEffect`).                                                                                                       |
| `ink-testing-library` ^4.0.0 | `package.json:79`; imported in `tui/components.test.tsx:13`                                                            | Renders ink trees into an in-memory writer; exposes `lastFrame()` and `stdin.write(...)` for keypress emulation. Test-only.                          |
| `effect`                     | Pervasive                                                                                                              | The runtime; specifically `Effect.runFork`, `Effect.runPromise`, `Effect.runSync`, `Ref`, `Logger`, `Layer`, `Schedule`, `Scope`, `Stdio`, `Stream`. |

### External resources

| Resource                              | Use                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| stdout (TTY)                          | Ink writes frames here. Not directly touched by tui code; goes via ink's own writer.                    |
| stderr                                | Plain renderer writes through `Stdio.stderr()` (`tui/plain.ts:291`).                                    |
| stdin                                 | Ink's `useInput` (`tui/components.tsx:381`) attaches a TTY raw-mode listener for `q`/`r`/Ctrl-C/Ctrl-D. |
| `process.kill(process.pid, 'SIGINT')` | `tui/index.ts:168` (`onQuit` fallback from `App` prop); `tui/components.tsx:429` (Ctrl-C/D)             | In-process self-signal so `NodeRuntime.runMain` runs its SIGINT teardown. |

The TUI consumes NO file system, NO docker socket, NO HTTP/RPC endpoints. Everything goes through
the engine Ref.

## Capabilities PRODUCED

### TypeScript exports consumed elsewhere

| Export                                                                           | From                                                                                                                   | Consumers                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `startTuiOnce(): Effect.Effect<TuiMount, never, Scope>`                          | `tui/index.ts:144`                                                                                                     | `compose/devstack.ts:58` (inside the `tui` renderer factory's `mount`).                                                                                                                                                  |
| `TuiLoggerLayer(engine): Layer.Layer<never, never, never>`                       | `tui/index.ts:285`                                                                                                     | `compose/devstack.ts:64,88` (logger layer for BOTH `tui` and `plain` factories).                                                                                                                                         |
| `TuiMount` interface (`{proxy, install, flush}`)                                 | `tui/index.ts:36-45`                                                                                                   | `compose/devstack.ts:62-63` returns `{install, flush}` from this.                                                                                                                                                        |
| `SHUTDOWN_LOG_MESSAGE` (string)                                                  | `tui/components.tsx:42`; re-exported from `tui/index.ts:305`                                                           | DUPLICATED by `engine/supervisor.ts:104` as its own private copy (see Hard requirements). Tests in `tui/components.test.tsx:344-353` assert on its content via the engine log buffer.                                    |
| `App` (React component)                                                          | `tui/components.tsx:358`                                                                                               | `tui/index.ts:202`, `tui/components.test.tsx:32,57,80,…`                                                                                                                                                                 |
| `AppProps` interface                                                             | `tui/components.tsx:340-353`                                                                                           | `tui/index.ts:202-205`, `tui/components.test.tsx:32`                                                                                                                                                                     |
| `startPlainRenderer(source): Effect.fn`                                          | `tui/plain.ts:259`                                                                                                     | `compose/devstack.ts:76` (inside the `plain` renderer factory's `mount`).                                                                                                                                                |
| `HEARTBEAT_INTERVAL_MS`, `HeartbeatEntry`, `HeartbeatState`, `computeHeartbeats` | `tui/plain.ts:105,114,123,159`                                                                                         | `tui/plain.test.ts:25-29`. Header on each: `@internal — exported only so plain.test.ts can assert against it.`                                                                                                           |
| Type re-exports from `engine/tui-state.js`                                       | `tui/index.ts:307-315` (`TuiDimensions`, `TuiEndpoint`, `TuiEntry`, `TuiEntryKind`, `TuiLog`, `TuiState`, `TagStatus`) | Plumbing convenience — same types could be imported from `engine/tui-state.js` directly. Per the `tui-state.ts` header (`engine/tui-state.ts:13-19`), these types are explicitly INTERNAL and not on the public surface. |

### State-store / on-disk artifacts

**None.** `tui/*` writes nothing to disk, registers no state-store keys, mints no port leases. It is
a pure transducer from `engine.tuiState` → an ink VDOM (or stderr line stream).

### Events emitted

**None** in the EventEmitter sense. The renderer's "output" is:

- Ink: characters written to `process.stdout` via ink's internal `Yoga` layout engine + `cli-cursor`
  / `string-width` machinery. The TUI never calls `process.stdout.write` directly.
- Plain: lines written to `Stdio.stderr()`.

### Container images / volumes

**None.** TUI does not interact with docker.

### CLI commands registered

**None.** TUI doesn't register CLI verbs.

### Routes registered

**None.**

## Lifecycle

### Startup

The supervisor's mount sequence (verified in `engine/supervisor.ts:2014-2034`):

1. `runMain` enters the outer launch effect; `Effect.scoped` opens `ambient`; supervisor forks a
   parallel child `longLived` (`engine/supervisor.ts:1824-1825`).
2. `bootstrapCtx` (engine + watchers + StateStore + Identity + platform) is built on `longLived`
   (`engine/supervisor.ts:1835`).
3. `rendererFactory.mount({ tuiStateRef: engine.tuiState })` runs
   (`engine/supervisor.ts:2030-2032`).
   - **TUI factory** (`compose/devstack.ts:54-65`): yields `startTuiOnce()` inside the
     `bootstrapCtx`. That:
     - Allocates `stableState` Ref<TuiState> seeded with empty state (`tui/index.ts:146-151`).
     - Allocates `currentRef` Ref<EngineHandleShape | undefined> = none (`tui/index.ts:152`).
     - Builds the `proxy` engine handle (`tui/index.ts:154`) — see "Proxy engine" below.
     - Defines `onQuit` (fires `process.kill(process.pid, 'SIGINT')` as a belt-and-braces fallback
       if the q-handler can't make progress through the in-process Deferred path —
       `tui/index.ts:156-169`).
     - Defines `flush`: snapshot the current engine's `tuiState` into `stableState`, then
       `Effect.sleep('20 millis')` to let React commit (`tui/index.ts:179-192`).
     - Calls
       `render(React.createElement(App, {engine: proxy, onQuit, onFlush}), {exitOnCtrlC: false, patchConsole: false})`
       (`tui/index.ts:201-211`).
     - Registers an `Effect.addFinalizer(() => instance.unmount())` on the `longLived` scope
       (`tui/index.ts:212-216`).
     - Forks a `forever` polling fiber (`tui/index.ts:225-243`): every 50 ms, read `currentRef`,
       read its `tuiState`, write to `stableState` if changed (reference-equality short-circuit on
       line 238).
     - Returns `{proxy, install, flush}` (`tui/index.ts:261`).
   - **Plain factory** (`compose/devstack.ts:72-89`): yields
     `startPlainRenderer(Ref.get(deps.tuiStateRef))`. That:
     - Sets up a closure-local `previous: TuiState | undefined` and `heartbeats: Map`
       (`tui/plain.ts:270-276`).
     - Defines `tick`: read `source` (the engine's `tuiState`), compute diff lines, compute
       heartbeat lines, write to `Stdio.stderr()` as one concatenated string. EPIPE swallowed via
       `Effect.ignore` (`tui/plain.ts:278-293`).
     - Forks `tick.pipe(Effect.repeat(Schedule.spaced('500 millis')))` on the current scope
       (`tui/plain.ts:295`).
     - Returns `{flush: tick}` (`tui/plain.ts:303`).
   - **Silent factory** (`engine/renderer.ts:70-78`): returns
     `{install: () => Effect.void, flush: Effect.void}` immediately.
4. `rendererMount.install(engine)` runs (`engine/supervisor.ts:2033`).
   - TUI: snapshots `engine.tuiState` into `stableState` synchronously FIRST, then writes
     `currentRef = engine`. This ordering is deliberate to avoid a one-tick window where
     `currentRef` points at the new engine but `stableState` still carries the previous cycle's
     entries (`tui/index.ts:246-259`).
   - Plain / silent: no-op (`compose/devstack.ts:78`, `engine/renderer.ts:73`).
5. SIGUSR2 handler + watcher fibers install on `longLived` (`engine/supervisor.ts:2041-2057`).
6. Launch loop iterates `runOnce(cycle, engine, memoMap)` until either `awaitRestart` (loop again,
   cycle++) or `awaitShutdown` (return).

### Ready criteria

**The TUI itself has no "ready" probe.** It begins rendering frames immediately after `render(...)`
returns (or after the first 500 ms tick for plain). The renderer doesn't block startup — primitives'
`markAcquiring` lines surface as soon as the engine writes them.

The user's perceptual "ready" is `engine.setBuildStatus('running')` firing
(`engine/supervisor.ts:1753`), which flips the header chip from `[restarting]`/`[shutting-down]` to
cyan `[running]`.

### Restart behavior (per-cycle)

The ink mount **does NOT re-mount** between cycles. The supervisor's restart path
(`engine/supervisor.ts:1535+`):

1. `runOnce` closes its per-cycle `supervisorScope`, cascading finalizers (incl.
   `engine.invalidateAll`) — the OLD per-cycle engine becomes unreachable.
2. A new per-cycle engine is built into a fresh `memoMap`-driven scope.
3. `engine.seedTags(seedEntries)` runs (`engine/supervisor.ts:1624`) — the new engine's `tuiState`
   carries the next cycle's pending rows.
4. The supervisor calls `engine.setHeader({..., cycle: N+1, buildStatus: 'restarting'})`
   (`engine/supervisor.ts:1608-1614`).

But the ink mount is still pointing at the OLD engine via `proxy`. The supervisor swap is achieved
by re-running `rendererMount.install(newEngine)` on each iteration (NOT directly called per-cycle in
the current supervisor code — see `engine/supervisor.ts:2033` runs `install` ONCE before the launch
loop starts; the proxy then catches up via the 50 ms sync fiber and the new engine's seeded state).

**OPEN QUESTION:** `rendererMount.install(engine)` is only called once at
`engine/supervisor.ts:2033` (BEFORE the launch loop starts). The engine handle returned by
`bootstrapCtx` is the same instance across cycles (it lives on `longLived`). So the "swap" semantics
on the proxy described in `tui/index.ts:8-15` are effectively a no-op today — the proxy always
points at the same engine. The 50 ms sync fiber still mirrors that one engine's state into
`stableState`. This is fine for correctness; the docs in `tui/index.ts` describe a feature that the
v2 selective-restart implementation may exercise but currently doesn't.

### Teardown

Ordered shutdown sequence (verified in `engine/supervisor.ts:2069-2101`):

1. User gesture fires one of:
   - SIGINT/SIGTERM → `NodeRuntime.runMain` interrupts the launch fiber; `Effect.onInterrupt` runs.
   - `q` keypress in TUI → forwards to `engine.setBuildStatus('shutting-down')`
     - `engine.appendLog(SHUTDOWN_LOG_MESSAGE)` + `engine.requestShutdown` → supervisor's
       `awaitShutdown` race wins; loop returns; outer scoped finalizers fire; ALSO
       `Effect.onInterrupt` runs (via the belt-and-braces `process.kill(process.pid, 'SIGINT')`
       self-signal at `tui/index.ts:168` if requestShutdown is too slow to unblock).
   - Ctrl-C/Ctrl-D inside the TUI (ink eats it; the handler re-emits
     `process.kill(process.pid, 'SIGINT')` per `tui/components.tsx:428-430`).
2. `Effect.onInterrupt` body (`engine/supervisor.ts:2082-2099`):
   - `engine.setBuildStatus('shutting-down')` — flips header tint to yellow + switches footer copy
     to "Shutting down — …".
   - `engine.appendLog({…, message: SHUTDOWN_LOG_MESSAGE})`.
   - `rendererFlush` — invokes the renderer's `flush` Effect.
     - TUI: snapshot the current engine's `tuiState` into `stableState`, sleep 20 ms to let React
       commit.
     - Plain: run one `tick` synchronously, writing any pending diff + heartbeat lines to stderr.
     - Silent: `Effect.void`.
3. Per-primitive `markStopping` → docker stop fires → `markStopped` (run in parallel via the
   supervisor's `supervisorScope` `parallel` finalizer strategy + `engine.invalidateAll` —
   `engine/supervisor.ts:1593`). The TUI renders each row's status flip as long as ink is still
   alive (it is — finalizer fires LAST on `longLived`).
4. `instance.unmount()` (`tui/index.ts:213-215`) — ink's finalizer on `longLived` runs LAST,
   releasing the terminal back to the shell.
5. `NodeRuntime.runMain` exits with code 130 (SIGINT) or whatever the outer launch effect's failure
   code is.

**Hard-kill path** (second Ctrl-C / second SIGTERM, `engine/supervisor.ts:1890-1972`): synchronous
`docker kill` of every container labelled with our app+stack, then `process.exit(130)`. The TUI gets
no chance to update — ink's last frame is whatever was on screen when the second signal fired. The
supervisor writes the "force-killed N container(s)…" summary to stderr directly, bypassing the TUI
entirely.

### Grace windows

- **20 ms** — `flush` settle delay (`tui/index.ts:191`). The window React has to commit + ink has to
  write the final frame after `stableState` changes.
- **50 ms** — sync-fiber poll interval (`tui/index.ts:228`).
- **100 ms** — ink-side `setInterval` polling of `engine.tuiState` (`tui/components.tsx:373` via
  `pollIntervalMs` default 100).
- **500 ms** — plain renderer's tick interval (`tui/plain.ts:38`).
- **15 s** — plain renderer's heartbeat interval (`tui/plain.ts:105`).

## Hard requirements / invariants

These are constraints that historically broke things — comments in the code explicitly call them
out.

1. **Ink is mounted EXACTLY ONCE per `runMain` lifetime.** `tui/index.ts:7-15,123-143`. Per-cycle
   re-mounting was tried in three earlier iterations of the hand-rolled live-region driver; each
   shipped real bugs (missing ESC byte, screen never clearing, full re-renders, terminal state
   corruption). The single mount + proxy + sync-fiber pattern is the load-bearing choice that makes
   hot-restart visible without committing the previous cycle's frame to scrollback.

2. **`exitOnCtrlC: false` MUST be set on `render(...)`** (`tui/index.ts:208`). Ink swallowing SIGINT
   would skip the engine's scope-finalizer shutdown path and leak docker containers —
   `tui/index.ts:139-142`.

3. **`patchConsole: false` MUST be set on `render(...)`** (`tui/index.ts:209`). Ink's console-patch
   swallowed stray `console.*` into an internal buffer never surfaced; debugging
   `devstack.config.ts` becomes opaque. Cost is occasional layout tear from a stray write — accepted
   trade-off (`tui/index.ts:195-200`).

4. **The proxy engine's `tuiState` field MUST be the stable `Ref`, not the cycle engine's Ref
   directly.** `tui/index.ts:84`. `<App>` holds the proxy in a `useState`/closure-stable reference
   for the entire `runMain` lifetime; without the stable Ref, swapping cycles would confuse React's
   hook identity (the polling `useEffect` keys on `props.engine`, so a different engine reference
   would tear down + re-create the interval).

5. **Reference-equality short-circuit on the polled snapshot** (`tui/components.tsx:369`,
   `tui/index.ts:238`). The engine mints a fresh `TuiState` object on every mutation (`Ref.update`
   returns `{...s, ...}`), so `prev === next` is an accurate "did anything change" check. Without
   the guard, React scheduled 10 rerenders/sec on a quiet stack.

6. **The q-handler MUST call `setBuildStatus('shutting-down')` + `appendLog(SHUTDOWN_LOG_MESSAGE)`
   BEFORE `requestShutdown`.** `tui/components.tsx:399-405`. Asserted by
   `tui/components.test.tsx:292-311,332-355`. Without ordering, the user sees the launch loop exit
   without any visible state change → reads as a hang.

7. **`SHUTDOWN_LOG_MESSAGE` is DUPLICATED between `tui/components.tsx:42` and
   `engine/supervisor.ts:104`.** Header comments on BOTH files acknowledge this. The duplication
   exists deliberately so the supervisor doesn't import upward into `tui/`. Test assertions live in
   `tui/components.test.tsx:344-353` (engine path) and would need a peer test in supervisor land for
   the supervisor path. **PAIN POINT.**

8. **`process.kill(process.pid, 'SIGINT')` IS the q-handler's fallback, NOT the primary path.**
   `tui/index.ts:156-169`. The primary path is `engine.requestShutdown` (`tui/components.tsx:406`).
   The SIGINT self-signal exists so a `q` press during a mid-build (e.g. while accounts retry the
   faucet for 90 s) doesn't have to wait for the slowest primitive to resolve before teardown
   begins.

9. **In-process `requestShutdown` MUST resolve the supervisor's `awaitShutdown` Deferred** — without
   this, only the SIGINT fallback keeps the q-key working. The proxy forwards `requestShutdown` to
   the live cycle engine (`tui/index.ts:79-82`).

10. **The plain renderer MUST NOT crash on EPIPE** — `tui/plain.ts:291` pipes the stream write
    through `Effect.ignore`. Header comment (`tui/plain.ts:7-15`) explains: piping
    `--renderer plain` to `head -1` closes the pipe partway, EPIPE arrives, must not tear down the
    devstack.

11. **`TuiLoggerLayer`'s sink MUST swallow defects via `catchCause(() => Effect.void)`** —
    `tui/index.ts:299`. The wrapped Effect is `Ref.update`, which is `Effect.sync` and registers no
    finalizers, so the only realistic defect surface is "Scope closed" during supervisor shutdown.
    Swallowing means a late `Effect.log*` during teardown doesn't propagate a defect to the user.

12. **`Effect.runSync` in `TuiLoggerLayer` is intentional** — `tui/index.ts:292`. The sink runs
    inside Effect's fiber context (not Effect context), so it can't `yield*`. Alternative designs
    (offer onto a Queue, drain in a forked fiber) introduce a scheduling race where the drain may be
    interrupted before consuming if the layer's scope is short-lived.

13. **`Static` MUST be used for log entries above the live region** (`tui/components.tsx:434-442`).
    Each log entry is keyed by stable `${ts}-${i}` id so ink only re-renders new entries, freezing
    prior ones into terminal scrollback. Without `Static`, every poll tick re-renders every log line
    and the dashboard tears.

14. **`engine.tuiState.entries` reference-equality is a load-bearing contract.** Both the ink poller
    (`tui/components.tsx:369`) and the sync fiber (`tui/index.ts:238`) rely on the engine returning
    the SAME object reference when nothing changed. If the engine ever started returning a fresh
    `{...s}` on every read (vs only on mutation), the short-circuit collapses and 10 rerenders/sec
    return. Verified at `engine/engine.ts:330` (`updateEntry` only re-spreads when the entry
    actually changed).

15. **The plain renderer's heartbeat clock must NOT reset on phase change.** `tui/plain.ts:185-191`,
    asserted by `tui/plain.test.ts:128-159`. A new `setPhase` mid-acquire is expected; the operator
    still wants the "still acquiring [Ns]" cadence to keep counting from the original anchor.

16. **The plain renderer's heartbeat MUST bump by exactly one interval on a late tick** (not catch
    up backlog). `tui/plain.ts:189-190`, asserted by `tui/plain.test.ts:315-333`. A 90 s GC pause
    emits one line, not six.

17. **The ink mount finalizer (`instance.unmount()`) lives on `longLived`** (the outer launch
    scope), not on the per-cycle scope. `tui/index.ts:212-216`. Per-cycle teardown leaves ink alive;
    only `runMain` exit unmounts.

## Failure modes

| Trigger                                                       | Current behavior                                                                                                                                                                                                                                                                                                                                                                                                                | Recovery path                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stray `console.*` interleaves with an ink frame               | Layout tears for one frame; next render heals it                                                                                                                                                                                                                                                                                                                                                                                | Accept (per `tui/index.ts:195-200`). Documented trade-off for `patchConsole: false`.                                                                                                                                                                                                           |
| Plain mode pipe closes (EPIPE)                                | Stream write fails; `Effect.ignore` swallows; renderer keeps polling                                                                                                                                                                                                                                                                                                                                                            | Pipe consumer sees fewer lines. Devstack continues. (`tui/plain.ts:7-15`)                                                                                                                                                                                                                      |
| `Effect.log*` fires during a closed Scope                     | `TuiLoggerLayer`'s `catchCause` swallows the defect                                                                                                                                                                                                                                                                                                                                                                             | Log line silently dropped. (`tui/index.ts:299`)                                                                                                                                                                                                                                                |
| `engine.tuiState` Ref is never mutated                        | `lastSnapshot === snapshot` short-circuit; no React rerender; no plain tick output (heartbeat will still fire if a tag is in `acquiring`)                                                                                                                                                                                                                                                                                       | Normal "quiet stack" mode. (`tui/index.ts:238`, `tui/plain.ts:184-191`)                                                                                                                                                                                                                        |
| `setPhase` fires for an unknown key                           | Engine silently drops (`engine/engine.ts:548-560`) — phase has no auto-register path                                                                                                                                                                                                                                                                                                                                            | The dashboard never surfaces the phase. (Failure mode of engine, not TUI.)                                                                                                                                                                                                                     |
| `markSelectiveRestart` is called with a key not in `entries`  | Engine silently drops (asserted by `tui/components.test.tsx:682-694`) — no "ghost row"                                                                                                                                                                                                                                                                                                                                          | No surface effect.                                                                                                                                                                                                                                                                             |
| q-keypress fires twice in rapid succession                    | First q sets buildStatus + appendLog + requestShutdown; second q's setBuildStatus is a no-op (already `'shutting-down'`); second appendLog re-pushes the same SHUTDOWN_LOG_MESSAGE; second requestShutdown is a no-op (Deferred already resolved). Then if the user keeps mashing it ANY signal handler counts toward the hard-kill threshold via the supervisor's `installHardKillHandler` (`engine/supervisor.ts:1861-1982`). | Hard-kill on second SIGINT → `docker kill` + `process.exit(130)`.                                                                                                                                                                                                                              |
| Terminal resize                                               | Ink auto-relayouts via Yoga; TUI code itself does NOT subscribe to resize.                                                                                                                                                                                                                                                                                                                                                      | Automatic — no devstack handling needed. **OPEN QUESTION:** does ink fire a re-render on resize, or does it wait for the next state change? Verified by reading: nothing in `tui/*` calls `useStdout()` or `useStdoutDimensions()`.                                                            |
| Non-TTY stdout                                                | Auto-resolver picks `plain` mode (`engine/supervisor.ts:273`); ink never mounts                                                                                                                                                                                                                                                                                                                                                 | Working as designed.                                                                                                                                                                                                                                                                           |
| User redirects stderr (plain mode)                            | Plain mode writes its lines into the redirect file/pipe; consumer sees structured lines instead of a live dashboard                                                                                                                                                                                                                                                                                                             | Working as designed.                                                                                                                                                                                                                                                                           |
| The engine `Ref` returns an unexpected shape (e.g. undefined) | `setState((prev) => (prev === next ? prev : next))` would set `undefined`; `<App>` renders `emptyState` defaults via destructuring (no field access on `undefined`)                                                                                                                                                                                                                                                             | Would surface as empty UI. Not a defended-against failure.                                                                                                                                                                                                                                     |
| Long log line (> 240 chars, INFO/WARN)                        | Truncated to 240 chars + `…` (`tui/components.tsx:777-782`)                                                                                                                                                                                                                                                                                                                                                                     | Full text reachable via `docker logs` for container output.                                                                                                                                                                                                                                    |
| Multi-line log entry > 12 continuation lines                  | First 12 continuation lines rendered; suffix replaced with `… N more lines suppressed (check 'docker logs' for full output)` (`tui/components.tsx:765,847-854`)                                                                                                                                                                                                                                                                 | Same — `docker logs` for full output.                                                                                                                                                                                                                                                          |
| Long error in row (`entry.error`, > 60 chars)                 | Truncated at MAX_DETAIL_LEN=60 with `…` (`tui/components.tsx:279-282`); full text always in global log buffer                                                                                                                                                                                                                                                                                                                   | Working as designed; asserted by `tui/components.test.tsx:448-476`.                                                                                                                                                                                                                            |
| Plain renderer tick exception                                 | `tick`'s body is `source.pipe(Effect.flatMap(...))`; an unexpected throw inside `flatMap` would propagate; `Effect.forever(tick.pipe(Effect.repeat(REFRESH)))` would terminate the fiber. There is NO catch wrapper at the tick level today.                                                                                                                                                                                    | **NOT DEFENDED AGAINST.** OPEN QUESTION: is this acceptable, given that `source` is `Ref.get` (infallible) and `diffState`/`computeHeartbeats`/`formatEntryLine`/`Stdio.stderr()` are pure or `Effect.ignore`'d? Inspection suggests "yes, currently safe", but no defensive try/catch exists. |

## Persistence model

| Category                                     | What                                                                                                                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Survives restart (state-store keys, on-disk) | **Nothing.** TUI writes nothing to state-store. Log lines live only in the engine's in-memory `LOG_BUFFER_LIMIT=200` ring (`engine/engine.ts:276`).                                                         |
| Survives snapshot                            | **Nothing.** Snapshot reads docker volumes + state-store, not the TUI buffer.                                                                                                                               |
| Wiped on `devstack wipe`                     | **Nothing TUI-specific.** TUI is process-local.                                                                                                                                                             |
| Process-local only                           | EVERYTHING. The `proxy` engine, `stableState`, `currentRef`, `heartbeats`, ink VDOM, ink terminal-state, are all process-local memory. A second `devstack up` (sibling stack) gets its own independent TUI. |

The TUI is a pure transducer — engine `Ref` → terminal characters. No persistence layer.
Cycle-to-cycle continuity is supplied by the engine (`engine.tuiState` survives across per-cycle
scope teardown because the engine itself lives on `longLived`).

## Modes & variants

Three renderer modes are selectable via `--renderer` flag or `defineDevstack({ renderer })` config.
Auto-selected by `engine/supervisor.ts:271-274` based on `process.stdout.isTTY`.

| Dimension                         | `tui` mode                                                                                                                                                                                                                                                                                                                                                                                         | `plain` mode                                                                                                                                                                                  | `silent` mode                                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required term capability          | TTY required for normal operation. Ink renders raw escape sequences regardless of `isTTY` (no internal guard in tui code); `process.stdout.isTTY === true` is only checked by the supervisor's auto-resolver.                                                                                                                                                                                      | None. Writes plain UTF-8 lines to stderr.                                                                                                                                                     | None.                                                                                                                                                                                     |
| Output target                     | `process.stdout` via ink (cursor/clear/diff). Goes through ink's `Static` for scrollback-pinned log entries + a live region below for the dashboard.                                                                                                                                                                                                                                               | `process.stderr` via `Stdio.stderr()` (`tui/plain.ts:262,291`).                                                                                                                               | None. Devstack runs headlessly.                                                                                                                                                           |
| Color                             | ANSI colors via ink's `<Text color="…">` props — cyan/green/yellow/magenta/blue/red/`*Bright` variants + `dimColor`/`inverse`/`bold`. No explicit `NO_COLOR` / `FORCE_COLOR` honoring in `tui/*` — relies on ink's own color autodetection. **OPEN QUESTION:** does ink read `NO_COLOR`? Per ink docs it relies on `chalk`/`ansi-styles` which DO honor `NO_COLOR`, but not asserted in our tests. | No color. Plain `printf`-style lines.                                                                                                                                                         | N/A.                                                                                                                                                                                      |
| Keypress handling                 | `ink.useInput` handler (`tui/components.tsx:381-431`). Binds: `q`/`Q` → shutdown sequence + onQuit; `r`/`R` → `engine.requestRestart`; Ctrl-C / Ctrl-D → `process.kill(process.pid, 'SIGINT')`.                                                                                                                                                                                                    | None — stdin is not attached. Ctrl-C is handled by `NodeRuntime.runMain`'s signal handler at the OS level.                                                                                    | None.                                                                                                                                                                                     |
| Log behavior                      | Logs append to engine's `LOG_BUFFER_LIMIT=200` ring via `TuiLoggerLayer`; rendered via `<Static>` (scrollback) by `LogLine` (`tui/components.tsx:784-858`). Per-line cap 240 chars (INFO/WARN), uncapped (ERROR/FATAL). Multi-line capped at 12 continuation lines.                                                                                                                                | Logs append to same engine ring via `TuiLoggerLayer` (`compose/devstack.ts:88`); plain renderer's diff pass emits any new logs as `[HH:MM:SS] LEVEL message` (`tui/plain.ts:90-92,242-247`).  | Logs append to engine ring but NOTHING reads them out. Default Effect logger continues to emit on stderr (silent factory's `loggerLayer` returns `Layer.empty`, `engine/renderer.ts:77`). |
| Heartbeat                         | None — the dashboard is always live; rows visibly show their `acquiring` glyph + phase.                                                                                                                                                                                                                                                                                                            | "still acquiring [Ns]" per tag every 15 s (`tui/plain.ts:94-105`). Suppressed on the same tick as a transition (`tui/plain.ts:181-184`). Bumps by exactly one interval (no backlog catch-up). | None.                                                                                                                                                                                     |
| Render cadence                    | Ink internal `useState` setter fires React rerenders; engine state polled at 100 ms (`tui/components.tsx:373`). Ink batches stdout writes to ~60 FPS.                                                                                                                                                                                                                                              | 500 ms tick (`tui/plain.ts:38`).                                                                                                                                                              | N/A.                                                                                                                                                                                      |
| Per-cycle behavior                | Ink mount survives cycles. `rendererMount.install(engine)` swaps the engine into the stable proxy (see `tui/index.ts:245-259`).                                                                                                                                                                                                                                                                    | No `install`-time work (`compose/devstack.ts:78`); the plain renderer reads `engine.tuiState` directly through the closed-over Ref captured at `mount` time.                                  | No-op install.                                                                                                                                                                            |
| Performance                       | ~10 React rerenders/sec maximum; reference-equality short-circuit makes a quiet stack effectively free. Ink's Yoga layout per render.                                                                                                                                                                                                                                                              | 2 ticks/sec. Diff is O(entries + new-log-count); typical stack has ~10 entries, ~0–20 new logs per second. Single `stderr` write per tick (joined `\n`).                                      | ~Zero.                                                                                                                                                                                    |
| Mount sequence                    | `startTuiOnce()` → seed empty `stableState`/`currentRef` → build proxy → `render(...)` → register unmount finalizer → fork 50 ms sync fiber.                                                                                                                                                                                                                                                       | `startPlainRenderer(source)` → set up closure-local previous + heartbeats → fork `tick.repeat(500ms)` on the current scope.                                                                   | `silentRendererFactory.mount()` → `Effect.succeed({install: noop, flush: void})` immediately.                                                                                             |
| Teardown                          | `flush` writes engine snapshot → `stableState`, sleeps 20 ms. Ink's `unmount()` runs on `longLived`-scope finalize.                                                                                                                                                                                                                                                                                | `flush` runs one synchronous `tick` invocation (so the final 'shutting-down' state lines reach stderr before docker-rm finalizers freeze the event loop — `tui/plain.ts:297-303`).            | `flush` is `Effect.void`.                                                                                                                                                                 |
| Persistence                       | None.                                                                                                                                                                                                                                                                                                                                                                                              | None.                                                                                                                                                                                         | None.                                                                                                                                                                                     |
| Failure modes (mode-specific)     | Stray `console.*` tears layout one frame; recovered next render.                                                                                                                                                                                                                                                                                                                                   | EPIPE on closed pipe silently swallowed; tick continues.                                                                                                                                      | None.                                                                                                                                                                                     |
| Dependencies (mode-specific)      | `ink` ^7, `react`, `effect`.                                                                                                                                                                                                                                                                                                                                                                       | `effect` (`Stdio`, `Stream`, `Schedule`), no `ink`.                                                                                                                                           | `effect` only.                                                                                                                                                                            |
| Hard requirements (mode-specific) | Ink mount lives on `longLived`. `exitOnCtrlC: false`, `patchConsole: false`. Proxy `tuiState` MUST be the stable Ref. SHUTDOWN_LOG_MESSAGE duplicated in `tui/components.tsx`.                                                                                                                                                                                                                     | Heartbeat clock NOT reset on phase change. Heartbeat bumps by exactly one interval on late tick. EPIPE must not tear devstack. Single concatenated write per tick (not per line).             | None.                                                                                                                                                                                     |
| CI fast-fail                      | TUI mode keeps the wait-for-`r` behavior (developer is at keyboard).                                                                                                                                                                                                                                                                                                                               | First-cycle build failure on non-TUI causes `Effect.fail` with exit-non-zero (`engine/supervisor.ts:1743-1751`).                                                                              | Same as plain — non-TUI fast-fails.                                                                                                                                                       |
| Endpoints panel                   | NO separate panel; per-entry endpoints render inline (first endpoint in detail column, rest as continuation rows under the row — `tui/components.tsx:319-324,679-732`).                                                                                                                                                                                                                            | All endpoints joined as `label=url` pairs inside the per-entry transition line (`tui/plain.ts:79-81`).                                                                                        | N/A.                                                                                                                                                                                      |

## Test coverage

### `tui/components.test.tsx` (722 LOC, 22 cases)

Wrapping `describe('App')`. Every case mounts `App` via `ink-testing-library`, drives a real
`EngineLive` engine, awaits a ~50 ms flush, and asserts on either `lastFrame()` or `engine.tuiState`
(read via `Ref.get`).

1. **`renders empty-state placeholder when no primitives are seeded`** (`:30`) — `lastFrame`
   contains `'no primitives in stack'`, `'[r]estart'`, `'[q]uit'`.
2. **`renders a service entry with title + primary URL + ready badge`** (`:45`) — seed
   `@devstack/Sui`, markAcquiring, markReady with title + primary; frame contains `'Services'`,
   `'localnet'`, `'http://127.0.0.1:9000'`, `'ready'`.
3. **`renders an action entry with the ready badge surfaced as "done"`** (`:68`) — frame contains
   `'Actions'`, `'hello'`, the packageId, `'done'`, the upgrade-cap extra.
4. **`actions section: three+ ready rows collapse into one compact summary line`** (`:93`) — frame
   contains `'Actions'`, `'done (3)'`, the three names normalized, and `'done'` appears exactly
   ONCE.
5. **`actions section: an endpoint-bearing row is excluded from the collapse`** (`:127`) —
   `'done (3)'` for the 3 URL-less rows; the 4th row's URL still visible.
6. **`actions section: in-flight row stays full while ready siblings collapse`** (`:165`) —
   `tx.slow` (acquiring, phase=executing) shows `'slow'`, `'executing'`, alongside `'done (3)'`
   summary for the three ready siblings.
7. **`failed entry surfaces the short error in the row and the full walk in the log tail`** (`:202`)
   — frame contains `'failed'` and the error string.
8. **`header surfaces app/network/cycle and build status`** (`:221`) — frame contains `'arena'`,
   `'localnet (stack=main)'`, `'cycle 2'`, `'[running]'`.
9. **`detail column prefers lastLog over primary when both are set`** (`:244`) — appendTagLog of
   `'starting genesis'` shows in detail column instead of the primary URL.
10. **`q keypress invokes onQuit after the shutdown-feedback flush`** (`:272`) — stdin.write('q'),
    then onQuit called exactly once.
11. **`q keypress flips engine.buildStatus to shutting-down`** (`:292`) — after stdin.write('q'),
    `engine.tuiState.header.buildStatus === 'shutting-down'`.
12. **`shutting-down build status renders [shutting-down] in the header`** (`:313`) —
    setHeader('shutting-down'); frame contains `'[shutting-down]'`.
13. **`q keypress appends a teardown-narration log line`** (`:332`) — last log message contains
    `'Shutting down'`, `'stay warm'`, `'devstack wipe'`, NOT `'container'`.
14. **`R (capital) keypress triggers engine.requestRestart (full restart)`** (`:357`) —
    stdin.write('R'); `Effect.timeout(engine.awaitRestart, 500ms)` resolves.
15. **`r (lowercase) keypress triggers engine.requestRestart (full restart)`** (`:370`) — same as
    #14 but lowercase.
16. **`logs appended to engine.tuiState surface in the rendered frame`** (`:384`) — appendLog →
    frame contains `'sui localnet ready'` + `'info'`.
17. **`rows group by the leading <group>.<name> segment of the title`** (`:399`) — three entries
    with `sui.localnet`/`accounts.alice`/`publish.hello` → `'Services'`, `'Actions'` headers
    visible, bare names visible.
18. **`seeded title surfaces while still pending (no markAcquiring yet)`** (`:428`) — pending row's
    title from seedTags renders as `Services` / `localnet` / `pending`, NOT the raw `@devstack/Sui`
    key.
19. **`long error truncates instead of wrapping onto a second row`** (`:448`) — frame contains the
    prefix + the truncation marker `'…'` + does NOT contain the tail of the long string.
20. **`acquiring entry surfaces the active phase as the status word`** (`:478`) —
    `setPhase('running genesis')` → frame normalized contains `'running'`, NOT `'acquiring'`.
21. **`acquiring entry without a phase falls back to the "starting" status word`** (`:503`) —
    `markAcquiring` only → frame contains `'starting'`, NOT `'acquiring'`.
22. **`phase override maps the awaiting-rpc compound phase to "waiting"`** (`:523`) —
    `setPhase('awaiting rpc + faucet + graphql')` → frame contains `'waiting'`.
23. **`unclassified entry lands under the synthetic Other section`** (`:545`) — entry with
    `kind: 'other'` and key `'mystery'` → frame contains `'mystery'` + `'Other'`.
24. **`multi-endpoint entry renders each endpoint on its own indented line`** (`:566`) — three
    endpoints (rpc/faucet/graphql) all visible by label + URL.
25. **`renders full packageId / address without truncating to "0x…"`** (`:600`) — 64-char hex
    packageId visible (normalized for ink wrap).
26. **`selective-restart: flag flips on markSelectiveRestart and clears on markReady`** (`:636`) —
    markSelectiveRestart(`{vault, codegen}`); vault+codegen entries have
    `selectiveRestart === true`, Sui entry doesn't. After markReady → flag undefined.
27. **`selective-restart: unknown keys are silently dropped (no ghost row)`** (`:682`) —
    markSelectiveRestart with an unseeded key → no entry materialized.
28. **`selective-restart: re-acquire reflows the row through acquiring → ready`** (`:696`) — full
    happy-path of the selective restart cycle.

(Note: the file's test counter has crept past the 22 I projected — actual cases as numbered above
land at 28. The `it(...)` calls are the source of truth.)

### `tui/plain.test.ts` (357 LOC, 13 cases)

Wrapping `describe('computeHeartbeats')`. Pure-function unit tests against the heartbeat helper — no
fiber, no real time. Uses fixed `BASE = new Date('2026-01-01T00:00:00').getTime()`.

1. **`does NOT emit on first sighting in acquiring (t=0)`** (`:72`) — anchor only;
   `lines.length === 0`; `state.get('svc.a').nextEmitAt === BASE + 15000`.
2. **`emits exactly one heartbeat at t = startedAt + 15s`** (`:87`) — at `BASE+15000`, one line,
   schedule bumped to `BASE+30000`.
3. **`emits two heartbeats total across 30s — one per interval`** (`:104`) — one at `BASE+15000`,
   one at `BASE+30000`, content reads `[30s]`.
4. **`does NOT emit on intermediate ticks before the next interval`** (`:117`) — at `BASE+500`, no
   line.
5. **`a phase change at t=10s does NOT reset the 15s clock`** (`:128`) — anchor, phase change
   suppressed at t=10s, heartbeat fires at t=15s with the new phase visible.
6. **`transition out of acquiring clears state — no further heartbeats`** (`:161`) — after
   transition to ready (with suppression), `state.has('svc.a') === false`; later tick produces no
   lines.
7. **`heartbeat without phase reads "still acquiring [Ns]"`** (`:191`) — string match
   `/ still acquiring$/`, no `phase=`.
8. **`heartbeat with phase reads "still acquiring (phase=<phase>)"`** (`:207`) — exact string match
   including the phase suffix.
9. **`next heartbeat reflects the LATEST phase even if it changed mid-window`** (`:227`) — anchor
   with phase-a, change to phase-b mid-window, t=15s heartbeat shows phase-b.
10. **`multiple concurrent acquires get independent schedules`** (`:256`) — svc.a anchors at t=0;
    svc.b anchors at t=5s; only svc.a fires at t=15s; only svc.b fires at t=20s.
11. **`suppression: heartbeat skipped on the same tick as a transition`** (`:292`) — same-tick
    suppression keeps the schedule from bumping.
12. **`a 90s-late tick emits exactly ONE catch-up heartbeat, not many`** (`:315`) —
    `lines.length === 1`, schedule bumped to `BASE+30000` (not by 6 intervals).
13. **`drops bookkeeping when an entry disappears from the snapshot entirely`** (`:335`) — entry
    removed → state.has returns false.
14. **`transitioning failed clears state just like ready does`** (`:345`) — failure transition also
    clears bookkeeping.

### `tui/logger.test.ts` (28 LOC, 1 case)

1. **`routes Effect.log* into engine.appendLog so the renderer can pick them up`** (`:12`) —
   `Effect.logInfo('hello tui')` and `Effect.logError('something bad')` under
   `TuiLoggerLayer(engine)` → `engine.tuiState.logs` contains both messages; the error one has
   `level === 'Error'`.

### What the tests DO NOT cover

- No `startPlainRenderer` integration test — only `computeHeartbeats` is exercised directly. The
  diff pass (`diffState`), the EPIPE swallow path, the cross-tick `previous` state mutation, and the
  `flush` return value are all untested.
- No `startTuiOnce` integration test — only `App` is exercised via `ink-testing-library`. The proxy
  engine swap, the 50 ms sync fiber, the reference-equality guard, and the `flush` Effect are
  untested.
- No `Header`/`Footer` standalone tests; both are exercised transitively via `App` tests.
- No NO_COLOR / FORCE_COLOR / TERM-capability handling tests.
- No resize tests.
- No tests of the "stopping" / "stopped" glyphs and colors (`STATUS_GLYPH`, `STATUS_COLOR` map
  entries for those two statuses). Tests cover `pending`/`acquiring`/`ready`/`failed` but the two
  teardown statuses are only exercised in production via the supervisor.
- No tests of the Footer's "Shutting down — waiting on N services from K plugins (…)" path. Tested
  at engine level (`engine.tuiState.entries` count under `shutting-down`) but not the actual
  rendering.

## Pain points today

1. **SHUTDOWN_LOG_MESSAGE is duplicated** between `tui/components.tsx:42` and
   `engine/supervisor.ts:104`. Comments on both call this out. The reason is the deliberate
   "supervisor doesn't import upward into `tui/`" constraint, but the cost is two strings that can
   drift independently; only `tui/components.test.tsx:344-353` pins the user-facing copy, and only
   via the engine-log buffer path. Anyone editing one location has to remember to edit the other.

2. **The engine handle is passed as a React prop into the ink tree (`AppProps.engine`)** and methods
   are called directly from the keypress handler. This is the assignment's flagged "TUI fed by
   direct method calls" coupling. It makes the TUI un-reusable without an `EngineHandleShape`; an
   alternate UX (e.g. a remote-control web dashboard) cannot reuse `App` because it would need the
   same 23-method handle surface.

3. **The proxy engine implements `EngineHandleShape` with mostly-noop defaults**
   (`tui/index.ts:83-119`). 14 methods return `Effect.void`; only `tuiState`, `requestRestart`,
   `requestShutdown`, `appendLog`, `setBuildStatus` are actually forwarded. The proxy is a leaky
   abstraction — the noop methods exist purely to satisfy `EngineHandleShape`, and any future field
   addition to `EngineHandleShape` requires touching the proxy or breaking the type.

4. **`Effect.runPromise(Ref.get(...))` inside React's `useEffect`** (`tui/components.tsx:370,374`) —
   this is "runtime escape": we drop out of Effect into Promise-land to bridge React's hook model.
   It works, but the `.catch(() => {})` swallow on line 372/376 is a one-direction error funnel — if
   `Ref.get` ever failed (it shouldn't), the dashboard would silently freeze on the last good frame.

5. **`Effect.runSync` inside `TuiLoggerLayer`'s sink** (`tui/index.ts:292`) — same runtime escape,
   with a `catchCause(() => Effect.void)` swallow. The header comment (`tui/index.ts:275-283`)
   acknowledges the design tension explicitly.

6. **`Effect.runFork` inside the q/r/R keypress handlers** (`tui/components.tsx:398,422`) — yet
   another runtime escape; ink's `useInput` handler is synchronous so we can't `yield*`. The
   `Effect.tap` follow-up to fire `onFlush()` + `onQuit()` after the shutdown sequence
   (`tui/components.tsx:408-414`) is awkward because it lives inside `runFork`'s pipe — the
   synchronicity guarantee is fragile.

7. **Two separate poll loops** drive the dashboard: ink's 100 ms `setInterval` inside `<App>`'s
   `useEffect` AND the supervisor-side 50 ms `Effect.forever` sync fiber in `tui/index.ts:225-243`.
   They both read `engine.tuiState`; one mirrors to `stableState`, the other reads from
   `props.engine.tuiState` (which IS the stable Ref via the proxy). The 50 ms fiber's snapshot wins,
   gets copied to `stableState`, then the 100 ms ink poller reads `stableState`'s parent state and
   triggers React rerender. Effectively the system polls at the slower of the two, but the
   architecture has two clocks where one would suffice. **Asserted by**: nothing — tests don't
   exercise the cross-clock interplay.

8. **`SECTION_ORDER` / `SECTION_HEADER` / collapse rules are constants inside the `NodeTable`
   function body** (`tui/components.tsx:484-498`) — every render allocates these maps fresh. Cheap
   (small N) but obviously suboptimal.

9. **The `parseTitle` fallback for `other`-kind entries** (`tui/components.tsx:262-267`) groups by
   the leading `<group>.<name>` prefix, which can land an `'other'`-kind entry into an arbitrary
   bucket (e.g. an entry named `sui.foo` lands in the `Sui` bucket alongside real Sui-kind
   services). The intent is graceful handling of hand-rolled refs, but the merging is silent.

10. **Footer "waiting on N services" pluralization** is hand-rolled (`tui/components.tsx:901-902`) —
    three conditional `${pending.length === 1 ? '' : 's'}` flourishes. Not a real pain, but
    indicates we don't have a shared i18n / pluralization helper.

11. **`SOURCE_PREFIX_RE` is a hand-rolled regex** (`tui/components.tsx:742`) that depends on
    log-message formatting conventions (`<service>: <message>` or `@devstack/<service>: <message>`)
    established elsewhere in the codebase. If the convention changes (e.g. a primitive prefixes with
    `[service]` instead of `service:`), log-line tinting silently breaks; no test pins the regex's
    behavior.

12. **The TUI imports `EngineHandleShape` directly from `engine/engine.js`** instead of from a
    narrower "TUI-facing" subset interface. Today's proxy satisfies the full shape; if
    `EngineHandleShape` were narrowed to just the fields the TUI actually reads/writes, the proxy
    could be 1/3 the size.

13. **`TuiState.endpoints` and `TuiState.depTreeLevels` are defined on the type but not surfaced by
    the TUI** (`engine/tui-state.ts:101-105, 133`). Endpoints are rendered per-entry via
    `TuiEntry.endpoints` instead; `depTreeLevels` is populated by the supervisor at compose time but
    no component reads it. Dead field today — would be the natural source for a build-plan preview
    banner.

14. **The TUI mount/unmount is INSIDE the launch effect**, so an unrelated startup failure (e.g.
    state-store lock contention) _while ink is mounted_ will tear ink down via the scope finalizer.
    Fine in production but means an early failure renders briefly then flashes away.

## Open questions

1. **Is the proxy's `install` ever called more than once per supervisor lifetime?**
   `engine/supervisor.ts:2033` calls it ONCE before the launch loop starts. If the engine is stable
   across cycles (it lives on `longLived`), the per-cycle swap is dead code today — but the proxy's
   existence implies a design where the engine WOULD be per-cycle. Reading the supervisor commits,
   this looks like a leftover from a pre-`longLived` design that never got pruned.

2. **Does ink honor `NO_COLOR` / `FORCE_COLOR` / `TERM=dumb`?** Not asserted in `tui/*`. Ink's color
   rendering routes through `chalk` which DOES honor `NO_COLOR` per upstream docs, but our test
   suite never sets `NO_COLOR=1` and verifies a stripped frame.

3. **Does the TUI redraw partial state during snapshot capture?** Snapshot is invoked via the
   `devstack snapshot` CLI verb, NOT during `devstack up`. The TUI is not active during `snapshot`.
   So the question is moot — but it's the question the assignment asks, and the answer is "snapshot
   is not a thing the TUI sees, only `devstack up`'s long-running supervisor loop is".

4. **What is the endpoint sidecar mentioned in `engine.ts` comments?** `engine/engine.ts:299`
   declares `endpoints: Object.freeze([]) as ReadonlyArray<TuiEndpoint>` — a TOP-LEVEL
   `TuiState.endpoints` array that is never populated by anything in the codebase. The per-entry
   `TuiEntry.endpoints` is the actual surface used. The top-level array seems to be a vestigial dead
   field, possibly intended for an "Endpoints" panel that was never built. The TUI does NOT surface
   a separate Endpoints panel.

5. **Does the TUI react to terminal resize?** No explicit `useStdoutDimensions()` or resize
   listener. Ink's Yoga layout will re-flow on the next `setState`, so a resize during a quiet stack
   will leave the layout stale until the next state mutation. Not a defended-against case. **OPEN
   QUESTION:** does ink internally subscribe to `process.stdout.on('resize', ...)` and force a
   rerender? Per ink 7 docs it does; not verified in our tests.

6. **What is the relationship between the "Footer 'waiting on N containers'" phrasing in
   `engine/supervisor.ts:105`** (the comment says "waiting on N containers" but the actual rendering
   is "waiting on N services from K plugins" in `tui/components.tsx:900-903`)? The assignment notes
   a `engine/supervisor.ts:105`-quoted footer phrase. That `:105` is the `SHUTDOWN_LOG_MESSAGE`
   definition in supervisor, not a "waiting on N containers" line. **The phrase is "waiting on N
   service[s]"**, not "N containers" (deliberately moved per the in-code comment
   `tui/components.tsx:893-897`).

7. **Why does `LogLine`'s message-string split on `\n`** while the detail-column truncation does NOT
   split? The latter could orphan a trailing newline glyph inside the row's flex slot. Possibly
   intentional (the detail-column callers' input strings don't contain newlines), but no test
   asserts this.

8. **Does anyone besides `tui/components.test.tsx` directly construct `App`?** Currently no — only
   the production `startTuiOnce` mount and the test. The `pollIntervalMs` prop exists for tests; the
   production call site doesn't set it (`tui/index.ts:202-206` only passes `engine` + `onQuit` +
   `onFlush`).

## Opportunities noticed

1. **Collapse the engine-handle proxy into a narrow "TUI-facing" interface.** The 14 noop methods in
   `tui/index.ts:83-119` exist only because we leaked the full `EngineHandleShape` into the React
   tree. A `TuiEngineReader` interface —
   `{tuiState, requestRestart, requestShutdown, setBuildStatus, appendLog}` — would be 5 fields, no
   noops, no `_shadowCache` placeholder, and would let `<App>` accept any object satisfying that
   smaller surface (handy for future remote dashboards).

2. **Deduplicate `SHUTDOWN_LOG_MESSAGE`.** Three options: (a) move it into `engine/tui-state.ts` (a
   leaf module both depend on), (b) make the supervisor consume it from `tui/components.tsx` via a
   re-export path that doesn't add to the supervisor's import graph in a circular way, or (c) accept
   the duplication but add a test in supervisor land that pins both copies to the same string.

3. **Drop the unused top-level `TuiState.endpoints` field** (`engine/tui-state.ts:101-105,115`).
   Per-entry endpoints (`TuiEntry.endpoints`) is the live surface; the top-level array is never
   populated and never read.

4. **Consolidate the two clocks.** The 100 ms ink `setInterval` + 50 ms sync fiber both poll the
   same Ref. A single sync fiber whose tick directly writes into a `SubscriptionRef` (or that calls
   into ink's `rerender` API) would halve the polling overhead and make the "did anything change"
   short-circuit live in one place.

5. **Reach for a `SubscriptionRef`** instead of polling. The engine exposes a plain
   `Ref.Ref<TuiState>` today; switching to a `SubscriptionRef` would let the TUI subscribe to
   mutations instead of poll, eliminating BOTH polling fibers and the cross-fiber short-circuit
   logic. Cost: bumping the engine's surface — a non-trivial refactor.

6. **Move per-section constants (`SECTION_ORDER`, `SECTION_HEADER`) out of `NodeTable`'s function
   body** (`tui/components.tsx:484-498`) to module scope. Cheap fix; trivial allocation win.

7. **Plain renderer's `tick`-level error handling is implicit.** Adding an
   `Effect.catchAll(() => Effect.void)` outside the `repeat(REFRESH)` would make the "we never crash
   on rendering" invariant explicit instead of relying on `source` (Ref.get) being infallible and
   `stdio.stderr()` being `Effect.ignore`'d.

8. **Promote `MAX_DETAIL_LEN` / `INFO_LOG_MAX_CHARS` / `LOG_BUFFER_LIMIT` to user-tunable knobs.**
   Today they're hard-coded. Power users with wide terminals + verbose primitives would benefit.

9. **`PHASE_STATUS_OVERRIDES` is a 3-entry map** that's actually a readability-tweak fixture for the
   existing phase strings; a more maintainable model would be for the engine's `setPhase` API to
   accept an optional `statusWord` field rather than having the TUI re-parse the phase. Couples the
   engine to a TUI presentation concern slightly more, but removes the parse-the-phrase guesswork.

10. **Combine `SECTION_COLORS` + `PLUGIN_COLOR_MAP` palette logic.** Both use the same 7-element
    palette + the same FNV-1a hash fallback (`sectionColor` lines 116-130, `pluginColor` lines
    160-178). A single shared `colorForName(name, palette)` helper would deduplicate ~25 lines.

11. **`tui/index.ts`'s `useEffect` runs an effect through `Effect.runPromise(...)` THREE times per
    polling cycle** (initial apply + every interval). Consolidating into a single `Effect.runFork`
    with a `Schedule.spaced` repeat would let the cleanup function interrupt the fiber instead of
    `clearInterval`, giving structured concurrency semantics for free.

12. **The `SOURCE_PREFIX_RE` regex** (`tui/components.tsx:742`) duplicates knowledge about the
    `<service>: <message>` log convention. Engine's `appendTagLog` already knows which tag produced
    the log; surfacing that attribution in the `TuiLog` shape itself (an optional `source?: string`
    field) would let the TUI tint without the regex-parse round trip.

13. **No assertions on the "stopping" / "stopped" rendering.** Adding one ink-testing-library case
    per teardown status (markStopping, markStopped — both glyphs and colors) would close a small but
    real coverage gap and pin the teardown UX.

14. **The plain renderer's tick output is `lines.join('\n') + '\n'`** (`tui/plain.ts:290`).
    Constructing the text via `Stream.fromIterable (lines).pipe(Stream.intersperse('\n'))` would
    Effect-idiomatically serialize without intermediate string allocation. Minor.

15. **`tui/index.ts:307-315`'s type re-exports duplicate the `engine/tui-state.ts:13-19` "internal
    only" intent.** Either `tui/index.ts` is genuinely public (in which case the re-exports are
    correct and `tui-state.ts`'s comment is misleading) or it is internal (in which case downstream
    consumers should import directly from `engine/tui-state.ts`). Today the public barrel
    (`packages/devstack/src/index.ts`, not read above but per the `tui-state.ts:13-19` comment) does
    NOT re-export these, so the `tui/index.ts` re-export is internal-to-package. Could be deleted.
