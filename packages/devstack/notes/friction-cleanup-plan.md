# Friction cleanup + docs refresh

Closing out the two friction-journal items still open after PRs 13–15
(deepbook plugin) and pulling forward the docs that drifted along the
way.

## What's open

### A. Playwright `baseURL` is hardcoded — e2e times out on port-allocator fallback

`packages/devstack/src/playwright/defineConfig.ts:46-47` hardcodes
`baseURL = http://localhost:${port}`. With the per-stack port
allocator, a dev who has `devstack watch` on `main` holding 5173
forces `pnpm test:e2e` (stack `test`) onto a kernel-allocated port
(e.g. 51202). Playwright polls 5173, waits 5 minutes, fails. Reproduced
during state-and-snapshots verification; documented in
`notes/friction.md:127-152`.

### B. Reconciler runs same-signer transactions in parallel — gas-object equivocation

The scheduler (`runtime/reconcile.ts:119-179`) goes up to
`maxConcurrency: 4` and only orders by `needs:`. Two `publishMove({
needs: ['sui.accounts'] })` actions both default to the `publisher`
account, sign concurrent txs that touch the publisher's gas object,
and Sui's validator-equivocation guard rejects the second one.
Reproduced during the deepbook migration (`notes/friction.md:154-173`)
and worked around in `examples/wallet/devstack.config.ts` with two
explicit `needs: ['usdc']` / `needs: [..., 'deepbook.pools']` edges.

### C. Stale docs from the deepbook + register-split + frontend rename

Three classes of staleness that accumulated:

1. **Working-tree drift, never committed.**
   `packages/docs/content/dev-wallet/guides/devstack-integration.mdx`
   — the diff from this branch updates `vite()` → `frontend()` and
   `createDevstackDappKit` → `createDAppKit({ ...localnetDappKitConfig
   (manifest) })` in the dev-wallet integration guide. Sat unstaged
   across the deepbook PRs.

2. **Old API name in the example map.** `examples/README.md:47` still
   refers to `createDevstackDappKit` even though every example app's
   `src/dapp-kit.ts` now uses `localnetDappKitConfig`.

3. **Filename ↔ symbol mismatch.**
   `packages/docs/content/devstack/plugins/vite.mdx` describes the
   `frontend()` plugin (its title is already "frontend"), but the
   filename + URL (`/docs/plugins/vite`) is the old `vite()` symbol.
   Three other docs link to `/docs/plugins/vite` so the rename has
   to happen as a single coordinated change.

## Approach

Three PRs, ordered by user-visible impact. PRs land independently — A
and B are surgical runtime changes; C is doc-only.

| PR  | Scope                                                        | Lines |
| --- | ------------------------------------------------------------ | ----- |
| 16  | Playwright baseURL reads the allocator-resolved port         | ~120  |
| 17  | Reconciler serializes same-signer txs                        | ~150  |
| 18  | Docs refresh: dev-wallet + examples + filename rename        | ~80   |

---

## PR 16 — Playwright `baseURL` reads the allocator-resolved port

**Goal**: tests survive the case where the preferred frontend port is
held by a sibling stack, without the user having to clean up containers
or compose stack-specific configs by hand.

### Mechanism

`defineDevstackPlaywrightConfig` already runs at config-eval time (it
allocates the port async via `port-allocator`). Extend it to also
resolve `baseURL` from the same allocator. Two paths:

1. **Allocator path (preferred)** — `defineDevstackPlaywrightConfig`
   calls `allocator.allocate({ slot: 'frontend.dev-server', preferred:
   <user option> })` directly at config-eval. The allocator returns
   the actually-bound port; `baseURL` becomes `http://localhost:${port}`.
   Same plumbing the frontend plugin uses, so the supervisor picks up
   the same value when it instantiates the `frontend()` plugin (the
   slot key is the cache key).

2. **Manifest-poll path (fallback)** — if the allocator hasn't run
   (cold first run with no `.devstack/ports.json`), Playwright's
   `webServer` polls the manifest at `<stackDir>/manifest.json` for
   the `frontend.dev-server` service entry, then polls that URL.

The allocator path covers everything except first-run-from-scratch;
the fallback covers that. Both end at `baseURL = http://localhost:${
actually-bound-port}`.

### Files

- **MODIFY** `packages/devstack/src/playwright/defineConfig.ts` —
  swap the hardcoded `port` for an allocator call gated on stack
  name; resolve `baseURL` from the result.
- **MODIFY** `packages/devstack/src/playwright/defineConfig.test.ts` —
  add cases for sibling-stack-holds-preferred and cold-first-run.
- **MODIFY** `packages/docs/content/devstack/adapters/playwright.mdx`
  — note the auto-resolution; remove any "make sure ports don't
  collide" caveat.
- **CLOSE** the friction entry in `notes/friction.md:127-152` with a
  `[CLOSED — PR 16]` marker + reference.

### Verification

- Standing up `devstack watch` on `main` (frontend on 5173); running
  `pnpm test:e2e` on `test` in another terminal — playwright resolves
  to a non-5173 port, navigates successfully, all 7 wallet e2e tests
  pass within the usual <40 s wall time.
- Cold first-run on a fresh-clone test stack — manifest-poll path
  kicks in; same outcome.
- Existing single-stack flow unchanged (port stays 5173 when nothing
  else holds it).

---

## PR 17 — Reconciler serializes same-signer txs

**Goal**: `publishMove({ name: 'usdc' })` + `publishMove({ name:
'weth' })` running in parallel without explicit `needs:` between them
should not equivocate. Apps stop having to thread artificial
dependencies through the action graph.

### Mechanism

Add an optional `runsAs?: string` field to action surfaces that sign
transactions (Publish, Seed, Register where relevant). The scheduler
treats it as a soft constraint: at most one inflight action per
distinct `runsAs` value. Actions without `runsAs` are unaffected.

```ts
// runtime/reconcile.ts (within isReadyToRun)
if (a.runsAs !== undefined) {
    for (const name of inflight) {
        const other = sorted.find((x) => x.name === name);
        if (other?.runsAs === a.runsAs) return false;
    }
}
```

The constraint composes with the existing `needs:` graph — a same-
signer pair without a `needs:` edge serializes by signer; with a
`needs:` edge, the topo dependency dominates. No deadlock risk: the
constraint is "at most one inflight per signer", not "must precede".

### Plumbing

- `definePublishAction` already has `publisher` on its options; thread
  it onto the action as `runsAs`.
- `seed()` accepts an optional `signer?: string` already (see
  `actions/transaction.ts`'s `runTransaction` wrapper); drop it onto
  the action when present.
- `register()` actions don't typically sign; leave alone.
- `containerService` / `service` / `hostProcess` / `build` — never
  signers, no change.

For seeds whose `run:` callback signs but doesn't expose a signer to
the factory (the wallet's `seedTokens` block uses `ctx.accounts.get
('publisher')` inside `run`), authors can opt in via an explicit
`runsAs: 'publisher'` on the `seed()` call. The framework can't infer
it.

### Files

- **MODIFY** `packages/devstack/src/core/types.ts` — `runsAs?: string`
  on `ActionBase`.
- **MODIFY** `packages/devstack/src/runtime/reconcile.ts` — add the
  same-signer guard to `isReadyToRun`.
- **MODIFY** `packages/devstack/src/runtime/reconcile.test.ts` — case
  for two same-signer actions running in parallel without `needs:`.
- **MODIFY** `packages/devstack/src/actions/publish.ts` — surface
  `publisher` as `runsAs` on the emitted action.
- **MODIFY** `packages/devstack/src/actions/seed.ts` — accept
  `runsAs?` and pass through.
- **MODIFY** `packages/devstack/src/actions/transaction.ts` —
  `runTransaction` already takes `signer:`; mirror it onto `runsAs`.
- **MODIFY** `examples/wallet/devstack.config.ts` — drop the manual
  `needs: ['usdc']` from `weth` and `needs: [..., 'deepbook.pools']`
  from `seedTokens`. Add `runsAs: 'publisher'` to `seedTokens`.
  Re-verify with cold + warm `devstack apply`.
- **MODIFY** `packages/devstack/CLAUDE.md` — note the new field in
  the "Setup design — the action graph IS the lifecycle" section.
- **MODIFY** `packages/docs/content/devstack/concepts/actions.mdx`
  — short paragraph: "When two actions share a signer, the
  reconciler runs them sequentially even without an explicit `needs:`
  edge."
- **CLOSE** the friction entry in `notes/friction.md:154-173` with a
  `[CLOSED — PR 17]` marker.

### Verification

- New unit test: two `publishMove`-shaped actions with the same
  `runsAs`, no `needs:` between them — assert one finishes before
  the other starts (sequential settlement order via the progress
  callback).
- Wallet cold apply with the workaround edges removed — passes
  end-to-end (the same e2e suite from PR 14, all 7 tests).
- Confirm two actions with *different* `runsAs` still parallelize
  (the test should fail if the implementation is too aggressive).

---

## PR 18 — Docs refresh

**Goal**: the docs published from `main` reflect the post-deepbook +
post-register-split + post-`frontend()`-rename API. No stale symbol
names anywhere.

### Mechanism

Three coordinated patches.

#### 18a. Commit the pending `dev-wallet/guides/devstack-integration.mdx`

The diff is already in the working tree (`vite()` → `frontend()`,
`createDevstackDappKit` → `createDAppKit({ ...localnetDappKitConfig
(manifest) })`). Verify against `examples/wallet/src/dapp-kit.ts` so
the snippet matches what an app actually does, then commit.

#### 18b. Fix `examples/README.md`

`examples/README.md:47` still mentions `createDevstackDappKit + dev-
wallet initializer`. Replace with the current shape:
`localnetDappKitConfig + dev-wallet initializer`. One-line change;
verify by grepping the file for any other old symbol names while
we're here.

#### 18c. Rename `plugins/vite.mdx` → `plugins/frontend.mdx`

The plugin function is `frontend()`; the filename should match. Three
coordinated edits:

1. `git mv packages/docs/content/devstack/plugins/vite.mdx packages/
   docs/content/devstack/plugins/frontend.mdx`.
2. `packages/docs/content/devstack/meta.json:25` — change
   `"plugins/vite"` → `"plugins/frontend"`.
3. Repoint the two link references found in the audit:
   - `packages/docs/content/devstack/index.mdx:45`
     (`/docs/plugins/vite` → `/docs/plugins/frontend`)
   - `packages/docs/content/devstack/getting-started.mdx:68`
     (same).

The built `packages/docs/dist/` tree gets regenerated on next docs
build; nothing to hand-edit there.

### Files

- **COMMIT** `packages/docs/content/dev-wallet/guides/devstack-
  integration.mdx` (already-staged tree changes).
- **MODIFY** `examples/README.md` — symbol-name refresh.
- **RENAME** `packages/docs/content/devstack/plugins/vite.mdx` →
  `frontend.mdx`.
- **MODIFY** `packages/docs/content/devstack/meta.json` — nav entry.
- **MODIFY** `packages/docs/content/devstack/index.mdx`,
  `getting-started.mdx` — link targets.

### Verification

- `pnpm --filter @mysten-incubation/docs build` succeeds; no broken
  links.
- `grep -rn "createDevstackDappKit\|plugins/vite" packages/docs/
  content examples/` returns zero matches (after exclusions for the
  built `dist/` tree, which regenerates).
- Side-by-side: dev-wallet integration guide's `dapp-kit.ts` snippet
  matches the actual content of `examples/wallet/src/dapp-kit.ts`.

---

## Out of scope

Items from `notes/architecture-review-followups.md` left for an
explicit consumer:

- New docs pages: `plugin-authoring.mdx`, `troubleshooting.mdx`. The
  followup file lists both. Not friction; deferring until someone
  hits a real "how do I do X" gap.
- Code-fence regex check in `validate-llm-docs.ts`. Pure tooling;
  bundle with whichever docs PR next surfaces a truncated block.
- `globalThis.__devstackDAppKit__` removal. Major-bump churn;
  unrelated to friction.
- Codegen MVR-pattern validation upstream in `@mysten/codegen`.
  Cross-repo; tracked separately.

## Architectural notes for future plans

- **Friction journal as the input.** Both PRs 16 and 17 trace cleanly
  to specific entries with file paths. CLAUDE.md's "extract from
  evidence, not anticipation" — the deepbook PR was the second
  reproduction of the same-signer race, which is the trigger.
- **Same-signer serialization vs. graph deps.** The right place to
  encode "same publisher signs these in order" is the runtime, not
  the user-facing graph. Apps shouldn't have to mention `publisher`
  in `needs:` to keep their txs from equivocating.
- **Doc-rename triggers a small audit.** Rename `vite.mdx` →
  `frontend.mdx` is two coordinated changes, but the grep for
  remaining stale references is the actual value — same shape as
  the codegen-doc cleanup that closed earlier doc-naming drift.
