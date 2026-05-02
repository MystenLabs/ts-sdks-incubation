# `accounts` + `active-stack` + `file-watcher`

**Verdict**: A− — Three of the cleanest extractions in the codebase. Strongest evidence of "extract from journal entries" as a design methodology working. Two missing test files.

## Architecture

**`accounts.ts`** is the cleanest of the three. The four-step resolution (per-network slot → `default` → implicit `generatedKeypair` on localnet → captured-error) is correctly factored — `materialize()` only handles slot dispatch, `pickSlot()` only normalizes spec shape, `invokeSlot()` only fires factories. The captured-error pattern (`errors.set(name, ...)`) is the load-bearing detail: a misconfigured testnet `cliSigner` cannot poison `ctx.accounts.get('alice')` for a sibling localnet account, which keeps `up` running on a hand-edited config. `names()` returning declared keys (not just successfully-resolved) is also right — it lets `sui.accounts` iterate-then-`get`-then-`try/catch` rather than guessing what was declared.

The async-factory rejection (lines 53-67) is honest — the resolver is sync-only, KMS/Ledger factories that need `await` would need a separate lazy path. Worth noting: the `accountSpec instanceof Signer` branch in `pickSlot` is structurally fragile because `Signer` is an abstract class from `@mysten/sui`; if a downstream factory returns a duck-typed signer the bare-Signer fast path will silently fall through.

**`active-stack.ts`** is 50 lines and does exactly one thing: a CLI-flag → env-var → pointer-file → `'main'` precedence chain over a single text file. The "never auto-create on read" rule is a deliberately small contract — `up` doesn't write the pointer until the user runs `stack new`/`use`, which keeps `git status` clean on a fresh checkout. The supervisor breaks this contract slightly at line 97 (`if (!fsExistsSync(activeStackFile)) writeActiveStack(...)`) so out-of-band consumers (Vite `.devstack/active` watcher) can resolve a stack — that's a reasonable trade but the asymmetry deserves a comment.

**`file-watcher.ts`** infers watch paths from action shape (Publish: `Move.toml` + `sources/`; Build: dockerfile + context) and unions with `action.watches`. The `existsSync` filter at line 96 is correctly load-bearing — without it, imported packages with `path: '<imported>'` placeholder would arm chokidar on a non-existent path, leaking memory. The 150ms debounce + per-action `pending` set is appropriate for editor save patterns. The `armed` gate lets the constructor pre-arm watchers but defer firing until after the first `runCycle` — important so the initial reconcile isn't fighting its own filesystem writes.

## Problem fit

`publisher`/`alice`/`bob` is the right convention, mostly because the journal documents it being arrived at via observation, not design. All four examples declare it the same way and the sui plugin's `role === 'publisher'` annotation lets the UI label the address. The downside is implicit — a misspelling like `Publisher` silently produces a non-publisher account, and there's no schema check.

Stack switching via `.devstack/active` is genuinely good: file-system pointer is portable across processes (CLI, Vite, vitest, e2e), survives crashes, and `TEST_STACK = 'test'` prevents e2e from trampling `main`.

## Integration

The wiring is clean and one-directional: `Supervisor` constructs `accounts` and `watcher` once, `Reconciler.cycle` receives `accounts` per cycle, every action's `ctx.accounts.<name>` pulls through. `wallet-server` reads `ctx.accounts.names()` server-side and signs over HTTP — keys never leave Node. The file-watcher's `onStale` calls `reconciler.resetAction(name)` then `runCycle()`; `cycleInFlight`/`cyclePending` coalesces bursts. **Bug-prone gap:** a mid-cycle file event during a long Publish has no effect — the action's state stays `running` and the watcher's `pending` set fires only after the cycle ends. Acceptable, but undocumented.

## Customizability + gaps

- Custom signer types beyond keypair: passkey/hardware/KMS need an async path the resolver explicitly rejects. The async-factory `Error` text suggests "wrap in a sync closure" which doesn't work for any factory that actually needs async.
- Env-var overrides: `envSigner({ name })` exists in `helpers/signers.ts` but there's no top-level `DEVSTACK_<ACCOUNT>_KEY` shortcut.
- Watch path overrides: `action.watches` exists and resolves against `appDir`, but no example uses it. GraphQL schemas / generated SDLs will need it.
- No way to opt out of the implicit `generatedKeypair` on localnet (e.g., to force `cliSigner` only).

## Testing

`accounts.test.ts` is thorough — 12 cases covering empty input, implicit generation, persistence, fall-through, all four spec shapes, factory invocation, captured errors, async rejection, and lookup error messages. Uses real `mkdtempSync` + `Ed25519Keypair`, no mocks. The bar to match.

**`active-stack.test.ts` and `file-watcher.test.ts` do not exist.** Both are small, deterministic, and pure-function-ish — `resolveStack`'s precedence chain alone is 4 cases and uncovered. The file-watcher's `watchPathsFor` union and `existsSync` filter is the kind of thing a refactor will silently break. These are the most obvious testing gaps in the runtime.

## Top recommendations

1. **Add `active-stack.test.ts` and `file-watcher.test.ts`** with the precedence chain and watchPathsFor cases.
2. **Add an async-factory path** to support KMS/passkey/hardware signers.
3. **Document the mid-cycle file event behavior** (events during a long Publish only fire post-cycle).
4. **Add a `DEVSTACK_<ACCOUNT>_KEY` env-var shortcut** for one-line account override.
