# Long-running CLI: `up` / `watch` / args / filters

**Verdict**: C+ — `up` and `watch` are accidental synonyms, not a thoughtful split. Args parser is hand-rolled and has minor footguns. Filters are clean but live in the wrong layer for `up`.

## The `up` vs `watch` collision — accidental, not `terraform apply`

The dispatch layer in `cli/index.ts:38-47` routes both `up` and `watch` to the same `cli/up.ts:main()` and only varies one flag — `up` always appends `--once`, `watch` always strips it. `up.ts` then branches in `runUp` on `flags.once`: true → `Supervisor.runOnce()` (reconcile + teardown), false → `Supervisor.start()` (long-running, file watcher, key handlers, keepalive timer).

This is *not* a `terraform apply` vs `plan` framing. With Terraform, `apply` is the mutating one and `plan` is read-only — both finish. Here, both verbs mutate identically; the difference is only "do I exit when done?" The README (line 137) calls `up` "one-shot reconciler" and `watch` "long-running supervisor; watches Move sources." The `apply` verb already exists as a separate command (`cli/apply.ts`) that does the real apply-versus-watch split. So `up` is *not* the apply analogue — `apply` is. Which leaves `up` as a redundant verb whose only differentiator from `watch` is teardown behavior.

This reads as accidental: the journal shows that when v2 was extracted the canonical script was `tsx .../cli/up.ts ./devnet.config.ts --once` — `--once` was the *normal* mode. `watch` was added later as the long-running variant, and the dispatch layer evolved to flip the default by force-adding/force-stripping `--once`. The `--once` flag is still wired through to `runUp` (and tested through it for Playwright globalSetup), but on the CLI it is now unreachable: dispatch overrides whatever the user types.

Real users have hit this: Playwright globalSetup *does* want `up --once`-shaped semantics, but `pnpm dev` always wants `watch`. Examples (every `package.json`) wire `dev → devstack watch` and `localnet:up → devstack up --once`. The `--once` on `localnet:up` is a no-op (dispatch adds it anyway) — pure documentation.

## Args parsing — manual, deliberately so

`args.ts` is hand-rolled. Each parser walks argv linearly, knows the set `FLAGS_WITH_VALUES` to skip past, and falls back to a trailing positional for `--config`. This is simple, dependency-free, and easy to compose across `up`/`apply`/`codegen`/`deploy`/`console`. The `runIfMain` helper at `args.ts:39-54` deduplicates the entry-point dispatch when tsx + workspace symlinks produce two ESM module records — a nice fix for a real bug.

Limitations: no short flags, no `--help` per command, no validation that flag values aren't another flag (`--stack --target foo` would record `--target` as the stack name, then re-walk and pick up `foo` as target — silently wrong). `parseConfigArg`'s positional fallback also accepts *any* non-flag token as the config path; if a user types `devstack up scratch` expecting `scratch` to be the stack, they get `configPath='scratch'` and a confusing "config did not export default" error. Coverage in `args.test.ts` is thorough for the happy paths, but doesn't exercise the "user typed a stack name as positional" case or duplicate-flag handling.

## Filters — clean, but live in the wrong layer for `up`

`filters.ts` is the elegant piece: three pure functions (`deployFilter`, `applyFilter`, `emitOnlyFilter`) over `(action, target)`. The behavior matrix in the file header is exact and `filters.test.ts` covers every cell. **But the supervisor (`up`/`watch`) has no filter concept** — `Supervisor` is localnet-only by construction (`supervisor.ts:87-93` throws on non-localnet) and runs every action type. So filters apply only to the one-shot path. This is consistent — there's no reason to filter when you own the localnet — but it means `up` cannot do partial bring-ups (no `--actions` scoping like `apply` has).

## `--target` resolution — correct, awkwardly placed

`up.ts:46-66` re-implements a chunk of `resolveTarget`'s logic to error fast on live-net targets. This was a deliberate guard but it's structural duplication: `apply.ts` calls `resolveTarget` directly. Cleaner would be a `resolveLocalnetTarget` helper in `target.ts` that throws on live nets, used by both `up.ts` and the supervisor's constructor.

## Customizability gaps

Real holes: no `--verbose`/`--quiet`/`--json` (status-renderer is the only output channel; CI logs are noisy and unstructured), no `--keepalive`/`--no-teardown` for `up` (the surprise mode users actually want), no env-var overrides except `DEVSTACK_STACK`. The `--actions` flag exists on `apply` but not on `up`/`watch`, even though watch-with-scope is a plausible workflow.

## Top recommendations

1. **Collapse `up`/`watch` into one verb.** Pick `up` (matches scaffold-eth `yarn chain`/`yarn start` muscle memory) and add `--once` as the explicit teardown mode. Or pick `watch` and make `up` an alias with deprecation. The current "dispatch mutates argv" pattern is hostile to introspection.
2. **Move the live-net guard out of `up.ts`** into the supervisor constructor (already exists) or `target.ts:resolveLocalnetTarget`.
3. **Add `--json` output** for CI consumers; the manual `process.stdout.write` in `apply.ts:59-66` is already a TTY-only hack.
4. **Tighten args parsing**: reject flag values that start with `--`, surface help per command, document the positional-config trap.
