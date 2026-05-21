# 20 CLI (distilled)

## Purpose

The CLI is the `devstack` binary's user-facing command surface — a single bin entry that dispatches
to a small fixed set of verbs (lifecycle, snapshot, stack, fork, diagnostic, introspection). Its job
is to parse args, apply environment overrides (network) _before_ any user-config import, route into
the engine, and render the result as either human text or a structured JSON envelope. It is
intentionally thin: it owns parsing, rendering, exit-code shaping, and prompt severity tiers. It
does not own state, lifecycle, or the engine — it merely calls into them and reports.

## Surface-equality principle

The CLI is one of five peer surfaces (with TUI, programmable API, codegen, build-integrations). None
is privileged; the engine speaks the same vocabulary to all of them.

- The CLI subscribes to typed engine events (readiness, progress, completion, error causes) and
  publishes typed commands (start, apply, snapshot, wipe, prune, advance, etc.) — never reaches into
  engine internals directly.
- Access to engine state goes through the same observation surface as TUI and programmable API. CLI
  must not have read paths that other surfaces lack.
- Output (envelope, exit codes, prompts) is the CLI's own concern; engine commands and events are
  surface-agnostic.
- Adding a new engine capability lights up all surfaces. Adding a CLI verb only adds
  parsing/rendering for an existing capability.

## Subcommands

Lifecycle:

- `up` — bring a stack up and stay attached until interrupted.
- `apply` — one-shot reconcile; build the layer to the point where state + manifest are written,
  then exit.
- `status` — observational read of stack state, manifest, and (if present) fork meta.

Persistence:

- `snapshot save` / `restore` / `list` / `delete` — capture, rehydrate, enumerate, remove
  point-in-time captures of a stack.

Teardown / cleanup:

- `wipe` — per-(app, stack) teardown of containers, networks, volumes, on-disk state.
- `prune` — cross-stack inventory + bulk cleanup, including orphans, repo-gone entries, interactive
  picker, and global passes over images / router / fork cache.
- `stack list` / `new` / `use` / `down` / `drop` — per-app stack management (creation, active-stack
  selection, stop, destroy).

Fork (chain-fork operations):

- `fork status` — point-in-time or streaming view of the fork supervisor.
- `fork advance-clock` / `advance-checkpoint` / `replay-to` — explicit time/checkpoint progression.
- `fork seed list` / `diff` — inspect / verify the on-disk seed manifest.
- `fork cache list` / `prune` — inspect / clean the shared upstream-snapshot cache.

Diagnostic / introspection:

- `doctor` — preflight check matrix + environment inventory, optionally cleaning stale locks.
- `manifest` — render the current stack's manifest (human or JSON).
- `graph` — render the dependency graph (text / mermaid / dot) and optional downstream-restart
  preview.
- `version` — one-line version.

Global:

- `--schema --json` action — emit the entire command tree + envelope shape + exit-code table +
  documented env vars as one JSON document.

Explicitly absent:

- No `restart` verb. Hot-restart is an engine concern (signal- and watcher-driven) that the CLI does
  not wrap.
- No `init` / scaffolding verb. Users hand-write the config.

## Responsibilities

1. Parse args; surface usage errors as a distinct exit code.
2. Apply network override into the environment **before** dynamically importing the user's config
   (top-level config reads of network env must observe the flag).
3. Dynamically import the user's config only when the verb needs it; verbs that don't (`status`,
   `snapshot *`, `wipe`, `prune`, `stack *`, `fork *`, `doctor`, `manifest`, `version`) never touch
   it.
4. Resolve the active `(app, stack, stateDir)` triple from a single fixed precedence chain (flag >
   env > active-stack file > built-in default).
5. Dispatch into engine commands; subscribe to engine events; project them into stdout/stderr.
6. Render output in the format the caller asked for (human or JSON envelope) and shape an exit code
   accordingly.
7. Run severity-tiered prompts when a destructive verb requires confirmation; collapse to
   non-interactive failures when stdin or environment forbid it.
8. On top-level failure, render a single pretty error to stderr; never double-render (subcommands
   that already rendered should be marked so the top-level renderer skips them).

## Output formats

Three output channels combine into the surface:

- **Human text (stdout)** — default for TTY callers. Free-form `Console.log` lines, lists, prompt
  previews. Color and ANSI on; respects standard escapes.
- **JSON envelope (stdout)** — chosen by `--json` flag or env switch. Exactly one envelope per
  command on stdout; pinned schema version. Absent fields are omitted entirely (no `undefined`
  values in serialized output). Carries: ok-flag, command name, data payload, error block (code,
  exit-code, hint, recipe, context), hints, elapsed time, dry-run flag.
- **Structured pretty error (stderr)** — only on failure, only when the subcommand has not already
  rendered its own error. Tree-form cause printout; stderr never receives the JSON envelope.

Selection rules:

- JSON mode is sticky: when enabled (flag or env), it applies uniformly across the verb. Prompts
  that would block must instead fail with a confirm-required code.
- Long-running verbs (`up`, `fork status --follow`, `prune --interactive`) currently use
  renderer-style output (TUI/plain/silent) rather than envelopes; an envelope per significant event
  is a noted future direction.
- Streaming verbs emit one record per event with stable line semantics (ISO timestamp + payload).

## Lifecycle / invocation patterns

Per-invocation shape: parse → maybe-override-env → maybe-load-config → dispatch → render → teardown
→ exit.

Per-verb mode:

- **Long-running until interrupt**: `up` (engine supervisor loop), `fork status --follow` (event
  stream).
- **Interactive until user exit**: `prune --interactive` (picker UI).
- **One-shot to scope-close**: `apply` (layer build completes when manifest is written).
- **One-shot synchronous**: every other verb — read state, perform action, emit summary, exit.

Ready criteria:

- `up`: engine reports the supervisor's overall readiness; CLI itself stays attached until
  interrupted.
- `apply`: layer-build scope closes successfully; manifest and state files have been written.
- All others: process exits 0.

Teardown:

- Successful completion → exit 0.
- Clean interrupt (Ctrl-C with no other failure) → exit 0.
- Any other failure → non-zero exit (today always 1; future: thread the envelope's numeric sysexit
  through).
- Long-running verbs must propagate the OS interrupt into the engine's scope so finalizers (e.g.
  container removal) run before the process leaves.

Restart behavior: none in the CLI. Re-invoke the binary. Engine-level hot-restart lives in the
supervisor.

## Inputs / dependencies

Inputs from the user:

- argv (positional + flags) parsed against a fixed command tree.
- Documented env vars: active-stack override, state-directory override, app-directory override,
  network override, manifest-path override, JSON mode, no-input mode, plus the standard
  color/no-color convention.
- The user's config module (only when the verb needs it), accessed by dynamic import. Each verb that
  needs it requires a specific projected field on the default export.

Inputs from the engine:

- Typed events for readiness, progress, errors, lifecycle transitions.
- Typed errors with structured tags (config not found, config invalid, seed-manifest mismatch,
  supervisor live, snapshot not found, etc.).
- Read-only views of: registered stack inventory, manifest, state, fork meta, fork cache inventory,
  dependency graph, docker label inventory.
- Command surface for: start/launch, apply, snapshot save/restore/list/delete, prune (per-stack and
  cross-stack), router bootstrap, fork RPCs (status, advance, replay, seed diff), lock sweeps.

Platform dependencies:

- Node process (argv, env, stdin/stdout/stderr, exit code, signals).
- TTY detection on stdin (prompt eligibility) and stdout (renderer default for `up`).
- An interactive-prompt library for confirm + text input (lazy-loaded so non-interactive paths don't
  pay the import cost).
- An Ink-style TUI library for `prune --interactive` only.

## Outputs

Per invocation:

- Exactly one JSON envelope (in JSON mode) or zero-or-more human lines (otherwise) on stdout.
- Zero or one pretty error tree on stderr (failure only).
- One numeric exit code.

Side effects (only when the verb mandates them):

- Writes/removes inside the state directory (active-stack pointer, stack directories, snapshot
  directories, fork cache directories).
- Removes Docker resources by label (containers, networks, volumes, optionally images).
- Removes stale lock files (state-store locks, move-git locks).
- Mutates `process.env.<network>` before dynamic import.

The CLI does **not** publish to any event bus. All communication is one-shot stdout + exit code;
long-running verbs use renderer output.

## Invariants and constraints

Sysexits-style exit-code table (pinned numbers and names):

- 0 OK; 1 generic; 64 usage; 65 data; 66 no-input; 69 unavailable; 73 cant-create; 75 temp-fail; 78
  config; and devstack-domain block: 40 supervisor-live; 41 snapshot-not-found; 42 seed-mismatch; 43
  confirm-required.
- Numbers and names are stable; new codes added at the end of the domain block.
- Today only some codes make it to `process.exitCode`; the envelope carries the precise code.
  Threading every code through to the OS exit code is mandated.

JSON envelope:

- Schema version pinned; bumped intentionally on breaking changes.
- Absent fields omitted from serialized output (no `undefined`).
- Exactly one envelope per command on stdout in JSON mode.
- Envelope must never carry devstack-internal types (no engine class instances, no Effect cause
  objects raw); errors are projected into a flat error block.

Surface invariants:

- Bin entry path must remain stable; renaming breaks every `npx` / `pnpm` / CI script.
- Network env override must be applied **before** any user-config import.
- Stack-name resolution precedence is fixed: explicit flag > env > active-stack file > default name.
- Docker label filters used by destructive verbs must include **both** app and stack labels;
  stack-only filtering would clobber sibling apps that share a stack name.
- Network and volume removal must run **after** the container kill pass (Docker rejects removal of
  live endpoints/mounts).
- `up` must hand its long-running effect to the outer Node runtime directly, not nest a runtime —
  otherwise SIGINT cannot reach scope finalizers and container teardown leaks.
- Clean Ctrl-C must exit 0, not the OS-conventional 128+signal value, so script runners don't flag
  it as failure.
- Top-level error rendering must not double-print when a subcommand already rendered.
- Stack and app name regexes must reject path traversal and shell metas (they flow into Docker
  labels and filesystem paths).
- Mutually-exclusive flag pairs (notably the upstream-cache pair on `wipe`) must fail with a usage
  code.
- `--dry-run` must short-circuit **before** prompting (the point of dry-run is "no side effects,
  including prompts").
- Interactive verbs (`prune --interactive`) must refuse to run on non-TTY stdin.
- Destructive verbs must re-verify supervisor liveness immediately before mutation (defends against
  a supervisor that woke up between inventory and action).
- Observational verbs (`status`, `manifest`) must tolerate missing/malformed state files — they
  describe what is, not what should be.
- Doctor's port probe must probe both wildcard and loopback addresses to mirror the engine's port
  allocator.
- The unconditional move-git stale-lock sweep on `wipe` must respect a minimum-age threshold to
  avoid touching live git ops.

## Edge cases and known failure modes

- Config not found at default path and walk-up exhausted: config-load error, exit non-zero.
- Config missing the expected projected field for the verb: typed config-load error.
- Docker daemon unreachable: best-effort handlers return empty; doctor surfaces a required-check
  failure with the unavailable exit code.
- `apply` hits a seed-manifest mismatch: render a recipe (wipe + apply with the right flags) and
  exit with the data-error code.
- `snapshot restore` reference not found or ambiguous: dedicated codes (snapshot-not-found, usage
  for ambiguous).
- `wipe` / destructive verbs without `--yes` on a non-TTY: confirm-unsupported usage error.
- `wipe` with `--no-input` and no `--yes`: confirm-required code.
- Tier-2 type-to-confirm declined (user typed the wrong phrase): declined outcome, usage exit.
- Live-supervisor refusal: `prune` / `wipe` against an in-use stack refuses with a supervisor-live
  signal.
- `fork *` against a non-fork or missing manifest: descriptive error with guidance to `apply` or to
  select the correct stack.
- Invalid positional integers (`advance-clock`, `advance-checkpoint`, `replay-to`): clear validation
  error.
- Replay-to a target already past: emit a noop success; do not error.
- Ctrl-C inside a prompt: cancelled outcome, usage exit.
- Stack/prune/app name validation failure: pinned regex rejection.

## Learnings from current implementation

- **Sysexits codes drift if not centralized.** All codes (standard + domain) must live in one table
  with name + description, drivable both by the schema-emit action and by per-command error
  builders.
- **Envelope schema must omit, not null, absent fields.** Tests catch regressions but the discipline
  is fragile; the builders themselves must enforce it.
- **One canonical envelope builder.** Per-verb hand-rolled JSON drifts; a single emit helper plus a
  single fail-with-envelope helper covers the surface.
- **Already-reported sentinel pattern.** Subcommands that pretty-print their own error need a marker
  so the top-level renderer skips them; the marker must traverse the cause structure used by the
  underlying Effect runtime.
- **Shared resolution helpers.** Without one helper for stack/app/state-dir/fork-paths, every
  command re-implements the precedence and they drift.
- **Severity-tiered prompts.** Two tiers (y/N for routine, type-to-confirm for
  destructive-of-shared-state) suffice; both must collapse to non-interactive failure modes that
  respect `--yes`, `--no-input`, and stdin TTY state.
- **Lazy-load the prompt library.** Non-interactive paths shouldn't pay the import cost and should
  remain usable in environments where the library is absent.
- **Live-holder defense is multi-layered.** Both the surface-level check and the engine-level lock
  guard must run; defense in depth is acceptable but duplication should consolidate.
- **`--dry-run` is load-bearing for automation.** Every mutating verb should have it; today it's
  inconsistent (notably absent on `replay-to`).
- **Network override timing is load-bearing.** Mutating the env var after the dynamic import lands
  too late because user config reads it at top level.
- **Renderer choice for `up` must not collapse to a single mode.** Plain mode is required for CI;
  TUI is required for interactive use; silent is required for embedded use.
- **Doctor's port probe must mirror the engine.** Mismatched probe addresses cause user-visible
  "doctor says fine, engine says port busy" confusion.
- **Move-git lock sweep is unconditional on `wipe` for a reason.** Stale `.lock` files left behind
  by interrupted Move builds cause subsequent builds to hang forever; threshold the age to avoid
  touching live ops.
- **State file reads in observational verbs must be tolerant.** Throwing on missing/malformed files
  breaks `status` for stacks that haven't been brought up.
- **Snapshot id needs a random suffix.** Same-second saves would otherwise collide.
- **Snapshot label-fragment match must look at the tail.** First-dash splits the random suffix and
  never matches the label.

## Cross-component references

- **Engine core (01)**: command surface and event surface the CLI dispatches into / subscribes to;
  lock contract; pretty-error infrastructure; identity / labels; resolve-app-dir; atomic-write;
  dep-graph + topo-levels.
- **Engine resources (02)**: state-store / registry contract; per-stack vs cross-app inventory
  model; router lifecycle; snapshot engine; move-build-lock; sui-fork meta / control /
  cache-inventory.
- **Observability (03)**: structured log surfaces the CLI projects into stderr; cause-to-JSON
  projection used by the envelope's error block.
- **Runtime / Docker (04)**: docker inventory, label filters, kill-then-network-then-volume
  ordering, image label sweep.
- **Sui (05)**: GRPC client used by `fork *` verbs (status, advance, subscribe, seed).
- **Walrus, Seal, DeepBook (06-08)**: peer service surfaces; CLI verbs are agnostic — same envelope,
  same exit codes.
- **Faucet (11), Account (12), Coin (13), Package (14), Wallet (15), Action (16)**: domain surfaces
  invoked through the same engine command surface — the CLI does not own bespoke handling per
  domain.
- **Snapshot (17)**: persistence model the snapshot verbs consume; id format, label resolution,
  include-images / include-fork-data conventions.
- **Router (18)**: shared router lifecycle that `prune --include-router` and `apply` (bootstrap)
  interact with.
- **Codegen (19)**: peer surface; same envelope discipline applies if codegen needs CLI verbs.
- **TUI (21)**: peer surface — same event subscription model; CLI prompts vs TUI panels are
  presentation only.
- **Programmable API (22)**: peer surface — same command/event surface available without going
  through stdin/stdout.
- **Build integrations (23)**: peer surface — invokes engine commands without rendering an envelope.
- **Examples (24)**: consume the CLI as the canonical entry point; their CI relies on the envelope
  and exit-code contracts.

## Open questions / decisions deferred

- Does the schema-emit action fire when the rest of argv is malformed (unknown subcommand)?
  Currently yes by virtue of global-flag dispatch order; behavior should be pinned by a test either
  way.
- Should every verb propagate its envelope's numeric exit code all the way to `process.exitCode`, or
  is "1 on failure" plus the envelope sufficient? The redesign should pick one and enforce it.
- How does the CLI surface engine-level concurrent-`up` lock contention? Today it inherits whatever
  the engine raises; the envelope should carry a stable code.
- Should `apply --dry-run` simulate router bootstrap and fork-meta consistency, or remain a
  config-only validation? "Validate without starting" is a useful third mode.
- Should long-running verbs (`up`, `fork status --follow`, `prune --interactive`) gain a JSON
  envelope stream mode (one envelope per significant event) for agent consumption?
- Should `--schema --json` enumerate per-verb flags? Today it lists commands only because the parser
  doesn't yet expose flag introspection; the redesign should pick a stable parser that does.
- Should the CLI offer a `restart` verb wrapping the engine's hot-restart signal, or stay out of it
  entirely?
- Should `--no-input` and the corresponding env be the single source of truth for "no prompts ever"
  across every verb (today `prune` rolls its own check)?
- Should `--include-images` / `--keep-snapshots` / `--include-fork-cache` / `--include-router` move
  into a single composable "scope-of-destruction" flag rather than a growing matrix?
- Should `up` accept an injected renderer factory (advanced callers) or stay closed at renderer-kind
  names?
- Should the snapshot id format sort lexicographically (move the random suffix to the end of all
  sort keys)?

## Opportunities noticed

- **Centralize action-time state-dir reads.** Every mutating verb re-implements the
  `${stateDir}/stacks/<stack>` join; one resolver.
- **One shared `--json` / `--dry-run` / `--yes` / `--stack` / `--app` flag definition** consumed by
  every verb instead of duplicated declarations.
- **One shared confirm-tier helper** that subsumes the duplicated TTY/`--yes`/`--no-input` logic in
  `prune` and `wipe`.
- **Lift sysexits codes into `main`'s teardown** so the OS exit code always matches the envelope.
- **Centralize the documented-env-var registry** so the schema-emit action and the consumers can't
  drift.
- **Pair the already-reported sentinel with the intended exit code** so the top-level reporter can
  thread the right code through without per-call wiring.
- **Split `prune` per-mode** (list / target / orphans / repo-gone / interactive) so the 600+-LOC
  file mirrors how `fork/` was split.
- **Consolidate live-supervisor checks** so there's one defense, not two slightly different ones.
- **Reduce `--dry-run` / `--json` description drift** across verbs (today they're near-identical but
  not identical).
- **`status`'s chain block and `fork seed list`'s rendering** read the same fork meta; share the
  projection.
- **Per-verb JSON envelopes on `stack *` and `prune --interactive`** so every mutating verb has an
  automation-ready output (today both fall back to human lines).
- **Long-running envelope stream for `up`** so agents can wait for "stack ready" without polling
  `status`.
- **Per-flag schema introspection** so `--schema --json` is actually agent-discoverable.
- **Audit the docker-gated test stubs** — several are placeholders; the surface they advertise is
  not yet covered.
