# `dapp-kit/` + `compose/` directory audit

**Status:** Read-only audit, design proposal. **Author:** dirs-audit subagent, 2026-05-19.
**Scope:** Two `packages/devstack/src/` subdirectories the user suspects shouldn't exist as separate
top-level subdirs:

- `packages/devstack/src/dapp-kit/` (27 + 44 = 71 LoC across 2 files)
- `packages/devstack/src/compose/` (41 + 280 = 321 LoC across 2 files, plus 103 LoC of tests)

**Net verdict up top:** `dapp-kit/` is a real wart — one 8-line public helper does not justify a
directory, a tsdown entry, AND a `package.json` subpath export. Fold it. `compose/` looks like a
wart but is actually a deliberate seam to break a `engine ↔ tui` import cycle; it CAN be flattened
but the win is marginal and the rename has to be carefully chosen. **Recommend: fold `dapp-kit/`,
leave `compose/` as-is OR rename + flatten to `src/devstack.ts` if you want one fewer dir.**

---

## 1. Findings per directory

### 1.1 `src/dapp-kit/`

**Files (2):**

| File                     | LoC | What                                                                                                                                                                                                             |
| ------------------------ | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/dapp-kit/index.ts`  | 27  | Barrel — re-exports `localnetWalrusOptions` and its `LocalnetWalrusOptions` type. Nothing else.                                                                                                                  |
| `src/dapp-kit/walrus.ts` | 44  | Single 8-line `localnetWalrusOptions({systemObjectId, stakingPoolId})` helper returning `{packageConfig: {systemObjectId, stakingPoolId}, storageNodeUrlScheme: 'http'}`. Plus its input/output interface types. |

**Exported under what subpath?**

- `package.json` declares `"./dapp-kit"` (lines 27-30) → `dist/dapp-kit/index.{mjs,d.mts}`.
- `tsdown.config.ts` lists `src/dapp-kit/index.ts` in the `fixtures` config entries (line 67) —
  separate config because rolldown-plugin-dts chokes on `@mysten/dapp-kit-react`'s transitive
  postcss types.

**Who imports `from '../dapp-kit/...'` inside `src/`?**

- **Zero.** No file inside `packages/devstack/src/` imports from `src/dapp-kit/` (only doc-comments
  in `vite/index.ts:85` and `services/codegen.ts:112` mention the public subpath name).

**Who imports the public subpath `@mysten-incubation/devstack/dapp-kit`?**

- **Exactly one consumer:** `examples/private-content/src/lib/walrus.ts:8`. Every other example app
  (`arena`, `deepbook-full`, `fork-greeting`, `token-studio`, `wallet`, `_template`, `effect-app`)
  imports the generated `devstackDappKitConfig` from `./generated/dapp-kit-config.js` instead — that
  name comes from the codegen emitter at `src/codegen/emitters/dapp-kit-config.ts`, NOT from this
  `dapp-kit/` subpath.

**Semantic role:** The dir's `index.ts` doc-comment (lines 1-26) is candid: there used to be a
runtime `createDevstackDappKit()` helper here; it was replaced by the codegen-time
`DappKitConfigEmitter`. Once that migration finished, the only thing left was
`localnetWalrusOptions` — a pure-function shim that hands a `WalrusClient` constructor two object
ids plus the literal `'http'`.

The doc explicitly notes that `Manifest` types and the kit constructor are NOT here. That tells you
the dir is vestigial: it used to be the runtime dapp-kit integration; now it's a single
walrus-options helper that happens to live behind a separate dts toolchain because of historical
postcss-types issues that no longer apply (no `@mysten/dapp-kit-*` is imported here).

**Build-time cost (real):**

- A whole second `tsdown` config (`fixtures`) entirely to emit this file's d.mts via a separate
  `tsc` step (`tsconfig.subpaths.json` + `scripts/finalize-subpath-dts.ts`). See
  `tsdown.config.ts:46-67`. The other entries in that second config (`vitest`, `playwright`, `vite`)
  genuinely need it because they import `@effect/vitest` / `@playwright/test` /
  `@mysten/dapp-kit-react`; `dapp-kit/` is the only entry whose source imports NOTHING from any peer
  dep yet still sits behind the subpath dts machinery.

**Bottom line:** dir is dead weight; one shim function and one type alias that don't even need the
postcss-workaround anymore.

### 1.2 `src/compose/`

**Files (3):**

| File                           | LoC | What                                                                                                                                                                                                                                                 |
| ------------------------------ | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/compose/devstack.ts`      | 280 | `devstack(...refs)` — the canonical entry. Variadic flatten, options-tail detection, auto-injects the manifest emitter ref, calls `fillDefaults`, instantiates the default renderer resolver (TUI + plain factories), delegates to `defineDevstack`. |
| `src/compose/defaults.ts`      | 41  | `fillDefaults(refs)` — adds `Sui()` and `Faucet({hidden: true})` to the stack when missing.                                                                                                                                                          |
| `src/compose/devstack.test.ts` | 103 | 7 smoke tests for variadic flatten, options detection, default-fill dedup.                                                                                                                                                                           |

**Exported under what subpath?**

- **None directly.** `package.json` has no `./compose` entry. `compose/devstack.ts` exports
  `devstack`, `DevstackComposeOptions`, `DevstackRefInput` and those reach the public API only via
  `src/index.ts:21-25` re-export.

**Who imports `from '../compose/...'`?**

- **Exactly one:** `src/index.ts:25`
  (`export { devstack, DevstackComposeOptions, DevstackRefInput } from './compose/devstack.js'`).
  Nothing in `engine/`, `runtime/`, `tui/`, `cli/`, `services/`, `advanced/`, `vitest/`,
  `playwright/`, or `vite/` imports from this dir. Doc-comments in `engine/supervisor.ts:236,243`
  and `engine/renderer.ts:20,81` mention "compose/devstack" as the wirer that ties the renderer
  abstraction to its TUI implementation.
- Inside the dir, `devstack.ts` imports `fillDefaults` from `./defaults.js`.

**Semantic role:** This dir is the **import-cycle break seam**:

- `engine/supervisor.ts` cannot import from `tui/` (the supervisor must not pull `ink` into headless
  callers).
- `tui/` imports heavily from `engine/` (`tui/plain.ts:28`, `tui/index.ts:21,315`,
  `tui/components.tsx:11,21`).
- So the renderer-factory abstraction `RendererResolver` is defined in `engine/renderer.ts` as an
  interface, and the concrete TUI/plain factories are constructed in `compose/devstack.ts`, which is
  allowed to import BOTH `engine/` and `tui/` because nothing else in the tree imports back into it.
  The supervisor accepts a resolver injected from outside its sub-tree.

`fillDefaults` lives here for the same reason: it auto-mounts `Sui()` + `Faucet()`, both of which
are in `services/`, and `services/` already imports from `engine/`. Putting `fillDefaults` in
`engine/` would force `engine/` to depend on `services/`, which would close several cycles. Putting
it in `services/` is plausible (`services/index.ts` could export it) but is awkward because it lives
at a strictly higher layer than the individual factories — it KNOWS about the set of "default
services," which is conceptually `compose/`-shaped, not service-shaped.

**Bottom line:** this dir IS load-bearing as a layer separator. It is misnamed — "compose" is
generic — but flattening it requires either picking a new home that doesn't reintroduce a cycle, or
moving the cycle to live inside a single file at the top level.

---

## 2. Proposed disposition

### 2.1 `dapp-kit/` — **delete + remove subpath export**

1. Move `localnetWalrusOptions` + `LocalnetWalrusOptions` into the root barrel (`src/index.ts`) OR
   into `src/services/walrus/index.ts` (the natural home — it's a walrus-client config helper).
   Recommend `src/services/walrus/options.ts` (new 30-line file) re-exported from `src/index.ts`.
2. Delete `src/dapp-kit/` entirely (both files).
3. Delete `"./dapp-kit"` from `package.json` exports.
4. Delete `'src/dapp-kit/index.ts'` from the `fixtures` entry in `tsdown.config.ts`.
5. Update `examples/private-content/src/lib/walrus.ts:8` from
   `import { localnetWalrusOptions } from '@mysten-incubation/devstack/dapp-kit'` to
   `import { localnetWalrusOptions } from '@mysten-incubation/devstack'`.
6. Update the two doc-comments that name the public subpath:
   - `src/vite/index.ts:85` — stale doc, references `createDevstackDappKit` which no longer exists;
     rewrite to mention the codegen emitter.
   - `src/dapp-kit/index.ts:16` doc text is being deleted with the file.

**Net LoC:** −71 (dapp-kit dir) + ~30 (new walrus/options.ts) = **−41 LoC**. Plus a `tsdown` entry,
a `package.json` export, and one example import line.

**Risk:** ONE downstream import line (`examples/private-content`). One published `package.json`
subpath export goes away — but the package is `0.0.0` and has never shipped (see `package.json:3`),
so this is a free breaking change.

### 2.2 `compose/` — **leave as-is (preferred) OR flatten to `src/devstack.ts`**

The dir is load-bearing as the engine/tui cycle break. Two options:

**Option A (recommended): leave it, rename ONLY if you really want.** The user's intuition is wrong
here. `compose/` exists because `engine/` cannot import `tui/`. The dir name is misleading but the
dir's existence is correct. Cost of doing nothing: 1 extra directory containing 3 files. If the
dir's PURPOSE was documented in a short `compose/README.md` (or a top-comment in `defaults.ts`) the
user wouldn't have flagged it.

**Option B: flatten by moving to top-level `src/`.** Move `compose/devstack.ts` → `src/devstack.ts`
and `compose/defaults.ts` → `src/devstack-defaults.ts` (or fold defaults INTO `src/devstack.ts` as a
private function — `fillDefaults` is 16 LoC). Update `src/index.ts:25` import to `./devstack.js`.

- Pro: kills one directory; co-locates the compose entry with the public barrel.
- Con: pollutes `src/` root with files that aren't barrel-shaped. Today `src/` has only `index.ts` +
  `index.test.ts` at the top level; the rest is subdirectories. Adding `devstack.ts` +
  `devstack-defaults.ts` adds two more non-barrel files.
- Cycle-break still holds: top-level files are free to import from both `engine/` and `tui/`.

**Net LoC for Option B:** ~0 LoC change (just file moves + 1 import-path edit). **Risk:** Zero.
Internal-only refactor; no external imports.

**Recommendation:** Option A. The dir name `compose/` IS specific enough (it's the variadic-compose
entry), and the cost is one directory. Bigger wins live elsewhere (see Opportunities below).

---

## 3. Migration steps

### 3.1 `dapp-kit/` deletion checklist

| #   | Action                                                                                                                                                     | File / line                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | Create `src/services/walrus/options.ts` with `localnetWalrusOptions` body                                                                                  | new file, ~30 LoC                       |
| 2   | Re-export from `src/services/walrus/index.ts` (the existing barrel)                                                                                        | 1-line `export ... from './options.js'` |
| 3   | Re-export from `src/index.ts` (root barrel) — same group as `Walrus`, line ~44                                                                             | 2 lines                                 |
| 4   | Update `examples/private-content/src/lib/walrus.ts:8` import                                                                                               | 1 line edit                             |
| 5   | Delete `src/dapp-kit/index.ts` + `src/dapp-kit/walrus.ts`                                                                                                  | rm                                      |
| 6   | Delete `"./dapp-kit"` block from `package.json:27-30`                                                                                                      | 4 lines removed                         |
| 7   | Remove `'src/dapp-kit/index.ts'` from `tsdown.config.ts:67` fixtures entry                                                                                 | 1 line removed                          |
| 8   | Verify `tsconfig.subpaths.json` doesn't reference dapp-kit (it's a glob, but check)                                                                        | 1 grep                                  |
| 9   | Rewrite stale doc-comment at `src/vite/index.ts:85-91` (mentions defunct `createDevstackDappKit`)                                                          | ~6 lines doc edit                       |
| 10  | `pnpm --filter @mysten-incubation/devstack build && pnpm --filter @mysten-incubation/devstack typecheck && pnpm --filter @mysten-incubation/devstack test` | CI                                      |
| 11  | `pnpm --filter @mysten-incubation/private-content typecheck`                                                                                               | example sanity                          |

### 3.2 `compose/` flatten checklist (only if Option B)

| #   | Action                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | `git mv src/compose/devstack.ts src/devstack.ts`                                                                           |
| 2   | `git mv src/compose/devstack.test.ts src/devstack.test.ts`                                                                 |
| 3   | `git mv src/compose/defaults.ts src/devstack-defaults.ts` (or inline into `devstack.ts`)                                   |
| 4   | In `src/devstack.ts`, change `import { fillDefaults } from './defaults.js'` → `'./devstack-defaults.js'`                   |
| 5   | In `src/index.ts:25`, change `from './compose/devstack.js'` → `from './devstack.js'`                                       |
| 6   | Update the four `engine/supervisor.ts` / `engine/renderer.ts` doc-comment references to "compose/devstack" → "devstack.ts" |
| 7   | `rmdir src/compose`                                                                                                        |
| 8   | `pnpm --filter @mysten-incubation/devstack build && pnpm --filter @mysten-incubation/devstack test`                        |

---

## 4. Risk / public API impact

### `dapp-kit/`

- **Public-API impact:** `@mysten-incubation/devstack/dapp-kit` subpath disappears. Any consumer
  importing from it must switch to the package root. Inside this repo: exactly one file
  (`examples/private-content/src/lib/walrus.ts`). Outside this repo: the package is `0.0.0` and
  unpublished, so no external blast radius.
- **Build-system impact:** one fewer tsdown entry; one fewer `package.json` exports key; one less
  d.mts subpath the `finalize-subpath-dts.ts` post-pass has to walk.
- **Migration cost:** 1 import-line edit in this repo.

### `compose/` (if flattened — Option B)

- **Public-API impact:** none. `compose/` was never a public subpath; only `src/index.ts` consumed
  it.
- **Internal-API impact:** doc-comments in `engine/supervisor.ts` and `engine/renderer.ts` reference
  "`compose/devstack.ts`" by path — those would need updating (cosmetic).
- **Cycle-break invariant:** preserved. The flattened file still lives outside both `engine/` and
  `tui/`.
- **Migration cost:** purely internal.

If `compose/` is left as-is (Option A — recommended): zero impact, zero migration cost. Add 4 lines
of doc to `compose/devstack.ts`'s top comment explaining "this dir exists to break the engine↔tui
cycle" so the next reader (and the user who flagged it) understands the load-bearing role.

---

## 5. Summary table

| Dir         | Verdict                                       | LoC Δ           | Imports to update        | Subpath export removed? |
| ----------- | --------------------------------------------- | --------------- | ------------------------ | ----------------------- |
| `dapp-kit/` | Delete, fold into `services/walrus/`          | −41             | 1 (private-content)      | Yes (`./dapp-kit`)      |
| `compose/`  | Leave (A) or flatten to `src/devstack.ts` (B) | 0               | 1 internal (root barrel) | No (was never public)   |
| **Both**    |                                               | **−41 LoC net** | **2 total**              | **1 subpath gone**      |
