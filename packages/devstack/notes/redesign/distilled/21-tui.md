# 21 TUI (distilled)

## Purpose

The TUI is devstack's terminal-UI presentation surface during a long-running `devstack up`. It
exists to make the engine's lifecycle legible to a human operator at a terminal: which primitives
are pending vs acquiring vs ready vs failed, which phase each is in, what endpoints they expose,
what errors have surfaced, and what the global log tail says. It is one of several peer surfaces
(CLI, programmable API, codegen, build-integrations) that all observe the same lifecycle; it has no
privileged status, no special engine hooks, no engine-vocabulary carve-out.

It is a pure transducer: lifecycle state in, terminal characters (or plain-text lines, or nothing)
out. It persists nothing, owns no domain state, mints no resources, and has no domain logic of its
own.

## Surface-equality principle

The TUI must subscribe to a typed event stream (or read a typed state projection) the engine
publishes for every consumer, and publish typed commands (shutdown, restart, selective restart,
etc.) into a typed command channel every surface can use. It must not name itself in the engine's
vocabulary, and the engine must not name the TUI in its.

Concretely, the engine never knows "the TUI is mounted", never knows "the dashboard wants a phase
narration", never knows "the renderer needs a display object". Whatever shape the engine exposes for
one surface (events + state-read + command-publish) is the shape every surface uses. The TUI is a
consumer of a generic projection, not a co-author of the engine's API.

"Consume state without dictating engine internals" here means: the engine emits structured lifecycle
facts (status transition, phase set, log appended, endpoint registered, error reported, build status
changed); the TUI interprets those facts into rows, glyphs, colors, narration text. The
interpretation lives in the TUI. The fact lives in the engine. The engine never imports anything
that hints at how the fact will be displayed.

## Responsibilities

- Status display: render one row per primitive showing its current lifecycle status (pending,
  acquiring, ready, failed, stopping, stopped) with a stable name + group classification.
- Phase narration display: surface the most recent phase string for an acquiring primitive as a
  human-readable verb.
- Endpoint surfacing: render primary + auxiliary endpoints inline with their owning primitive when
  those endpoints are user-actionable (URLs to click, addresses to copy).
- Error/hint surfacing: show a short error blurb on a failed row; full text is reachable via the log
  stream.
- Log streaming: render a bounded log tail (engine-owned ring buffer) with level-based coloring and
  per-line truncation rules.
- Build-status header: show the overall stack state (booting, running, restarting, shutting-down)
  and cycle counter.
- Input handling (interactive mode only): translate keypresses (quit, restart) into command
  publications on the shared command channel.
- Section grouping + collapse: organize rows into sections (services, packages, accounts, actions,
  apps, other) and collapse uninteresting ready-row clusters into summary lines.

## Renderers

Three renderer variants exist, selected at startup:

- **Ink dashboard** — interactive React-for-terminal tree. Live grouped table + scrollback-pinned
  log lines + footer. Used when stdout is a TTY and the operator wants the live view. Owns keypress
  handling for quit and restart.
- **Plain renderer** — non-interactive line-stream output to stderr. Emits one structured line per
  status transition, one per new endpoint, one per new log entry, plus a periodic "still acquiring"
  heartbeat per in-flight primitive. Used in CI, when piped, when stdout is not a TTY, or when
  explicitly selected.
- **Silent** — no output at all. Devstack runs headlessly. Used by scripted/programmatic flows that
  consume the event stream directly and don't want any side-channel rendering.

Selection: explicit CLI/config selection wins; otherwise auto-resolve based on whether stdout is a
TTY. The choice is made before any renderer mounts; the renderers themselves are interchangeable
behind a common contract and cannot tell which one was picked.

A future JSON renderer is a natural sibling — same event stream, but emits one structured JSON line
per fact for machine consumption.

## Lifecycle states

TUI process states:

- not-mounted (silent mode, or before mount)
- mounted-live (interactive ink view actively rendering frames)
- mounted-stream (plain renderer ticking on a schedule)
- flushing (during shutdown — final frame/lines being committed)
- unmounted (terminal released back to shell)

Row states the renderers display:

- pending (declared, not yet started)
- acquiring (in-flight start)
- ready (start succeeded; the row's primary value is now usable)
- failed (start raised; error surfaced)
- stopping (teardown in progress)
- stopped (teardown complete)
- selective-restart-in-flight (re-acquire mid-run; cosmetic flag)

Build-status states displayed in the header:

- booting / running / restarting / shutting-down

## Inputs / dependencies

What the TUI reads (from the engine's projection layer):

- A subscribable lifecycle-state stream or snapshot Ref containing: the set of entries (one per
  primitive) with their statuses, phases, titles, errors, endpoints, source-plugin tags, and kind
  classifications.
- A bounded log ring buffer (engine-owned) with per-line timestamps, levels, source-attribution, and
  messages.
- A header projection (app name, network identity, cycle counter, build status, optional pre-flight
  build plan).
- A clock for plain-renderer heartbeat scheduling.

What the TUI writes (into the engine's command channel):

- A shutdown-request command.
- A restart-request command.
- (Future) a selective-restart command for a named subset.

The TUI does NOT touch the file system, docker, the network, port allocator, state store, or any
service plugin directly.

## Outputs / capabilities provided

- Visible terminal output (stdout for ink, stderr for plain, nothing for silent).
- A keypress-driven mechanism to publish shutdown + restart commands.
- A flush hook the supervisor can call at shutdown to commit the final frame/lines before terminal
  teardown.

The TUI exports no domain artifacts, registers no CLI verbs, no endpoints, no routes, no state-store
keys, no docker resources.

## Invariants and constraints

- Mounted exactly once per process lifetime. Per-cycle re-mounting historically caused frame tears,
  terminal state corruption, and scrollback duplication. The mount survives all in-process restarts.
- Frame stability: rendering must short-circuit when nothing has changed (reference-equality on the
  polled snapshot is the practical signal). A quiet stack must produce no visible churn and
  near-zero CPU.
- No-TTY fallback: if stdout is not a TTY, the live renderer is never selected; the plain renderer +
  heartbeat substitute. The fallback must be automatic, not require a flag.
- Exit-code preservation: the TUI must not swallow the supervisor's exit code on SIGINT / quit /
  failure. SIGINT must still reach the scope-finalizer teardown so docker containers are released.
- Heartbeat behavior (plain mode): clock anchors on first sighting in acquiring; phase changes do
  NOT reset the clock; a late tick emits exactly one heartbeat (no backlog catch-up); transition out
  of acquiring clears bookkeeping.
- Pipe-safety: writes to stdout/stderr must not crash on EPIPE (`head -1 | devstack up` is a
  supported invocation).
- Live-region discipline: log entries above the live dashboard region must be scrollback-pinned (not
  re-rendered) so prior output is preserved in the terminal history.
- Console-passthrough discipline: stray writes (a misplaced `console.log` from user code) should
  reach the terminal even if they tear one frame. Silent capture into an invisible buffer is worse
  than transient layout glitches.
- Color handling must defer to upstream conventions (NO_COLOR, FORCE_COLOR, TERM=dumb) without
  TUI-specific overrides.

## Edge cases and known failure modes

- Stray non-Effect writes (`console.*`, child-process stdout that escapes capture) interleave with
  the live region: accept one tear, recover on next render.
- Pipe consumer closes early (EPIPE in plain mode): swallow the stream error, keep ticking, devstack
  continues.
- A `setPhase` arrives for an unseeded key, or a selective-restart references an unknown key: the
  projection drops it silently — no ghost rows. The TUI inherits this behavior.
- Late `Effect.log*` calls during shutdown after scope close: the log sink must swallow defects; a
  late log line is dropped silently rather than propagating a defect to the user.
- Quiet-stack churn: without reference-equality short-circuiting, the projection-poll rerenders the
  whole dashboard several times a second on an idle stack.
- Terminal resize mid-quiet-stack: the layout may stay stale until the next state mutation if the
  underlying terminal library doesn't subscribe to resize events. Untested today.
- Two rapid quit gestures: the first publishes shutdown commands; a second within the grace window
  must count toward the hard-kill threshold the supervisor enforces (synchronous docker-kill + force
  exit). The TUI does not own this logic but must not block it.
- Hard-kill path: when the supervisor force-exits, the TUI gets no flush window. The last frame is
  whatever was on screen. The supervisor writes its own summary directly to stderr, bypassing the
  renderer.
- Very long log lines / multi-line entries: truncate at documented caps with a "see container logs
  for full output" hint; never wrap unbounded text into the live region.
- Long error blurbs on failed rows: truncate in-row; full error reachable via the log tail.

## Learnings from current implementation

The single biggest substrate violation in the current codebase is the TUI's vocabulary leaking into
the engine's public API. Three symptoms of this same violation:

1. **Engine methods named after TUI concerns.** The engine exposes methods like
   `markReady(display)`, `appendTagLog`, `setEntryTitle`, `setPhase`. These name renderer-side ideas
   (a "display", a "title", a "phase narration") on the engine surface. Every plugin's start path
   calls these methods, so the engine API cannot be redesigned without touching every plugin. The
   TUI is allowed to interpret a lifecycle fact as "a phase narration"; the engine must not name
   facts in those terms.

2. **A "proxy engine" satisfying the full engine handle shape just to feed the React tree.** Today
   the renderer accepts the entire engine handle as a prop (~20+ methods) and calls into it directly
   from keypress handlers. To swap engines across cycles, a proxy object is constructed that
   implements every method of the engine handle — but ~14 of those methods are noop stubs that exist
   purely to satisfy the type. The noop count is the measure of the leak: every noop is an engine
   concern that has no business being visible to the renderer at all. In the redesign, the renderer
   must consume a narrow projection (subscribable state + command publisher), not the engine handle.
   A renderer-facing interface should have 0 noops, not 14.

3. **Direct method-call coupling from the React tree into the engine.** Keypress handlers call
   `engine.setBuildStatus(...)`, `engine.appendLog(...)`, `engine.requestShutdown` directly from
   inside the React render tree, bridged through Effect runtime escapes (`Effect.runFork`,
   `Effect.runPromise`, `Effect.runSync`) because React's hook model is synchronous. This couples
   the renderer to an engine-handle shape AND requires escape hatches from structured concurrency
   for every interaction. The redesign should replace direct calls with command publication on a
   typed channel — the same channel CLI/programmable API/codegen use.

What to do instead in the redesign:

- The renderer reads a narrow, renderer-facing projection (the smallest superset of fields any
  consumer needs), not the engine handle.
- The renderer writes commands onto a typed command channel; the engine consumes the channel and
  decides what to do. The renderer has no awareness of supervisor internals like Deferred / Queue /
  scope structure.
- The engine never exposes anything named after a renderer concern. No "display", no "title", no
  "phase" in engine vocabulary — those become the renderer's interpretation of generic facts (status
  transitions, free-form annotations the publisher attaches to its own primitive).
- Subscription, not polling. The two-poll-loop architecture (50ms sync fiber + 100ms React poll) is
  a consequence of having no proper subscription primitive at the engine. A pub-sub or
  SubscriptionRef-style API at the engine level eliminates both poll loops and the
  reference-equality short-circuit logic.
- Test the renderer against a fake projection + fake command sink, not against a live engine. Today
  every TUI test boots an `EngineLive`; that's only possible because the renderer takes the engine
  handle. A narrow projection makes test fakes trivial.

Additional secondary lessons:

- Constants shared between the renderer and the supervisor (the shutdown narration string is the
  canonical example) belong in a shared leaf module both can depend on, not duplicated.
- Renderer-side polished defaults (truncation caps, column widths, buffer sizes) should be reachable
  as user-tunable knobs.
- Per-renderer-mode behavior (heartbeat, color, keypress) should live with the renderer, not be
  smuggled into the engine.

## Cross-component references

- `01-engine-core` (lifecycle state machine that publishes the facts the TUI projects)
- `03-observability` (log buffer + renderer factory selection + pretty-error rendering; pretty
  errors are a renderer concern per the goals doc, NOT engine-resident)
- `20-cli` (peer surface; its `--renderer` flag selects which TUI mode loads; CLI publishes commands
  onto the same channel the TUI uses)
- `22-programmable-api` (peer surface; consumes the same projection programmatically)
- `19-codegen` (peer surface; subscribes to readiness events before emitting artifacts)
- `23-build-integrations` (peer surface; consumes lifecycle events from a build plugin)
- `17-snapshot` (the snapshot CLI verb does not run alongside the TUI; orthogonal)

## Open questions / decisions deferred

- Does the engine expose a generic event stream + a state-snapshot Ref + a command channel, or just
  a SubscriptionRef + commands? The choice affects whether the TUI is purely state-driven or hybrid
  (some facts only appear as one-shot events, e.g. "a log line was appended at this timestamp").
- Should per-row presentation knobs (column widths, truncation caps, log buffer size, heartbeat
  interval) be user-configurable, and at what scope (per-stack config? CLI flags? env vars)?
- Should the projection include a pre-flight build-plan preview, or is that strictly a CLI concern?
- Should there be a JSON renderer for programmatic consumers? If yes, what's the line-protocol
  contract?
- How does the renderer interact with the supervisor's hard-kill path? Today it gets no flush window
  on a second SIGINT; should the supervisor offer a "fast flush" hook the renderer can guarantee
  will complete in under N ms?
- Where does the shutdown narration string canonically live so it's not duplicated between renderer
  and supervisor?
- Should `setPhase`-equivalent (free-form annotation a publisher attaches to its primitive while
  acquiring) be a structured facet (verb + detail) or remain free-form text?
- Does the renderer subscribe to terminal resize, or rely on the upstream library? Today this is
  untested.

## Opportunities noticed

- The renderer-facing projection should be defined in a shared leaf module and consumed by every
  surface; this is the natural home for the today-duplicated shutdown narration string and similar
  shared constants.
- The two-poll-loop architecture (one fiber-side, one React-side) collapses to a single subscription
  if the engine exposes a proper pub-sub primitive.
- Section-color and plugin-color palettes use the same hash + the same 7-element palette; a single
  `colorForName(name, palette)` helper deduplicates the logic.
- Log source attribution should be carried as a structured field on log records, not parsed back out
  of the message string by a renderer-side regex.
- The plain renderer's tick has no explicit error wrapper; the invariant "rendering never crashes
  the stack" should be made explicit, not implicit in the infallibility of its inputs.
- The `TuiState.endpoints` and `TuiState.depTreeLevels` fields are defined but unread; either fold
  them into a real "endpoints panel" / "build-plan preview" feature in the redesign or omit them.
- Status-glyph + status-color tables for `stopping` / `stopped` are exercised only in production
  today; the test fake projection enables coverage trivially.
- Selecting a renderer mode could be a generic surface-loading concern (which event/command consumer
  modules are loaded), not a bespoke "renderer factory" registry. The same machinery that loads the
  CLI / programmable-API / codegen / build-integration surfaces should load the TUI.
- The renderer's keypress-to-command path crosses three Effect runtime escapes today (`runFork`,
  `runPromise`, `runSync`); a command-channel design with a properly-scoped fiber on each surface
  eliminates all three.
