# Docs + design journal

**Verdict**: B − Three-layer architecture is sound. `principles.md` is the strongest doc in the repo. Real drift between code and walrus/react comments. The friction journal has become archive material; the live design log is `api-refactor.md` but the docs structure doesn't reflect this.

## Architecture: three layers, mostly clean

The intended split is sound:

- **AI/contributor norms** in `packages/devstack/CLAUDE.md` and `AGENTS.md` — short, opinionated, evergreen.
- **Human-facing reference docs** in `packages/devstack/docs/` (durable principles + stacks reference) and the published Fumadocs site under `packages/docs/content/devstack/` (with build output mirrored to `packages/docs/dist/devstack/`).
- **Design history** in `packages/devstack/notes/`.

The drift is at the boundaries. `principles.md` is the strongest doc in the repo — it correctly claims the right to outlive everything. `devstack-design.md` opens with a candid "this document is historical" banner, but the file name reads as a current architecture doc; a contributor scanning the directory listing won't see the banner. The CLAUDE.md says "phase 1 / phase 2" extract-from-friction, but the v3 refactor (api-refactor.md) explicitly admits the team designed up-front for the second time.

## Problem fit & contributor onramp

A new contributor has a workable but redundant path: `README.md` (root) → `packages/devstack/README.md` (currently the most accurate, code-aligned doc) → docs site. **Three of the four READMEs say roughly the same things in different order, and the most up-to-date Quickstart lives in `packages/devstack/README.md` while the docs site's `getting-started.md` lags.**

Docs site `getting-started.md` lines 26-35 also have a broken code block — the `import` line is missing entirely. `accounts.md` has the same defect. The `wallet-server.md` has a similar truncation. **This is a build-pipeline regression**, not a content problem — `validate-llm-docs.ts` only checks frontmatter and meta.json membership, not whether code fences round-trip.

The friction journal has become a graveyard. The latest entry is dated 2026-04-30, marked "Closed by v2." The journal's framing as "Phase 2 input" no longer matches reality: the last 60% of the file is a v2 post-mortem and the final two entries explicitly ship features the user requested (per-app stacks) that "predate Phase 2 extraction discipline." The new live design log is `notes/api-refactor.md`, which contains a decisions log + dated session log and runs through 2026-05-01. **`friction.md` is now archive material; `api-refactor.md` is the live journal; the docs structure does not reflect this.**

## Code-vs-docs integration: real lies in the source

The user's specific examples are confirmed and join a small cluster:

- **`react/walrus.ts:43-47`** documents `wasmUrl` as auto-resolved by `virtual:devstack-walrus-wasm-url` from `devstackVitePlugins()`. That virtual module does not exist anywhere in the codebase. `vite/plugin.ts` synthesizes only `virtual:devstack-manifest`; the comment is fiction.
- **`plugins/walrus/index.ts:106-109`** says "the `_walrus/node-<idx>` proxy installed by `devstackVitePlugins()`." Wrong layer entirely — the proxy is an nginx Docker sidecar (lines 290-373 of the same file). The Vite plugin installs no proxy.
- **`createDevstackWalrusClient`** is exported from `react/index.ts:25` but appears in zero docs site pages. Public API, undocumented.
- The `devstack-design.md` file warns it's historical, but the surrounding `docs/` directory (`stacks.md`, `principles.md`) is treated as current. A reader has to see the banner to know which is which.
- The "v3 refactor closed" map in `friction.md:18-46` is the closest thing to a release-notes-style mapping and works well, but it doesn't appear in user-facing docs.

The package README.md (the most current doc) mentions `useDevstackPackage`, `useDevstackPackageOptional`, `useDevstackSignAndExecute`, `DevstackDebugPanel`, `createDevstackDappKit` — but not `useDevstackDeployed`, `bindPackage`, or `createDevstackWalrusClient`. **Three publicly exported react hooks/utilities are README-invisible.**

## Customizability + gaps

What's missing for a third-party plugin author or migrating app:

- **No "write your own plugin" walkthrough.** `define-plugin.md` shows a 30-line example and refers out to `concepts/plugins.md`; neither covers a complete from-scratch flow.
- **No migration recipe.** `defineDevstackConfig` API has shifted twice (v1→v2, v2→v3 per `api-refactor.md`); apps in `examples/` are the only migration reference.
- **No troubleshooting page.** "How do I fix `getStatus` cold-cycle"? "Why didn't my Emit re-fire?" "What does `before:` silently dropping look like?" These are real failure modes from the journal that never made it to docs.
- **No recipe-style index** ("I want to add a custom signer / a custom indexer / a Pyth oracle plugin").
- **`packages/devstack/docs/stacks.md`** is excellent reference but is not linked from the docs site — only `concepts/stacks.md` (a thinner version) appears there.

## Testing the docs

`packages/docs/scripts/validate-llm-docs.ts` checks frontmatter + meta.json membership only. There's no link checking, no dead-code-snippet detection, no tsc-check on inline `ts` blocks. The README's `pnpm dev` walk would benefit from a CI smoke check. The build pipeline silently strips MDX content (the broken code blocks above) — adding a regex to fail on `^\s*$` immediately after `\`\`\`ts` would catch both observed regressions.

## Most useful vs. most aspirational

**Most useful, in this order:** `principles.md` (durable, evergreen, well-edited); `packages/devstack/README.md` (matches code as of 2026-05-01); `notes/api-refactor.md` (live decisions log); the `dist/devstack/` API reference pages.

**Aspirational or stale:** `friction.md` framing as "input to Phase 2" (now archive); `devstack-design.md` (banner-tagged historical); CLAUDE.md's "design from evidence" line (the v3 refactor was a designed up-front exception that's gone unmentioned); the walrus comments in `react/walrus.ts` and `plugins/walrus/index.ts` (referencing infrastructure that doesn't exist).

## Top recommendations

1. **Strip or rewrite the `virtual:devstack-walrus-wasm-url` and `_walrus` Vite-proxy comments**; document the actual nginx sidecar.
2. **Document `createDevstackWalrusClient`, `useDevstackDeployed`, and `bindPackage`** on the docs site.
3. **Fix the docs-build code-fence corruption** in `getting-started.md`, `accounts.md`, `wallet-server.md`, `react.md`, `vite.md`, `imports.md`. Add a `^```ts\n\s*$` regex check to `validate-llm-docs.ts`.
4. **Reframe `friction.md` as `notes/archive/phase1-friction.md`** and elevate `api-refactor.md` to the canonical journal. Update CLAUDE.md to say "design when evidence converges; capture the design decision in `notes/`."
5. **Add a "write a plugin from scratch" recipe** and a troubleshooting page.
