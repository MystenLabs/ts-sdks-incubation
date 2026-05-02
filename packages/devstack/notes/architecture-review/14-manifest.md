# Manifest reader/writer/types

**Verdict**: B − Schema-versioned, namespace-shaped, durable across plugin add/remove. **Atomic write is missing** — the single biggest defect in the subsystem.

## Architecture

### Atomic write — there isn't one

`manifest-writer.ts:64` calls `writeFileSync(path, json, 'utf8')` directly. There is no `O_TMPFILE`, no `write(tmp) → rename(tmp, real)`, and no `fsync`. The supervisor calls `persistManifest()` at the end of every cycle (`supervisor.ts:265`), which means a crash mid-write — `cmd-Q` to the terminal, OS power loss, `kill -9` on the dev container — leaves a partially-written `manifest.json` on disk. The vite plugin (`plugin.ts:110`) and `readManifest` (`manifest-reader.ts:48`) both `JSON.parse` blindly; the vite plugin happens to swallow the parse error and fall back to `EMPTY_MANIFEST`, but the supervisor's `hydrateRegistry` propagates a parse failure back to the caller as an `Error` — and on the deploy path, `runOneShot` would then refuse to hydrate. **This is the single biggest defect in this subsystem.** The fix is a 3-line change: write to `${path}.tmp` then `renameSync` (POSIX atomic on the same FS).

The `JSON.stringify(..., '\t')` choice is a real win for git diff readability but irrelevant to atomicity.

### Schema versioning — well-shaped, untested

`ManifestVersion = 1 | 2` widens the type to make room. `MANIFEST_MIGRATIONS` is the right registry shape — keyed by source version, returns the next-version manifest, walked iteratively. Errors on unknown future versions with an actionable suggestion (`devstack reset --yes`). The registry is currently empty, which is fine for v2-only readers, but it means the migration path has never executed in CI — the first real upgrade will be the first test of the loop. Recommend adding a "ghost" v1 → v2 migration test now.

Also: most callers use `readManifest` (no migration) — `readManifestWithMigration` is only exported, not used internally. The supervisor's `hydrateFromManifest` and the vite plugin both bypass migration. That's fine while we're at v2-only, but the moment v3 ships, those call sites silently read stale shapes.

### Namespace shape

The on-disk shape — `registry.{tokens, packages, accounts, services, walrus, seal, ...}` — is durable and obvious. Core kinds are flat arrays; plugin namespaces are objects whose own keys are kind names whose values are arrays. The `SerializedRegistry` index signature `[namespace: string]: unknown` keeps types open without leaking plugin internals. The writer reaches into `RegistryImpl.namespaces` via a typed cast (`manifest-writer.ts:82-91`); reader symmetrically uses `reg.ns<...>(name)`. The asymmetry — writer touches private state, reader uses public API — is mild encapsulation rot but contained to one file.

## Problem fit

The manifest *is* the cross-process contract. Vite plugin reads it, supervisor writes it, one-shot writes/hydrates it, codegen plugin and Playwright/vitest globalSetup read it. Surviving restarts is the explicit goal, and the v2-out / hydrate-in cycle does that. The 50 MB cap is appropriate.

Schema durability across plugin add/remove is good *because* of the namespace map: removing the seal plugin doesn't break parse; the leftover `registry.seal` block is just orphaned data. Adding a plugin works trivially.

## Integration

- **Reader → registry hydrate:** `hydrateRegistry` registers each entry through the public `register()` API (so dirty bits get set), then calls `flushDirty()` to drop them. Without the flush, every dependent Emit fires unconditionally on cycle 1.
- **Writer → reconciler:** invoked from `Supervisor.runCycle` post-cycle and from `runOneShot` post-cycle. There is *no* invocation when a cycle aborts (try/catch on `supervisor.ts:251` skips `persistManifest()` on a thrown contract bug), which is correct.
- **Live-net divergence:** `manifestPath` returns `<appDir>/.devstack/manifests/<network>.json` for testnet/mainnet, ignoring `stack`. The doc comment is candid about why ("you don't run multiple testnets locally").

## Customizability + gaps

- **No per-entry timestamps.** Only `manifest.emittedAt`. Useless for "when did this `package` get republished".
- **No compaction / pruning.** Removed actions never delete their previously-registered entries; the in-memory `register()`-only API has no `unregister`.
- **`bigint` replacer is the only special case** — sound but undocumented in the type module.
- **Single-file lock-free writer** invites torn writes if `runOneShot` and `Supervisor` ever run concurrently against the same `<app>-<network>.json`.

## Testing

`one-shot.test.ts:100,120` covers `readOnly` skip-write + happy-path write. Schema correctness tested via parse-and-introspect.
`supervisor.test.ts` covers construction only — no `persistManifest` assertion across cycles.
**Zero coverage on:** writer atomicity (no concurrent-writer or kill-mid-write fixture), `readManifestWithMigration` (the migration table is empty so the function is dead branches), version-mismatch error path, `MANIFEST_MAX_BYTES` rejection, namespaced kinds round-trip.

## Top recommendations

1. **Atomic write via tmp + rename.** ~5 lines in `writeManifest`. Highest payoff.
2. **Migration smoke test.** Even a no-op v1 → v2 with a fixture future-proofs the migrate loop.
3. **Use `readManifestWithMigration` in the vite plugin and supervisor hydrate**, not `readManifest`, so the first v3 ship doesn't stealth-break dev servers.
4. **Per-entry timestamps** (`registeredAt`) when v3 lands — supports "stale manifest" UX in the renderer.
5. **Tighten the writer's `RegistryImpl` private-field reach** by exposing a `namespaces()` iterator on `RegistryImpl`.
