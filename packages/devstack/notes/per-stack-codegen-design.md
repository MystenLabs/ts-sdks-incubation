# Per-stack codegen output + import alias (design)

Status: **proposed** (not yet implemented). Enables `pnpm dev` and `pnpm test:e2e`
(and any number of named stacks) to run **concurrently** for the same app
without their Move codegen clobbering each other.

## Problem

Two stacks of the same app run codegen into the **same** `src/generated/`
output dir. Different stacks have different chains → different package IDs and
wallet pair tokens → the second stack's `codegen.emitted` **overwrites** the
first's files, breaking the already-running app. Verified empirically: booting
`token-studio` (default) and `--stack e2e` concurrently, both emitted
`codegen.emitted files=11` into `src/generated/`.

This is the last coexistence blocker. The supervisor-lock collision (exit 40)
is already solved by the stack-name precedence fix (explicit `--stack` /
`$DEVSTACK_STACK` > `config.stackName` > inference); this doc only addresses
the **codegen output location** + how the app resolves it per stack.

## Relevant current code

- `orchestrators/runtime-composition.ts:152-155` `productionCodegenOutputDir` —
  resolves `outputDir ?? 'src/generated'` against `appRoot`. **Stack-blind:**
  the stack name is never passed in.
- `orchestrators/codegen/paths.ts:55-58, 122-124` — `CodegenRoot.stackSubdir`
  exists and would nest output per stack, but **every caller passes `null`**
  (`runtime-composition.ts:203`, `cli/wirings/build-verb-layers.ts:32`,
  `api/run-stack.ts:250`). This is effectively dead code today — it's exactly
  the seam this design activates.
- `cli/wirings/identity.ts:26-55` — the precedence fix threads `explicitStack`
  (the `--stack`/env value, `undefined` when neither given). This is the signal
  that distinguishes the **home** stack from an **override**.
- Apps import generated code via **static relative** specifiers, e.g.
  `examples/token-studio/src/dapp-kit.ts` → `./generated/accounts.js`,
  `./generated/dapp-kit/config.js`, `./generated/sui/network.js`. No alias today.
- `src/generated/` is fully gitignored (codegen emits a `*` `.gitignore`); apps'
  `tsconfig.app.json` already `exclude` `.devstack`. Relocation is clean.
- Host-service launches the example's **own Vite** as a child inheriting the
  supervisor env, and `cli/main.ts:342-347` injects `DEVSTACK_STACK=<stack>`.
  Playwright's `webServer` runs `pnpm dev` and also sets `DEVSTACK_STACK`
  (`build-integrations/playwright/config.ts:212-216`). So **`DEVSTACK_STACK`
  reliably reaches the Vite process in both dev and e2e** — the key seam.

> Note: "main/home stack" is **not** the literal `'main'`. Each example declares
> its own `stackName` (e.g. `defineDevstack({ stackName: 'token-studio' })`).
> Home = "the run whose effective stack equals the config's `stackName`", i.e.
> no explicit `--stack`/env override — exactly `identity.explicitStack === undefined`.

## Design

### 1. Output-location rule (default; explicit config still wins)

- **Home stack** (`effectiveStack === config.stackName`, no override) →
  `<appRoot>/src/generated/` — canonical, unchanged, committed-ignored.
- **Non-home stack** (e.g. `test`/`e2e`/`demo`) →
  `<appRoot>/.devstack/stacks/<stack>/generated/`.

App-local `.devstack/` (not the engine `~/.devstack` state root) keeps codegen
in the user's source tree (per the `paths.ts:8-10` invariant) and mirrors the
manifest layout `stacks/<stack>/manifest.json`, so a stack's generated code is a
sibling of its manifest. Already gitignored + tsconfig-excluded.

**The resolved output dir is recorded in the stack's manifest** (a `codegen.generatedDir`
field) so the reader (§2) consults the *same* location the writer chose — read and
write are gated by one decision, not two. The write decision (`effectiveStack ===
config.stackName`) is made once, at the boot seam where both names are known, and
persisted; the reader never recomputes it.

This is the **default**, keyed on home-vs-override (free from `explicitStack`),
**not** an opt-in flag — the failure mode of an opt-in (forgetting it) is the
exact silent-clobber bug we're fixing. An app that sets `codegen.outputDir` or
`codegen.stackSubdir` explicitly keeps that behavior (escape hatch).

### 2. Import mapping via a customizable alias

App source imports generated code through a **configurable alias prefix**
(default **`@generated`**) instead of `./generated`. A new devstack Vite plugin
points that alias at the **active stack's** output dir, keyed on
`$DEVSTACK_STACK`:

- New build integration `build-integrations/vite/` exporting
  `devstackVitePlugin({ alias?, generatedDir? })`, new package export
  `@mysten-incubation/devstack/vite`.
- The plugin's `alias` option **defaults to `@generated`** but is **customizable**
  per app (some apps may prefer `@gen`, `~generated`, etc.). The app must use the
  same prefix in three places (all derivable from one chosen string):
  the plugin option, the `tsconfig` `paths` entry, and its import specifiers.
- At config-resolve, the plugin computes the active stack's dir and sets
  `resolve.alias[<prefix>] = <that dir>`:
  - `resolveDiscoveryEnv(process.env)` (`runtime/resolve-discovery-env.ts`) →
    `{ stack, stateDir }` (single source of truth; honors `DEVSTACK_STACK` and
    `DEVSTACK_RUNTIME_ROOT`/`DEVSTACK_STATE_DIR`).
  - **Target resolution — manifest-recorded (single source of truth):** the
    plugin finds the current stack's manifest at `<stateDir>/stacks/<stack>/manifest.json`
    (via `resolveDiscoveryEnv` + `discoverManifestPath`, the same machinery the
    runtime/playwright integrations already use) and reads the recorded
    `codegen.generatedDir`. That is the exact dir codegen wrote to for THIS stack —
    so the alias points where the files actually are, with no recomputation and no
    "is this home?" inference in the reader. The home stack's manifest records
    `src/generated/`; a non-home stack's records `.devstack/stacks/<stack>/generated/`.
    (Cold-start fallback: if the manifest/field isn't present yet, alias to
    `src/generated/` and let the next read pick up the recorded value.)
- Because Playwright's `webServer` runs the **app's own Vite**, the same plugin
  serves **both dev and e2e** automatically. Vitest has its own Vite pipeline, so
  the plugin is also added to `vitest.config.ts` (or folded into the existing
  `devstackVitestServerConfig()` so apps wire one symbol). Vitest reads
  `DEVSTACK_STACK` from the `test`/`test:e2e` script env.

### 3. TypeScript / IDE type resolution

Bundler aliases (Vite/vitest/Rollup) and `tsc`/IDE resolution are independent.

- `tsconfig.app.json` `paths`: `"<prefix>/*": ["./src/generated/*"]`. So `tsc -b`
  and the IDE always resolve types against the **real home-stack files** at
  `src/generated/`. The hard requirement (default case works for `tsc`/IDE) holds.
- Non-home stacks resolve **types** from the home generated dir (shapes are
  identical across stacks — same emitters; only literal package-id/token *values*
  differ, which the bundler alias swaps at runtime). True per-stack IDE types are
  an explicit follow-up (a generated `tsconfig.<stack>.json` override, or the
  manifest-recorded path in the open decision below) — out of scope here.

## Customization summary

The alias prefix is the single customizable knob, default `@generated`:

```ts
// vite.config.ts
import { devstackVitePlugin } from '@mysten-incubation/devstack/vite';
export default defineConfig({ plugins: [devstackVitePlugin()] }); // alias: '@generated'
// or devstackVitePlugin({ alias: '@gen' })
```
```jsonc
// tsconfig.app.json
{ "compilerOptions": { "paths": { "@generated/*": ["./src/generated/*"] } } }
```
```ts
// app source
import { accounts } from '@generated/accounts.js';
```

(Optional sugar: surface the prefix as `defineDevstack({ codegen: { importAlias } })`
so it lives in one config; the Vite plugin can read it or accept it as the arg.)

## Implementation plan

1. **Output-location resolver** — new pure fn
   `resolveCodegenOutput({ appRoot, effectiveStack, homeStack, explicitOutputDir, explicitStackSubdir })`
   → `{ outputDir, stackSubdir }` (home → `src/generated`; non-home →
   `.devstack/stacks/<stack>/generated`; explicit values win). Lives next to
   `productionCodegenOutputDir` in `runtime-composition.ts` (or `codegen/output-location.ts`).
   Pure + unit-testable. The supervisor then **records the resolved `generatedDir`
   in the per-stack manifest** (add the field to `substrate/manifest.ts` + the
   manifest write/projection) so the reader consults the same value.
2. **Thread home + effective stack to the resolver** at the three boot seams
   (both names already in scope): `cli/wirings/up.ts:452-466`,
   `cli/wirings/apply.ts:130-145`, `api/run-stack.ts:246-252`
   (`homeStack = stack.options.stackName`, `effectiveStack = identityValue.stack`).
3. **`build-verb-layers.ts:22-34`** calls the resolver and passes the computed
   `outputDir`/`stackSubdir` into `layerProductionOrchestrators`. `paths.ts` /
   `runtime-composition.ts` keep consuming a literal `outputDir` — minimal blast radius.
4. **New Vite plugin** `build-integrations/vite/index.ts` (`devstackVitePlugin`):
   resolve the active stack via `resolveDiscoveryEnv(process.env)`, locate its
   manifest via `discoverManifestPath`, read the recorded `codegen.generatedDir`,
   and set `resolve.alias[prefix]` to it (fallback `src/generated/` if absent).
   Sync + dependency-light (mirror the playwright/vitest helpers).
5. **Package export** `"./vite"` in `package.json`.
6. **(Optional)** fold the plugin into `devstackVitestServerConfig()`.
7. **Migrate example apps** to the alias: update import specifiers in
   `examples/{_template,token-studio,connect-four,deepbook-trader,private-content}/src/**`,
   add the plugin to each `vite.config.ts` (+ `vitest.config.ts` if not folded),
   add the `tsconfig.app.json` `paths` entry. `_template` is the canonical scaffold.
8. **Gitignore** — confirm repo-root `.gitignore` covers `.devstack/` (the
   emitted `.gitignore` inside the output dir double-covers it).

## Edge cases

- **N stacks concurrently:** each non-home stack gets its own
  `.devstack/stacks/<stack>/generated/`; home keeps `src/generated/`. No shared
  writers; the staging dir + `<outputDir>.codegen.lock` (`paths.ts:125-131`)
  relocate cleanly and never contend across stacks.
- **Cold-start ordering:** the plugin reads `codegen.generatedDir` from the
  manifest at Vite config-load; the manifest field must be written first. In the
  supervised flow Vite starts *after* post-acquire codegen (playwright global-setup
  waits for it, `playwright/config.ts:90-92`; host-service `after:` deps), so the
  field is present. If the manifest/field isn't there yet, the alias falls back to
  `src/generated/` — wrong values for a non-home stack, not a crash; essentially
  unreachable in the supervised path.
- **`reuseExistingServer`** (playwright `!CI`): a reused dev server is already
  pinned to its stack's dir (env set at start) — correct.
- **Explicit `codegen.outputDir`:** honored verbatim; per-stack isolation skipped
  (documented opt-out; warn if two stacks then collide).
- **Prod `vite build`:** same plugin resolves the alias at build time; prod
  normally runs the home stack → `src/generated/` (unchanged).

## Resolved: read and write share one gate

Read and write MUST be gated by the same decision. The writer
(`effectiveStack === config.stackName`, computed at boot where both names are
known) is authoritative and **records its resolved `generatedDir` in the stack
manifest**; the reader (Vite plugin) **reads that recorded path**. One decision,
one source of truth — they cannot drift. This needs a `codegen.generatedDir`
field on the manifest (`substrate/manifest.ts`) and a read in the plugin
(reusing `discoverManifestPath`); that small schema addition is justified
precisely because an inferred proxy (e.g. a folder-existence check) would gate
reading on a *different* signal than writing and could disagree (stale dirs,
cold-start window).

**Even-simpler alternative (separate decision):** if the dev/home stack were
named `main` rather than the app name, the location would be a *pure function of
the stack name* — `stack === 'main' ? src/generated : .devstack/stacks/<stack>/generated`
— computable identically by reader and writer with NO manifest field and NO
config load. This is cleaner but requires examples to stop hardcoding
`stackName` to the app name (so the default stack is `main`); it's entangled
with the broader `stackName`-default-vs-app-name question and is out of scope
here. If that cleanup happens, this whole reader/writer gating collapses to one
shared pure function.

## Opportunities noticed

- **`stackSubdir` is dead code today** (always `null` at all 3 call sites). This
  design finally exercises the per-stack-output intent — use it as the vehicle
  (sibling dirs) or retire it in favor of the `.devstack` location.
- **The codegen output resolver is stack-blind by construction.** Any future
  per-stack codegen concern (formatting, sensitive-file policy) hits the same
  missing seam. Consider passing the resolved `Identity` (or `stack`) into
  `ProductionCodegenOptions` once rather than threading individual fields.
- **Discovery default `'main'` vs config `stackName` mismatch**
  (`resolve-discovery-env.ts:27`): a build integration discovering with no env
  set looks under `stacks/main/` while the supervisor wrote `stacks/<app>/`.
  Latent footgun beyond this task; may deserve a unifying pass.
