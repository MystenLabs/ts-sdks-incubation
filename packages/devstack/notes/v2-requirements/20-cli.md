# cli

## Purpose

The `cli` component is the `devstack` binary's user-facing command surface: a single `bin` entry
(`./dist/cli/main.mjs`) that boots a NodeRuntime, dynamically imports the user's
`devstack.config.ts` when the verb needs it, and dispatches into 12 top-level subcommands (`up`,
`apply`, `status`, `snapshot`, `wipe`, `prune`, `stack`, `fork`, `doctor`, `manifest`, `graph`,
`version`) plus a global `--schema --json` action flag. Every verb shares a single canonical JSON
envelope (`schemaVersion: 1`), a sysexits-style exit-code table (12 numeric codes), severity-graded
interactive prompts (`@clack/prompts`), and a consolidated stack/state-dir/app-name resolution
helper. The CLI is intentionally thin — its primary responsibility is parsing args, applying env-var
overrides BEFORE the dynamic import, routing into the engine or into purpose-built one-shot helpers
(snapshot, prune, doctor inventory, graph render), and rendering structured output for human or
agent consumption.

## Current implementation

Top-level `src/cli/` (10 files, 1043 src LOC + 685 test LOC):

| File                  | LOC | Summary                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`             | 45  | Bin entry. Wires `NodeServices.layer + RegistryLive`, hands the composed CLI effect to `runMain` with a custom teardown so clean Ctrl-C exits 0 (not 130) and disables runMain's default error reporter (we own pretty-print via `tapCause`). cli/main.ts:32-44                                                                                                                                               |
| `index.ts`            | 144 | Composes `rootCommand` from the 12 subcommand modules, defines inline `up` and `version` verbs, registers the `--schema --json` `GlobalFlag.action`, and exports `cli = Command.run(rootCommand).pipe(Effect.tapCause(prettyError))`. cli/index.ts:99-144                                                                                                                                                     |
| `flags.ts`            | 45  | Shared `rendererFlag` (`'tui' \| 'plain' \| 'silent'`) and `networkFlag` (`'localnet' \| 'testnet' \| 'mainnet'`) plus `applyNetworkOverride` which mutates `process.env.DEVSTACK_NETWORK` BEFORE the user's config import. cli/flags.ts:11-45                                                                                                                                                                |
| `loaders.ts`          | 158 | `loadConfigModule(path, validate)` resolves+dynamic-imports `devstack.config.ts`, plus `requireLaunchEffect` / `requireLayer` validators and the `findConfigUp` walker that stops at the first `package.json`. cli/loaders.ts:54-67, 82-99, 107-142                                                                                                                                                           |
| `exit-codes.ts`       | 150 | The sysexits-style numeric table: `EX_OK=0`, `EX_GENERIC=1`, `EX_USAGE=64`, `EX_DATAERR=65`, `EX_NOINPUT=66`, `EX_UNAVAILABLE=69`, `EX_CANTCREAT=73`, `EX_TEMPFAIL=75`, `EX_CONFIG=78`, plus devstack-domain block `EX_SUPERVISOR_LIVE=40`, `EX_SNAPSHOT_NOT_FOUND=41`, `EX_SEED_MISMATCH=42`, `EX_CONFIRM_REQUIRED=43`. With `exitCodeName`/`exitCodeDescription`/`ALL_EXIT_CODES`. cli/exit-codes.ts:19-150 |
| `envelope.ts`         | 151 | Canonical `--json` envelope (`ok / command / data / error / hints / elapsedMs / dryRun`), schemaVersion=1, `successEnvelope` / `errorEnvelope` / `emitEnvelope` / `failWithEnvelope` builders, plus `jsonModeEnabled` (`--json` or `DEVSTACK_JSON=1`) and `inputDisabled` (`--no-input` or `DEVSTACK_NO_INPUT=1`). cli/envelope.ts:48-151                                                                     |
| `cli-prompt.ts`       | 182 | Severity-graded prompt helpers `promptConfirm` (Tier 1 y/N) and `promptTypeToConfirm` (Tier 2 type-the-stack-name). Lazy-loads `@clack/prompts`; `__setClackForTest` for mocking. Returns `PromptOutcome` discriminated union (`confirmed / declined / cancelled / non-interactive`). cli/cli-prompt.ts:31-182                                                                                                |
| `schema-emit.ts`      | 164 | `buildSchema` / `renderSchema` for `devstack --schema --json` — projects the Command tree (name + description + nested subcommands), maps `ALL_EXIT_CODES` into `{code, name, description}` records, lists 8 documented global env vars. cli/schema-emit.ts:75-164                                                                                                                                            |
| `stack-resolution.ts` | 129 | Shared resolution helpers: `resolveStack(fs, path, override)` (override → `DEVSTACK_STACK` → `<stateDir>/active` → `'main'`), `resolveStackFromEnv`, `resolveAppName`, `resolveStateDir`, plus per-stack path helpers `resolveForkDataDir`, `resolveForkMetaPath`, `resolveForkCacheRoot`. cli/stack-resolution.ts:45-129                                                                                     |
| `already-reported.ts` | 47  | `AlreadyReportedError` sentinel + `failAlreadyReported(message)` helper + `causeHasAlreadyReported(cause)` walker. Subcommands raise this AFTER printing their own human error; the top-level `tapCause` skips pretty-print when the sentinel is present. cli/already-reported.ts:11-47                                                                                                                       |

Tests (cli root): `main.test.ts` (95), `loaders.test.ts` (116), `envelope.test.ts` (150),
`cli-prompt.test.ts` (238), `schema-emit.test.ts` (89), `stack-resolution.test.ts` (96).

`src/cli/commands/` top-level (13 src files, 4181 LOC + 1058 test LOC):

| File                           | LOC | Summary                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apply.ts`                     | 224 | `devstack apply [config-path]` — `Layer.build` inside `Effect.scoped` for a one-shot reconcile + `bootstrapRouterFor('apply')`. Typed catch for `SeedManifestMismatchError` renders the wipe-and-retry recipe. Flags: `--json`, `--dry-run`, `--network`. cli/commands/apply.ts:72-224                                             |
| `status.ts`                    | 214 | `devstack status` — reads `<stateDir>/stacks/<stack>/state.json` + manifest.json + optional `sui-fork/meta.json`. Tolerant of missing files; emits a `chain:` block when the manifest has a Sui service. Flag: `--json`. cli/commands/status.ts:89-214                                                                             |
| `snapshot.ts`                  | 655 | `devstack snapshot <save\|restore\|list\|delete>` — see modes below. Uses `engine/snapshot.ts` for the actual capture; CLI handles id generation (`<UTC-timestamp>-<rand4hex>[-<label>]`), label-fragment matching, fork-data-extras auto-include with a 1GB threshold, Tier-1 confirm on delete. cli/commands/snapshot.ts:171-655 |
| `wipe.ts`                      | 405 | `devstack wipe` — per-(app, stack) teardown via the shared `pruneStack` helper. Mutually-exclusive `--also-upstream-cache` (Tier 2 type-to-confirm) / `--keep-upstream-cache`. Sweeps `~/.move/git/**/*.lock` unconditionally. cli/commands/wipe.ts:168-405                                                                        |
| `prune.ts`                     | 618 | `devstack prune [<app>/<stack>]` — cross-stack cleanup. Five modes (`--list` / target / `--repo-gone` / `--all-orphans` / interactive Ink picker). `--include-images` / `--include-router` / `--include-fork-cache` global post-passes. cli/commands/prune.ts:455-618                                                              |
| `stack.ts`                     | 271 | `devstack stack <list\|new\|use\|down\|drop>` — per-app stack management against `.devstack/stacks/<name>/` + `.devstack/active`. `down --force` destroys writable layer (`docker rm -f` vs `docker stop`); `drop` requires `--yes`. cli/commands/stack.ts:55-271                                                                  |
| `status.ts` (re-counted above) |     |                                                                                                                                                                                                                                                                                                                                    |
| `graph.ts`                     | 275 | `devstack graph [config-path]` — three formats (`text` default / `mermaid` / `dot`). `--downstream <key>` for selective restart preview. Uses `flattenStackMembers` + `buildDepGraph` + `topoLevels`. cli/commands/graph.ts:136-275                                                                                                |
| `manifest.ts`                  | 72  | `devstack manifest [path]` — wraps `readStackContext` and renders via shared `renderManifestBody`. Flag: `--json`. cli/commands/manifest.ts:22-72                                                                                                                                                                                  |
| `_manifest-render.ts`          | 71  | Shared human-readable manifest renderer used by `manifest` and `status`. Projects endpoints, packages, accounts, optionally coins+extras. cli/commands/\_manifest-render.ts:12-71                                                                                                                                                  |
| `_prune-stack.ts`              | 351 | `pruneStack(options)` — shared (containers + networks + volumes + state) tear-down used by both `wipe` and `prune`. `ensureNoLiveHolder` aborts when a live supervisor holds the lock. `removeLabelledImagesNotInUse` is the global-image variant. cli/commands/\_prune-stack.ts:275-352                                           |
| `_prune-ui.tsx`                | 295 | Ink picker for `devstack prune --interactive`. Keyboard: ↑/↓/k/j/space/a/n/enter/q/Ctrl-C. Pre-selects repo-gone rows. Cross-stack router row above the per-(app, stack) listing (not selectable). cli/commands/\_prune-ui.tsx:69-295                                                                                              |

`src/cli/commands/doctor/` (6 files, 759 LOC):

| File              | LOC | Summary                                                                                                                                                                                                                                                       |
| ----------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`        | 173 | `devstack doctor` — orchestrates the 9-check preflight + inventory section. Flags: `--clean-locks`, `--state-dir`, `--json`. doctor/index.ts:65-173                                                                                                           |
| `_check.ts`       | 173 | Shared `Check` type + `renderChecks` orchestrator (human + JSON envelope + non-zero exit on any required failure). Audit-line block for cleaned locks. doctor/\_check.ts:24-173                                                                               |
| `checks-env.ts`   | 98  | `checkDocker` (required) + `checkSui` (informational, warns on minor-version drift from pinned `devnet-v1.71.0`). doctor/checks-env.ts:16-98                                                                                                                  |
| `checks-ports.ts` | 62  | `checkCommonPorts` probes a fixed set `[9000, 9123, 9125, 5180]` via dual-stack `0.0.0.0` + `127.0.0.1` bind probes. doctor/checks-ports.ts:14-62                                                                                                             |
| `checks-locks.ts` | 315 | State-store lock walk (`<stateDir>/{stacks/*,networks}/**/*.lock`) + Move-git lock walk (`~/.move/git/<repo>/.git/*.lock`). `findStaleLocks` / `removeStaleLocks` / `listStaleMoveGitLocks` + `sweepStaleGitLocks` (re-export). doctor/checks-locks.ts:41-316 |
| `checks-fork.ts`  | 232 | Fork-specific checks (P4.11-P4.14): `checkSuiForkBinary`, `checkUpstreamGraphql` (TCP :443 probe of `fullnode.<upstream>.sui.io` with 2s timeout), `checkSeedManifests` (configHash self-consistency), `checkForkDataSizes`. doctor/checks-fork.ts:37-232     |

`src/cli/commands/fork/` (7 files, 936 LOC):

| File         | LOC | Summary                                                                                                                                                                                                                                                                           |
| ------------ | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`   | 73  | `devstack fork` parent — composes the 6 subcommands and re-exports `_internal` for tests. fork/index.ts:52-74                                                                                                                                                                     |
| `_shared.ts` | 112 | Shared `stackFlag` / `jsonFlag`, `resolveForkRuntimeCtx` (reads manifest, derives upstream from `services.sui.network`, fails on non-fork variant), `makeForkClient` (SuiGrpcClient against `services.sui.rpc.url`), `wrapForkRpc` error envelope helper. fork/\_shared.ts:15-113 |
| `status.ts`  | 106 | `devstack fork status [--follow]` — one-shot `GetStatus` RPC or `--follow` streams `SubscribeCheckpoints` events (subscription→poll fallback). fork/status.ts:31-107                                                                                                              |
| `advance.ts` | 173 | `devstack fork advance-clock <durationMs>` + `advance-checkpoint --count N`. Both support `--dry-run`. fork/advance.ts:20-174                                                                                                                                                     |
| `replay.ts`  | 106 | `devstack fork replay-to <checkpoint>` — repeatedly `advance-checkpoint` until local seq ≥ target; emits `noop: true` if already at/past. fork/replay.ts:21-107                                                                                                                   |
| `seed.ts`    | 256 | `devstack fork seed <list\|diff>`. `diff` compares on-disk meta.json against caller-supplied `--upstream/--checkpoint/--addresses/--objects`; exit 1 + `EX_SEED_MISMATCH` on mismatch unless `--dry-run`. fork/seed.ts:17-256                                                     |
| `cache.ts`   | 166 | `devstack fork cache <list\|prune>` — list reports per-chainId size under `.devstack/sui-fork-cache/` with referenced/orphan marks; `prune --unreferenced --yes` removes orphans. fork/cache.ts:22-166                                                                            |

Tests (commands): graph.test.ts (112), prune.test.tsx (148, browser/ink), wipe.envelope.test.ts
(138), wipe.fork.test.ts (110), snapshot.fork.test.ts (72), stack.drop-fork.test.ts (56),
apply.fork-seed-mismatch.test.ts (67), doctor.fork.test.ts (97), fork.test.ts (160). Plus 5
docker-gated stub tests (`*.docker.test.ts`, each 20-49 LOC, all `expect(SHOULD_RUN).toBe(true)`
placeholders gated by `RUN_FORK_DOCKER_TESTS=1`).

**LOC totals:** src ≈ 6224 (10 root files 1043 + 13 commands 4181 + 6 doctor 1053 — note
`checks-locks.ts` is 315, see breakdown above; recount per `wc -l` is 6114 src + 2044 doctor/fork =
8158 total including tests, of which src ≈ 6224). Tests ≈ 1743.

## Configuration

### CLI flags (per command)

**Global / structural flags:**

- `--schema` (boolean, `GlobalFlag.action`) — when passed with `--json`, prints the full command
  tree + envelope shape + exit-code table as one JSON document and exits. cli/index.ts:81-93,
  cli/schema-emit.ts:90-158
- No `--help` is explicitly defined; provided by `effect/unstable/cli`'s `Command.run`.

**`devstack up [config-path]`:**

- positional `config-path` (optional, default `./devstack.config.ts`). cli/index.ts:43-46
- `--renderer {tui|plain|silent}` (optional; default `tui` on TTY, `plain` otherwise —
  supervisor-level). cli/flags.ts:11-17, cli/index.ts:48
- `--network {localnet|testnet|mainnet}` (optional). Mutates `process.env.DEVSTACK_NETWORK` BEFORE
  the dynamic import. cli/flags.ts:23-29, cli/flags.ts:35-45

**`devstack apply [config-path]`:**

- positional `config-path` (optional, default `./devstack.config.ts`). cli/commands/apply.ts:75
- `--json` (boolean). cli/commands/apply.ts:76
- `--dry-run` (boolean, default `false`). cli/commands/apply.ts:77-81
- `--network {localnet|testnet|mainnet}` (optional). cli/commands/apply.ts:83

**`devstack status`:**

- `--json` (boolean). cli/commands/status.ts:92

**`devstack snapshot save`:**

- `--label <string>` (optional). cli/commands/snapshot.ts:174
- `--stack <string>` (optional, default active). cli/commands/snapshot.ts:147-150
- `--app <string>` (optional, default `<appDir>/package.json#name`).
  cli/commands/snapshot.ts:156-161
- `--include-images` / `--no-include-images` (boolean, default `true`).
  cli/commands/snapshot.ts:177-184
- `--include-fork-data` (boolean, optional 3-state — auto by 1GB threshold).
  cli/commands/snapshot.ts:190-197
- `--json` (boolean, default `false`). cli/commands/snapshot.ts:198-201
- `--dry-run` (boolean, default `false`). cli/commands/snapshot.ts:202-205

**`devstack snapshot restore [id-or-label]`:**

- positional `id-or-label` (optional; default = newest entry). cli/commands/snapshot.ts:333
- `--stack <string>` (optional, default active). cli/commands/snapshot.ts:334
- `--json` (boolean, default `false`). cli/commands/snapshot.ts:335-338
- `--dry-run` (boolean, default `false`). cli/commands/snapshot.ts:339-342

**`devstack snapshot list`:**

- `--json` (boolean, default `false`). cli/commands/snapshot.ts:472-475

**`devstack snapshot delete <id-or-label>`:**

- positional `id-or-label` (required). cli/commands/snapshot.ts:522
- `--yes` (boolean, default `false`). cli/commands/snapshot.ts:523-526
- `--json` / `--dry-run` / `--no-input`. cli/commands/snapshot.ts:527-538

**`devstack wipe`:**

- `--stack <string>` (optional, default `DEVSTACK_STACK` env or `'main'`).
  cli/commands/wipe.ts:51-54
- `--app <string>` (optional, default `<appDir>/package.json#name`). cli/commands/wipe.ts:64-69
- `--yes` (boolean, default `false`). cli/commands/wipe.ts:71-76
- `--keep-snapshots` (boolean, default `false`). cli/commands/wipe.ts:78-81
- `--no-stop` (boolean, default `false`). cli/commands/wipe.ts:83-86
- `--images` (boolean, default `false`). cli/commands/wipe.ts:88-91
- `--also-upstream-cache` (boolean, default `false`; Tier 2 confirm). cli/commands/wipe.ts:103-110
- `--keep-upstream-cache` (boolean, default `false`; affirming-default form).
  cli/commands/wipe.ts:112-119
- `--json` / `--dry-run` / `--no-input`. cli/commands/wipe.ts:121-136
- Mutually exclusive: `--also-upstream-cache` + `--keep-upstream-cache` → `EX_USAGE`
  `MUTUALLY_EXCLUSIVE_FLAGS`. cli/commands/wipe.ts:200-212

**`devstack prune [target]`:**

- positional `target` (optional, `<app>/<stack>` shape; regex
  `/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/`). cli/commands/prune.ts:54, cli/commands/prune.ts:56-59
- `--yes` (boolean, default `false`). cli/commands/prune.ts:61-64
- `--list` (boolean, default `false`). cli/commands/prune.ts:66-69
- `--all-orphans` (boolean, default `false`). cli/commands/prune.ts:71-76
- `--interactive` (boolean, default `false`; Ink picker). cli/commands/prune.ts:78-81
- `--keep-snapshots` (boolean, default `false`). cli/commands/prune.ts:83-86
- `--images` (boolean, default `false` — per-stack). cli/commands/prune.ts:88-91
- `--include-images` (boolean, default `false` — global label sweep post-pass).
  cli/commands/prune.ts:93-98
- `--repo-gone` (boolean, default `false`). cli/commands/prune.ts:100-103
- `--app <string>` (optional, filter). cli/commands/prune.ts:105-110
- `--dry-run` (boolean, default `false`). cli/commands/prune.ts:112-115
- `--include-router` (boolean, default `false`). cli/commands/prune.ts:117-122
- `--include-fork-cache` (boolean, default `false`). cli/commands/prune.ts:129-135
- `--json` (boolean, default `false`). cli/commands/prune.ts:471-474

**`devstack stack list`:** no flags. cli/commands/stack.ts:55-88

**`devstack stack new <name>`:**

- positional `name` (required; regex `/^[a-z0-9][a-z0-9._-]{0,63}$/`). cli/commands/stack.ts:92-94
- `--set-active` (boolean, default `false`). cli/commands/stack.ts:95-98

**`devstack stack use <name>`:** positional `name` only. cli/commands/stack.ts:118-138

**`devstack stack down [name]`:**

- positional `name` (optional; resolves via `resolveStack`). cli/commands/stack.ts:159-161
- `--force` (boolean, default `false`; `docker rm -f` vs `docker stop`).
  cli/commands/stack.ts:162-169

**`devstack stack drop <name>`:**

- positional `name` (required, name-validated). cli/commands/stack.ts:204
- `--yes` (boolean, default `false`; required to actually delete). cli/commands/stack.ts:205-208

**`devstack fork status`:**

- `--stack <string>` (optional). fork/\_shared.ts:15-18
- `--json` (boolean, default `false`). fork/\_shared.ts:20-23
- `--follow` (boolean, default `false`). fork/status.ts:23-29

**`devstack fork advance-clock <durationMs>`:**

- positional `durationMs` (required, must be positive integer). fork/advance.ts:23-25,
  fork/advance.ts:37-42
- `--stack` / `--json`. fork/advance.ts:26-27
- `--dry-run` (boolean, default `false`). fork/advance.ts:28-31

**`devstack fork advance-checkpoint`:**

- `--count <string>` (default `'1'`, must be positive integer). fork/advance.ts:96-99
- `--stack` / `--json` / `--dry-run`. fork/advance.ts:100-105

**`devstack fork replay-to <checkpoint>`:**

- positional `checkpoint` (required, must be non-negative integer). fork/replay.ts:24-26,
  fork/replay.ts:34-39
- `--stack` / `--json`. fork/replay.ts:27-28

**`devstack fork seed list`:** `--stack` / `--json`. fork/seed.ts:20-21

**`devstack fork seed diff`:**

- `--upstream <name>` (optional). fork/seed.ts:86-89
- `--checkpoint <string>` (optional, non-negative integer). fork/seed.ts:90-93
- `--addresses <comma-string>` (optional). fork/seed.ts:94-97
- `--objects <comma-string>` (optional). fork/seed.ts:98-101
- `--stack` / `--json`. fork/seed.ts:102-103
- `--dry-run` (boolean, default `false`; suppresses non-zero exit on mismatch). fork/seed.ts:104-109

**`devstack fork cache list`:** `--json` only. fork/cache.ts:22-22

**`devstack fork cache prune`:**

- `--unreferenced` (boolean, default `false`; required). fork/cache.ts:71-74
- `--yes` (boolean, default `false`). fork/cache.ts:75-78
- `--dry-run` (boolean, default `false`). fork/cache.ts:79-82
- `--json`. fork/cache.ts:83

**`devstack doctor`:**

- `--clean-locks` (boolean, default `false`). doctor/index.ts:49-55
- `--state-dir <string>` (optional). doctor/index.ts:57-63
- `--json` (boolean, default `false`). doctor/index.ts:70-73

**`devstack manifest [path]`:**

- positional `path` (optional; passed as `manifestPath` override). cli/commands/manifest.ts:25
- `--json` (boolean). cli/commands/manifest.ts:26-28

**`devstack graph [config-path]`:**

- positional `config-path` (optional, default `./devstack.config.ts`). cli/commands/graph.ts:139
- `--format {text|mermaid|dot}` (optional, default `'text'`). cli/commands/graph.ts:141-146
- `--downstream <key>` (optional). cli/commands/graph.ts:150-155
- `--json` (boolean, default `false`; overrides `--format`). cli/commands/graph.ts:156-160

**`devstack version`:** no flags. cli/index.ts:68-73

### Env vars consumed by the CLI

| Env var                  | Read in                                                                                               | Semantics                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DEVSTACK_STACK`         | cli/stack-resolution.ts:53, cli/stack-resolution.ts:82-83, cli/stack-resolution.ts:99-101             | Active stack override; precedence below `--stack` flag, above `.devstack/active` file, above `'main'` fallback.                     |
| `DEVSTACK_STATE_DIR`     | cli/stack-resolution.ts:27, cli/stack-resolution.ts:53-55, cli/commands/wipe.ts:216                   | Override the `.devstack/` state directory location. Relative paths resolve against `resolveAppDir()`; absolute returned as-is.      |
| `DEVSTACK_APP_DIR`       | cli/stack-resolution.ts:36, cli/stack-resolution.ts:49 (via `resolveAppDir`)                          | Override the app directory (where `.devstack/` lives).                                                                              |
| `DEVSTACK_NETWORK`       | cli/flags.ts:41                                                                                       | Set by `--network` flag BEFORE the dynamic import; consumed downstream by network-aware service factories.                          |
| `DEVSTACK_MANIFEST_PATH` | runtime/discover-manifest.ts:74 (consumed via `readStackContext`)                                     | Override the manifest.json discovery walk-up. Surfaced as a documented global env in schema-emit but never read directly by `cli/`. |
| `DEVSTACK_JSON`          | cli/envelope.ts:104                                                                                   | When `'1'` or `'true'`, every command behaves as if `--json` was passed. CI default.                                                |
| `DEVSTACK_NO_INPUT`      | cli/envelope.ts:113                                                                                   | When `'1'` or `'true'`, every confirm prompt skips and fails (`EX_CONFIRM_REQUIRED`). CI default.                                   |
| `NO_COLOR`               | NOT read directly by `cli/` — documented in `schema-emit.ts:150-153` as a "standard clig.dev escape". | Consumed by Effect's default logger / ink; surfaced in `--schema` global env list.                                                  |
| `RUN_FORK_DOCKER_TESTS`  | tests only (cli/commands/\*.docker.test.ts)                                                           | Gate for skipped docker-fork test suites; not consumed at runtime.                                                                  |

### defineDevstack config keys honored by CLI

The CLI never reads the user's config directly — it dynamic-imports `devstack.config.ts` and pulls
one of three projected fields off the default export:

- `.launchEffect(overrides?)` — consumed by `up` via `requireLaunchEffect`. cli/loaders.ts:54-60
- `.layer` — consumed by `apply` via `requireLayer` (used as `Layer.build` input).
  cli/loaders.ts:62-67
- `.config` — consumed by `graph` via `requireConfig` (uses `config.stack` for dep-graph rendering).
  cli/commands/graph.ts:48-62

`RunOverrides` are passed through `launchEffect`:
`{ renderer?: RendererKind, rendererFactory?: RendererFactory }`. cli/index.ts:50-65,
supervisor.ts:297-300.

## Capabilities CONSUMED

### From Effect / @effect/platform-node

- `effect` core: `Cause`, `Console`, `Effect`, `Exit`, `FileSystem`, `Layer`, `Option`, `Path`,
  `Schema`, `Stream` — used across virtually every file.
- `effect/unstable/cli`: `Argument`, `Command`, `Flag`, `GlobalFlag` — the entire parser surface.
  cli/index.ts:22 — **NOTE: stability is liable to shift before stabilization (verbatim warning at
  cli/index.ts:13-17)**.
- `effect/unstable/process`: `ChildProcess`, `ChildProcessSpawner` — every docker shell-out
  (snapshot container enumeration, stack down, prune image sweep, doctor binary checks).
  cli/commands/snapshot.ts:24, cli/commands/stack.ts:16, cli/commands/\_prune-stack.ts:14,
  doctor/checks-env.ts:11.
- `@effect/platform-node/NodeServices` (the `layer` export aliased `NodeServicesLayer`): bundles
  `FileSystem + Path + ChildProcessSpawner + Stdio + Terminal`. cli/main.ts:19,
  cli/commands/apply.ts:14.
- `@effect/platform-node/NodeRuntime.runMain` — drives the CLI to a clean exit; we override its
  teardown for graceful 130→0 conversion and disable its default error reporter. cli/main.ts:20,
  cli/main.ts:32-44.

### Engine surface

- `RegistryLive` (provides `Registry` service) — provided at `main.ts:24` so prune / inventory
  commands can drop stale entries. cli/main.ts:21, cli/commands/prune.ts:46,
  cli/commands/\_prune-stack.ts:18.
- `bootstrapRouterFor('apply')` — invoked by `apply` BEFORE building the user stack so the shared
  `devstack-router` docker network exists. cli/commands/apply.ts:17, cli/commands/apply.ts:131.
- `engine/snapshot.ts`: `list`, `restore`, `snapshot` — `snapshot` save/restore/list.
  cli/commands/snapshot.ts:43.
- `engine/docker/inventory.ts`: `collectInventory`, `collectRouterInfo`, `formatBytes`,
  `isPidAlive`, `removeDockerByLabel`, `renderInventoryRow`, `renderRouterRow`, `renderTotals`,
  `shortRepoPath`, `summarizeContainers`, `totalsFor`, `volumeBytes`, plus types `InventoryRow`,
  `InventoryTotals`, `RouterInfo`. cli/commands/prune.ts:34-44, doctor/\_check.ts:11-15.
- `engine/docker/router.ts`: `ROUTER_CONTAINER`, `ROUTER_NETWORK`. cli/commands/prune.ts:45.
- `engine/registry.ts`: `Registry`, `RegistryNetwork`. cli/commands/\_prune-stack.ts:18.
- `engine/process-liveness.ts`: `isHolderLive` (start-time-aware, defends against PID reuse,
  cross-host = live). cli/commands/\_prune-stack.ts:17, doctor/checks-locks.ts:17.
- `engine/move-build-lock.ts`: `sweepStaleGitLocks` — invoked unconditionally by `wipe`.
  cli/commands/wipe.ts:38, cli/commands/wipe.ts:348.
- `engine/atomic-write.ts`: `writeFileAtomic` — for `.devstack/active` writes.
  cli/commands/stack.ts:18.
- `engine/identity.ts`: `DockerLabel`, `deriveAppName`. cli/commands/snapshot.ts:41,
  cli/commands/stack.ts:21, cli/stack-resolution.ts:16.
- `engine/resolve-app-dir.ts`: `resolveAppDir`, `APP_DIR_ENV` (re-exported by
  `cli/stack-resolution.ts`). cli/stack-resolution.ts:34-36.
- `engine/fs-utils.ts`: `safeDirSize` — fork-data threshold + doctor's P4.14.
  cli/commands/snapshot.ts:42, doctor/checks-fork.ts:15.
- `engine/errors.ts`: `ConfigLoadError`, `SeedManifestMismatchError`, `ManifestDiscoveryError`,
  `ManifestShapeError`. cli/loaders.ts:15, cli/commands/apply.ts:15, cli/commands/status.ts:8.
- `engine/pretty-error.ts`: `causeToJson`, `prettyError` — top-level `tapCause` rendering + apply's
  JSON error envelope. cli/loaders.ts:16, cli/index.ts:23, cli/commands/apply.ts:16.
- `engine/router-bootstrap.ts`: `bootstrapRouterFor`. cli/commands/apply.ts:17.
- `engine/supervisor.ts`: `RendererKind`, `RunOverrides`, `DevstackConfig`, `StackMember`,
  `flattenStackMembers`. cli/index.ts:23, cli/loaders.ts:17, cli/commands/graph.ts:34-38.
- `engine/dep-graph.ts`: `buildDepGraph`, `computeDownstreamClosure`, `topoLevels`, `DepGraph`.
  cli/commands/graph.ts:28-33.
- `engine/sui-fork/meta.ts`: `computeConfigHash`, `readForkMeta`,
  `resolveForkMetaPath as resolveEngineForkMetaPath`. cli/commands/status.ts:9,
  doctor/checks-fork.ts:16, fork/seed.ts:10, fork/index.ts:44.
- `engine/sui-fork/control.ts`: `subscribeCheckpointsWithFallback`, `ForkCheckpointEvent`.
  fork/status.ts:9-12.
- `engine/sui-fork/cache-inventory.ts`: `collectCacheEntries`, `collectReferencedChainIds`.
  cli/commands/prune.ts:47, fork/cache.ts:13-15, fork/index.ts:42-43.
- `engine/registry.ts`: `Registry`, `RegistryLive`. cli/main.ts:21, cli/commands/prune.ts:46.

### Runtime surface

- `runtime/read-stack-context.ts`: `readStackContext({stack?, manifestPath?})` + `StackContext` —
  used by `status` / `manifest` / `fork/_shared`. cli/commands/status.ts:10,
  cli/commands/manifest.ts:17, fork/\_shared.ts:11.
- `runtime/manifest-schema.ts`: `Manifest` type — `_manifest-render.ts:7`.

### External / SDK

- `@mysten/sui/grpc`: `SuiGrpcClient` — `fork` commands use
  `client.forkingService.{getStatus,advanceClock,advanceCheckpoint,subscribeCheckpoints}`.
  fork/\_shared.ts:10, fork/\_shared.ts:78-79.
- `@clack/prompts`: Lazy-imported by `cli-prompt.ts` for confirm + text prompts.
  cli/cli-prompt.ts:44-51. `__setClackForTest` mock seam at cli/cli-prompt.ts:57-63.
- `ink` + `react`: prune interactive picker, mounted via `render` from ink.
  cli/commands/prune.ts:32-33, cli/commands/\_prune-ui.tsx:27-28.
- `ink-testing-library`: used by `prune.test.tsx`. cli/commands/prune.test.tsx:11.

### Node platform

- `node:fs` (`existsSync`, `promises as nodeFs`): loaders.ts:11, snapshot delete fallback removal,
  wipe rm of upstream cache. cli/loaders.ts:11, cli/commands/wipe.ts:33, cli/commands/prune.ts:28,
  fork/cache.ts:10.
- `node:path` (`dirname`, `isAbsolute`, `join`, `resolve`): all over. cli/loaders.ts:12,
  cli/commands/snapshot.ts:21, cli/stack-resolution.ts:15.
- `node:url` (`pathToFileURL`): for `import(url)` of user config. cli/loaders.ts:13.
- `node:net.createServer`: doctor port-bind probe. doctor/checks-ports.ts:11.
- `node:net.Socket`: doctor TCP :443 probe for fork upstreams. doctor/checks-fork.ts:12.
- `node:os` (`homedir`): doctor + wipe sweep of `~/.move/git/`. cli/commands/wipe.ts:34,
  doctor/index.ts:25.
- `node:crypto.randomBytes(2).toString('hex')`: 4-hex-char suffix for snapshot ids.
  cli/commands/snapshot.ts:25.

### Surfaces / capabilities

- **stdout**: structured JSON envelope (one line per command in `--json` mode); also human-readable
  lines via `Console.log`. JSON envelope ALWAYS goes to stdout. cli/envelope.ts:97,
  cli/commands/\*.ts.
- **stderr**: `Console.error` for human-readable error rendering done by `tapCause`
  (cli/index.ts:140) and subcommands' own pretty error paths (`apply failed: …`).
- **stdin TTY detection**: `process.stdin.isTTY` direct read in `cli-prompt.ts:39` and
  `prune.ts:584`.
- **stdout TTY detection**: `process.stdout.isTTY` for renderer default (in supervisor, not CLI).
  The CLI's `up` doesn't override the renderer unless `--renderer` is passed.
- **Signal handling**: SIGINT propagated by `NodeRuntime.runMain` into the launched scope's
  finalizers. cli/main.ts:32-44 sets exit code 0 on clean (interrupts-only) cause, 1 otherwise.
  **SIGUSR2 is handled by the ENGINE/supervisor (`installSignalRestart('SIGUSR2', engine)` at
  supervisor.ts:2041), not by the CLI layer itself.** The CLI sees nothing of SIGUSR2.

## Capabilities PRODUCED

### Bin export

- `package.json#bin.devstack` → `./dist/cli/main.mjs` (the compiled output of `src/cli/main.ts`).
  package.json:19-21.

### TypeScript exports

- `cli/index.ts`: `rootCommand`, `cli`. Consumed by tests for surface assertions (`main.test.ts`)
  and by `main.ts` for run.
- `cli/envelope.ts`: `ENVELOPE_SCHEMA_VERSION`, `Envelope`, `EnvelopeError`, `successEnvelope`,
  `errorEnvelope`, `emitEnvelope`, `failWithEnvelope`, `jsonModeEnabled`, `inputDisabled`.
- `cli/exit-codes.ts`: `EX_OK`, `EX_GENERIC`, `EX_USAGE`, `EX_DATAERR`, `EX_NOINPUT`,
  `EX_UNAVAILABLE`, `EX_CANTCREAT`, `EX_TEMPFAIL`, `EX_CONFIG`, `EX_SUPERVISOR_LIVE`,
  `EX_SNAPSHOT_NOT_FOUND`, `EX_SEED_MISMATCH`, `EX_CONFIRM_REQUIRED`, `ExitCode`, `exitCodeName`,
  `exitCodeDescription`, `ALL_EXIT_CODES`.
- `cli/cli-prompt.ts`: `PromptOutcome`, `stdinIsTTY`, `loadClack`, `__setClackForTest`,
  `promptConfirm`, `promptTypeToConfirm`.
- `cli/flags.ts`: `rendererFlag`, `networkFlag`, `applyNetworkOverride`.
- `cli/loaders.ts`: `wrapCause`, `DevstackLaunchable`, `DevstackLayered`, `requireLaunchEffect`,
  `requireLayer`, `findConfigUp`, `loadConfigModule`.
- `cli/already-reported.ts`: `AlreadyReportedError`, `failAlreadyReported`,
  `causeHasAlreadyReported`.
- `cli/schema-emit.ts`: `buildSchema`, `renderSchema`.
- `cli/stack-resolution.ts`: `STATE_DIR_ENV`, `STACK_NAME_ENV`, `stateDir`, `APP_DIR_ENV`,
  `resolveAppDir`, `resolveStateDir`, `readActiveStack`, `resolveStack`, `resolveAppName`,
  `resolveStackFromEnv`, `resolveForkDataDir`, `resolveForkMetaPath`, `resolveForkCacheRoot`.
- `cli/commands/_prune-stack.ts`: `PruneStackBlockedError`, `PruneStackOptions`, `PruneStackResult`,
  `removeLabelledImagesNotInUse`, `pruneStack`.
- `cli/commands/_manifest-render.ts`: `projectEndpoints`, `renderManifestBody`.
- `cli/commands/graph.ts`: `renderText`, `renderMermaid`, `renderDot`, `graphCommand`.
- `cli/commands/fork/index.ts`: `forkCommand`, `_internal` (re-exports `resolveForkRuntimeCtx`,
  `resolveEngineForkMetaPath`, `collectReferencedChainIds`, `collectCacheEntries`).
- Per-command exports: `applyCommand`, `statusCommand`, `snapshotCommand`, `wipeCommand`,
  `pruneCommand`, `stackCommand`, `manifestCommand`, `doctorCommand`.

### Files written / mutated by CLI verbs

- `<stateDir>/active` (one-line stack name) — `stack new --set-active` / `stack use`.
  cli/commands/stack.ts:40-52.
- `<stateDir>/stacks/<name>/` directory creation — `stack new` / `stack use`.
  cli/commands/stack.ts:106-107, 127.
- `<stateDir>/stacks/<name>/` removal — `stack drop --yes` / `wipe` / `prune`.
  cli/commands/stack.ts:225, cli/commands/\_prune-stack.ts:241.
- `<stateDir>/snapshots/<id>/` creation — `snapshot save` (via engine).
  cli/commands/snapshot.ts:286-293.
- `<stateDir>/snapshots/<id>/` removal — `snapshot delete`. cli/commands/snapshot.ts:633-635.
- `<stateDir>/sui-fork-cache/` removal — `wipe --also-upstream-cache`. cli/commands/wipe.ts:325-335.
- `<stateDir>/sui-fork-cache/<chainId>/` removal — `prune --include-fork-cache` /
  `fork cache prune --unreferenced`. cli/commands/prune.ts:361-364, fork/cache.ts:139.
- `process.env.DEVSTACK_NETWORK` — mutated by `applyNetworkOverride` from `--network`.
  cli/flags.ts:35-45.
- Docker labels read+removed: `devstack.app=<app>`, `devstack.stack=<stack>`, `devstack.image=true`.
  cli/commands/snapshot.ts:127-129, cli/commands/\_prune-stack.ts:300-310,
  cli/commands/\_prune-stack.ts:165-204.
- `~/.move/git/<repo>/.git/*.lock` files removed — `wipe` (unconditional sweep) +
  `doctor --clean-locks`. cli/commands/wipe.ts:348, doctor/index.ts:118.
- `<stateDir>/stacks/<stack>/state.json.lock` etc removed — `doctor --clean-locks`.
  doctor/checks-locks.ts:162-188.

### Events / topics emitted

The CLI does not emit on any event bus. Communication is one-shot stdout + exit code.

### Subcommands registered (root tree)

`up`, `apply`, `status`, `snapshot {save, restore, list, delete}`, `wipe`, `prune`,
`stack {list, new, use, down, drop}`,
`fork {status, advance-clock, advance-checkpoint, replay-to, seed {list, diff}, cache {list, prune}}`,
`doctor`, `manifest`, `graph`, `version`. Plus global `--schema` action flag. cli/index.ts:99-116.

## Lifecycle

The CLI itself is not a long-lived service; per invocation it has a startup, a per-command body, and
a teardown. Each verb has its own run mode.

**Startup (every invocation):**

1. Node loads `dist/cli/main.mjs`.
2. `main.ts` imports `cli/index.ts` and `engine/registry.ts`, composes
   `CliPlatform = Layer.provideMerge(RegistryLive, NodeServicesLayer)`.
3. `runMain(cli.pipe(Effect.provide(CliPlatform)), {disableErrorReporting: true, teardown})` enters
   the Effect runtime.
4. `effect/unstable/cli` parses `process.argv` (sliced by NodeStdio automatically) against
   `rootCommand`.
5. Global flags fire first — if `--schema --json` is set, the action prints the schema JSON and
   returns (no subcommand body runs). cli/index.ts:81-93.
6. The matched subcommand body runs.

**Per-verb run mode:**

| Verb                                                      | Run mode                                                 | Loads config?            | Builds layers?                                                       |
| --------------------------------------------------------- | -------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------- |
| `up`                                                      | Long-running (until SIGINT/SIGTERM)                      | yes                      | yes (`launchEffect`)                                                 |
| `apply`                                                   | One-shot                                                 | yes                      | yes (`Layer.build` + scoped)                                         |
| `status`                                                  | One-shot                                                 | no                       | no                                                                   |
| `snapshot {save, restore, list, delete}`                  | One-shot                                                 | no                       | no — talks to docker via `ChildProcessSpawner` + engine `snapshot()` |
| `wipe`                                                    | One-shot                                                 | no                       | no                                                                   |
| `prune` (non-interactive)                                 | One-shot                                                 | no                       | no                                                                   |
| `prune --interactive`                                     | Interactive (until Ink picker exits)                     | no                       | no                                                                   |
| `stack {list, new, use, drop}`                            | One-shot                                                 | no                       | no                                                                   |
| `stack down`                                              | One-shot                                                 | no                       | no (just `docker stop`)                                              |
| `fork status` (no `--follow`)                             | One-shot                                                 | no                       | no — reads manifest + dispatches gRPC                                |
| `fork status --follow`                                    | Long-running stream (until SIGINT or upstream completes) | no                       | no                                                                   |
| `fork advance-clock` / `advance-checkpoint` / `replay-to` | One-shot                                                 | no                       | no                                                                   |
| `fork seed list`                                          | One-shot                                                 | no                       | no (pure fs read of meta.json)                                       |
| `fork seed diff`                                          | One-shot                                                 | no                       | no                                                                   |
| `fork cache list` / `prune`                               | One-shot                                                 | no                       | no                                                                   |
| `doctor`                                                  | One-shot                                                 | no                       | no                                                                   |
| `manifest`                                                | One-shot                                                 | no                       | no                                                                   |
| `graph`                                                   | One-shot                                                 | yes (for `config.stack`) | no (read-only graph build)                                           |
| `version`                                                 | One-shot                                                 | no                       | no                                                                   |

**Ready criteria:**

- `up`: the engine supervisor's own ready criteria (every primitive's ready check). Outer
  indication: the supervisor's launch loop is running.
- `apply`: `Layer.build` scope closes successfully → state.json + manifest.json have been written.
- All others: process exits with code 0.

**Teardown:**

- `main.ts` teardown: `Exit.isSuccess` → 0; `Cause.hasInterruptsOnly` → 0 (clean Ctrl-C); else → 1.
  cli/main.ts:33-43.
- Long-running commands (`up`, `fork status --follow`, `prune --interactive`) propagate SIGINT
  through the outer NodeRuntime into the launch scope's finalizers (e.g. `docker rm -f` registered
  by `Docker.run`). This is the load-bearing reason `up` yields `launchEffect` natively
  (cli/index.ts:60-64) rather than calling `Effect.runPromise(devstack.run(…))` — the latter creates
  a sibling runtime whose fibers SIGINT can't reach.

**Restart behavior:**

- The CLI itself has no internal restart; an interrupted run requires re-invoking `devstack up`. The
  engine's hot-restart (SIGUSR2 / TUI `r` / file watcher) lives in the supervisor and operates on
  the engine's launch loop, not the CLI process.

## Hard requirements / invariants

1. **Bin entry must remain at `package.json#bin.devstack` → `./dist/cli/main.mjs`.** Renaming breaks
   every `npx devstack`, `pnpm devstack`, CI script. package.json:19-21.
2. **`applyNetworkOverride(network)` must run BEFORE `loadConfigModule(...)`.** The user's config
   reads `process.env.DEVSTACK_NETWORK` at top-level during import; mutating it after the dynamic
   import lands too late. cli/flags.ts:31-34, cli/index.ts:51-54.
3. **`up` must `yield*` the launchEffect natively (not `Effect.runPromise(devstack.run(...))`).**
   Nesting runtimes breaks SIGINT propagation into the scope finalizers; `docker rm -f` never runs.
   cli/index.ts:60-64.
4. **`disableErrorReporting: true` + custom teardown on `runMain`.** Without
   `disableErrorReporting`, the user sees the pretty-printed error twice (once from our `tapCause`,
   once from runMain's default). Without custom teardown, clean Ctrl-C exits 130 and `pnpm dev`
   prints `ELIFECYCLE Command failed with exit code 130`. cli/main.ts:32-44.
5. **`AlreadyReportedError` must walk via `cause.reasons` flat array (v4 model).** The check in
   `causeHasAlreadyReported` uses Cause v4's `for (reason of cause.reasons)` traversal; the older
   `Cause.failures` / `Cause.find` would silently no-op. cli/already-reported.ts:33-46.
6. **Stack-name resolution precedence is
   `--stack > DEVSTACK_STACK env > .devstack/active > 'main'`** — pinned by
   `stack-resolution.test.ts`. Drift across `wipe.ts`, `snapshot.ts`, etc. caused historical
   cross-stack surprises ("`DEVSTACK_STACK=foo devstack wipe` cleared `main`").
   cli/stack-resolution.ts:1-12, 75-86.
7. **Docker label filter MUST include BOTH `devstack.app=<app>` AND `devstack.stack=<stack>`.**
   Filtering on stack alone clobbers sibling apps' containers when both default to `stack=main`.
   cli/commands/snapshot.ts:99-103, cli/commands/wipe.ts:11-13.
8. **Network + volume removal MUST happen AFTER the kill pass.** Docker rejects `network rm` /
   `volume rm` against live endpoints / mounts. cli/commands/\_prune-stack.ts:307-310.
9. **Snapshot ids are timestamp + 4-hex-char rand suffix.** Two saves within the same wall-clock
   second produce distinct ids; the suffix prevents silent overwrite.
   cli/commands/snapshot.ts:55-68.
10. **Snapshot label matching matches the FINAL hyphen-tail.** Pre-fix used `indexOf('-')` (first
    dash) which sliced `<rand>-<label>` and never matched a `--label` value.
    cli/commands/snapshot.ts:85-91.
11. **`workspace boundary === package.json boundary`** for `findConfigUp`. Without that guard, a
    workspace-root config would shadow a package's own missing-config error. cli/loaders.ts:90-94,
    loaders.test.ts:39-52.
12. **Mutually exclusive: `--also-upstream-cache` + `--keep-upstream-cache`** on `wipe`. Returns
    `EX_USAGE` with `MUTUALLY_EXCLUSIVE_FLAGS`. cli/commands/wipe.ts:200-212.
13. **`--dry-run` short-circuits BEFORE prompting on `wipe`.** The point of `--dry-run` is to
    surface a preview without ANY side effects, including the interactive prompt.
    cli/commands/wipe.ts:229-260.
14. **`prune --interactive` requires a real TTY.** Hard `failAlreadyReported` if not, so a CI shell
    can't hang waiting for keypresses. cli/commands/prune.ts:584-588.
15. **`prune` refuses to mutate a stack whose supervisor is live.** Re-checks `state.json.lock`'s
    holder PID via `isPidAlive` even after the inventory snapshot. cli/commands/prune.ts:209-219,
    537-541; cli/commands/\_prune-stack.ts:47-69 raises `PruneStackBlockedError`.
16. **`wipe` unconditionally sweeps `~/.move/git/<repo>/.git/*.lock` files older than 60s.** The 60s
    window guarantees no real in-flight git op is touched. cli/commands/wipe.ts:336-348.
17. **`stack new`/`use`/`drop` name validation: `/^[a-z0-9][a-z0-9._-]{0,63}$/`.** Defends against
    `..`, `/`, shell-metas flowing into docker labels / fs paths. cli/commands/stack.ts:26-38.
18. **`prune` target regex: `/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/`.** Same defense.
    cli/commands/prune.ts:54.
19. **`fork seed diff` exit codes:** match → 0; mismatch (no `--dry-run`) → `EX_SEED_MISMATCH=42`
    plus `AlreadyReportedError`. CI gates on this specific code. cli/commands/fork/seed.ts:215-228,
    243-245.
20. **Doctor's port probe MUST probe both `0.0.0.0` and `127.0.0.1`.** A bare `0.0.0.0` misses
    processes that bound `127.0.0.1` explicitly. Must mirror the engine's port allocator probe so
    accounting matches. doctor/checks-ports.ts:30-42.
21. **Doctor's stale-lock removal MUST re-verify holder liveness immediately before unlink.** The
    findStaleLocks pass and the unlink can race a supervisor that just woke up and rewrote the lock
    body. doctor/checks-locks.ts:170-185.
22. **`status.json` / `manifest.json` reads in `status` MUST be tolerant of missing/malformed
    files.** `status` is observational; it must not throw just because the stack hasn't been brought
    up yet. cli/commands/status.ts:26-45.
23. **JSON envelope `schemaVersion` pinned at 1.** Bump intentionally on breaking changes;
    envelope.test.ts:26-28 fails LOUDLY when someone forgets.
24. **JSON envelope absent fields MUST be omitted (no `"data":undefined` in stdout).** Test asserts
    via `'data' in env`. cli/envelope.ts:71-75, envelope.test.ts:30-41.
25. **`prune.test.tsx` uses `vi.waitFor` (not `setTimeout`) for Ink frame polling.** Ink commits on
    `setImmediate` + React batches; `setTimeout`-based flushes were flaky under load. Commit history
    shows a recent fix (4c7d716a). cli/commands/prune.test.tsx:60-63.
26. **`stack down` defaults to `docker stop` (preserves writable layer) — `--force` is
    `docker rm -f`.** Load-bearing for snapshots: chain state lives in the writable layer;
    `docker rm` here forces a fresh genesis. cli/commands/stack.ts:141-198, 236-242.

## Failure modes

| Trigger                                                                                    | Current behavior                                                                                                                                                                                               | Recovery path                                                                                  |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Missing `devstack.config.ts` at default path AND walk-up exhausted                         | `ConfigLoadError(phase='load')` → top-level `tapCause` renders "config not found at … (resolved from `./devstack.config.ts` against cwd …)" → exit 1                                                           | Create a config or pass `<config-path>` explicitly. cli/loaders.ts:117-130.                    |
| Config missing `default.launchEffect` (or `.layer` / `.config`)                            | `ConfigLoadError(phase='validate', expected='DevstackHandle …')` → exit 1                                                                                                                                      | Default-export a DevstackHandle from `devstack(...)` / `defineDevstack`. cli/loaders.ts:43-67. |
| Docker daemon unreachable (any command using docker)                                       | Best-effort handlers swallow as empty list (snapshot container enumeration, prune image sweep). Doctor surfaces a required `Docker daemon` ✗ and exits non-zero with `EX_UNAVAILABLE` envelope under `--json`. | Start Docker Desktop / `dockerd`. doctor/\_check.ts:79-95.                                     |
| Apply hits `SeedManifestMismatchError`                                                     | Typed catch prints actionable `devstack wipe --keep-upstream-cache --yes && devstack apply` recipe; `--json` carries `code: SEED_MANIFEST_MISMATCH` + `exitCode: EX_DATAERR` + context.                        | Run the printed recipe. cli/commands/apply.ts:147-204.                                         |
| `snapshot restore` ref doesn't match                                                       | `SNAPSHOT_NOT_FOUND` envelope + `EX_SNAPSHOT_NOT_FOUND=41`.                                                                                                                                                    | `devstack snapshot list`. cli/commands/snapshot.ts:386-396.                                    |
| `snapshot restore` ref matches multiple                                                    | `AMBIGUOUS_REF` envelope + `EX_USAGE`.                                                                                                                                                                         | Pass full id. cli/commands/snapshot.ts:372-385.                                                |
| `wipe --no-input` on TTY without `--yes`                                                   | `CONFIRM_REQUIRED` envelope + `EX_CONFIRM_REQUIRED=43`. cli/commands/wipe.ts:281-294.                                                                                                                          | Pass `--yes`.                                                                                  |
| `wipe` on non-TTY stdin without `--yes` / `--no-input`                                     | `CONFIRM_UNSUPPORTED` envelope + `EX_USAGE`.                                                                                                                                                                   | Pass `--yes`. cli/cli-prompt.ts:89-95.                                                         |
| `wipe --also-upstream-cache` + Tier-2 phrase mismatch                                      | `declined` envelope + `EX_USAGE`. cli/commands/wipe.ts:295-309.                                                                                                                                                | Re-run, type the stack name exactly.                                                           |
| `prune <app>/<stack>` against a live supervisor                                            | `failAlreadyReported('prune: refusing to remove … — supervisor is running (pid N). Stop it first.')` → exit 1. cli/commands/prune.ts:537-541.                                                                  | Stop the supervisor (Ctrl-C the running `up`).                                                 |
| `pruneStack` invoked with live holder via `state.json.lock`                                | `PruneStackBlockedError(app, stack, lockPath, holderPid)` raised. cli/commands/\_prune-stack.ts:47-69.                                                                                                         | Same.                                                                                          |
| `prune --interactive` on non-TTY                                                           | `failAlreadyReported('devstack prune: interactive mode requires a TTY. …')`. cli/commands/prune.ts:584-588.                                                                                                    | Use `--list`, `--repo-gone --yes`, `--all-orphans --yes`, or `<app>/<stack> --yes`.            |
| `fork status` against a non-fork stack                                                     | `failAlreadyReported("manifest's services.sui.network='X' is not a fork variant. …")`. fork/\_shared.ts:53-61.                                                                                                 | Use the right stack via `--stack` / `DEVSTACK_STACK`.                                          |
| `fork status` against a missing manifest                                                   | `failAlreadyReported('no fork stack found for stack=…')`. fork/\_shared.ts:47-52.                                                                                                                              | Run `devstack apply` first.                                                                    |
| `fork advance-clock` non-positive `durationMs` / `advance-checkpoint --count` non-positive | `failAlreadyReported(…must be a positive integer)`. fork/advance.ts:37-42, 111-116.                                                                                                                            | Pass a positive integer.                                                                       |
| `fork replay-to <checkpoint>` already at/past target                                       | Emits `noop: true`, exit 0. fork/replay.ts:46-69.                                                                                                                                                              | None — succeeded.                                                                              |
| `fork seed diff` mismatch (no `--dry-run`)                                                 | Prints `MISMATCH` block + raises `AlreadyReportedError` with exit `EX_SEED_MISMATCH=42`. fork/seed.ts:243-245.                                                                                                 | Re-seed or fix config.                                                                         |
| Stack name validation fail                                                                 | `Error('stack: name '<n>' is invalid …')`. cli/commands/stack.ts:31-38.                                                                                                                                        | Use a valid name.                                                                              |
| `stack drop` without `--yes`                                                               | `failAlreadyReported('devstack stack drop: --yes is required …')`. cli/commands/stack.ts:213-217.                                                                                                              | Pass `--yes`.                                                                                  |
| `prune` target without `--yes` (or `--dry-run`)                                            | `failAlreadyReported('--yes (or --dry-run) is required …')`. cli/commands/prune.ts:532-535.                                                                                                                    | Pass `--yes` or `--dry-run`.                                                                   |
| User Ctrl-C inside a prompt                                                                | clack returns its `isCancel` sentinel → outcome `cancelled` → `CANCELLED` envelope + `EX_USAGE`. cli/cli-prompt.ts:119-122.                                                                                    | Re-run or pass `--yes`.                                                                        |
| Top-level cause not already reported                                                       | `tapCause` calls `prettyError(cause)` to stderr; runMain teardown exits 1. cli/index.ts:130-142.                                                                                                               | Read the rendered error.                                                                       |

## Persistence model

The CLI itself owns no persistent state directly. It writes/removes the following on behalf of the
user:

**Survives restart (across `devstack` invocations):**

- `<stateDir>/active` — written by `stack {new --set-active, use}`.
- `<stateDir>/stacks/<name>/` directory tree — created by `stack {new, use}`, populated by engine
  acquire path during `up` / `apply`.
- `<stateDir>/snapshots/<id>/` — written by `snapshot save`, removed by `snapshot delete` / `wipe`
  (unless `--keep-snapshots`).
- `<stateDir>/sui-fork-cache/<chainId>/` — written by the supervisor at fork-acquire time; preserved
  by default through `wipe`. Removed by `wipe --also-upstream-cache` / `prune --include-fork-cache`
  / `fork cache prune --unreferenced`.

**Survives snapshot (`snapshot save` captures):**

- `state.json` (verbatim copy).
- `runtime/<service>/...` tarred.
- Per-container `docker commit + save`d tars (`include-images=true` default).
- Optional extras (e.g. `sui-fork/data/` when `include-fork-data` is on — default = auto-include if
  dir < 1GB).

**Wiped by `devstack wipe` (default):**

- `<stateDir>/stacks/<stack>/` tree.
- `<stateDir>/state.json` (flat layout).
- Docker containers / networks / volumes labelled `devstack.app=<app>,devstack.stack=<stack>`.
- Stale `~/.move/git/<repo>/.git/*.lock` files older than 60s (UNCONDITIONAL on `wipe`).

**Wiped only with explicit flags:**

- Snapshots: removed unless `--keep-snapshots`.
- Devstack images: only with `--images` (per-stack) or `--include-images` (prune global).
- Shared fork cache: only with `--also-upstream-cache` (wipe Tier 2) or `--include-fork-cache`
  (prune).
- Shared router: only with `--include-router` (prune).

**Process-local only:**

- The dynamically imported config module (`import(...)`).
- Parsed flag values / Option fields.
- The active Effect runtime + scope.

## Modes & variants

The CLI's primary "mode" dimension is output: human vs JSON, TTY vs piped, color vs none. A
secondary dimension is interactive-prompt behavior across `--yes` / `--no-input` / non-TTY stdin.
Documented as a matrix below.

| Dimension                                 | TTY default                                                                                                                                                                                                                      | TTY + `--json`                                                                                                            | Non-TTY default (CI)                                                      | Non-TTY + `--json`                 | `--no-input` (env or flag)                           | `DEVSTACK_JSON=1`                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| stdout content                            | human Console.log lines                                                                                                                                                                                                          | one JSON envelope per command                                                                                             | human Console.log lines                                                   | one JSON envelope                  | (same as without; only changes prompt)               | one JSON envelope per command             |
| stderr content                            | pretty-error tree (on failure only)                                                                                                                                                                                              | pretty-error tree (on failure only; envelope still on stdout)                                                             | same                                                                      | same                               | same                                                 | same                                      |
| Color / ANSI                              | enabled (Console + ink)                                                                                                                                                                                                          | enabled (`prettyError` colors) but envelope is plain JSON                                                                 | typically disabled by `NO_COLOR` convention; NOT enforced by CLI directly | same                               | same                                                 | same                                      |
| Log buffering                             | line-buffered via Effect's Console                                                                                                                                                                                               | line-buffered                                                                                                             | line-buffered                                                             | line-buffered                      | n/a                                                  | n/a                                       |
| Signal handling                           | SIGINT → clean teardown → exit 0; SIGTERM → cause teardown → exit 1                                                                                                                                                              | same                                                                                                                      | same                                                                      | same                               | same                                                 | same                                      |
| `--renderer` default for `up`             | `tui`                                                                                                                                                                                                                            | n/a (only affects `up`'s renderer; envelope is wider)                                                                     | `plain`                                                                   | same                               | n/a                                                  | n/a                                       |
| Prompts                                   | clack-rendered confirm / text                                                                                                                                                                                                    | clack still rendered to stderr (clack uses stderr)                                                                        | aborts with `EX_USAGE` `CONFIRM_UNSUPPORTED` (non-TTY)                    | same; outcome rendered as envelope | aborts with `EX_CONFIRM_REQUIRED` envelope (or hint) | n/a                                       |
| Exit code on warning                      | 0 (warnings render `(informational)` tag)                                                                                                                                                                                        | 0                                                                                                                         | 0                                                                         | 0                                  | 0                                                    | 0                                         |
| Exit code on required-check failure       | 1 (doctor: `Error('doctor: required checks failed')`)                                                                                                                                                                            | 1; envelope `ok=false`, `code=PREFLIGHT_FAILED`, `exitCode=EX_UNAVAILABLE=69` (but main.ts teardown maps non-success → 1) | same                                                                      | same                               | same                                                 | same                                      |
| Interactive picker (`prune`) availability | yes                                                                                                                                                                                                                              | yes (still mounts ink; result rendered as envelope on submit)                                                             | refused with `failAlreadyReported(…requires a TTY)`                       | refused                            | refused                                              | refused (no impact — picker requires TTY) |
| Exit codes propagated to OS               | Per `main.ts` teardown: `Cause.hasInterruptsOnly → 0`; success → 0; else → 1. **Note: sysexits codes in the envelope's `error.exitCode` are NOT yet propagated to `process.exitCode` — main.ts:43 always returns 1 on failure.** | same                                                                                                                      | same                                                                      | same                               | same                                                 | same                                      |

A second "modes" matrix per long-running vs one-shot:

| Verb mode                                                                            | Lifetime                                   | Foreground I/O                                                                                    | Signal contract                                                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `up` (long-running)                                                                  | until SIGINT/SIGTERM or watcher reload     | TUI / plain renderer + log buffer to stderr                                                       | SIGINT → graceful teardown (docker rm -f via scope finalizers), exit 0; SIGUSR2 handled by engine, not CLI |
| `apply` (one-shot)                                                                   | until `Layer.build` scope closes           | success: "apply ok — state + manifest written for …"; failure: pretty-error / SeedMismatch recipe | SIGINT during scope close interrupts finalizers, exit 1                                                    |
| `snapshot save` (one-shot)                                                           | until engine `snapshot()` resolves         | progress line "saving snapshot <id> …" + final summary                                            | SIGINT mid-save: best-effort; partial artifact may remain                                                  |
| `snapshot restore` (one-shot)                                                        | until engine `restore()` resolves          | summary line                                                                                      | same                                                                                                       |
| `snapshot list` / `delete`                                                           | one-shot                                   | listing / confirmation prompt → removal                                                           | n/a (fast)                                                                                                 |
| `wipe`                                                                               | one-shot                                   | preview prompt → action summary                                                                   | n/a (fast)                                                                                                 |
| `prune --list` / `<app>/<stack> --yes` / `--all-orphans --yes` / `--repo-gone --yes` | one-shot                                   | inventory / preview / action summary                                                              | n/a                                                                                                        |
| `prune --interactive`                                                                | interactive (until picker exits or Ctrl-C) | Ink TUI                                                                                           | Ctrl-C → `onQuit` → exit 0 (`inkApp.exit()` then unmount)                                                  |
| `stack {list, new, use, down, drop}`                                                 | one-shot                                   | line per outcome                                                                                  | n/a                                                                                                        |
| `fork status` (no `--follow`)                                                        | one-shot                                   | block of fields                                                                                   | n/a                                                                                                        |
| `fork status --follow`                                                               | long-running stream                        | one event per line, ISO-timestamp + checkpoint                                                    | SIGINT → stream interrupted → exit 0                                                                       |
| `fork advance-clock` / `advance-checkpoint` / `replay-to`                            | one-shot                                   | one summary line per RPC                                                                          | n/a                                                                                                        |
| `fork seed list` / `diff` / `cache list` / `cache prune`                             | one-shot                                   | listing or action summary                                                                         | n/a                                                                                                        |
| `doctor`                                                                             | one-shot                                   | "Checks" + "Inventory" sections                                                                   | n/a                                                                                                        |
| `manifest`                                                                           | one-shot                                   | path + body lines                                                                                 | n/a                                                                                                        |
| `graph`                                                                              | one-shot                                   | per-format render to stdout                                                                       | n/a                                                                                                        |
| `version`                                                                            | one-shot                                   | one line                                                                                          | n/a                                                                                                        |

## Test coverage

### `cli/main.test.ts` (CLI surface smoke)

- **CLI surface > exposes every documented top-level subcommand**: walks `rootCommand.subcommands`
  and asserts the exact 12-entry list
  `[up, apply, status, snapshot, wipe, prune, stack, fork, doctor, manifest, graph, version]`. Locks
  the surface against accidental drops/renames.
- **CLI surface > every top-level command has a description**: every `Command.withDescription` set
  so `--help` doesn't render blank entries.
- **CLI surface > exposes every `snapshot` subcommand**: `[save, restore, list, delete]`.
- **CLI surface > exposes every `stack` subcommand**: `[list, new, use, down, drop]`.
- **CLI surface > exposes every `fork` subcommand (Phase 4 P4.1)**:
  `[status, advance-clock, advance-checkpoint, replay-to, seed, cache]` plus
  `fork.seed = [list, diff]` and `fork.cache = [list, prune]`.

### `cli/loaders.test.ts`

- **findConfigUp > finds a config in the same dir**.
- **findConfigUp > walks up two dirs to find a config under the same package**.
- **findConfigUp > returns null when no config is reachable below the package boundary**:
  workspace-root config is NOT picked up when there's a `package.json` between cwd and it.
- **findConfigUp > returns null when no config exists in any ancestor at all**.
- **findConfigUp > accepts .mts / .mjs / .js as alternative extensions**.
- **requireLaunchEffect / requireLayer typed-throws > requireLaunchEffect throws ConfigLoadError
  when module has no default export**.
- **... when default export lacks launchEffect**.
- **requireLayer throws ConfigLoadError when default export lacks layer**.

### `cli/envelope.test.ts`

- **cli/envelope > schemaVersion is pinned at 1 (bump intentionally on breaking changes)**.
- **... successEnvelope omits absent fields** (`data`, `dryRun`, `hints` absent when undefined).
- **... successEnvelope includes data + dryRun when supplied**.
- **... successEnvelope drops empty hints array** (`hints: []` is omitted).
- **... errorEnvelope carries every documented sub-field** (`code`, `exitCode`, `hint`, `recipe`,
  `context`).
- **... jsonModeEnabled honors --json flag and DEVSTACK_JSON env** (`'1'` or `'true'`, not
  `'not-a-truthy'`).
- **... inputDisabled honors --no-input flag and DEVSTACK_NO_INPUT env**.
- **cli/exit-codes > every ALL_EXIT_CODES entry has a name + description** (used by `--schema`).
- **cli/exit-codes > exit codes are unique**.
- **cli/envelope emitEnvelope > emits exactly one JSON line on stdout**.

### `cli/cli-prompt.test.ts`

- **promptConfirm > --yes short-circuits to confirmed without invoking clack**.
- **... --no-input fails with EX_CONFIRM_REQUIRED on a TTY**.
- **... non-TTY stdin returns non-interactive with EX_USAGE**.
- **... clack-confirmed becomes confirmed**.
- **... clack-declined becomes declined**.
- **... clack-cancel becomes cancelled** (clack's isCancel symbol).
- **... preview block is rendered as a clack note above the confirm**.
- **promptTypeToConfirm > --yes short-circuits to confirmed**.
- **... exact phrase match becomes confirmed**.
- **... cancel becomes cancelled**.
- **... --no-input fails with EX_CONFIRM_REQUIRED**.

### `cli/schema-emit.test.ts`

- **renderSchema produces parseable JSON**.
- **schema carries every documented top-level field** (`schemaVersion`, `version`, `envelope`,
  `exitCodes`, `globalEnv`, `commands`).
- **lists every top-level subcommand**.
- **projects nested subcommands** (`snapshot.save / stack.list / fork.seed.diff`).
- **every exit code carries name + description**.
- **documents every canonical env var** (`DEVSTACK_STACK`, `DEVSTACK_JSON`, `DEVSTACK_NO_INPUT`,
  `NO_COLOR`).

### `cli/stack-resolution.test.ts`

- **resolveStackFromEnv > explicit override wins over env**.
- **... falls through to DEVSTACK_STACK env when no override**.
- **... falls through to "main" when nothing set**.
- **... treats empty string env as absent**.
- **resolveStack > explicit override wins over env and active file**.
- **... env wins over active file when no override**.
- **... active file wins when no override and no env**.
- **... falls through to "main" when nothing is set**.

### `cli/commands/graph.test.ts`

- **renderText groups members by topological level with friendly titles**.
- **renderMermaid emits flowchart TD with one edge per upstream** (sanitised ids:
  `@devstack/SuiTag → _devstack_SuiTag`).
- **renderDot emits digraph with LR rankdir + box shape**.
- **falls back to the key when no displayTitle is set**.

### `cli/commands/prune.test.tsx`

- **selectableKeys > omits rows with a live supervisor**.
- **... returns empty when every row is running**.
- **PruneApp > renders one row per stack and surfaces the running marker**.
- **... shows the confirmation prompt after toggle + enter** (15s timeout; uses `vi.waitFor` for Ink
  frame polling).
- **... calls onQuit when q is pressed and never invokes onSubmit**.
- **... pre-selects repo-gone rows on mount**.
- **... doesn't open confirm when nothing is selected**.

### `cli/commands/wipe.envelope.test.ts`

- **wipe --dry-run --json emits the canonical envelope with dryRun=true** (asserts
  `schemaVersion=1`, `ok=true`, command=`wipe`, `wouldRemove.stateDir` present, no `upstreamCache`).
- **--dry-run --also-upstream-cache --json surfaces the upstream cache path**.
- **--no-input without --yes fails with the CONFIRM_REQUIRED envelope under --json**
  (`exitCode=43`).

### `cli/commands/wipe.fork.test.ts`

- **resolveForkCacheRoot lives at `<state>/sui-fork-cache` (NOT inside stacks/)**.
- **P4.T7 invariant: removing `stacks/<stack>/sui-fork/` leaves `<state>/sui-fork-cache` intact**.
- **P4.T8 invariant: `--also-upstream-cache` removes BOTH the per-stack dir AND the cache**.

### `cli/commands/snapshot.fork.test.ts`

- **resolveForkDataDir locates `<state>/stacks/<stack>/sui-fork/data`**.
- **a missing fork data dir reports size 0 (skip extras pass)**.
- **above-threshold data dir size flips auto-include OFF** (asserts 1GB threshold math).

### `cli/commands/stack.drop-fork.test.ts`

- **drops `<state>/stacks/<name>/` including sui-fork/, leaves cache intact**.

### `cli/commands/apply.fork-seed-mismatch.test.ts`

- **SeedManifestMismatchError carries actionable wipe recipe in message** (matches
  `/devstack wipe --keep-upstream-cache/`, `/devstack apply/`).
- **previous / current snapshots disambiguate the diff**.
- **typed catch flows through `Cause.failures`** (walks `cause.reasons` for
  `_tag: 'SeedManifestMismatchError'`).

### `cli/commands/doctor.fork.test.ts`

- **configHash is self-consistent on a freshly-written meta**.
- **configHash drift is detectable (tampered meta.json)**.

### `cli/commands/fork.test.ts`

- **manifest discovery + upstream derivation (P4.T1 wiring) > reads `services.sui` from a manifest
  and derives the upstream** (sets `DEVSTACK_APP_DIR/STATE_DIR/STACK`, asserts
  `_internal.resolveForkRuntimeCtx('main')` returns `{stack, upstream='testnet', rpcUrl, chainId}`).
- **collectReferencedChainIds (P4.T4 + cache list) > walks per-stack meta.json files and folds
  upstream + chainId into the set**.
- **cache list + prune marker logic > collectCacheEntries marks unreferenced chainIds correctly**.

### Docker-gated stubs (gated by `RUN_FORK_DOCKER_TESTS=1`, all currently `expect(SHOULD_RUN).toBe(true)` placeholders)

- `cli/commands/fork.docker.test.ts`: P4.T1-P4.T4 placeholders for
  `fork status/advance-clock/advance-checkpoint/seed-diff`.
- `cli/commands/apply.fork-seed-mismatch.docker.test.ts`: P4.T5 placeholder for two-`apply` mismatch
  cycle.
- `cli/commands/wipe.fork.docker.test.ts`: P4.T7/P4.T8 placeholders for cache reuse / wipe + cache
  reset.
- `cli/commands/doctor.fork.docker.test.ts`: P4.T9 placeholder.
- `cli/commands/stack.drop-fork.docker.test.ts`: P4.T10 placeholder.

## Pain points today

1. **Sysexits codes are not propagated to the process exit code.** Every `failWithEnvelope` puts a
   numeric code (e.g. `EX_SEED_MISMATCH=42`) into `error.exitCode`, but `main.ts:43` always returns
   1 on failure. CI agents reading `process.exitCode` see only "1 = something failed". The
   envelope's `exitCode` is the only place to read the structured code today. (Documented at
   `exit-codes.ts:12-15`: "Phase A is additive — these codes are emitted in the envelope's
   `error.exitCode` field, but `cli/main.ts`'s teardown still maps every non-success to 1 unless the
   per-command flow surfaces a specific code. Phase B threads the codes through the top-level
   reporter.")
2. **`--no-input` and `DEVSTACK_NO_INPUT` semantics are inconsistent across `prune`.** `wipe` /
   `snapshot delete` honor them via `cli-prompt`'s helpers; `prune` rolls its own TTY check at
   cli/commands/prune.ts:584-588 and ignores both knobs. CI users get a clean error in one case and
   a different one in another.
3. **`prune --interactive` doesn't have a `--json` envelope path.** Successful selections render via
   `Console.log(renderPruneResult)` regardless of `useJson`. cli/commands/prune.ts:606-612. Agents
   can't programmatically know which stacks were pruned.
4. **`stack` subcommands have no `--json` envelope.** `list / new / use / down / drop` all emit
   plain Console.log only. cli/commands/stack.ts throughout.
5. **`manifest` / `status` JSON envelope path emits the entire parsed manifest under `data.manifest`
   / `data.state.content`** — these can be large (every package id, every account address). No
   pagination / projection. cli/commands/status.ts:135-157, cli/commands/manifest.ts:36-52.
6. **Flag introspection in `--schema --json` is omitted.** Effect's CLI surface keeps the flag table
   behind a private field — "Phase B may stabilize the shape and we wire it through then"
   (cli/schema-emit.ts:72-74). Agents discover every verb but NOT the per-verb flag set.
7. **`devstack restart` does not exist.** The task brief asked about it; only `stack down`
   (per-stack) and `wipe` (per-stack) + supervisor's SIGUSR2 are available. SIGUSR2 must be sent to
   the running supervisor pid directly; no CLI verb wraps that today.
8. **`up`'s `--renderer` flag only accepts kind names; no way to inject a factory.** Cli
   `applyNetworkOverride`-style hooks would let advanced callers pass a
   `RunOverrides.rendererFactory`. Not exposed today.
9. **Action-time env reads scattered across commands.** Several files (`snapshot.ts`, `wipe.ts`,
   `manifest.ts`, `status.ts`) note "action-time reads of `DEVSTACK_STATE_DIR`" — same comment block
   repeated. Stack-resolution.ts centralized this but the per-command callers still inline
   `process.env.DEVSTACK_STATE_DIR ?? '.devstack'` (e.g. cli/commands/wipe.ts:216).
10. **`prune` and `wipe` both call `pruneStack` BUT use different live-supervisor checks.** `prune`
    checks via `isPidAlive` against `inventory.runningPid` AND `pruneStack`'s own
    `ensureNoLiveHolder`; `wipe` relies on `pruneStack`'s check only. Double-defense is fine but the
    duplication is real. cli/commands/prune.ts:209-219 vs cli/commands/\_prune-stack.ts:47-69.
11. **Fork subcommand `--dry-run` is inconsistent.** `advance-clock`, `advance-checkpoint`,
    `seed diff` have `--dry-run`; `replay-to` does NOT (it could meaningfully say "would advance N
    checkpoints").
12. **The `Flag.boolean('no-stop')` on wipe** still removes networks + volumes even though the
    comment says "Skip the docker kill pass — only remove on-disk state".
    cli/commands/\_prune-stack.ts:299-311 conditions ALL three docker passes on
    `options.noStop !== true` — actually correct, but the wipe-side flag description is potentially
    misleading ("only remove on-disk state" implies networks/volumes are NOT removed when set; in
    fact they are skipped entirely when `--no-stop` is passed).
13. **`@clack/prompts` lazy import via `loadClack` is best-effort.** When the module is missing,
    prompts fall back to `non-interactive` with `EX_USAGE`. In production it's a direct dep
    (package.json:59); the swallow exists only for tests + sandboxes. Could be replaced with a
    stricter assert.
14. **Snapshot id format `<YYYYMMDD>T<HHMMSS>-<rand4hex>[-<label>]` doesn't sort lexicographically
    with `<rand>` after `<HHMMSS>`** — but `listSnapshots` (engine) sorts by `createdAt` from the
    meta, so this is only a problem for naive `ls` listing. Possibly OK.
15. **`apply --dry-run` only validates config; it doesn't simulate the bootstrap router or fork-meta
    consistency check.** Hard limit of "no layers built" — but a `--validate` mode that ran the
    readiness checks without actually starting containers would be useful.
16. **`graph --downstream <key>` requires loading the user's full `devstack.config.ts`.** This means
    an expensive module side-effect chain (e.g. constructing `@mysten/sui` clients) just to print
    which keys depend on a given primitive. The graph itself is cheap once loaded.

## Open questions

- **Does `--schema --json` need to fire on a strictly unrecognized command?** Today, the GlobalFlag
  action runs BEFORE the subcommand dispatch, so it does — but tests don't cover the case where
  someone passes `devstack notavalidcommand --schema --json`. OPEN QUESTION: should the schema-emit
  happen even if the rest of the argv is malformed?
- **What happens when two `devstack up` invocations against the same `(app, stack)` race for the
  state-store lock?** The CLI inherits whatever the engine's state-store lock contract enforces —
  likely an `AlreadyRunningError`-style failure. OPEN QUESTION: where exactly does the engine's lock
  acquire surface? (Owned by engine-resources doc, not cli.)
- **Why does `wipe` resolve `stateDirPath` inline via
  `process.env.DEVSTACK_STATE_DIR ?? '.devstack'` (cli/commands/wipe.ts:216) instead of going
  through `resolveStateDir`?** May be a vestige of pre-consolidation. OPEN QUESTION: is the
  `<stateDir>/stacks/<stack>` path in the wipe envelope identical to what `resolveStateDir` would
  produce? Probably yes for the default case but not when `--app` is passed and `DEVSTACK_APP_DIR`
  differs from the default.
- **`devstack stack` says
  `state-store currently writes a flat .devstack/state.json regardless of stack name`**
  (cli/commands/stack.ts:7-12). Has the per-stack state-store wiring landed elsewhere? OPEN
  QUESTION: confirm against `engine/state-store.ts`. (Owned by engine doc.)
- **The `apply` command's `bootstrapRouterFor('apply')` call provides `NodeServicesLayer` directly
  instead of the full bootstrap layer** (cli/commands/apply.ts:122-131). OPEN QUESTION: is there a
  routerFor case that needs more than ChildProcessSpawner? Today no, but the asymmetry with `up`
  (which goes through the full supervisor) is worth flagging.
- **`fork seed diff` without `--upstream` is "print-only"** (just prints the on-disk hash) — but
  `--json` still emits a success envelope with `mode: 'print-only'`. OPEN QUESTION: is this the
  intended "default = noop" or should `diff` require either explicit comparison flags or `--json`?
- **NO_COLOR**: documented in the global env list but not directly consumed by `cli/` (only by
  Effect's default Console and ink). OPEN QUESTION: does the schema-emit advertise this correctly
  given the indirect consumption?
- **`devstack init` / scaffolding**: not present. The task brief asked about it; the project assumes
  users hand-write `devstack.config.ts`. OPEN QUESTION: future work?
- **Mutating `process.env.DEVSTACK_NETWORK` from `--network` happens in `applyNetworkOverride`, but
  it doesn't unset on success.** If the same Node process runs more than one verb (test harness?
  library use?), the second verb inherits the first's network. OPEN QUESTION: this is fine for the
  bin entrypoint (one process per invocation) but matters for embedded callers — not currently a
  documented use case.

## Opportunities noticed

- **Centralize action-time `DEVSTACK_STATE_DIR` reads.** `manifest.ts:16-17`, `snapshot.ts:48-49`,
  `wipe.ts:216`, `status.ts:15-16` each re-implement `${stateDir()}/stacks/<stack>` paths. Move into
  `stack-resolution.ts` (or use the existing `resolveStateDir`) consistently.
- **Lift sysexits-code propagation into `main.ts`.** Track the highest non-zero exit code from any
  `failWithEnvelope` call (e.g. via Effect Ref or thread-local) and surface in `teardown`. Today the
  code is in the envelope but `process.exitCode` is always 1 on failure. (Already TODO per
  `exit-codes.ts:12-15`.)
- **Refactor every per-verb `--json` flag definition.** `snapshot save / restore / list / delete`,
  `wipe`, `prune`, `graph`, `apply`, `status`, `manifest`, `fork *` all re-declare
  `Flag.boolean('json')` with a near-identical description. Extract one shared `jsonFlag` (mirrors
  how `fork/_shared.ts` already does for fork subcommands).
- **`--dry-run` flag is similarly duplicated across `apply`, `snapshot save/restore/delete`, `wipe`,
  `prune`, `fork advance-clock/advance-checkpoint/seed-diff/cache-prune`, but with subtly different
  descriptions.** Extract shared `dryRunFlag`.
- **`--yes` flag is duplicated.** Same opportunity.
- **`--stack` flag exists on snapshot, wipe, fork, but defined slightly differently (string vs
  string-with-default-empty-string vs optional).** Could be one source of truth.
- **`--app` flag on snapshot and wipe.** Same.
- **Replace `wipe.ts`'s inline `process.env.DEVSTACK_STATE_DIR ?? '.devstack'` with
  `resolveStateDir({override: Option.none()})`.** Matches the rest of the codebase.
- **Consolidate live-supervisor checks.** `pruneStack`'s `ensureNoLiveHolder` and `prune.ts`'s
  `findRunningRow` do nearly the same thing; the latter is a defensive check the former should fully
  replace.
- **`AlreadyReportedError` could carry the exit code.** Today it's just a sentinel; pairing it with
  the intended sysexits would let the top-level teardown thread the code through cleanly.
- **Move `RouterRow` rendering out of the Ink picker file.** `_prune-ui.tsx:274-294` defines a
  non-selectable RouterRow that's used only inside `PruneApp`; the same data is rendered by
  `prune --list` via `renderRouterRow` from engine. Slight asymmetry.
- **`--no-include-images` should be the canonical opt-out for snapshots.** Today snapshot save
  expects `--no-include-images`; consider documenting the `Flag.boolean(...).withDefault(true)`
  opt-out convention more prominently.
- **`fork seed list` reads on-disk meta only — could share more with `status`'s chain block.** Today
  they both render meta.upstream + meta.checkpoint + meta.configHash slightly differently.
- **`schema-emit.ts` omits per-flag introspection.** Once `effect/unstable/cli` stabilizes the flag
  table accessor, the schema becomes much more useful for agents.
- **Test counts may be misleading.** Several `*.docker.test.ts` files are stubs (each contains a
  single `it(name, () => expect(SHOULD_RUN).toBe(true))`) — the surface area they advertise is not
  yet implemented. This is noted in the test coverage table but worth highlighting for the
  architecture phase: the docker-side coverage for fork CLI is essentially absent.
- **`prune.ts` is 618 LOC** with 5 modes — splitting per-mode files (`_prune-list.ts`,
  `_prune-target.ts`, `_prune-bulk.ts`, `_prune-interactive.ts`) would mirror the `fork/` split.
  Audit E20 (referenced at fork/index.ts:36-37) did the same for the fork directory.
- **`wipe.ts` and `snapshot.ts` both define their own `stackFlag` / `appFlag` with similar but not
  identical descriptions.** Hoist shared.
- **`up` lacks `--json`.** Long-running commands could still emit start/end envelopes; today `up`
  only emits via the chosen renderer (TUI or plain). An agent watching `devstack up` for "stack is
  ready" has to poll `status` or parse renderer output.
- **`schema-emit.ts:121-153` hardcodes the global env list.** Drift risk: adding a new `DEVSTACK_*`
  var means updating both the consumer site and this list. A registry pattern (e.g. centralized
  `ENV_VARS` array exported by `stack-resolution.ts` + `envelope.ts`) would prevent drift.
- **`already-reported.ts` walks `cause.reasons` ad-hoc.** A shared `findCauseByTag<T>` helper in
  `engine/pretty-error` would let `apply.ts:findSeedManifestMismatch` use the same primitive.
