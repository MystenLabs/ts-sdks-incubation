# `devstack` CLI Redesign — Research, Audit, Proposal

Status: design proposal, READ-ONLY. No source touched. Author: Claude (Opus 4.7), 2026-05-19. Scope:
full ground-up redesign of the `devstack` CLI surface — verbs, flags, prompts, errors, JSON
envelope, agent affordances, library choice, migration phases.

---

## 0. TL;DR

The CLI we have now is a v3-parity port: 5,987 LoC under `packages/devstack/src/cli/`, eleven
subcommands, twenty-plus boolean flags, no prompts, four different "destructive op gate" patterns,
two competing error-rendering paths, and `--json` support that is present on some commands and
silently absent on others. Recent searches show every named "AI-agent-friendly CLI" of 2025–2026
(gh, stripe, vercel, supabase, …) has converged on the same shape: **noun-verb tree,
default-prompt-on-TTY destructive ops, `--json` everywhere with a stable envelope, deterministic
exit codes, `--dry-run` first-class for anything mutating, machine-readable errors with a
recommended next step.** Devstack is on the wrong side of all of those except the
JSON-on-some-commands one.

The redesign proposes:

1. Stay on Effect's `effect/unstable/cli` (we already use it; rewrites would burn the layer
   integration we get for free) — and layer `@clack/prompts` on top of it for the interactive
   confirm/select primitives that today's CLI lacks entirely.
2. **One destructive-op pattern**: prompt on TTY, refuse on non-TTY without `--yes`, support
   `--dry-run` (alias `-n`) everywhere a write happens. No more `--yes`-as-the-only-way.
3. **One JSON envelope** (`{ok, command, data?, error?, hints?}`) applied across every subcommand,
   plus a `--schema` introspection mode so agents can autodiscover the command tree without scraping
   `--help`.
4. Rename + consolidate: `wipe` → `reset`, fold `prune` into `stack` and `cache` subtrees, demote
   `fork seed diff` exit-1-on-mismatch into a typed error, split the 723 LoC `doctor` into
   checks-of-checks.
5. New verbs: `doctor --json` enriched, `logs <service>`, `endpoints` (extracted from `status`),
   `open <example>` (browser open against the running stack's URL).
6. Two-phase migration: **Phase A** lands the envelope + prompt + sysexits codes behind feature
   flags (no rename); **Phase B** lands the renames + new commands; **Phase C** removes the
   v3-parity aliases. Each phase is independently shippable; the LoC delta net is ≈ −1,200 (5,987 →
   ~4,800) with substantially more functionality.

---

## 1. Motivation & user pain points

Direct quotes from the operator:

> "I don't know what wiping does, I don't know what options I have." "Some of the flags make no
> sense." "`--yes` is unintuitive as the only way to actually do it — we don't prompt?" "There are
> tons of other issues." "We should build from the ground up — focus on what users (and agents)
> need." "Don't get too bogged down in what we have today." "Research best practices, look at what
> other libraries are doing — lots of recent posts on how CLIs are great for LLMs."

The pain points concretely (mapped to today's code):

| Quote                              | Where it lives                                                                                                                                                         | Concrete defect                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "`--yes` is unintuitive"           | `cli/commands/wipe.ts:132-136`, `cli/commands/stack.ts:213-219`, `cli/commands/fork.ts:790-799`, `cli/commands/prune.ts:301-305`, `cli/commands/_prune-stack.ts:47-69` | Five separate sites each `if (!yes) failAlreadyReported(...)`. No prompt, no `--dry-run` companion on `wipe`/`stack drop`, no consistent message wording.                                                                                                                                                                                                                                                          |
| "I don't know what wiping does"    | `wipe.ts:1-32` JSDoc, no `--help` example                                                                                                                              | The list of side effects (containers + networks + volumes + state dir + maybe fork cache + maybe images) lives only in the _file's top comment_ — never reaches the user. `wipe --help` shows seven flag descriptions but doesn't enumerate what `wipe` removes by default.                                                                                                                                        |
| "I don't know what options I have" | `wipe.ts:71-117` — 7 booleans, two of them (`--also-upstream-cache` / `--keep-upstream-cache`) "mutually exclusive in spirit but accepting both"                       | `--keep-upstream-cache` exists _only because_ the `SeedManifestMismatchError` recipe reads better with the affirmative form — but that's a docs hack, not a flag. The `--no-stop` flag fires only when `--yes` is also set, which is undiscoverable. `--images` (boolean) means _also_ remove images, but `prune.ts` carries a separate `--include-images` flag with the same meaning — they share zero help text. |
| "Some of the flags make no sense"  | `apply.ts:75`, `snapshot.ts:181-207`, `fork.ts:62-66`, `prune.ts:59-133`                                                                                               | Naming drift: `--json` is `Flag.boolean('json')` (no description) on `apply`, but `jsonFlag` (with description) on `fork`. `snapshot save` accepts both `--label` (flag) and a positional id; restore matches by `endsWith('-' + ref)` (label) OR `startsWith(ref)` (prefix) OR `===` (exact) — three lookup modes from one parameter, undocumented in `--help`.                                                   |

Beyond the quotes, several pain points are visible from a hands-on read:

- **No `--help` examples anywhere.** `Command.withDescription(...)` exists on every command;
  `Command.withExamples` does not. Operators discovering `devstack` for the first time see only
  `'Tear down the current stack…'` for `wipe`.
- **`apply` is the only command that emits a structured error.** It calls `causeToJson(cause)` (see
  `apply.ts:136`). Every other command emits a plain string via `failAlreadyReported`, so
  `devstack wipe --yes --json` (impossible — `--json` doesn't exist on `wipe`) couldn't be
  machine-parsed even if it failed cleanly.
- **`up` vs `apply` is the wrong dichotomy.** `up` runs `launchEffect` (long-running, supervisor
  blocks until SIGINT). `apply` runs `Layer.build` inside `Effect.scoped` (one-shot reconcile, exit
  clean). Both load the same config, both bring the same primitives up, both write the same
  manifest. Users have to learn that `apply` exits and `up` doesn't.
- **`status` and `manifest` overlap by ~70%.** `status.ts:196-237` and `manifest.ts:44-123` both
  walk `manifest.services.{sui,seal,walrus}` + `manifest.app.{dev,wallet}` + packages + accounts.
  The audit (`stack-simplification-audit.md` E19) already calls this out — three sites read the
  manifest.
- **`prune` is a kitchen sink.** 603 LoC, twelve flags, five modes (`--list`, target arg,
  `--repo-gone`, `--all-orphans`, `--interactive`), three post-passes (`--include-images`,
  `--include-router`, `--include-fork-cache`), one Ink picker. The current docstring lists
  `--interactive (default)` but the actual default path requires `process.stdin.isTTY` and falls
  back to "specify a flag" with no hint of which.

---

## 2. Research findings

### 2.1 The 2025–2026 consensus on agent-friendly CLIs

A search across the recent literature gives a remarkably consistent answer:

- **clig.dev** ([Command Line Interface Guidelines](https://clig.dev/), originally Docker Compose
  authors): humans first, machines second; `--json` for structure; prompt severity-graded
  (delete-app warrants typing the name); `--dry-run` for destructive ops; sysexits-style exit codes;
  explicit `--no-input` to disable prompts; flags > positionals for clarity.
- **dev.to / Writing CLI Tools That AI Agents Actually Want to Use**
  ([source](https://dev.to/uenyioha/writing-cli-tools-that-ai-agents-actually-want-to-use-39no)):
  the single most important feature is `--json`; agents do not parse decorated terminal text;
  noun-verb hierarchy ("docker container ls") turns exploration into a deterministic tree search;
  `--dry-run` lets agents introspect before mutating.
- **Propel "Agent-First CLI Design"**
  ([source](https://www.propelcode.ai/blog/agent-first-cli-design-coding-agents)): typed, actionable
  errors paired with a recommended next step; dry-run as a first-class operation; review artifacts
  emitted by default ("intent, scope, planned operations, validations run, final side effects").
- **InfoQ "Patterns for AI Agent Driven CLIs"**
  ([source](https://www.infoq.com/articles/ai-agent-cli/)): structured output as API contract
  (versioned, backward-compat'd, CI-validated); early validation (`--syntax-check`,
  `--check --diff`); graceful `SIGTERM`; track agent-vs-human usage separately because agents adopt
  features differently.
- **Firecrawl "Best CLI Tools for Your AI Agents in 2026"**
  ([source](https://www.firecrawl.dev/blog/best-cli-tools)): authenticate-once + structured output
  is what makes GitHub/Stripe/Vercel/Supabase CLIs the de facto agent surface. The article
  emphasises one-time auth + clean structured output reduces every per-call token cost.
- **Medium "10 must-have CLIs for AI agents in 2026"**
  ([source](https://medium.com/@unicodeveloper/10-must-have-clis-for-your-ai-agents-in-2026-51ba0d0881df)):
  the ten in question (gh, stripe, supabase, vercel, valyu, posthog, elevenlabs, ramp, gworkspace,
  agentmail) all share JSON output, idempotent operations, single-command workflows, and
  headless-terminal compatibility.
- **"CLI Tools vs MCP" / jannikreinhard**
  ([source](https://jannikreinhard.com/2026/02/22/why-cli-tools-are-beating-mcp-for-ai-agents/)): a
  comparative study found CLI agents beat MCP on every efficiency metric — 10–32× cheaper on tokens
  and ~100% reliability vs MCP's 72% — because the CLI lets the agent use `--help` for just-in-time
  discovery rather than carrying the schema in context.

The convergence is on six features:

1. `--json` / `--output json` on every command, with a stable envelope.
2. Noun-verb (or verb-noun, pick one) subcommand tree, never both.
3. Default-prompt destructive ops on TTY; `--yes` or `--force` to bypass; `--no-input` to fail
   rather than block.
4. `--dry-run` (and/or `--check --diff`) as a first-class operation, not an afterthought.
5. Sysexits-style exit codes (0 success, 64 usage, 65 dataerr, 73 cantcreat, 78 config, plus a
   CLI-specific block for domain errors).
6. Schema introspection (`--schema`, `--help` examples, ideally machine-readable) so agents can
   autodiscover without training-set memorization.

### 2.2 Library landscape

Five libraries are credible 2026 picks for a Node/TS CLI of devstack's complexity. Audit:

| Library                                                                                                                  | Strong at                                                                                                                                                                             | Weak at                                                                                                                                                                                                                                                                                                                    | Use here?                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **`effect/unstable/cli`** (in use)                                                                                       | Effect-native — actions are `Effect<A, E, R>`, errors flow into the same `tapCause` reporter as the engine, layers compose. Argument/Flag/Command types are strict.                   | API marked **unstable**; `Flag.choice` exists but `Command.withExamples` does not (we hand-rolled examples into descriptions). No built-in prompt support. No `--json` defaulting. ([Effect v4 source · packages/effect/src/unstable/cli](https://github.com/Effect-TS/effect/tree/main/packages/effect/src/unstable/cli)) | **Yes — keep.** The engine is Effect-shaped; switching frameworks would force every command body to bridge two runtimes.   |
| **`@clack/prompts`** ([npm · @clack/prompts](https://www.npmjs.com/package/@clack/prompts))                              | Modern, minimal, beautifully styled prompts. ESM-only, TS-native. `confirm`, `select`, `multiselect`, `text`, `spinner` — all the primitives we need. No coupling to a CLI framework. | Doesn't define command trees — purely interactive.                                                                                                                                                                                                                                                                         | **Yes — adopt.** Layer it under a thin `prompt.ts` wrapper that our `Effect`-based commands call from `Effect.tryPromise`. |
| **`citty`** ([unjs/citty](https://github.com/unjs/citty))                                                                | Lazy-loaded subcommands (200 commands → fast startup). Lifecycle hooks (setup/run/cleanup). Lightweight, ~zero deps, TS-first, Nuxt is using it.                                      | Not Effect-aware; every action body would bridge to/from Effect. Lazy-loading is a marginal win for a CLI our size.                                                                                                                                                                                                        | **No.** Re-platforming buys lazy-load (~50ms startup we don't need) and loses Effect interop.                              |
| **`oclif`** ([oclif/oclif](https://github.com/oclif/oclif))                                                              | Enterprise framework, plugin architecture, lazy-load, scaffolding. The Heroku CLI/Salesforce CLI are oclif.                                                                           | Class-based API, large install footprint, Effect bridge is awkward, opinionated about file layout.                                                                                                                                                                                                                         | **No.** Wrong vibe for our codebase.                                                                                       |
| **`commander` / `yargs`**                                                                                                | Battle-tested classics, ~35M / ~30M weekly downloads, lots of Stack-Overflow lore the model "knows".                                                                                  | Imperative APIs, weak TS inference, manual JSON envelope work, no prompt support. ([Commander vs Yargs vs Oclif · grizzlypeaksoftware](https://www.grizzlypeaksoftware.com/library/cli-framework-comparison-commander-vs-yargs-vs-oclif-utxlf9v9))                                                                         | **No.** Effect already gives us better types.                                                                              |
| **`cmd-ts`** ([gal.hagever · cmd-ts](https://gal.hagever.com/posts/type-safe-cli-apps-in-typescript-with-cmd-ts-part-1)) | Strong TypeScript types, fp-friendly, lightweight.                                                                                                                                    | Small community, no prompts.                                                                                                                                                                                                                                                                                               | **No.** Effect already covers our type needs.                                                                              |
| **`ink`** (in use for `_prune-ui.tsx`)                                                                                   | React-for-the-terminal — ideal for the supervisor TUI (already used in `engine/renderer.ts`) and the `prune --interactive` picker.                                                    | Wrong abstraction for one-shot commands.                                                                                                                                                                                                                                                                                   | **Keep where it is.** Don't push ink into commands that are non-interactive.                                               |

**Recommendation: Effect CLI + `@clack/prompts` + keep ink where it is.** No replatform. Effect CLI
gives us the action model; clack fills the prompt gap; ink stays for the supervisor TUI and the
cross-stack picker.

### 2.3 Modern CLI UX best practices (digest)

From [clig.dev](https://clig.dev/) (the canonical reference):

- **Discoverable.** Comprehensive help with examples leading. Suggest the next command on success
  and on error. Suggest a correction on typo.
- **Conversational.** A CLI is a dialogue. Confirmations, dry-runs, and clear intermediate states
  beat one-shot perfection.
- **Humans first, machines second.** Pretty by default on a TTY; switch to JSON when `--json` is
  passed or stdout is not a TTY.
- **Errors as messages, not exceptions.** Rewrite caught errors into "problem → why → fix →
  see-also" — no raw stack traces in normal operation.
- **Severity-graded confirmation.** Mild op (single file delete): optional confirm. Moderate op
  (resource deletion): confirm Y/N. Severe op (delete an _application_): require typing the name.
- **`--dry-run` everywhere mutating** — operator can preview without risk, agent can introspect
  intent before commit.

From
[Stripe/GitHub/Vercel CLI patterns](https://www.deployhq.com/blog/6-developer-clis-ai-coding-agents-use-well):

- One short flag, one long flag. Stable cross-command flag names (`-f`/`--force`, `--json`,
  `--quiet`, `--debug`).
- One canonical config-precedence order: **flags > env > project config > user config > system
  config**.
- `--no-input` to disable all prompts (CI default); `--yes` to auto-confirm a single prompt.

From [sysexits.h conventions](https://man7.org/linux/man-pages/man3/sysexits.h.3head.html):

- `0` success, `1` general failure (catch-all).
- `64` EX_USAGE (bad flags / args).
- `65` EX_DATAERR (input data malformed — e.g. our `SeedManifestMismatchError`).
- `66` EX_NOINPUT (missing config / manifest).
- `69` EX_UNAVAILABLE (docker daemon down).
- `73` EX_CANTCREAT (couldn't write state).
- `75` EX_TEMPFAIL (retryable — port in use, upstream RPC blip).
- `78` EX_CONFIG (semantic config error — e.g. invalid `--upstream` value).

The remaining `7n` codes are sendmail-shaped and don't map cleanly; we'd reserve `40–63` for
domain-specific (e.g. `40` SUPERVISOR_LIVE, `41` SNAPSHOT_NOT_FOUND).

### 2.4 LLM-targeted features (what an agent needs that a human doesn't)

Distilled from the agent-focused searches above:

1. **Strict JSON envelope, no ANSI in `--json` mode.** Today our `apply --json` does this; `wipe`,
   `stack`, `manifest`, `graph`, `prune` don't support `--json` at all.
2. **Stable schema across versions.** Output is an API contract; bump major version on breaking
   change.
3. **`--schema` introspection.** A `devstack --schema` that emits an OpenAPI-ish description of
   every command + its args + its output envelope. Agents tools (LangChain, MCP servers, custom
   harnesses) load this once and skip re-prompting on `--help` for every command.
4. **`--dry-run`/`--plan` everywhere mutating.** Already noted; specifically critical for
   `reset`/`wipe`, `snapshot save/delete`, `stack drop`, `prune`, `fork cache prune`.
5. **Deterministic, parseable error envelope.** `{ok: false, error: {code, message, hint, cause?}}`
   — the `hint` is what enables "agent self-heals" loops.
6. **Idempotent by default.** Re-running `apply` is idempotent (✓). Re-running `snapshot save` with
   the same label is not — it appends a `-suffix`. Document or make idempotent.
7. **Hidden interactive vs explicit non-interactive.** Auto-detect TTY for prompts; `--no-input` to
   fail (not block) on non-TTY when a prompt would otherwise be required.
8. **No surprise side effects under `--json`.** Anything that would prompt in interactive mode MUST
   fail under `--json` without `--yes` — agents can't see prompts.

### 2.5 Subcommand structure: noun-verb vs verb-noun

The Propel and DEV articles both argue for **noun-verb** (`gh pr create`, `docker container ls`).
Today's devstack is **mixed**:

- Verb-style top-level: `up`, `apply`, `wipe`, `prune`, `doctor`, `status`, `manifest`, `graph`.
- Noun-style subtrees: `snapshot {save,restore,list,delete}`, `stack {list,new,use,down,drop}`,
  `fork {status,advance-clock,advance-checkpoint,replay-to,seed,cache}`.

The redesign goes **mostly verb-style at the top + noun-style under domains** — exactly what `gh`
does (`gh pr create` is noun-then-verb; `gh auth login` is noun-then-verb; `gh repo create` is
noun-then-verb). For us:

- Top-level lifecycle verbs against the implicit stack: `up`, `down`, `restart`, `apply`, `reset`,
  `status`, `doctor`, `logs`, `open`.
- Noun-then-verb under domains: `snapshot save/restore/list/delete`, `stack list/use/new/drop`,
  `fork status/advance/replay/seed`, `cache list/prune`.

This keeps the muscle memory of `up`/`apply`/`status` (everyone has it) while moving the noisier
domain commands into clean subtrees.

---

## 3. Current state audit

### 3.1 Command tree as it stands today

```
devstack
├── up                  cli/index.ts:41
├── apply               cli/commands/apply.ts:70
├── status              cli/commands/status.ts:87
├── snapshot            cli/commands/snapshot.ts:394
│   ├── save            :180
│   ├── restore         :279
│   ├── list            :343
│   └── delete          :366
├── wipe                cli/commands/wipe.ts:118
├── prune               cli/commands/prune.ts:469
├── stack               cli/commands/stack.ts:271
│   ├── list            :57
│   ├── new             :93
│   ├── use             :120
│   ├── down            :159
│   └── drop            :204
├── fork                cli/commands/fork.ts:856
│   ├── status          :137
│   ├── advance-clock   :221
│   ├── advance-checkpoint :276
│   ├── replay-to       :340
│   ├── seed
│   │   ├── list        :438
│   │   └── diff        :506
│   └── cache
│       ├── list        :730
│       └── prune       :772
├── doctor              cli/commands/doctor.ts:589
├── manifest            cli/commands/manifest.ts:20
├── graph               cli/commands/graph.ts:135
└── version             cli/index.ts:66
```

### 3.2 Per-command audit

Each row: **what it does today → what's confusing → what users/agents actually need**.

| Cmd                                         | Today                                                                                                                                                                                                                                                       | Confusing                                                                                                                                                                                                                                                                                            | Need                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up` (`cli/index.ts:41`)                    | Long-running supervisor; blocks until SIGINT. `--renderer tui/plain/silent`, `--network`, positional `config-path`.                                                                                                                                         | The distinction from `apply` is invisible from `--help`. `--renderer silent` works but is undocumented in docstrings.                                                                                                                                                                                | Default action when in a dev loop. Add `--detach` for background.                                                                                                                                                                                                                                                                                                                             |
| `apply` (`apply.ts:70`)                     | One-shot reconcile. Writes state.json + manifest. Has `--json`. Special-cases `SeedManifestMismatchError`.                                                                                                                                                  | Why does it exist as a separate verb from `up --once`? `--json` is here but not on its sister commands.                                                                                                                                                                                              | Keep, but rename clearer relative to `up`; surface the `SeedManifestMismatch` recipe via the new error envelope.                                                                                                                                                                                                                                                                              |
| `status` (`status.ts:87`)                   | Read-only dump of state.json + manifest.json. `--json` supported. Prints endpoints/packages/accounts/chain.                                                                                                                                                 | Overlaps heavily with `manifest`. The chain block only shows for fork stacks (silent on non-fork).                                                                                                                                                                                                   | Keep as the canonical "what's running here?" probe; split off `endpoints` for terse machine queries.                                                                                                                                                                                                                                                                                          |
| `snapshot save` (`snapshot.ts:180`)         | Saves containers + runtime + state. `--label`, `--stack`, `--app`, `--include-images`, `--include-fork-data`. `id` is timestamp+suffix+label.                                                                                                               | `--label` (flag) is named but the id IS the lookup key. No `--json`. The auto-threshold on `--include-fork-data` (1 GB) prints a hint but is silent in JSON.                                                                                                                                         | Make label a required positional or a friendly arg; emit `--json`; auto-threshold should be in the envelope.                                                                                                                                                                                                                                                                                  |
| `snapshot restore` (`snapshot.ts:279`)      | Restores newest or matched. `ref` positional accepts exact id / suffix / prefix. `--stack`.                                                                                                                                                                 | Three lookup modes from one parameter (line 73-85). No `--json`. Cross-stack restore warning is stderr-only.                                                                                                                                                                                         | Surface lookup-mode in the envelope; require `--from-stack X --to-stack Y` for cross-stack to avoid surprise.                                                                                                                                                                                                                                                                                 |
| `snapshot list` (`snapshot.ts:343`)         | Lists newest-first.                                                                                                                                                                                                                                         | Always prints; no `--json` flag.                                                                                                                                                                                                                                                                     | Add `--json`.                                                                                                                                                                                                                                                                                                                                                                                 |
| `snapshot delete` (`snapshot.ts:366`)       | Removes a snapshot dir. `ref` positional.                                                                                                                                                                                                                   | No prompt, no `--dry-run`, deletes immediately.                                                                                                                                                                                                                                                      | Add prompt + `--dry-run`.                                                                                                                                                                                                                                                                                                                                                                     |
| `wipe` (`wipe.ts:118`)                      | Removes containers + networks + volumes + state for this `(app, stack)`. Requires `--yes`. Optional `--keep-snapshots`, `--no-stop`, `--images`, `--also-upstream-cache`, `--keep-upstream-cache`.                                                          | The seven flags + `--yes`-only-gate. The mutually-exclusive-in-spirit flags. `--no-stop` silently flips a step off; users don't realize what they skipped. Reason for existing alongside `prune` is unclear.                                                                                         | Rename to `reset` (or keep `wipe` as alias). Prompt by default. List the side effects before confirming ("will remove 3 containers, 2 volumes, 14M chain state — type 'yes' to confirm").                                                                                                                                                                                                     |
| `prune` (`prune.ts:469`)                    | Cross-stack cleanup. Twelve flags, five modes. Ink picker default on TTY.                                                                                                                                                                                   | Inventory-print path (`--list`) and `doctor`'s inventory section duplicate. `--repo-gone` is the most useful mode (kills stacks whose repo is gone) but isn't the default — users discover it only via `doctor`'s nudge.                                                                             | Split: `stack list --json` covers `--list`; `stack drop --orphans` covers `--all-orphans`; `stack drop --repo-gone` covers that mode; keep the Ink picker behind `devstack stack drop --interactive`.                                                                                                                                                                                         |
| `stack list/use/new/drop/down` (`stack.ts`) | Stack lifecycle. `drop --yes` mirrors wipe's pattern.                                                                                                                                                                                                       | Mixes "manage active selection" (`list`, `use`, `new`) with "tear down" (`down`, `drop`). The CAVEAT in line 11-14 ("V4 caveat: the current state-store writes flat regardless of stack name") means `stack new`/`use` are partly no-ops.                                                            | Add prompts to `drop`. Make the caveat visible via `--help` until resolved.                                                                                                                                                                                                                                                                                                                   |
| `fork *` (`fork.ts`)                        | Six subcommands hitting the running fork's gRPC admin RPC. Every subcommand has `--json` (consistent ✓). `replay-to` is the only one that loops.                                                                                                            | `advance-clock` takes `durationMs` (a number-shaped string) as a positional — should accept human-friendly `60s`/`1h`. `seed diff` uses exit-1-on-mismatch as a feature; agents need to know that's the contract. `cache prune --unreferenced` is the only legal flag, refuses without — pure paper. | Keep envelope, simplify positionals, unify the `--stack` flag plumbing (audit E20 — every subcommand re-derives `resolveForkRuntimeCtx`).                                                                                                                                                                                                                                                     |
| `doctor` (`doctor.ts:589`)                  | Preflight checks + inventory. `--clean-locks` to remove dead state-store locks AND (since the 2026-05-19 move-build lock fix) stale `~/.move/git/<repo>/.git/*.lock` files via `engine/sui-build-container.ts::sweepStaleGitLocks`. `--state-dir` override. | No `--json`. Inventory output is shared with `prune --list` (audit E21). The 723 LoC mixes docker/sui/port checks + fork-specific checks + lock-cleanup + inventory. Two distinct lock-cleanup paths share one flag.                                                                                 | Emit `--json` with all checks tagged. Split into discrete check producers (audit E21). Expose `--check docker,sui,ports,fork,locks` to scope. Lock-cleanup becomes a `locks` producer that fans to all known sources (state-store, move-git, future). `devstack wipe` already calls `sweepStaleGitLocks` unconditionally (safe — 60s age + lock-key serialisation) so the helper is reusable. |
| `manifest` (`manifest.ts:20`)               | Print manifest.json (raw with `--json`, human-summary otherwise).                                                                                                                                                                                           | Overlaps `status` ~70%. The `eps` projection here and the same projection in `status.ts:196-237` are hand-rolled twice (audit E19).                                                                                                                                                                  | Fold into `status --json` (canonical) and `endpoints` (extracted).                                                                                                                                                                                                                                                                                                                            |
| `graph` (`graph.ts:135`)                    | Render the static dep graph. `text`/`mermaid`/`dot` formats. `--downstream <key>` closure.                                                                                                                                                                  | `--format` is `Flag.string` with manual validation (line 202) because `Flag.choice` "doesn't ship" in the version we're on — but it DOES exist (we use it for `--renderer`!). Just needs migrating.                                                                                                  | Tidy `--format` to `Flag.choice`. Keep as-is otherwise; this command is well-shaped.                                                                                                                                                                                                                                                                                                          |
| `version` (`cli/index.ts:66`)               | Prints `package.json#version`.                                                                                                                                                                                                                              | No `--json`.                                                                                                                                                                                                                                                                                         | Add `--json` for parity.                                                                                                                                                                                                                                                                                                                                                                      |

### 3.3 What the audit doc already flagged

`notes/stack-simplification-audit.md` already names five CLI-adjacent rocks:

- **E19** (line 225) — three CLI commands read v5 manifest, projection drifts. Already partly
  addressed (D.5 — `readStackContext` consolidation), but the per-command rendering still
  duplicates.
- **E20** (line 235) — `fork.ts` is 917 LoC; six subcommands repeat
  `resolveForkRuntimeCtx → makeForkClient → tryPromise → catch → failAlreadyReported`. Author
  proposed a `forkSubcommand({op, args, run})` factory — `−417 LoC`.
- **E21** (line 245) — `doctor.ts` is 723 LoC mixing four check types. Author proposed an
  `interface Check` table — `−400 LoC`.
- **E22** (line 254) — `prune` `Mode` resolver vs `wipe` flag mutex are the same
  "validate-flag-combination" pattern duplicated.
- **E23** (line 264) — `loaders.ts` `requireLaunchEffect` + `requireLayer` are two near-identical
  validators. Trivial fold.

The redesign here is the natural successor to those individual fixes — they all collapse into the
new envelope/factory design rather than being five separate refactors.

### 3.4 Specific flag oddities found in the audit

- **`wipe --no-stop`** (`wipe.ts:81-84`): skips the docker-kill pass. The docstring says "only
  remove on-disk state". But the on-disk pass also removes volumes — which docker refuses if
  containers still reference them. So `--no-stop` doesn't actually do what the name suggests; it
  produces a partial cleanup. Should be removed or renamed `--state-only`.
- **`wipe --images`** (`wipe.ts:86`) vs **`prune --include-images`** (`prune.ts:91`): same
  semantics, different names. Pick one (`--with-images`).
- **`prune --interactive`** (`prune.ts:76`): described as "force the Ink picker even if other flags
  imply non-interactive" — but the default IS interactive when no other flags are set. So the flag
  is only useful in a corner case (`prune --list --interactive`) that doesn't apply.
- **`fork advance-clock <durationMs>`**: positional must be an integer ms (`fork.ts:235-240`).
  Operators reach for `60s`/`1h`/`1d`. Trivial humanize.
- **`snapshot save --label <label>`**: the label is part of the id, but the prompt for "which
  snapshot do I want?" doesn't show it as the primary field — line 78's lookup goes id →
  label-suffix → prefix in three lookups.
- **`apply --json`** is `Flag.boolean('json')` with no description (`apply.ts:75`). Every other JSON
  flag in the codebase IS described. Drift.
- **`--app`** (on `wipe`, `snapshot save`, `snapshot restore`) is
  `Flag.string('app').pipe(Flag.optional)`. Default is `deriveAppName(resolveAppDir())`. No short
  flag. Inconsistent with `--stack` which has the same shape but is uppercase-aware via env.

---

## 4. Proposed redesign

### 4.1 Verbs and nouns — the canonical mental model

```
devstack <verb>           # lifecycle / inspection of "the current stack"
devstack <noun> <verb>    # management of named resources (snapshot, stack, cache, fork)
```

Top-level verbs (all act on the implicit current stack — resolved by `--stack` > `DEVSTACK_STACK` >
`.devstack/active` > `main`):

| Verb              | Action                                                                                        | Replaces                        |
| ----------------- | --------------------------------------------------------------------------------------------- | ------------------------------- |
| `up`              | Boot + supervise (long-running). Renamed `--renderer` → `--ui`. New `--detach`.               | `up` (kept)                     |
| `down`            | Stop containers, keep state (writable layer survives, ~1s resume). Renamed from `stack down`. | `stack down`                    |
| `apply`           | One-shot reconcile (build + write state, exit).                                               | `apply` (kept)                  |
| `restart`         | `down` then `up` (in detach) — convenience for "I edited the config".                         | (new)                           |
| `reset`           | The new name for `wipe`. Prompts. Severity-graded confirm.                                    | `wipe`                          |
| `status`          | Read-only inspection: what's running, endpoints, packages, accounts. `--json` canonical.      | `status` + `manifest` (folded)  |
| `endpoints`       | Just URLs, one-per-line plain text (default) or JSON. Pipe-friendly.                          | (new — extracted from `status`) |
| `logs <service?>` | Tail container logs. `--follow`, `--since`, `--grep`.                                         | (new)                           |
| `open <name?>`    | Open `app.dev.url` (default) or named endpoint in default browser.                            | (new — quality of life)         |
| `doctor`          | Preflight + inventory. `--check docker,sui,ports,fork` to scope. `--json` canonical.          | `doctor` (rewritten)            |
| `graph`           | Render dep graph. `--format text/mermaid/dot` (now `Flag.choice`).                            | `graph` (kept)                  |
| `version`         | Print version. Now `--json` aware.                                                            | `version` (kept)                |

Noun-then-verb subtrees:

```
devstack snapshot
├── save <label?>       # was `snapshot save --label foo`. Label positional.
├── restore <ref?>      # ref positional (id/label/prefix); newest if omitted.
├── list                # +--json
└── delete <ref>        # +--dry-run +prompt

devstack stack
├── list                # +--json (replaces `prune --list`)
├── use <name>          # current behaviour
├── new <name>          # +--use to also mark active
├── drop <name>         # prompt + --dry-run +--orphans +--repo-gone (folds in `prune` modes)
└── pick                # interactive ink picker (was `prune --interactive` default)

devstack fork
├── status              # +--follow (kept)
├── advance clock <duration>   # accepts 60s/1h/1d, replaces advance-clock
├── advance checkpoint [<n>]   # n positional, default 1, replaces --count
├── replay to <checkpoint>     # replaces replay-to
├── seed list                  # kept
├── seed verify                # was `seed diff` — exit-0/1 semantics renamed for agent clarity

devstack cache
├── list                # was `fork cache list`
└── prune               # was `fork cache prune --unreferenced` — flag drops, default is unref-only

devstack router          # was `prune --include-router` post-pass
├── status
└── reset
```

Why fold `prune` away entirely? Because `prune` today is doing five jobs (`--list`, target,
`--repo-gone`, `--all-orphans`, `--interactive`) that each have an unambiguous home in the
noun-then-verb tree. The "kitchen sink" disappears.

### 4.2 Global flags

Stable across every command. Single source of truth in `cli/flags.ts`.

| Flag          | Short | Default                | Meaning                                                                           |
| ------------- | ----- | ---------------------- | --------------------------------------------------------------------------------- |
| `--json`      |       | off                    | Emit machine-readable envelope to stdout. Implies `--no-color`, `--no-input`.     |
| `--quiet`     | `-q`  | off                    | Suppress progress; only final result.                                             |
| `--debug`     |       | off                    | Verbose tracing. Goes to stderr. Implies `EFFECT_LOG_LEVEL=Debug`.                |
| `--no-color`  |       | TTY-detected           | Disable ANSI. `NO_COLOR=1` env honored ([clig.dev](https://clig.dev/) standard).  |
| `--no-input`  |       | TTY-detected           | Disable prompts; commands that would prompt fail with `EX_USAGE` (64).            |
| `--yes`       | `-y`  | off                    | Auto-confirm a single prompt (does not imply `--no-input`).                       |
| `--dry-run`   | `-n`  | off                    | Print intent envelope; do not mutate. Required-allowed on every mutating command. |
| `--stack`     | `-s`  | resolved               | Override active stack.                                                            |
| `--app`       |       | derived                | Override app identifier (for cross-app commands).                                 |
| `--state-dir` |       | `.devstack`            | Override `DEVSTACK_STATE_DIR`.                                                    |
| `--config`    | `-c`  | `./devstack.config.ts` | Override config path.                                                             |
| `--network`   |       | `localnet`             | Sui network.                                                                      |
| `--ui`        |       | TTY-detected           | `tui`, `plain`, `silent`. Renamed from `--renderer` for plain-English.            |
| `--help`      | `-h`  |                        | Show help.                                                                        |
| `--version`   | `-V`  |                        | Show version.                                                                     |

Global env vars (canonical, documented in one place — addresses E40 in the audit):

- `DEVSTACK_STACK`, `DEVSTACK_APP_DIR`, `DEVSTACK_STATE_DIR`, `DEVSTACK_NETWORK`,
  `DEVSTACK_MANIFEST_PATH` (all existing).
- `DEVSTACK_JSON=1` (new — forces `--json` everywhere).
- `DEVSTACK_NO_INPUT=1` (new — forces `--no-input` everywhere; CI default).
- `NO_COLOR=1` (clig standard).

### 4.3 Confirmation patterns

Severity-graded, three tiers ([clig.dev rationale](https://clig.dev/#prompts)):

**Tier 0 — read-only.** No prompt. `status`, `endpoints`, `doctor`, `graph`, `snapshot list`,
`stack list`, `cache list`, `fork status/seed list`, `manifest`, `version`.

**Tier 1 — moderate (resource removal that's recoverable).** Default prompt on TTY:
`Continue? [y/N]`. `--yes` skips. `--no-input` fails with EX_USAGE without `--yes`. Applies to:
`down --hard`, `snapshot delete`, `cache prune`, `fork cache prune`, `router reset`.

**Tier 2 — severe (destructive, full stack teardown).** Default prompt on TTY shows a _preview_
before asking:

```
$ devstack reset
About to reset stack 'arena' in /Users/m/code/arena:
  - 3 containers (devstack-sui-localnet, devstack-walrus-0, devstack-seal-server)
  - 2 networks (devstack-arena-main, devstack-router)
  - 4 volumes (~127 MB chain state)
  - state dir: /Users/m/code/arena/.devstack/stacks/main/ (14 MB)
  - upstream cache: PRESERVED (.devstack/sui-fork-cache/, 412 MB) — use --reset-upstream-cache to drop

Type 'arena' to confirm (or Ctrl-C to abort): _
```

The user has to type the stack name to proceed. `--yes` bypasses (single-keystroke confirm).
`--no-input` fails with EX_USAGE. `stack drop`, `reset` are Tier 2.

For `--dry-run`, the preview is emitted _without_ asking — the operator sees what `reset` would do
and exits 0. Idiomatic for agent introspection:

```
$ devstack reset --dry-run --json
{
  "ok": true,
  "command": "reset",
  "dryRun": true,
  "data": {
    "stack": "arena",
    "wouldRemove": {
      "containers": ["devstack-sui-localnet", "devstack-walrus-0", "devstack-seal-server"],
      "networks": ["devstack-arena-main", "devstack-router"],
      "volumes": [{"name": "devstack-arena-rocksdb", "bytes": 127394816}, ...],
      "stateDir": "/Users/m/code/arena/.devstack/stacks/main/",
      "upstreamCache": null
    }
  }
}
```

### 4.4 `--json` envelope (canonical, versioned)

Every command, success or failure, emits exactly one JSON object on stdout. Stderr stays empty in
`--json` mode (or carries only ANSI-free log lines under `--debug`).

```typescript
interface Envelope<T> {
	readonly schemaVersion: 1;
	readonly ok: boolean;
	readonly command: string; // dot-path, e.g. "snapshot.save"
	readonly stack: string; // resolved active stack (always present)
	readonly app: string; // resolved app (always present)
	readonly dryRun: boolean; // mirror of --dry-run
	readonly data?: T; // command-specific success payload
	readonly error?: ErrorBody; // present when ok=false
	readonly hints?: ReadonlyArray<string>; // human-readable suggestions
	readonly elapsedMs: number;
}

interface ErrorBody {
	readonly code: string; // stable identifier, e.g. "SEED_MANIFEST_MISMATCH"
	readonly exitCode: number; // sysexits-style
	readonly message: string; // single-line summary
	readonly hint?: string; // recommended next step (CLI command)
	readonly recipe?: string; // multi-step recipe (e.g. "devstack reset --keep-upstream-cache && devstack apply")
	readonly cause?: unknown; // tagged-error tree (current `causeToJson` shape)
	readonly context?: Record<string, unknown>;
}
```

This collapses the four error-rendering paths today (`failAlreadyReported`, `apply`'s `causeToJson`,
`wrapCause`, default `tapCause`) to one.

Example success (`devstack apply --json`):

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "apply",
  "stack": "arena",
  "app": "arena",
  "dryRun": false,
  "data": {
    "configPath": "/Users/m/code/arena/devstack.config.ts",
    "manifestPath": "/Users/m/code/arena/.devstack/stacks/main/manifest.json",
    "services": ["sui", "walrus", "seal"],
    "packages": [{"name": "arena", "id": "0xabc..."}],
    "endpoints": [{"name": "sui-rpc", "url": "http://127.0.0.1:9000"}, ...]
  },
  "elapsedMs": 12834
}
```

Example error (the fork seed mismatch):

```json
{
	"schemaVersion": 1,
	"ok": false,
	"command": "apply",
	"stack": "arena",
	"app": "arena",
	"dryRun": false,
	"error": {
		"code": "SEED_MANIFEST_MISMATCH",
		"exitCode": 65,
		"message": "fork seed manifest mismatch — on-disk meta differs from current config",
		"hint": "devstack reset --keep-upstream-cache --yes && devstack apply",
		"recipe": "devstack reset --keep-upstream-cache --yes && devstack apply",
		"context": {
			"metaPath": "/Users/m/code/arena/.devstack/stacks/main/sui-fork/meta.json",
			"previous": { "upstream": "mainnet", "checkpoint": 100123, "configHash": "sha256:..." },
			"current": { "upstream": "mainnet", "checkpoint": null, "configHash": "sha256:..." }
		}
	},
	"elapsedMs": 411
}
```

Example dry-run (`devstack snapshot delete latest --dry-run --json`):

```json
{
	"schemaVersion": 1,
	"ok": true,
	"command": "snapshot.delete",
	"stack": "arena",
	"app": "arena",
	"dryRun": true,
	"data": {
		"wouldDelete": {
			"id": "20260519T142211-a4f1-latest",
			"path": "/Users/m/code/arena/.devstack/stacks/main/snapshots/20260519T142211-a4f1-latest/",
			"bytes": 412393984
		}
	},
	"elapsedMs": 14
}
```

### 4.5 Exit codes

| Code | Name               | Used by                                                                                      |
| ---- | ------------------ | -------------------------------------------------------------------------------------------- |
| 0    | success            | every command on success                                                                     |
| 1    | catch-all          | unexpected internal error                                                                    |
| 64   | EX_USAGE           | bad flags, missing required positional, `--no-input` with no `--yes`, ambiguous snapshot ref |
| 65   | EX_DATAERR         | seed manifest mismatch, manifest shape error, malformed config                               |
| 66   | EX_NOINPUT         | config not found, manifest not found                                                         |
| 69   | EX_UNAVAILABLE     | docker daemon down, upstream RPC unreachable in fork apply                                   |
| 73   | EX_CANTCREAT       | state-dir not writable, atomic-write failed                                                  |
| 75   | EX_TEMPFAIL        | port in use, transient network                                                               |
| 78   | EX_CONFIG          | semantic config error (invalid `--upstream`, unrecognised network)                           |
| 40   | SUPERVISOR_LIVE    | tried to mutate a live stack's state (current `state.json.lock`)                             |
| 41   | SNAPSHOT_NOT_FOUND | restore/delete couldn't match the ref                                                        |
| 42   | SEED_MISMATCH      | `fork seed verify` mismatch (CI-friendly)                                                    |

Today's exits are 0 / 1 / 130 (interrupt). The new table is what agents want — they can branch on 65
vs 69 vs 75 to retry vs fail vs ask-the-human.

### 4.6 `--help` redesign — example for `devstack reset`

Today:

```
$ devstack wipe --help
Tear down the current stack: kill devstack-* containers + networks + volumes
and remove on-disk state. Requires --yes.

Flags:
  --stack <string>              Per-stack name (default: DEVSTACK_STACK env or "main")
  --app <string?>               App identifier (default: ...)
  --yes                         Required. Confirms the wipe.
  --keep-snapshots              Don't delete labeled snapshots under snapshots/
  --no-stop                     Skip the docker kill pass — only remove on-disk state
  --images                      Also `docker rmi` devstack-* images with no running containers
  --also-upstream-cache         Also remove `.devstack/sui-fork-cache/` ...
  --keep-upstream-cache         Explicitly affirm the default ...
```

Proposed:

```
$ devstack reset --help

devstack reset — tear down the current stack: containers, networks, volumes,
on-disk state. Idempotent — safe to re-run.

USAGE
  devstack reset [--stack <name>] [--app <name>] [--yes] [--dry-run] [flags]

WHAT IT REMOVES
  ✓ Docker containers labelled devstack.app=<app>,devstack.stack=<stack>
  ✓ Docker networks   "
  ✓ Docker volumes    "
  ✓ State directory:  .devstack/stacks/<stack>/
  -- Preserves: .devstack/snapshots/, .devstack/sui-fork-cache/ (cross-stack)

EXAMPLES
  # Interactive — preview + confirm + run
  devstack reset

  # Non-interactive (CI) — skip the prompt
  devstack reset --yes

  # Preview only, no mutation
  devstack reset --dry-run --json

  # Recover from a seed manifest mismatch
  devstack reset --keep-upstream-cache --yes && devstack apply

OPTIONS
  --stack <name>        Override active stack (default: arena from .devstack/active)
  --app <name>          Override app identifier (default: derived from package.json#name)
  -y, --yes             Auto-confirm the prompt (CI)
  -n, --dry-run         Print what would be removed; do not mutate
      --keep-snapshots  Preserve .devstack/snapshots/ (default: PRESERVED)
      --with-images     Also remove devstack-* docker images with no live containers
      --reset-upstream-cache
                        Also clear .devstack/sui-fork-cache/ (default: PRESERVED;
                        forces re-warming on next fork apply)
      --json            Emit machine-readable envelope

EXIT CODES
  0   success (or dry-run completed cleanly)
  40  SUPERVISOR_LIVE — refused because a supervisor holds the lock
  64  EX_USAGE         — bad flags, or non-TTY without --yes

SEE ALSO
  devstack stack drop <name>      # drop a stack by name (cross-cwd)
  devstack cache prune             # clean the shared upstream cache
  devstack doctor                  # show what would be reset
```

This `--help` answers the original "I don't know what wiping does, I don't know what options I have"
complaint by surface alone.

### 4.7 Error envelope (human form)

Single source of truth in `cli/render-error.ts`. Replaces `prettyError`, `causeToJson`,
`failAlreadyReported`'s ad-hoc messages, and per-command catch sites. Human form template:

```
devstack <command>: <one-line problem>

  what:   <what failed, structured>
  why:    <root cause, structured>
  hint:   <next command to try>

  see:    <doc link or `devstack <related> --help`>
```

Worked example for `SeedManifestMismatchError`:

```
devstack apply: fork seed manifest mismatch

  what:   the on-disk fork meta at
          /Users/m/code/arena/.devstack/stacks/main/sui-fork/meta.json
          describes a different fork shape than your current config.

  why:    upstream changed: mainnet@100123 → mainnet@latest
          configHash:        sha256:abc... → sha256:def...

  hint:   devstack reset --keep-upstream-cache --yes && devstack apply

  see:    `devstack fork seed verify --help`
          `devstack fork seed list`
```

### 4.8 Agent / LLM affordances — explicit list

What an agent needs that a human doesn't, mapped to concrete CLI features:

| Need                      | Feature                                                        | Today                                              |
| ------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| Stable parseable output   | `--json` envelope on every command, schemaVersion versioned    | partial — `apply`/`status`/`fork`/`manifest` only  |
| No ANSI in machine mode   | `--json` implies `--no-color`                                  | done partially in `apply` (its stderr still emits) |
| Predictable exit codes    | sysexits + 40s for domain                                      | only 0/1/130                                       |
| Idempotency               | `up`, `apply`, `snapshot save` (with explicit id)              | `apply` yes; `snapshot save` no                    |
| `--dry-run` introspection | every mutating command                                         | `prune` has it; others don't                       |
| Self-introspection        | `devstack --schema --json` emits the full command tree as JSON | doesn't exist                                      |
| Error recovery hint       | every error carries `hint` + optional `recipe`                 | only `SeedManifestMismatchError`                   |
| `--no-input` fail-fast    | global flag — fail with EX_USAGE on missing prompts            | doesn't exist                                      |
| Stable command names      | aliases for old names during migration                         | n/a                                                |

The `--schema` introspection is the highest-leverage new feature: agents call
`devstack --schema --json` once at session start, cache the output, and use it to call every other
command without `--help` round-trips. Spec:

```typescript
interface SchemaEnvelope {
	readonly schemaVersion: 1;
	readonly cliVersion: string;
	readonly commands: ReadonlyArray<CommandSchema>;
	readonly globalFlags: ReadonlyArray<FlagSchema>;
	readonly exitCodes: Readonly<Record<string, number>>;
	readonly envVars: ReadonlyArray<{ name: string; description: string; default?: string }>;
}

interface CommandSchema {
	readonly path: string; // "snapshot.save"
	readonly description: string;
	readonly mutates: boolean; // agent uses to decide --dry-run
	readonly args: ReadonlyArray<ArgSchema>;
	readonly flags: ReadonlyArray<FlagSchema>;
	readonly outputSchema: JsonSchema; // describes the `data` field
	readonly examples: ReadonlyArray<{ description: string; command: string }>;
	readonly exitCodes: ReadonlyArray<{ code: number; meaning: string }>;
}
```

This is ~250 LoC of declarative emission, derived from the same `Command.make(...)` builders the
runtime uses — no separate schema source of truth.

### 4.9 Hidden interactive vs explicit non-interactive

The detection table:

| stdin TTY | `--no-input`   | `--yes` | Behaviour                          |
| --------- | -------------- | ------- | ---------------------------------- |
| yes       | no             | no      | Prompt (interactive default)       |
| yes       | no             | yes     | Skip prompt, proceed               |
| yes       | yes            | no      | Fail EX_USAGE — prompts disabled   |
| yes       | yes            | yes     | Skip prompt, proceed               |
| no        | (implicit yes) | no      | Fail EX_USAGE — no TTY, no `--yes` |
| no        | (implicit yes) | yes     | Proceed                            |

`--json` implies `--no-input` (agents don't see prompts).

---

## 5. Library choice and rationale

**Decision: stay on `effect/unstable/cli`. Layer `@clack/prompts` on top via a thin `cli/prompt.ts`
wrapper. Keep `ink` for the supervisor TUI and the cross-stack picker.**

One-line rationale: **the engine is Effect-shaped end-to-end; any library swap forces every command
body to bridge two runtimes for zero discoverable benefit, while `@clack/prompts` closes the only
real gap (no prompts) without disturbing the rest of the stack.**

Longer rationale by criterion:

- **Type integration with the engine.** Every command action today reads `FileSystem`, `Path`,
  `ChildProcessSpawner`, `Registry` etc. from `Effect`'s context. Switching to
  `citty`/`oclif`/`commander` forces every action to `Effect.runPromise`-bridge to fulfill those,
  breaking the `Layer.provide` flow used by `cli/main.ts:24`. Net change: many hundreds of lines of
  plumbing, zero functional gain.
- **Help / argument parsing quality.** Effect CLI's `Argument.string`/`Flag.boolean`/`Flag.choice`
  give us strict types and validation. The remaining gap (`Command.withExamples`) is solvable by
  either wrapping our own `Command.withDescription` to embed examples or upstreaming. The audit
  doc's E20/E21 refactors give us a `forkSubcommand` factory + `Check` table that further reduce
  surface area.
- **Prompt support.** `@clack/prompts` is the modern default — minimal, beautifully styled,
  TS-native, ESM
  ([pkgpulse comparison](https://www.pkgpulse.com/guides/ink-vs-clack-vs-enquirer-interactive-cli-nodejs-2026)).
  The integration is trivial: `Effect.tryPromise({try: () => clack.confirm({message})})`. We isolate
  it in `cli/prompt.ts` so command bodies stay Effect-pure.
- **Ink.** Already in `engine/renderer.ts` (TUI) and `cli/commands/_prune-ui.tsx` (cross-stack
  picker). Both are correct usages — long-running UI surfaces. We don't push it into non-interactive
  commands.

Concrete additions:

```
package.json deps:
  + "@clack/prompts": "^0.10.x"     (~30KB ESM)
```

New files under `cli/`:

```
cli/
├── envelope.ts            new — Envelope<T> type + Effect-shaped emitter
├── prompt.ts              new — clack wrappers (confirm/select/text/spinner)
├── render-error.ts        new — single error-rendering source
├── exit-codes.ts          new — sysexits + domain mapping
├── schema-emit.ts         new — --schema JSON emitter from Command builders
└── commands/
    ├── reset.ts           renamed from wipe.ts
    ├── down.ts            extracted from stack.ts:downCommand
    ├── restart.ts         new
    ├── endpoints.ts       extracted from status.ts/manifest.ts overlap
    ├── logs.ts            new
    ├── open.ts            new
    ├── doctor/            split per audit E21
    │   ├── index.ts
    │   ├── docker.ts
    │   ├── sui.ts
    │   ├── ports.ts
    │   ├── locks.ts
    │   ├── fork.ts
    │   └── inventory.ts
    ├── fork/              split per audit E20
    │   ├── index.ts
    │   ├── factory.ts     forkSubcommand({op, args, run}) factory
    │   ├── status.ts
    │   ├── advance-clock.ts
    │   ├── advance-checkpoint.ts
    │   ├── replay-to.ts
    │   ├── seed-list.ts
    │   └── seed-verify.ts (renamed from `seed diff`)
    ├── cache.ts           promoted out of fork.ts
    ├── router.ts          new (devstack router status/reset)
    └── snapshot/
        ├── index.ts
        ├── save.ts
        ├── restore.ts
        ├── list.ts
        └── delete.ts
```

Removed:

```
- cli/commands/wipe.ts (renamed)
- cli/commands/prune.ts (folded into stack drop / cache prune / router reset)
- cli/commands/_prune-stack.ts (moved into engine/prune.ts as a shared primitive)
- cli/commands/_prune-ui.tsx (moved into commands/stack/pick.tsx)
- cli/commands/manifest.ts (folded into status.ts / endpoints.ts)
```

---

## 6. Migration phases

Three phases, each shippable independently. Each phase ships behind a feature flag
(`DEVSTACK_CLI_V2=1`) so we can land + verify without flipping the default.

### Phase A — envelope, prompts, exit codes (additive only)

Goal: make every existing command behave correctly under `--json` and `--no-input`, with sysexits
codes and the shared error envelope. No renames, no removed commands.

Concrete steps:

1. Land `cli/envelope.ts`, `cli/exit-codes.ts`, `cli/render-error.ts`, `cli/prompt.ts`.
2. Replace every `Console.log` of a success and every `failAlreadyReported` with envelope-aware
   emitters.
3. Add `--dry-run` to `wipe`, `snapshot delete`, `cache prune` (the three mutating commands that
   lack it).
4. Add `--json` to `wipe`, `prune`, `manifest`, `graph`, `version`, `stack *`, `snapshot list`.
5. Add `--no-input` global flag (gates every prompt).
6. Add prompts to `wipe`, `stack drop`, `snapshot delete`, `cache prune` (default TTY behaviour) —
   but keep `--yes` as bypass.
7. Land `cli/schema-emit.ts` + `devstack --schema --json`.
8. Migrate `graph`'s `--format` from `Flag.string` to `Flag.choice` (line 142-148, easy win).
9. Wire sysexits codes through the top-level reporter (`cli/index.ts:107-119`).

Tests: each command gets an `--json --dry-run` smoke test asserting the envelope shape. Snapshot
tests for `--help` outputs.

LoC delta: +600 new infra / −400 per-command boilerplate (every `failAlreadyReported` call
simplifies). Net: **+200 LoC, ~20% more functionality.**

### Phase B — verbs renamed, new commands, splits

Goal: implement the noun-verb tree from §4.1. Old names kept as hidden aliases.

Concrete steps:

1. Rename `wipe` → `reset` (alias `wipe` for one release).
2. Land new top-level verbs: `down`, `restart`, `endpoints`, `logs`, `open`.
3. Promote `stack down` to top-level `down`; keep `stack down` as alias.
4. Split `fork.ts` (917 LoC) into `cli/commands/fork/*.ts` per audit E20 — `forkSubcommand`
   factory + 6 thin files.
5. Split `doctor.ts` (723 LoC) into `cli/commands/doctor/*.ts` per audit E21 — `Check` interface +
   producer table + orchestrator.
6. Promote `fork cache *` → top-level `cache *`.
7. Promote `prune --include-router` post-pass → top-level `router status/reset`.
8. Fold `manifest` and the overlap in `status` into one `status --json` canonical + `endpoints`
   extracted (audit E19).
9. Rename `fork advance-clock <ms>` → `fork advance clock <duration>` (humanize duration parsing —
   `60s`/`1h`/`1d`).
10. Rename `fork seed diff` → `fork seed verify` (exit-1-on-mismatch is now documented in `--help` +
    the schema).

Tests: keep the v1-name aliases green; add v2-name suite.

LoC delta: −1,300 from splits (fork −400, doctor −400, manifest fold −90, prune fold −500) + ~+200
for the new verbs and humanize helpers + ~+100 for the v2/v1 alias plumbing. Net: **−1,000 LoC.**

### Phase C — remove v3-parity aliases

Goal: drop `wipe`, `prune`, `manifest`, `fork advance-clock`, `fork seed diff` as visible commands
(hidden aliases preserved one more release, then removed).

Concrete steps:

1. Mark v1-named commands as deprecated in `--help` (prefix "(deprecated, use X)").
2. Emit a warning to stderr on use (suppressed under `--json`).
3. After one minor release, drop them entirely.

LoC delta: −200.

**Cumulative net: +200 − 1,000 − 200 = −1,000 LoC over baseline 5,987 → ~4,990 LoC, with
significantly more functionality.**

---

## 7. LoC and UX delta — three representative commands before/after

### 7.1 `wipe` → `reset`

Today (`cli/commands/wipe.ts`, 201 LoC):

```typescript
// 8 flag definitions, each with a description block (-> 50 LoC)
const yesFlag = Flag.boolean('yes').pipe(...);
const keepSnapshotsFlag = Flag.boolean('keep-snapshots').pipe(...);
// ... 6 more

Command.make('wipe', {stack, app, yes, keepSnapshots, noStop, images, alsoUpstreamCache, keepUpstreamCache},
  ({...}) => Effect.gen(function* () {
    if (!yes) return yield* failAlreadyReported('--yes is required ...');  // <- the pain
    if (alsoUpstreamCache && keepUpstreamCache) return yield* failAlreadyReported('mutually exclusive');
    const result = yield* pruneStack({...});
    // 30 LoC of summary rendering
    if (alsoUpstreamCache) { /* 15 LoC of nodeFs.rm + reporting */ }
    yield* Console.log(`devstack wipe (app=..., stack=...): stopped ... removed ...`);
  }),
);
```

Proposed (`cli/commands/reset.ts`, ~120 LoC estimated):

```typescript
const flags = {
  stack: globalStackFlag,
  app: globalAppFlag,
  yes: globalYesFlag,
  dryRun: globalDryRunFlag,
  json: globalJsonFlag,
  keepSnapshots: Flag.boolean('keep-snapshots').pipe(
    Flag.withDescription('Preserve .devstack/snapshots/ (default: preserved)'),
    Flag.withDefault(true)),
  withImages: Flag.boolean('with-images').pipe(Flag.withDescription('Also remove devstack-* images')),
  resetUpstreamCache: Flag.boolean('reset-upstream-cache').pipe(...),
};

const examples = [
  {description: 'Interactive — preview + confirm + run', command: 'devstack reset'},
  {description: 'CI', command: 'devstack reset --yes'},
  {description: 'Preview only', command: 'devstack reset --dry-run --json'},
  {description: 'Recover from seed manifest mismatch', command: 'devstack reset --keep-upstream-cache --yes && devstack apply'},
];

export const resetCommand = makeCommand('reset', {
  description: 'Tear down the current stack: containers, networks, volumes, on-disk state.',
  mutates: true,
  examples,
  flags,
  run: ({stack, app, yes, dryRun, keepSnapshots, withImages, resetUpstreamCache, json}) =>
    Effect.gen(function* () {
      const plan = yield* gatherResetPlan({app, stack, keepSnapshots, withImages, resetUpstreamCache});
      if (dryRun) return yield* emitSuccess('reset', {dryRun: true, wouldRemove: plan});
      if (!yes && !(yield* hasTTY)) return yield* failUsage('reset requires --yes outside a TTY');
      if (!yes) yield* requireConfirmation(plan.previewPrompt());  // Tier 2 — type the stack name
      const result = yield* applyResetPlan(plan);
      yield* emitSuccess('reset', {removed: result});
    }),
});
```

LoC delta: 201 → ~120 (**−81**), and we _gained_ prompt + dry-run + json + structured envelope.

### 7.2 `snapshot save`

Today (`cli/commands/snapshot.ts:180-277`, 97 LoC):

- 4 flag definitions
- threshold logic inlined (15 LoC)
- 5x `yield* Console.log(...)` lines for the result

Proposed (~70 LoC estimated):

- Same 4 flags + globals
- Threshold logic moves to `engine/snapshot.ts` (return decision in the envelope)
- One envelope emission

LoC delta: 97 → ~70 (**−27**), plus `--json`, `--dry-run`, idempotent-with-explicit-id.

### 7.3 `apply`

Today (`cli/commands/apply.ts`, 179 LoC):

- 40 LoC of `findSeedManifestMismatch` cause-tree walk
- 25 LoC of `renderSeedMismatchRecipe`
- Inline error-rendering double-path (json branch + human branch)

Proposed (~80 LoC estimated):

- Cause walk moves to `engine/errors.ts` (`isSeedManifestMismatch` predicate, reusable from CI)
- Error rendering becomes one `failWithRecipe(SeedManifestMismatch, recipe)` call
- One envelope emission for success + the typed-error path

LoC delta: 179 → ~80 (**−99**), plus the error becomes machine-parseable from the schema definition.

### 7.4 Aggregate

| Command                                                                               | Today LoC    | After LoC                   | Δ          |
| ------------------------------------------------------------------------------------- | ------------ | --------------------------- | ---------- |
| `up` / `index.ts:41`                                                                  | 24           | ~20                         | −4         |
| `apply`                                                                               | 179          | 80                          | −99        |
| `status` (folds `manifest`)                                                           | 239+131=370  | ~150                        | −220       |
| `snapshot` (save/restore/list/delete)                                                 | 399          | ~250                        | −149       |
| `wipe` → `reset`                                                                      | 201          | 120                         | −81        |
| `prune` (fold into stack/cache/router)                                                | 603+438=1041 | ~500                        | −541       |
| `stack`                                                                               | 274          | ~250                        | −24        |
| `fork`                                                                                | 883          | ~480                        | −403       |
| `doctor`                                                                              | 723          | ~350                        | −373       |
| `manifest` (folded into status)                                                       | 131          | 0                           | −131       |
| `graph`                                                                               | 222          | ~210                        | −12        |
| New: `down`, `restart`, `endpoints`, `logs`, `open`, `router`, `cache`                | 0            | ~400                        | +400       |
| New: `envelope.ts`, `render-error.ts`, `prompt.ts`, `exit-codes.ts`, `schema-emit.ts` | 0            | ~600                        | +600       |
| **Total**                                                                             | **5,987**    | **~3,410 + 1,000 = ~4,410** | **−1,577** |

Net: about **−1,500 LoC**, with substantially more functionality (`--json` everywhere, prompts
everywhere, `--dry-run` everywhere, schema introspection, 5 new commands).

---

## 8. Open questions

1. **Where does `--detach` for `up` actually run?** Background process, or `&`-only? Probably out of
   scope for v1 — recommend `pnpm devstack up &` for now and revisit.

2. **`logs <service>` source.** `docker logs <container>` works but multi-service streaming wants
   something nicer. Options: spawn `docker compose logs` (we're not on compose), or write our own
   multiplex. Inclined to keep it minimal — `--service sui` selects one container.

3. **`open` default endpoint.** The dev server URL feels right. But the manifest carries `wallet`,
   `seal-key-server`, etc. — should `open` accept a name? Probably: `open` (default dev URL) and
   `open <name>` to pick.

4. **`--schema` JSON Schema vs OpenAPI vs ad-hoc?** OpenAPI is overkill (no HTTP semantics). JSON
   Schema is a reasonable subset. Recommend a minimal subset of JSON Schema for the `outputSchema`
   field — agents that want stricter validation can layer Zod/Schema themselves.

5. **`stack drop --orphans` vs `--all-orphans`.** The current `prune --all-orphans` flag is "every
   stack whose supervisor isn't running" — but that includes the user's just-stopped stack. Should
   this be `--idle` (less destructive-sounding) or stay as `--orphans`? Probably `--orphans`, with
   the preview showing the list before mutation.

6. **MCP server wrapper.** Once `--schema` lands, a thin MCP server around the CLI is trivial — emit
   the schema as MCP tool definitions, route each tool call to the underlying CLI. Out of scope for
   this redesign but the foundation is here.

7. **Backwards compatibility for `--label`.** Today `snapshot save --label foo` is a flag. New
   design uses a positional `<label>`. We can accept both for a release (positional preferred, flag
   warned).

8. **`fork seed verify` exit code.** Today `seed diff` exits 1 on mismatch (CI-friendly). New
   design: exit 42 (`SEED_MISMATCH`, custom domain code). CI scripts
   `if ! devstack fork seed verify` still work because non-zero is non-zero — but tooling that
   branched on `1` specifically (none in-tree that I see) would need updating.

9. **Effect CLI's "unstable" status.** The `effect/unstable/cli` namespace can shift before
   stabilization. We pin against the version we ship; any shift becomes a single migration PR rather
   than a per-command rewrite.

10. **Telemetry for agent-vs-human usage.** The InfoQ article makes a strong case ("agents adopt
    features differently"). Out of scope for v1, but the envelope carries enough context (`dryRun`,
    `--json`, TTY-or-not at emit time) to differentiate later if we want.

---

## 9. Sources

- [Command Line Interface Guidelines (clig.dev)](https://clig.dev/) — the canonical reference for
  human-first CLI design with machine-second considerations
- [Writing CLI Tools That AI Agents Actually Want to Use (DEV)](https://dev.to/uenyioha/writing-cli-tools-that-ai-agents-actually-want-to-use-39no)
  — noun-verb hierarchy + `--json` as #1 priority
- [Patterns for AI Agent Driven CLIs (InfoQ)](https://www.infoq.com/articles/ai-agent-cli/) —
  structured output as API contract, schema evolution, dry-run, SIGTERM handling
- [Agent-First CLI Design (Propel)](https://www.propelcode.ai/blog/agent-first-cli-design-coding-agents)
  — typed errors with recommended next steps, review artifacts
- [CLI Tools vs MCP: Better AI Agents With Less Context](https://jannikreinhard.com/2026/02/22/why-cli-tools-are-beating-mcp-for-ai-agents/)
  — comparative study: CLI 10–32× cheaper on tokens vs MCP
- [Best CLI Tools for Your AI Agents in 2026 (Firecrawl)](https://www.firecrawl.dev/blog/best-cli-tools)
- [10 Must-have CLIs for your AI Agents in 2026 (Medium)](https://medium.com/@unicodeveloper/10-must-have-clis-for-your-ai-agents-in-2026-51ba0d0881df)
- [6 Developer CLIs That AI Coding Agents Actually Use Well (DeployHQ)](https://www.deployhq.com/blog/6-developer-clis-ai-coding-agents-use-well)
- [sysexits.h(3head) — Linux manual page](https://man7.org/linux/man-pages/man3/sysexits.h.3head.html)
  — canonical exit-code conventions
- [CLI Framework Comparison: Commander vs Yargs vs Oclif (Grizzly Peak)](https://www.grizzlypeaksoftware.com/library/cli-framework-comparison-commander-vs-yargs-vs-oclif-utxlf9v9)
- [Ink vs @clack/prompts vs Enquirer 2026 (PkgPulse)](https://www.pkgpulse.com/guides/ink-vs-clack-vs-enquirer-interactive-cli-nodejs-2026)
- [unjs/citty (GitHub)](https://github.com/unjs/citty) — UnJS CLI framework, considered + rejected
- [Effect CLI README](https://github.com/Effect-TS/effect/blob/main/packages/cli/README.md) —
  current Effect CLI v4 surface
- [Shell Script User Interaction: Confirm Before Dangerous Actions](https://www.commandinline.com/shell-script-confirm-dangerous-actions/)
  — confirmation pattern review
- [CLI Tools That Support Previews, Dry Runs or Non-Destructive Actions (Nick Janetakis)](https://nickjanetakis.com/blog/cli-tools-that-support-previews-dry-runs-or-non-destructive-actions)
