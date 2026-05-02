# status-renderer + hash + scope-actions

**Verdict**: B − Three small utilities, all functionally adequate, all undertested. Hash has real edge cases (Date, Map, Set collide); renderer has no JSON output; scope-actions silently drops typo'd action names.

## status-renderer.ts

A line-oriented in-place block renderer. TTY mode redraws via `ESC[1A ESC[2K` (cursor-up + erase-line) per `prevBlockHeight`; headless mode emits one line per state change. No alternate-screen, no curses — coexists with normal scrollback. Logs flow above the block; the block always sits at the bottom. Glyph table covers all eight `ActionStatus` values. Verbose toggle is a flag with a one-line indicator; not actually wired to filter log volume — the comment "verbose log mode on" is aspirational.

**Output is good for the supervisor's interactive case**: action table at the bottom, log lines stream above, `[ts action]` prefixes make grep-after-the-fact viable. The CSI escape choice is solid (no `\r` repaint flicker). But there are gaps: no truncation when `name.length > 32`; no width-aware fitting if a terminal is narrower than ~50 cols; the `appendLog` line emits raw `line` without ANSI sanitisation — a colored `console.log` from an action that contains `\n` will desync `prevBlockHeight` and orphan rows.

**Integration**. Supervisor wires `progress` → `renderer.update`, `appendLog` → `renderer.appendLog`, `markStale` from `onFileStale`. Headless path used by tests with non-TTY streams. `runOneShot` does **not** use the renderer at all — its CLI commands print their own results. That's a fork: the live block format lives only in the supervisor, and the apply/deploy paths re-implement summary lines elsewhere.

**Gaps**. No JSON output mode (CI-blind: a Playwright runner has to scrape ANSI lines). No verbosity levels beyond the inert toggle. No way to suppress glyphs. No structured event emission.

## hash.ts

Hand-rolled `stableStringify` → SHA-256 hex. Object keys sorted lexically; `undefined` values stripped from objects (parity with `JSON.stringify`); arrays recursive in order; `bigint` → `<n>n`; non-JSON types (functions, symbols) → opaque `__nonjson:<typeof>` marker. Top-level `undefined` is `'undefined'` (a string sentinel) — distinct from `null` and from `{}`.

For declared input objects the hash is correct: order-independent in keys, deterministic across runs, sha256 collision-resistant. Bigint handling matters because `JSON.stringify(1n)` throws. Strings use `JSON.stringify` so escaping/unicode normalises correctly.

**Critical gaps for plugin authors who'll inevitably stuff non-JSON things into `inputs`:**
- **No `Date` handling** — falls into the object branch, hashes `Object.entries(date)` = `{}`. Two different dates collide.
- **No `Map`/`Set`** — same trap, both hash to `{}`.
- **No `Uint8Array`/`Buffer`** — hashes `{0: 1, 1: 2, ...}` (works, but slow + opaque).
- **No `RegExp`** — hashes `{}`.
- **No custom serializer hook** — plugin authors can't register their own toJSON/marshallers.
- **No cycle detection** — a self-referential input recursion stack-overflows.
- **No content-based hashing for filesystem inputs.** The header comment mentions "FS-side hashing extends this in later phases by feeding additional content into the same `update()` flow," but `stableHash` returns the digest immediately — there's no streaming `update()` API to feed file bytes into.

No tests for `stableHash`. Coverage for the `Date`/`Map` collision should land before plugin authors hit it.

## scope-actions

The helper is an internal function in `one-shot.ts:169`, not a separate module. The walk: seed `keep` with scope names, **always** add every Emit action (so codegen-style cascades fire), then transitively expand `needs`. Capability suffixes (`cap:before`/`cap:after`) get stripped + warned about because resolution requires the full topo pass. Order preserved by re-filtering the original list.

**The "always include Emit" rule is the right call** for the stated UX (`apply --actions wallet.usdc` should still regenerate bindings). The capability-warning heuristic is honest — better to log than silently drop. **Silently dropping unknown names is debatable**: typo'd action names go unnoticed; a "no actions matched" warning would help.

`scope-actions.test.ts` mocks `Reconciler.cycle` and inspects the action list it received — sound approach. **Gaps**: no test for the capability-stripping warning path; no test for the interaction between `actionFilter` and `actionScope`. The walk doesn't propagate `dependsOnKind` — implicitly handled by "always include every Emit" rather than by graph reasoning. Works in practice; brittle if a future Emit cascade rule changes.

## Top recommendations

1. **Add `Date`/`Map`/`Set`/`RegExp` handlers to `stableHash`** + test fixtures asserting they don't collide.
2. **Add a JSON output mode to status-renderer** for CI consumers.
3. **Warn when `scopeActions` matches no names** (typo'd action) instead of silently producing an empty cycle.
4. **Add cycle detection to `stableHash`** — a self-referential input today stack-overflows.
