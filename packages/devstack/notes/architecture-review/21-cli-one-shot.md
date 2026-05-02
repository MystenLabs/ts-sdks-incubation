# One-shot CLI subcommands

**Verdict**: B+ — Well-shaped and correctly factored. Two real wrinkles: the `apply` vs `up --once` distinction is internally sound but externally confusing, and `stack drop`'s force-bypass via `devstack reset` is a foot-gun.

## Architecture

The clean factoring across `runtime/one-shot.ts` + `cli/filters.ts` + `cli/target.ts` is the strongest part. Three filters (`deployFilter`, `applyFilter`, `emitOnlyFilter`) compose with a single `runOneShot` engine, so `apply`/`deploy`/`codegen` differ only in which actions they admit and whether they write the manifest. `console` doesn't run actions at all — it's a pure manifest consumer with a `.deploy` REPL command that re-enters `runApply`. `stack` is the only verb that doesn't touch `runOneShot`; it's docker plumbing.

**`apply` vs `up --once`**: They're not equivalent and the comment at the top of `apply.ts:7-12` documents why — `up --once` runs through the supervisor (signal handlers, file watcher init, render loop, shutdown hooks, hydrate-from-manifest) just to do one cycle and tear down. `apply` is a bare `runOneShot` call with `applyFilter`. The semantics differ in three places that matter:
1. `up --once` always uses the localnet-supervisor code path (rejects live-net targets); `apply` accepts any target.
2. `up --once` invokes Service actions to spin up containers; `apply` does too on localnet, but routes through `runOneShot` so the dirty-cascade semantics match `deploy`.
3. `up --once` emits a status-rendered TUI; `apply` emits a flat name+status list.

**External confusion**: `examples/token-studio/package.json` exposes `localnet:up = devstack up --once` and `apply = devstack apply` as separate scripts. From a user's seat on localnet, what's the difference? Both reconcile once. The honest answer is "almost nothing — `apply` is what you want when you're scripting; `up --once` is what `localnet:up` is wired to so the supervisor's banner shows up."

## Problem fit

- **"deploy to testnet"**: `devstack deploy --network testnet` is the right shape, but the C1 `deployFilter` keeps `Build` on live nets ("preserved pre-C1 behavior verbatim"). Real testnet deploys don't want docker image builds. The hint that `applyFilter` is the right default isn't acted on.
- **"switch stacks"**: `stack use` + `localnet:up` is two commands. The "scaffold-eth-2 for Sui" bar wants one. A `stack use --up` shortcut would help.
- **"fresh codegen"**: `devstack codegen` works correctly — `readOnly: true`, `emitOnlyFilter`, hydrates manifest, runs only Emit. The error message at `codegen.ts:54-58` correctly directs the user to `apply`/`deploy` if no manifest exists.

## `stack drop` semantics — the walrus debugging hazard

`stack.ts:188-221`. Two guards (`name === DEFAULT_STACK`, `name === active`) are bypassed by `--force`, which the top-level `devstack reset` (`index.ts:69-71`) hard-codes: `['drop', '--force', ...argv]`. So `devstack reset --yes` always means "drop the active stack including the default `main` stack, including volumes." There's no confirmation prompt, no `--dry-run`, no log of what's about to disappear — just a single `--yes` line. During walrus debugging this is exactly what you want when stuck, and exactly what you don't want when fat-fingered. The `removeStackVolumes` walk by `<app>-<stack>-` prefix is correct but unrecoverable.

## Integration

`target.resolveTarget` is the single resolver used by `apply`/`deploy`/`codegen`/`console`. `up.ts` reuses it but rejects non-localnet results. `network-profile.ts` is a 19-line file pulled out cleanly so live-net `rpcUrl` lookups have one error message. The `<network>:<stack>` parser handles ambiguity well — bare values fall through to localnet stack names, with a `tetnet:main` typo caught as an unknown network rather than silently degrading.

The `console` REPL's `.deploy <pkg>` shortcut re-importing `runApply` is a smart composition: the resolved target is preserved across the boundary so a user who launched `console --target testnet` and then types `.deploy` gets a testnet apply. The bare-name → action lookup in `resolveScopeToActions` is fragile though — a typo'd action name silently runs an empty cycle.

## Customizability + gaps

- `--config` resolution is consistent across all verbs via `parseConfigArg`.
- `--filter` doesn't exist; users get `applyFilter` always for `apply`, `deployFilter` always for `deploy`. There's no escape hatch to run `apply` semantics on a live net.
- **No `--dry-run`** on `apply`/`deploy`/`stack drop` — the highest-impact missing flag. A dry-run would have made the walrus volume-loss episode a rehearsal.
- **No tab completion**, no `--help` per subcommand. `parseArgs` is hand-rolled in every verb; a small commander/citty wrapper would unify this.
- `parseConfigArg`'s positional fallback at `args.ts:82-84` quietly overwrites any earlier `--config` value if a positional comes later.

## Testing

`target.test.ts` covers the resolver fully (10 cases). `filters.test.ts` covers all three filters across networks. **`apply.ts`, `deploy.ts`, `codegen.ts`, `console.ts`, `stack.ts` have zero unit tests** despite each containing parse-args logic that's drifted slightly between files (e.g. `console.ts` has its own `--codegen-dir` parse loop that ignores the `FLAGS_WITH_VALUES` consistency in `args.ts`).

## Top recommendations

1. **`devstack reset` should print the volume names it's about to delete** and prompt unless `--yes --force-delete` is doubly explicit.
2. **Add `stack drop --dry-run`** that lists containers, volumes, and the host dir without removing them.
3. **Add a `--filter` escape hatch** so `apply` semantics can run on live nets when needed.
4. **Switch `deployFilter` default to `applyFilter` shape** for live nets (drop Build), or document the C1 behavior preservation as a known issue.
5. **Unify parse-args in a small citty/commander wrapper** to fix the `console.ts` drift and add `--help` per subcommand.
