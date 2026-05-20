# Consolidating top-level `*-image/` directories under `images/`

**Status:** proposal — READ-ONLY audit, no moves performed. **Author:** audit-bot, 2026-05-19.
**Scope:** `packages/devstack/`.

The five `<name>-image/` directories living at the package root each hold a Dockerfile +
entrypoint/scripts for one devstack service. They clutter the top-level listing, hide a packaging
bug (two are referenced from `src/` but missing from `tsdown.config.ts`'s copy list), and have
inconsistent relative-path depths across consumers. Folding them under a single `images/<service>/`
tree shrinks the package root from 5 image dirs to 1, makes the build-asset packaging rule trivially
uniform, and gives future services an obvious home.

---

## 1. Inventory

All five directories live at `packages/devstack/<name>-image/`. Each holds a Dockerfile (and usually
an `entrypoint.sh` / helper scripts). None are stale; none are empty; none are published packages.

| Dir               | Files (LOC)                                                                              | Role                                                                                                                                                                    | Consumer(s)                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seal-image/`     | `Dockerfile` (63), `entrypoint.sh` (50)                                                  | Fetches platform-specific `seal-cli` + `key-server` binaries from a Seal GitHub release; runs the local key server. No Rust compile.                                    | `src/services/seal/internal.ts:277` (only). Copied to `dist/seal-image/` by tsdown.                                                                                        |
| `sui-image/`      | `Dockerfile` (63), `entrypoint.sh` (188)                                                 | Pinned upstream Sui release (`SUI_VERSION` build arg), with `gawk` apt-pulled for `sui-cli.ts:303` and a `sui genesis`-first default entrypoint.                        | `src/services/sui.ts:758` (vendored-build branch). Copied to `dist/sui-image/`.                                                                                            |
| `walrus-image/`   | `upstream.Dockerfile` (77), `wrapper.Dockerfile` (53), `deploy.sh` (251), `run.sh` (106) | Two-stage: `upstream` is a cargo build of walrus binaries from a pinned `WALRUS_VERSION`; `wrapper` layers a matching `sui` binary + `deploy.sh` / `run.sh` on top.     | `src/services/walrus/local-cluster.ts:154` (upstream factory) and `src/services/walrus/image.ts:39,46` (wrapper build via `Docker.build`). Copied to `dist/walrus-image/`. |
| `postgres-image/` | `Dockerfile` (27)                                                                        | Vendored `postgres:<ver>` with `PGDATA` relocated to `/pgdata` so `docker commit` captures schema/rows (the upstream `VOLUME` declaration excludes the default PGDATA). | `src/services/postgres.ts:122` and `src/services/sui.ts:780` (sui-indexer-db). **Not in `tsdown.config.ts` copy list** → missing from `dist/`.                             |
| `sui-fork-image/` | `Dockerfile` (117), `entrypoint.sh` (73)                                                 | Builds a Sui fork binary from a pinned `SUI_REV` for mainnet-fork / testnet-fork / devnet-fork networks. Also used by tests via the testkit.                            | `src/services/sui.ts:1624` (vendored-build branch) and `src/engine/sui-fork.testkit.ts:70`. **Not in `tsdown.config.ts` copy list** → missing from `dist/`.                |

### Notable findings during the audit

- **Latent packaging bug.** `postgres-image/` and `sui-fork-image/` are referenced from compiled
  `dist/services/sui.mjs` via `new URL('../../postgres-image/', import.meta.url)` (verified — see
  `dist/services/sui.mjs:200,756`), but `tsdown.config.ts:32-41` only copies `seal-image/`,
  `sui-image/`, `walrus-image/`. Published consumers calling `Sui({version: …})` (vendored build) or
  `Postgres({…})` will hit ENOENT at `Docker.build` time. The consolidation **must** include both
  dirs in the new copy rule. (This is a pre-existing bug; the consolidation accidentally fixes it by
  switching to one glob-style copy.)
- **Depth asymmetry.** `walrus/local-cluster.ts` is one directory deeper than the other consumers,
  so its URL uses `../../../` while the others use `../../`. The new layout keeps both depths
  working because the target `images/<svc>/` lives at the same `packages/devstack/` depth as the
  originals.
- **No CI coupling.** `.github/workflows/devstack-e2e.yml` mentions "image" only in the abstract
  (cache, pulls); no path-coupled references to `*-image/`.
- **No package.json `files:` impact.** `files: ["dist", "src", "LICENSE"]` already excludes
  top-level `*-image/` dirs — only `dist/<svc>-image/` ships via tsdown's copy. The proposal
  preserves that exact shipping model.
- **Docs:** `notes/integration-contract-redesign.md:103,244` and
  `notes/sui-fork-phase-5-walrus-seal-audit.md:65` mention the dir names in prose. `AGENTS.md` does
  not couple to dir layout. Each source comment that names a path (`packages/devstack/seal-image/`,
  etc.) also needs a touch-up — there are ~16 of them, listed below.

---

## 2. Proposed layout

```
packages/devstack/
  images/
    seal/
      Dockerfile
      entrypoint.sh
    sui/
      Dockerfile
      entrypoint.sh
    sui-fork/
      Dockerfile
      entrypoint.sh
    walrus/
      upstream.Dockerfile
      wrapper.Dockerfile
      deploy.sh
      run.sh
    postgres/
      Dockerfile
```

- `seal-image/` → `images/seal/`
- `sui-image/` → `images/sui/`
- `walrus-image/` → `images/walrus/`
- `postgres-image/` → `images/postgres/`
- `sui-fork-image/` → `images/sui-fork/`

The `-image` suffix drops because the parent `images/` already conveys that. Each subdir's contents
are byte-identical to today.

`tsdown.config.ts` collapses from 8 copy entries to 1:

```ts
copy: [{ from: 'images', to: 'dist/images' }];
```

The path constants in source flip from `'../../sui-image/'` to `'../../images/sui/'` (and the walrus
call site from `'../../../walrus-image/'` to `'../../../images/walrus/'`). The depth stays the same
because `images/sui/` and `images/walrus/` are still one and two levels below `packages/devstack/`
respectively — identical to today.

---

## 3. Migration steps

### 3.1 `git mv` invocations (5)

```sh
git mv packages/devstack/seal-image      packages/devstack/images/seal
git mv packages/devstack/sui-image       packages/devstack/images/sui
git mv packages/devstack/walrus-image    packages/devstack/images/walrus
git mv packages/devstack/postgres-image  packages/devstack/images/postgres
git mv packages/devstack/sui-fork-image  packages/devstack/images/sui-fork
```

Total **file-move count: 11** (Dockerfiles + entrypoints + scripts):

- seal: 2 files
- sui: 2 files
- sui-fork: 2 files
- walrus: 4 files
- postgres: 1 file

### 3.2 Source code edits (the only load-bearing churn)

Seven `new URL(..., import.meta.url)` callsites need their path strings updated:

| File:line                                  | Current                    | New                         |
| ------------------------------------------ | -------------------------- | --------------------------- |
| `src/services/seal/internal.ts:277`        | `'../../seal-image/'`      | `'../../images/seal/'`      |
| `src/services/sui.ts:758`                  | `'../../sui-image/'`       | `'../../images/sui/'`       |
| `src/services/sui.ts:780`                  | `'../../postgres-image/'`  | `'../../images/postgres/'`  |
| `src/services/sui.ts:1624`                 | `'../../sui-fork-image/'`  | `'../../images/sui-fork/'`  |
| `src/services/postgres.ts:122`             | `'../../postgres-image/'`  | `'../../images/postgres/'`  |
| `src/services/walrus/local-cluster.ts:154` | `'../../../walrus-image/'` | `'../../../images/walrus/'` |
| `src/engine/sui-fork.testkit.ts:70`        | `'../../sui-fork-image/'`  | `'../../images/sui-fork/'`  |

### 3.3 Build / tooling

`tsdown.config.ts:32-41` — replace the 8 explicit per-file entries with a single dir copy:

```ts
copy: [{ from: 'images', to: 'dist/images' }];
```

(Confirmed `tsdown`'s `copy` accepts directory sources — currently used for individual files only; a
dir source will recursively copy. If verification shows otherwise, fall back to 5 entries:
`{from: 'images/seal', to: 'dist/images/seal'}`, etc. — still down from 8 to 5 and uniform.)

### 3.4 Doc / comment edits (non-breaking but worth a sweep)

Comments naming the old path. None are runtime-load-bearing:

- `src/engine/sui-cli.ts:39,243,303` — comments mentioning `sui-image/`
- `src/engine/sui-build-container.ts:203,522` — same
- `src/services/sui.ts:83,106,124,581,583,591,641,642,748,774,1621,1943` — JSDoc/comments
- `src/services/postgres.ts:5,19,118` — comments
- `src/services/seal/internal.ts:189,268,409` — comments
- `src/services/deepbook/vendor.ts:32` — comment
- `notes/integration-contract-redesign.md:103,244` — example container-name strings (these refer to
  container-name patterns like `<app>-<stack>-seal-image`, not path; _do not change_)
- `notes/sui-fork-phase-5-walrus-seal-audit.md:65` — explicit path reference, should update

A single global rename of `<svc>-image/` → `images/<svc>/` in `src/**/*.ts` and
`notes/sui-fork-phase-5-walrus-seal-audit.md` covers all of it. Do not rename in
`notes/integration-contract-redesign.md` — the `seal-image` there is a container-name suffix, not a
path.

### 3.5 No-op surfaces (confirmed unchanged)

- `package.json` — `files: ["dist", "src", "LICENSE"]` already excludes top-level image dirs and
  includes `dist/`. No change.
- `.github/workflows/*.yml` — no path-coupled refs. No change.
- `scripts/finalize-subpath-dts.ts` — no image refs. No change.
- `tsconfig.json` / `tsconfig.subpaths.json` — no image refs. No change.
- `.devstack/` state — no image refs. No change.
- `AGENTS.md` — no path-coupled refs (only `dockerImage` API mention). No change.

---

## 4. Risk

- **`tsdown` directory-copy semantics.** The current config copies individual files (e.g.
  `seal-image/Dockerfile` → `dist/seal-image/`). If tsdown's `copy:` doesn't accept a directory
  source, the consolidation regresses to 5 entries instead of 1. Either way it shrinks (8 → 1 or 8 →
  5).
- **Bind-mount paths inside Dockerfiles.** None of the Dockerfiles reference their own directory by
  name (verified via `grep -n "FROM\|COPY\|ARG"` on each — all `COPY` sources are relative to the
  build context, not absolute paths). Renaming the dir does not affect the build context's internal
  view.
- **Wrapper Dockerfile in walrus.** `walrus-image/wrapper.Dockerfile` is built via `Docker.build`
  with `context` flowing from the same `dockerContext` URL as the upstream. Both target the _same_
  directory — one config swap (`local-cluster.ts:154`) updates both.
- **Latent-bug fix coupling.** Adding `postgres-image/` and `sui-fork-image/` to the `dist/` copy is
  a real behavior change for any published consumer that previously hit the missing-dir ENOENT. This
  is desirable but should be called out in the PR description so reviewers know the new dist tarball
  will be slightly larger and that `Sui({version: …})` + `Postgres({...})` start working in
  published use.
- **Stale CI / docker cache keys.** None observed — image tags are content-addressed off the
  Dockerfile + entrypoint bytes, not the source path. The first build after the move is a clean
  rebuild (different content hash if `dockerContext` is part of the hash input). A quick check of
  `engine/content-hash.ts` is worth doing before merge: if `context` strings feed into the tag hash,
  expect one-time cache misses on the next `up` everywhere.

---

## Summary

- **5 dir moves**, **11 files relocated**, **7 source-string edits**, **1 tsdown config
  simplification** (8 entries → 1 dir copy), ~**16 comment/doc touch-ups** (cosmetic).
- Side-effect: fixes a latent packaging bug where `postgres-image/` and `sui-fork-image/` were
  referenced from `dist/` but never copied.
- No CI, no `package.json`, no tsconfig, no scripts impact.
