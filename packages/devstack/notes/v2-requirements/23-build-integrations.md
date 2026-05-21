# build-integrations

## Purpose

The `build-integrations` component is the slice of `packages/devstack` that lets the devstack
supervisor be **consumed by other build tools** — Vite (browser app dev server + bundler), Vitest
(the test runner), Playwright (browser e2e harness), and apps' browser-side runtime bundles. It is
the set of small, declarative one-call config helpers and in-spec helpers that lets every example
app reduce its `vite.config.ts` / `vitest.config.ts` / `playwright.config.ts` to a single
`defineDevstackXxxConfig()` call, plus the in-spec helpers (`connectAs`, `loadStackManifest`,
`loadStackKeypair`) that let Playwright specs talk to the live stack.

The component also includes the `runtime/` directory, which is the shared **manifest produce +
consume substrate** sitting between the supervisor (which writes
`.devstack/stacks/<stack>/manifest.json`) and every consumer of that file — including the build
integrations covered here (Vite resolves a per-stack alias to it, Playwright reads endpoint URLs
from it for `webServer.url` + `use.baseURL`, Vitest itself does not use it), but also codegen
emitters (`gatherManifest()` feeds the generated `extras.ts`, `dapp-kit-config.ts`,
`stack-handle.ts`) and CLI commands (`status`, `manifest`, `fork`). See `Open questions` for the
scope-ownership ambiguity.

The build-integrations component is the **public boundary** of devstack to the rest of a frontend
project's tooling stack: app authors write a single-line `vite.config.ts`, a single-line
`vitest.config.ts`, a single-line `playwright.config.ts`, and a small `dapp-kit.ts` that calls
`createDAppKit({ ...devstackDappKitConfig })`. Everything else (port allocation, traefik routing,
manifest discovery, cold-start URL fallback, graceful shutdown of the dev server) is encoded inside
these one-call helpers.

---

## Current implementation

### Sub-component: `src/vite/` — Vite config preset

Wraps `defineConfig` from Vite. Returns a `UserConfig` baking in the canonical wiring every devstack
example app needs.

| File                     | LOC | Summary                                                                                                                                                                                                                          |
| ------------------------ | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/vite/index.ts`      | 140 | Sole module. Exports `defineDevstackViteConfig(options)` and the `DevstackViteConfigOptions` interface. Composes `@vitejs/plugin-react` + `@tailwindcss/vite` + per-stack manifest alias + `$PORT` pin + Traefik-compatible HMR. |
| `src/vite/index.test.ts` | 81  | Unit-only. Asserts the canonical plugin set, ES2022 target, `$PORT` precedence, per-stack manifest alias path, `extraPlugins`, `extend` pass-through.                                                                            |

**Totals (vite):** src 140, test 81 = 221 LOC.

### Sub-component: `src/vitest/` — Vitest config preset

Wraps `defineConfig` from `vitest/config`. The smallest sub-component; historically also held a
`withDevstack(handle)` shim that was deleted in "Wave 6" with zero in-tree callers
(`src/vitest/index.ts:9-17`).

| File                               | LOC | Summary                                                                                                                                                                       |
| ---------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/vitest/index.ts`              | 22  | Barrel re-export of `defineDevstackVitestConfig` and a header comment documenting the deleted `withDevstack` shim + the `@effect/vitest` `it.layer` pattern that replaced it. |
| `src/vitest/define-config.ts`      | 36  | Sole real implementation. Returns `{ test: { include, exclude, passWithNoTests } }` with user overrides.                                                                      |
| `src/vitest/index.test.ts`         | 25  | Peer-dependency contract test — asserts `package.json` declares `@effect/vitest` as an **optional** peer.                                                                     |
| `src/vitest/define-config.test.ts` | 17  | Two unit tests for the preset at minimum invocation and with a user-supplied `test` override.                                                                                 |

**Totals (vitest):** src 58, test 42 = 100 LOC.

### Sub-component: `src/playwright/` — Playwright preset, in-spec helpers, artifact loaders

Five files split across three concern groups: one-call config preset (`define-config.ts`), low-level
`webServer` / `baseURL` resolvers (`web-server.ts`), in-spec UI helpers (`helpers.ts`), in-spec
artifact loaders (`artifacts.ts`). The barrel re-exports everything from this subpath PLUS `test` +
`expect` from `@playwright/test`.

| File                                   | LOC | Summary                                                                                                                                                                                                                     |
| -------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/playwright/index.ts`              | 54  | Public surface barrel. Three concern groups: config, in-spec helpers, re-exports of `test` / `expect`.                                                                                                                      |
| `src/playwright/define-config.ts`      | 74  | `defineDevstackPlaywrightConfig({endpoint?, timeout?, webServer?, extend?})` — single-call canonical config. Bakes in `testDir: './e2e'`, `workers: 1`, `fullyParallel: false`, CI-aware `forbidOnly`/`retries`/`reporter`. |
| `src/playwright/web-server.ts`         | 134 | Low-level: `webServer({endpoint})` returns Playwright's `WebServerSingle`; `baseURL({endpoint})` returns the URL string. Reads the manifest sync via `readStackContextSync`; cold-start fallback via `conventionalUrl()`.   |
| `src/playwright/helpers.ts`            | 76  | In-spec UI helpers: `connectAs(page, label)` drives the dApp Kit dev-wallet flow + `switchAccount`; `selectAccount(loc, name)` is a `<select>`-by-text shim.                                                                |
| `src/playwright/artifacts.ts`          | 138 | In-spec artifact loaders: `loadStackManifest()` typed-reads the manifest, `loadStackKeypair(name)` reads `runtime/accounts/<name>.key` and returns an `Ed25519Keypair`.                                                     |
| `src/playwright/define-config.test.ts` | 61  | Asserts canonical config shape, default 300s timeout, custom timeout, `extend.use` pass-through.                                                                                                                            |
| `src/playwright/helpers.test.ts`       | 76  | Source-text assertions (selectors, helper names, global slot). Browser-driving paths are deferred to example apps' real e2e suites.                                                                                         |
| `src/playwright/web-server.test.ts`    | 243 | The deepest test file. Covers manifest read, cold-start fallback, malformed manifest, missing endpoint, app-name stripping, `PLAYWRIGHT=1` stamp, `SIGTERM gracefulShutdown` wiring.                                        |

**Totals (playwright):** src 476, test 380 = 856 LOC.

### Sub-component: `src/browser/` — Browser-safe re-exports

| File                   | LOC | Summary                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/browser/index.ts` | 27  | Sole module, no tests. Re-exports `getWalrusCaptured`, `localnetWalrusOptions`, plus types `LocalnetWalrusOptions`, `LocalnetWalrusInputs` from `services/walrus/options.js`. Exists because the main `.` barrel pulls in node-only modules (supervisor, docker, identity) that throw at module-init time when Vite externalizes them. |

**Totals (browser):** src 27, test 0 = 27 LOC.

### Sub-component: `src/runtime/` — Manifest produce + consume substrate

11 source files. Cross-cutting between sub-components (see Open questions).

| File                                     | LOC | Summary                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/runtime/manifest-schema.ts`         | 235 | `Manifest` shape via `effect/Schema`. Top-level: `stack`, `services`, `packages`, `accounts`, `coins`, `app`. Nested schemas for `SuiManifest`, `SealManifest`, `WalrusManifest`, `DeepbookManifest`, `PythManifest`, `PostgresManifest`, `EndpointEntry`, `AppManifest`, `StackIdentity`. Single source of truth for the on-disk shape.                                                                              |
| `src/runtime/manifest-emit.ts`           | 166 | `emitManifest()` — Effect that performs eager write at acquire, slow-tick (`500ms` default) re-snapshot during lifetime, final flush on scope close. Schema-encodes before serialize. Atomic write (tmp + rename) via `writeFileAtomicIfChanged`. Permission `0o600` (extras may be sensitive). Output path defaults to `.devstack/stacks/<stack>/manifest.json`.                                                     |
| `src/runtime/service.ts`                 | 350 | `gatherManifest(extras?)` — reads every registry (`PackageRegistry`, `EndpointRegistry`, `AccountRegistry`, `CoinRegistry`, `SuiStateRegistry`, `SealStateRegistry`, `WalrusStateRegistry`, `DeepbookStateRegistry`, `PythStateRegistry`, `PostgresStateRegistry`, `DeepbookIndexerStateRegistry`, `DeepbookServerStateRegistry`, `DeepbookMarginStateRegistry`) + `Identity` and projects into the `Manifest` shape. |
| `src/runtime/read-stack-context.ts`      | 245 | Unified manifest reader + projection. Two surfaces: `readStackContextSync` (Playwright) and `readStackContext` (Effect, used by CLI). Schema-decodes; surfaces `ManifestDiscoveryError` (missing) or `ManifestShapeError` (corrupt JSON / wrong shape) at the boundary instead of NPEing downstream. Projects `endpoint(name) => EndpointEntry`.                                                                      |
| `src/runtime/discover-manifest.ts`       | 133 | `discoverManifestPath({override?, cwd?, stack?, stateDir?, required?})` — sync walk-up resolver. Precedence: env `DEVSTACK_MANIFEST_PATH` → override → walk up from `cwd` looking for `<stateDir>/stacks/<stack>/manifest.json`. Stack-scoped only; flat `<stateDir>/manifest.json` deliberately ignored.                                                                                                             |
| `src/runtime/endpoint-names.ts`          | 141 | `defineEndpoint(...)` declarations for the well-known endpoints (sui-rpc, sui-faucet, sui-graphql, sui-indexer-db, wallet-app, frontend.dev-server, seal-key-server, walrus-aggregator, walrus-publisher, postgres, sui-checkpoint-volume) + the flat `EndpointName` constants object exported to consumers.                                                                                                          |
| `src/runtime/conventional-routes.ts`     | 83  | `CONVENTIONAL_ROUTES` table derived from `listEndpointDeclarations()`. `conventionalUrl(endpoint, {stack?, app?})` returns the `<stack>.<service>.<app>.localhost:<port>` cold-start URL when no manifest exists yet. `readAppName(dir)` reads + un-scopes `package.json`'s `name` field.                                                                                                                             |
| `src/runtime/sdk-coin.ts`                | 30  | Pure projection `toSdkCoin({fullCoinType, decimals}) => {address, type, scalar}`. Bridges devstack's internal coin representation to the SDK-aligned shape consumed by `@mysten/deepbook-v3` + dapp-kit. Re-exported from `services/package.ts`.                                                                                                                                                                      |
| `src/runtime/manifest-emit.test.ts`      | 168 | `emitManifest` test — eager write, mode `0o600`, `Extras` propagation, late-registration final-flush, custom output path.                                                                                                                                                                                                                                                                                             |
| `src/runtime/service.test.ts`            | 220 | `gatherManifest` test — seeds registries, asserts manifest shape. Late-registration call returns fresh snapshot. Postgres URL never carries credentials. `EndpointName` constants lock-down.                                                                                                                                                                                                                          |
| `src/runtime/read-stack-context.test.ts` | 222 | `readStackContext{Sync}` test — well-formed projection, malformed `ManifestShapeError(phase: shape)`, corrupt JSON `ManifestShapeError(phase: parse)`, missing file `ManifestDiscoveryError`.                                                                                                                                                                                                                         |
| `src/runtime/discover-manifest.test.ts`  | 178 | `discoverManifestPath` test — env-var precedence, override, walk-up, stack-scoped (`ignores a stale flat manifest`), `DEVSTACK_STACK` env, `stateDir` override, required throw, nested-project closest-wins.                                                                                                                                                                                                          |
| `src/runtime/extras-consistency.test.ts` | 112 | `ExtrasResolved` consistency — manifest's `app.extras` and the codegen-emitted `extras.ts` carry the SAME blob even when input is a non-pure `() => ({tick: counter++})` function. Resolves once at infra-layer build time.                                                                                                                                                                                           |

**Totals (runtime):** src 1383, test 900 = 2283 LOC.

### Cross-component totals

| Sub-component | Src LOC | Test LOC | Total |
| ------------- | ------- | -------- | ----- |
| vite          | 140     | 81       | 221   |
| vitest        | 58      | 42       | 100   |
| playwright    | 476     | 380      | 856   |
| browser       | 27      | 0        | 27    |
| runtime       | 1383    | 900      | 2283  |
| **all**       | 2084    | 1403     | 3487  |

---

## Configuration

Configuration is split into three layers: build-tool config (via the `defineDevstackXxxConfig`
options), environment variables (resolved at each helper's call site), and devstack's primary config
(`defineDevstack` — owned by other components, but the build integrations consume the side effects).

### Vite preset options — `DevstackViteConfigOptions`

`src/vite/index.ts:34-53`

| Option         | Type                          | Default                   | Read at                    | Description                                                                                                                                                                                                                                 |
| -------------- | ----------------------------- | ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port`         | `number`                      | `5179` (line 79)          | `src/vite/index.ts:79`     | Fallback dev-server port when `$PORT` is unset. Each example app picks a distinct fallback (arena=5176 per `examples/arena/vite.config.ts:3`) so concurrent `vite` runs outside the supervisor don't collide.                               |
| `appDir`       | `string`                      | `process.cwd()` (line 70) | `src/vite/index.ts:70`     | App root for resolving the per-stack manifest alias and `@` source alias. Override only when running vite from a non-project-root cwd.                                                                                                      |
| `extraPlugins` | `ReadonlyArray<PluginOption>` | `[]` (line 80)            | `src/vite/index.ts:80,84`  | Plugins appended after the bundled `react()` + `tailwindcss()` pair.                                                                                                                                                                        |
| `extend`       | `UserConfig`                  | `{}` (line 81)            | `src/vite/index.ts:81-130` | Extra fields merged into the resulting config. One-level-deep merge for `server`, `resolve`, `build`, `optimizeDeps` so preset defaults survive partial overrides; top-level keys win via `stripHandledKeys` + spread (lines 129, 135-138). |

### Vitest preset options — `DevstackVitestConfigOptions`

`src/vitest/define-config.ts:3-6`

| Option | Type                                  | Default                                                                                                                                    | Read at                          | Description                                                                       |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | --------------------------------------------------------------------------------- |
| `test` | `NonNullable<ViteUserConfig['test']>` | `{ include: ['src/**/*.{test,spec}.ts?(x)'], exclude: ['e2e/**', 'node_modules', 'dist', '.turbo'], passWithNoTests: true }` (lines 30-32) | `src/vitest/define-config.ts:33` | User-supplied fields merged via spread; user fields win for any overlapping keys. |

### Playwright preset options — `DevstackPlaywrightConfigOptions`

`src/playwright/define-config.ts:6-25`

| Option      | Type                               | Default                                                       | Read at                                    | Description                                                                                                                                                                                |
| ----------- | ---------------------------------- | ------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `endpoint`  | `string`                           | `EndpointName.DEV_SERVER_PRIMARY` (= `'frontend.dev-server'`) | `src/playwright/define-config.ts:45`       | Manifest endpoint name wired as BOTH `webServer.url` and `use.baseURL`. Must match the endpoint name the `Dev(...)` primitive registers, or a conventional short name like `'wallet-app'`. |
| `timeout`   | `number`                           | `300_000` (300s)                                              | `src/playwright/define-config.ts:46`       | `webServer` startup timeout in ms. Bump to ~`900_000` for apps with walrus/seal cold-start.                                                                                                |
| `webServer` | `Omit<WebServerOptions, 'endpoint' | 'timeout'>`                                                   | undefined                                  | `src/playwright/define-config.ts:56`                                                                                                                                                       | Extra options forwarded to the `webServer` helper — `command`, `manifestPath`, `extend`. |
| `extend`    | `PlaywrightTestConfig`             | `{}`                                                          | `src/playwright/define-config.ts:47,57-64` | Top-level fields merged shallowly. `use` and `projects` are passed through unchanged via dedicated handling so callers can fully customize them.                                           |

### Low-level `WebServerOptions`

`src/playwright/web-server.ts:10-24`

| Option         | Type                                 | Default                                                                                          | Read at                                | Description                                                                                                                      |
| -------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`     | `string`                             | required                                                                                         | `src/playwright/web-server.ts:41`      | Manifest endpoint name.                                                                                                          |
| `manifestPath` | `string`                             | undefined → walk-up from cwd                                                                     | `src/playwright/web-server.ts:106-107` | Explicit override for the manifest path (still validated to exist; see `discoverManifestPath` precedence).                       |
| `command`      | `string`                             | `'pnpm dev'`                                                                                     | `src/playwright/web-server.ts:43`      | Dev-server launch command. `defineDevstackPlaywrightConfig` does not expose this directly; only via `options.webServer.command`. |
| `timeout`      | `number`                             | `120_000` (when called via low-level helper) / `300_000` (when called via the preset, see above) | `src/playwright/web-server.ts:45`      | `webServer.timeout` in ms.                                                                                                       |
| `extend`       | `Partial<PlaywrightWebServerSingle>` | undefined                                                                                        | `src/playwright/web-server.ts:52,63`   | Extra `webServer` fields. User `env` is merged AFTER `PLAYWRIGHT: '1'` so user wins.                                             |

### Low-level `BaseURLOptions`

`src/playwright/web-server.ts:67-72`

| Option         | Type     | Default   | Read at                           | Description                    |
| -------------- | -------- | --------- | --------------------------------- | ------------------------------ |
| `endpoint`     | `string` | required  | `src/playwright/web-server.ts:84` | Manifest endpoint name.        |
| `manifestPath` | `string` | undefined | `src/playwright/web-server.ts:84` | Same discovery as `webServer`. |

### Artifact loader options — `LoadStackManifestOptions` / `LoadStackKeypairOptions`

`src/playwright/artifacts.ts:36-46,80-85`

| Option         | Type     | Default                                    | Read at                                   | Description                                                                                  |
| -------------- | -------- | ------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `manifestPath` | `string` | undefined                                  | `src/playwright/artifacts.ts:62-68`       | Explicit override (lower precedence than `DEVSTACK_MANIFEST_PATH`).                          |
| `cwd`          | `string` | `process.cwd()`                            | `src/playwright/artifacts.ts:62-68`       | Walk-up start dir.                                                                           |
| `stack`        | `string` | `process.env.DEVSTACK_STACK ?? 'main'`     | `src/playwright/artifacts.ts:62-68`       | Stack name.                                                                                  |
| `accountsDir`  | `string` | `<manifestDir>/runtime/accounts` (derived) | `src/playwright/artifacts.ts:101,120-138` | Override for the directory holding `<name>.key` files. Overriding skips the manifest lookup. |

### `DiscoverManifestPathOptions` (passed through by all manifest readers)

`src/runtime/discover-manifest.ts:43-63`

| Option     | Type      | Default                                         | Read at                                             | Description                                                                                     |
| ---------- | --------- | ----------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `override` | `string`  | undefined                                       | `src/runtime/discover-manifest.ts:89-102`           | Caller-supplied path. Still validated to exist; lower precedence than `DEVSTACK_MANIFEST_PATH`. |
| `cwd`      | `string`  | `process.cwd()`                                 | `src/runtime/discover-manifest.ts:105`              | Walk-up start.                                                                                  |
| `stack`    | `string`  | `process.env.DEVSTACK_STACK ?? 'main'`          | `src/runtime/discover-manifest.ts:103`              | Stack name.                                                                                     |
| `stateDir` | `string`  | `process.env.DEVSTACK_STATE_DIR ?? '.devstack'` | `src/runtime/discover-manifest.ts:104`              | State-dir subdirectory inside each walk-up parent.                                              |
| `required` | `boolean` | `false`                                         | `src/runtime/discover-manifest.ts:62,77-99,120-130` | When true, throws `ManifestDiscoveryError` instead of returning `undefined`.                    |

### `EmitManifestOptions`

`src/runtime/manifest-emit.ts:35-42`

| Option         | Type                     | Default                                            | Read at                              | Description                                                                          |
| -------------- | ------------------------ | -------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| `output`       | `string`                 | `.devstack/stacks/<stack>/manifest.json` (derived) | `src/runtime/manifest-emit.ts:44-47` | Override the on-disk manifest path.                                                  |
| `tickInterval` | `` `${number} millis` `` | `'500 millis'`                                     | `src/runtime/manifest-emit.ts:155`   | Re-snapshot interval for the forked-scoped repeater that catches late registrations. |

### Environment variables

All env vars are read at helper call time, not at module load.

| Env var                  | Read at                                                                                                   | Default                | Effect                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                   | `src/vite/index.ts:112`                                                                                   | unset → preset default | Wins over `options.port`. Set by the supervisor's port allocator when Vite is spawned via `pnpm dev`.                                                                             |
| `DEVSTACK_STACK`         | `src/vite/index.ts:69` ; `src/runtime/discover-manifest.ts:103` ; `src/runtime/conventional-routes.ts:76` | `'main'`               | Selects which stack's manifest to alias / discover / fall-back-URL. Non-main stack name becomes the leading host label in cold-start URLs (`feature-x.dev.<app>.localhost:5175`). |
| `DEVSTACK_STATE_DIR`     | `src/runtime/discover-manifest.ts:104`                                                                    | `'.devstack'`          | Name of the supervisor's state directory at each walk-up parent.                                                                                                                  |
| `DEVSTACK_MANIFEST_PATH` | `src/runtime/discover-manifest.ts:74-87`                                                                  | unset                  | Top-precedence manifest-path override. Wins over `override:` arguments. When set but the file is missing, returns `undefined` (or throws if `required: true`).                    |
| `CI`                     | `src/playwright/define-config.ts:53-55` ; `src/playwright/web-server.ts:46`                               | unset                  | Enables `forbidOnly: true`, `retries: 2`, `reporter: [['github'], ['list']]`, AND disables `reuseExistingServer`.                                                                 |
| `PLAYWRIGHT`             | Set BY `webServer()` to `'1'` (`src/playwright/web-server.ts:52`)                                         | unset (in supervisor)  | Stamped into the child process env so a devstack config can branch on e2e mode (e.g. `hotRestart: false` — see comment about codegen's `sui move build` tripping the watcher).    |

### Conventional defaults baked into helpers (cannot be configured)

The following are hard-coded; callers cannot configure them without forking the helper. They're
called out here because architecture design will need to decide whether they stay hard-coded.

| Constant                                                                        | Where                                   | Why                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vite `build.target: 'es2022'`                                                   | `src/vite/index.ts:92`                  | Top-level await + class fields required by the `createDevstackDappKit` factory + the `@mysten/dapp-kit-*` peers.                                                                                |
| Vite `optimizeDeps.esbuildOptions.target: 'es2022'`                             | `src/vite/index.ts:94`                  | Keep dev-mode pre-bundle (default es2020) consistent with production target.                                                                                                                    |
| Vite `server.allowedHosts: ['.localhost']`                                      | `src/vite/index.ts:118`                 | Without this, Vite's `Host:` header allowlist rejects requests routed through traefik on `*.localhost` virtual hosts.                                                                           |
| Vite `server.hmr.clientPort: 5175`                                              | `src/vite/index.ts:125-126`             | HMR over the router. Browser dials the public router port; pinning prevents dial-the-upstream-local-port-from-the-public-host.                                                                  |
| Vite `server.watch.ignored: ['**/.devstack/**']`                                | `src/vite/index.ts:108`                 | Without this, Vite full-reloads on every per-stack manifest write — 500ms tick → reload loop.                                                                                                   |
| Vitest `passWithNoTests: true`                                                  | `src/vitest/define-config.ts:31`        | Codegen-derived stacks without unit tests yet don't fail CI.                                                                                                                                    |
| Playwright `testDir: './e2e'`                                                   | `src/playwright/define-config.ts:50`    | Single canonical e2e dir. Diverges from the Playwright default `./tests`.                                                                                                                       |
| Playwright `fullyParallel: false`, `workers: 1`                                 | `src/playwright/define-config.ts:51-52` | Devstack apps share one supervisor per stack — parallel tests would contend on the shared faucet / wallet / RPC.                                                                                |
| Playwright `webServer.gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 }` | `src/playwright/web-server.ts:62`       | Default SIGKILL on the shell parent reparents every descendant to init with no cleanup, leaving orphan vite processes that hold ports for hours. Fixed by 41366505 (the `process-tree` commit). |
| Playwright `webServer.env: { PLAYWRIGHT: '1', ... }`                            | `src/playwright/web-server.ts:52`       | User env wins.                                                                                                                                                                                  |
| Manifest file mode `0o600`                                                      | `src/runtime/manifest-emit.ts:61,138`   | Extras blob may carry sensitive data.                                                                                                                                                           |
| Manifest write `tickInterval` default `'500 millis'`                            | `src/runtime/manifest-emit.ts:155`      | Picks up late registrations (wallet endpoint can land after `emitManifest`'s acquire) without thrashing the disk.                                                                               |

---

## Capabilities CONSUMED

### From other devstack components

The build-integrations depend on:

**The supervisor's eventual side effects**

- The Vite preset assumes the supervisor sets `$PORT` (`src/vite/index.ts:112`) — port allocator
  owned by `engine/port-allocator.ts`.
- The Vite preset assumes traefik will route `dev.<app>.localhost:5175` to the dev server
  (`src/vite/index.ts:117-126`) — traefik routing owned by another component (router/proxy).
- The Playwright preset assumes the supervisor will write `.devstack/stacks/<stack>/manifest.json`
  containing the endpoint URLs it expects (`src/playwright/web-server.ts:106` reads it).
- The Playwright artifact loader assumes the supervisor will write `runtime/accounts/<name>.key`
  files alongside the manifest (`src/playwright/artifacts.ts:101-118`).

**State-store registries (consumed by `gatherManifest`, `src/runtime/service.ts:252-273`)**

- `Identity` (`src/runtime/service.ts:253`) — provides `app`, `stack`, `network`.
- `PackageRegistry` (`src/runtime/service.ts:254`).
- `EndpointRegistry` (`src/runtime/service.ts:255`).
- `AccountRegistry` (`src/runtime/service.ts:256`).
- `CoinRegistry` (`src/runtime/service.ts:257`).
- `SuiStateRegistry` (`src/runtime/service.ts:289`).
- `SealStateRegistry` (`src/runtime/service.ts:290`).
- `WalrusStateRegistry` (`src/runtime/service.ts:291`).
- `DeepbookStateRegistry` (`src/runtime/service.ts:258`).
- `DeepbookIndexerStateRegistry` (`src/runtime/service.ts:259`).
- `DeepbookServerStateRegistry` (`src/runtime/service.ts:260`).
- `DeepbookMarginStateRegistry` (`src/runtime/service.ts:261`).
- `PythStateRegistry` (`src/runtime/service.ts:298`).
- `PostgresStateRegistry` (`src/runtime/service.ts:299`).

**Engine resources**

- `ExtrasResolved` (`src/runtime/manifest-emit.ts:105`) — the memoized extras Effect; resolved once
  at infra-layer build time so manifest + extras.ts + dapp-kit config see the same blob.
- `findEndpointDeclaration` (`src/runtime/service.ts:12`) and `listEndpointDeclarations`
  (`src/runtime/conventional-routes.ts:12`) — read the `defineEndpoint(...)` registry from
  `engine/define-endpoint.ts`.
- `defineServiceProjection` from `engine/service-projection.ts` (`src/runtime/service.ts:33`) —
  declarative per-service projection helper.
- `writeFileAtomicIfChanged` from `engine/atomic-write.ts` (`src/runtime/manifest-emit.ts:21`) —
  tmp-file + rename atomic write.
- `jsonBigintReplacer` from `engine/json-bigint.ts` (`src/runtime/manifest-emit.ts:20`) — JSON
  serializer that handles bigint cleanly.
- Error classes from `engine/errors.ts`: `ManifestError`, `ManifestDiscoveryError`,
  `ManifestShapeError` (`src/runtime/manifest-emit.ts:22`, `src/runtime/read-stack-context.ts:23`,
  `src/playwright/web-server.ts:2`).

**Endpoint constants**

- `EndpointName` from `runtime/endpoint-names.ts` consumed by `playwright/define-config.ts:3`
  (`DEV_SERVER_PRIMARY` default).

### Surfaces

- Vite plugin output → consumed by Vite itself.
- Vitest config → consumed by Vitest.
- Playwright config → consumed by Playwright runner.
- Browser bundle exports → consumed by app code via `@mysten-incubation/devstack/browser` subpath.
- `connectAs` reads `globalThis.__devstackDAppKit__` (`src/playwright/helpers.ts:43-65`) — the slot
  the example app's `dapp-kit.ts` must populate.

### External

- HTTP / DOM:
  - `connectAs` clicks `mysten-dapp-kit-connect-button` and `mysten-dapp-kit-connect-modal` web
    components (`src/playwright/helpers.ts:25-29`) — depends on `@mysten/dapp-kit` UI contract.
  - `connectAs` matches the wallet by literal text `'Dev Wallet'`
    (`src/playwright/helpers.ts:28,54`) — depends on the dev-wallet emitter naming.
  - Browser dials the manifest's endpoint URLs (`baseURL`) on `*.localhost` hostnames via traefik.
- Filesystem:
  - `existsSync` walk-up in `discoverManifestPath` (`src/runtime/discover-manifest.ts:39,107-119`).
  - `readFileSync` in `readStackContextSync` (`src/runtime/read-stack-context.ts:21,199`) and
    `loadStackManifest` / `loadStackKeypair` (`src/playwright/artifacts.ts:29,76,105`).
  - `fs.chmod` after manifest write (`src/runtime/manifest-emit.ts:138`).
- Process:
  - `process.env` reads at multiple sites — see the env-var table above.
  - `process.cwd()` reads in vite preset, manifest discovery, conventional-route resolver
    (`src/vite/index.ts:70`, `src/runtime/discover-manifest.ts:105`,
    `src/runtime/conventional-routes.ts:77`).
  - SIGTERM/SIGKILL propagation via Playwright's `gracefulShutdown` wiring to `pnpm dev` →
    supervisor → Effect finalizers → spawner SIGTERM to vite's process group
    (`src/playwright/web-server.ts:62`).

### Effect / Layer / Context machinery

- `Effect.gen` blocks throughout `manifest-emit.ts`, `read-stack-context.ts`, `service.ts`.
- `Schedule.spaced(...)` (`src/runtime/manifest-emit.ts:155`) — slow-tick re-snapshot scheduler.
- `Scope.Scope` requirement on `emitManifest` (`src/runtime/manifest-emit.ts:90`);
  `Effect.forkScoped` + `Effect.addFinalizer` (`src/runtime/manifest-emit.ts:152,161`).
- `Schema.decodeUnknownSync(Manifest)` (`src/runtime/read-stack-context.ts:88`);
  `Schema.encodeUnknownSync(Manifest)` (`src/runtime/manifest-emit.ts:33`).
- `Effect.tryPromise`, `Effect.try`, `Effect.catch`, `Effect.repeat`, `Effect.withSpan`
  (manifest-emit + read-stack-context).

### npm dependencies

- **`vite`** (peer, optional): `defineConfig`, `PluginOption`, `UserConfig`
  (`src/vite/index.ts:32`).
- **`@vitejs/plugin-react`** (peer, optional): `react()` (`src/vite/index.ts:31`).
- **`@tailwindcss/vite`** (peer, optional): `tailwindcss()` (`src/vite/index.ts:30`).
- **`vitest`**: `defineConfig`, `ViteUserConfig` from `vitest/config`
  (`src/vitest/define-config.ts:1`).
- **`@effect/vitest`** (peer, optional): re-export contract from the `/vitest` subpath (asserted in
  `src/vitest/index.test.ts:21-24`).
- **`@playwright/test`** (peer, optional): `PlaywrightTestConfig`, `devices`, `test`, `expect`,
  `Page`, `Locator` (`src/playwright/define-config.ts:1-2`, `src/playwright/helpers.ts:1`,
  `src/playwright/index.ts:54`).
- **`@mysten/sui`**: `Ed25519Keypair`, `decodeSuiPrivateKey` (`src/playwright/artifacts.ts:31-32`).
- **`effect`**: `Effect`, `Schema`, `Schedule`, `Scope` (runtime/\* files).
- **`node:fs`, `node:path`, `node:os`, `node:url`**: throughout.

### Workspace imports

None directly within the build-integrations modules — the `@mysten-incubation/dev-wallet` peer is
referenced only by services elsewhere in the package, not by this component. The
`@mysten/dapp-kit-*` peers are referenced indirectly via `globalThis.__devstackDAppKit__` (the slot
contract).

---

## Capabilities PRODUCED

### TypeScript exports per subpath

Each subpath is declared in `package.json` `exports` (`package.json:23-49`):

**`@mysten-incubation/devstack/vite`** (`src/vite/index.ts`)

- `defineDevstackViteConfig(options?): UserConfig` (`src/vite/index.ts:63`)
- `DevstackViteConfigOptions` interface (`src/vite/index.ts:34`)

**`@mysten-incubation/devstack/vitest`** (`src/vitest/index.ts:22`)

- `defineDevstackVitestConfig(options?): ViteUserConfig` (`src/vitest/define-config.ts:25`)
- `DevstackVitestConfigOptions` interface (`src/vitest/define-config.ts:3`)

**`@mysten-incubation/devstack/playwright`** (`src/playwright/index.ts:24-54`)

- `defineDevstackPlaywrightConfig(options?): PlaywrightTestConfig`
- `DevstackPlaywrightConfigOptions` interface
- `webServer(opts): PlaywrightWebServerSingle`
- `baseURL(opts): string`
- `WebServerOptions`, `BaseURLOptions` interfaces
- `connectAs(page, label): Promise<void>`
- `selectAccount(loc, name): Promise<void>`
- `loadStackManifest(opts?): Manifest`
- `loadStackKeypair(name, opts?): Ed25519Keypair`
- `LoadStackManifestOptions`, `LoadStackKeypairOptions` interfaces
- `test`, `expect` re-exported from `@playwright/test`

**`@mysten-incubation/devstack/browser`** (`src/browser/index.ts:22-27`)

- `getWalrusCaptured`
- `localnetWalrusOptions`
- `LocalnetWalrusOptions` type
- `LocalnetWalrusInputs` type

**`@mysten-incubation/devstack/advanced`** (re-exports relevant runtime bits;
`src/advanced/index.ts:107,113`)

- `gatherManifest` re-exported from `runtime/service`.
- `EndpointName`, `EndpointNameValue` re-exported from `runtime/endpoint-names`.

### Files written

- `.devstack/stacks/<stack>/manifest.json` — written by `emitManifest` via atomic write + chmod
  0o600 (`src/runtime/manifest-emit.ts:47,138`). Body is the schema-encoded `Manifest`
  (`src/runtime/manifest-schema.ts:224-230`). The manifest shape carries `stack`, `services`,
  `packages`, `accounts`, `coins`, `app` sections plus the user-supplied `app.extras` blob.

### State-store entries

No state-store entries are produced by the build-integration code itself. The manifest write is the
only persistent surface. Per-account `<name>.key` files written by the supervisor under
`runtime/accounts/` are consumed by `loadStackKeypair` but are not produced by this component.

### Events emitted

None directly. The manifest-write side effect has no event channel; readers are expected to either
poll (Playwright's `webServer.url` ready-wait) or treat absence as "stack hasn't been brought up
yet" (cold-start fallback).

### Endpoints

No endpoints are produced by this component itself. The Vite preset configures the dev-server
endpoint Vite serves (port = `$PORT ?? options.port ?? 5179`) but the URL the dev server is
reachable at is owned by the traefik routing component.

### Global slots produced by callers (read here)

- `globalThis.__devstackDAppKit__` is **populated by the example app's `dapp-kit.ts`** (per the
  comment in `src/playwright/helpers.ts:18-22`) and **read by** `connectAs`
  (`src/playwright/helpers.ts:43-65`). This is a cross-package contract, not produced by
  build-integrations.

### CLI commands registered

None. The CLI commands live in `cli/commands/` and consume `runtime/` for manifest reads, but the
build-integration sub-components don't register CLI surfaces.

---

## Lifecycle

The four sub-components have very different lifecycles. They're documented separately.

### Vite preset

- **Startup**: `defineDevstackViteConfig({...})` is called synchronously by Vite when it loads
  `vite.config.ts`. Reads `process.env.DEVSTACK_STACK`, `process.env.PORT`, and `process.cwd()` at
  the moment of the call (lines 69, 70, 112).
- **Ready criteria**: returns a `UserConfig` object. Vite is "ready" when its own dev-server starts;
  that's outside this component.
- **Restart behavior**: idempotent — calling the function again returns a fresh `UserConfig`. No
  persistent state.
- **Teardown**: none. The function returns; nothing to clean up.

### Vitest preset

- **Startup**: `defineDevstackVitestConfig({...})` called synchronously by Vitest when it loads
  `vitest.config.ts`. No env reads. No I/O.
- **Ready criteria**: returns a `ViteUserConfig`. Vitest is "ready" when its own runner starts.
- **Restart behavior**: idempotent — no state.
- **Teardown**: none.

Note: there is **no** devstack lifecycle hooked into Vitest. The deleted `withDevstack(handle)`
helper used to wrap `@effect/vitest`'s `it.layer`; the current pattern (header comment in
`src/vitest/index.ts:9-17`) is for the consumer to call `it.layer(stack.layer)` directly. So
devstack does NOT boot before vitest tests via this preset; it's the test's job (via the
`@effect/vitest` layer pattern, or via a separate Playwright globalSetup mentioned in the header
comment line 20). See Open questions.

### Playwright preset + webServer

- **Startup sequence** (driven by Playwright):
  1. Playwright loads `playwright.config.ts` synchronously → `defineDevstackPlaywrightConfig({...})`
     runs.
  2. `webServer({endpoint, timeout, ...})` runs synchronously (`src/playwright/web-server.ts:40`):
     - Calls `readStackContextSync` → `discoverManifestPath({required: true})`.
     - If the manifest doesn't exist (cold-start), catches `ManifestDiscoveryError` and computes
       `conventionalUrl(endpoint)` as the fallback URL (`src/playwright/web-server.ts:109-122`).
     - If the manifest exists but the schema rejects, re-throws `ManifestShapeError` verbatim (the
       message carries a `RECOVERY:` recipe).
     - Otherwise reads `ctx.endpoint(endpoint).url` and uses that.
  3. `baseURL({endpoint})` runs the same logic (`src/playwright/web-server.ts:83-85`).
  4. Playwright spawns the `webServer.command` (`pnpm dev` by default) via `shell: true`, waits for
     `webServer.url` to respond (up to `timeout` ms, default 300_000ms for the preset).
  5. The spawned `pnpm dev` invokes the devstack supervisor, which writes the real manifest. The
     Playwright `webServer.url` we computed converges with what the supervisor wires (same
     `<stack>.<service>.<app>.localhost`
     - traefik entrypoint port — see comment at `src/playwright/web-server.ts:95-103`).
  6. Per-spec: tests run, `connectAs` drives the dev wallet via the global slot, `loadStackManifest`
     / `loadStackKeypair` read the live artifacts.
- **Ready criteria**:
  - For Playwright's perspective: `webServer.url` responds within `timeout` ms.
  - For the dev server's perspective: vite reports its dev server up; the supervisor reports the
    stack up via its own readiness machinery (outside this component).
- **Restart behavior**:
  - `reuseExistingServer: !process.env.CI` (`src/playwright/web-server.ts:46`) — on a developer
    machine, reuses an already-running `pnpm dev`. On CI (where `process.env.CI` is set), always
    spawns fresh.
- **Teardown**:
  - Playwright sends SIGTERM to the shell process at the configured `gracefulShutdown.timeout` (10s,
    `src/playwright/web-server.ts:62`).
  - Shell propagates SIGTERM to `pnpm dev`.
  - `pnpm dev` propagates to the supervisor.
  - The supervisor's `NodeRuntime` runs Effect finalizers.
  - `Dev()` primitive's spawner sends SIGTERM to vite's process group.
  - On the 10s grace window expiring, Playwright sends SIGKILL.
  - This wiring is load-bearing — the default SIGKILL-on-shell would orphan every descendant and
    leave vite holding ports (commit 41366505).

### Browser sub-package

- **Startup**: import time only. No I/O, no state. Module-init pure re-exports.
- **Ready criteria**: imports resolve.
- **Teardown**: none.

### Runtime (`manifest-emit`)

`emitManifest` lifecycle (`src/runtime/manifest-emit.ts:75-166`):

1. **Acquire**:
   - Read `Identity` to derive output path.
   - Resolve `ExtrasResolved` (memoized once at infra build time).
   - Run `snapshotAndWrite` eagerly (`emitManifest.ts:146`) — `gatherManifest`, encode, write
     atomic, chmod.
   - Fork a scoped repeater (`emitManifest.ts:152-158`) that re-runs `snapshotAndWrite` every 500ms.
   - Add a `Effect.addFinalizer` (`emitManifest.ts:161`) that runs `snapshotAndWrite` once more on
     scope close.
2. **During lifetime**:
   - The slow-tick re-snapshot picks up late-registered services. For example, the wallet
     primitive's endpoint can land AFTER the manifest factory's acquire has returned; the next tick
     catches it.
3. **Final flush**:
   - Scope close → finalizer runs → final `snapshotAndWrite` captures any teardown-time mutations.

### Runtime (`readStackContext{Sync}`)

Read-only; no lifecycle. Each call is independent.

---

## Hard requirements / invariants

Load-bearing constraints whose violation breaks integration. Each cited to file:line.

### Vite preset

1. **`$PORT` MUST win over `options.port`** when the supervisor sets it (`src/vite/index.ts:112`;
   asserted in `src/vite/index.test.ts:27-37`). Otherwise concurrent stacks all land on the same
   port and collide.

2. **`server.allowedHosts: ['.localhost']` MUST be set** (`src/vite/index.ts:118`; asserted in
   `src/vite/index.test.ts:10`). Without it, Vite's host allowlist rejects every traefik-routed
   request.

3. **`server.hmr.clientPort: 5175` MUST be set** (`src/vite/index.ts:125`; asserted in
   `src/vite/index.test.ts:11`). Otherwise the HMR client dials the local upstream port from the
   public router host.

4. **`server.watch.ignored` MUST include `'**/.devstack/**'`** (`src/vite/index.ts:108`; asserted in
   `src/vite/index.test.ts:12`). Otherwise vite full-reloads on every 500ms manifest re-snapshot.

5. **`build.target` and `optimizeDeps.esbuildOptions.target` MUST be ES2022**
   (`src/vite/index.ts:92,94`; asserted in `src/vite/index.test.ts:9`). The `createDevstackDappKit`
   async factory uses top-level await; the `@mysten/dapp-kit-*` peers ship ES2022.

6. **Per-stack manifest alias MUST resolve `'../../.devstack/manifest.json'` to the active stack's
   file** (`src/vite/index.ts:65-77,100`; asserted in `src/vite/index.test.ts:39-67`). The
   codegen-emitted `src/generated/manifest.ts` hardcodes the relative path; the alias retargets it
   to `.devstack/stacks/<stack>/manifest.json` (or `.devstack/manifest.json` for the `main` stack).
   Without this, `DEVSTACK_STACK=test playwright` would read the `main` stack's manifest.

### Vitest preset

7. **`@effect/vitest` MUST be declared as an optional peer dependency in `package.json`**
   (`package.json:71,80-82`; asserted in `src/vitest/index.test.ts:21-24`). Without it, pnpm hoist /
   npm dedup don't guarantee the subpath import resolves.

8. **`passWithNoTests: true`** MUST be on by default (`src/vitest/define-config.ts:31`; asserted in
   `src/vitest/define-config.test.ts:7-10`). Codegen-derived stacks without unit tests yet would
   fail CI otherwise.

### Playwright preset

9. **`webServer.gracefulShutdown: {signal: 'SIGTERM', timeout: 10_000}`** MUST be set
   (`src/playwright/web-server.ts:62`; asserted in `src/playwright/web-server.test.ts:80`).
   Otherwise SIGKILL on the shell orphans vite + supervisor descendants holding ports (commit
   41366505).

10. **`workers: 1, fullyParallel: false`** MUST be set (`src/playwright/define-config.ts:51-52`;
    asserted in `src/playwright/define-config.test.ts:33-34`). Devstack apps share one supervisor
    per stack; parallel tests would contend on the shared faucet / wallet / RPC.

11. **`webServer.url` MUST be settable at config-load time even when no manifest exists**
    (`src/playwright/web-server.ts:106-125`; asserted in
    `src/playwright/web-server.test.ts:93-112`). The cold-start fallback via
    `conventionalUrl(endpoint)` is the mechanism.

12. **Malformed manifest MUST throw a structured `ManifestShapeError` (not NPE)**
    (`src/playwright/web-server.ts:122-125` re-throws from `readStackContextSync`; asserted in
    `src/playwright/web-server.test.ts:129-169`).

13. **Manifest discovery MUST be stack-scoped only** (`src/runtime/discover-manifest.ts:107-119`;
    asserted in `src/runtime/discover-manifest.test.ts:83-92`). A stale flat
    `.devstack/manifest.json` would silently return wrong URLs / package ids for a deleted stack.
    The walk-up looks ONLY for `<stateDir>/stacks/<stack>/manifest.json`.

14. **`connectAs` MUST find the `Dev Wallet` by literal text and switch via
    `globalThis.__devstackDAppKit__`** (`src/playwright/helpers.ts:28,43-65`; asserted via
    source-text assertion in `src/playwright/helpers.test.ts:56-75`). Renaming either side of this
    contract silently breaks every consumer's e2e.

### Runtime (manifest contract)

15. **Manifest file mode MUST be `0o600`** (`src/runtime/manifest-emit.ts:61,138`; asserted in
    `src/runtime/manifest-emit.test.ts:102-111`). Extras may carry sensitive data.

16. **Atomic write (tmp + rename)** is load-bearing (`src/runtime/manifest-emit.ts:51-55` comment,
    implementation in `writeFileAtomicIfChanged`). Every reader does `readFileSync`, which races a
    truncate+rewrite. `rename(2)` is atomic on the same FS.

17. **Schema encode MUST happen BEFORE serialize** (`src/runtime/manifest-emit.ts:33,115-123`;
    deliberate design note at lines 27-32). A shape mismatch fails HERE at write time with the
    offending field path, not later as invalid JSON.

18. **`gatherManifest` MUST reflect late `eps.register` calls**
    (`src/runtime/service.test.ts:150-173`). The slow-tick re-snapshot in `manifest-emit` relies on
    this.

19. **Postgres URL MUST NOT carry credentials** (`src/runtime/service.ts:153-159`
    - comment; asserted in `src/runtime/service.test.ts:181-199`). The split is at the
      registry-shape level — `PostgresStateRecord.endpoint` is guaranteed plain by construction; the
      password lives in a separate field.

20. **`ExtrasResolved` MUST resolve ONCE per supervisor cycle** (`src/runtime/manifest-emit.ts:105`
    comment; asserted in `src/runtime/extras-consistency.test.ts:78-110`). Pre-fix, manifest-emit
    and each codegen emitter independently called `resolveExtras(yield* Extras)`; non-pure inputs
    (`() => ({ts: Date.now()})`) returned divergent values across artifacts.

21. **`DEVSTACK_MANIFEST_PATH` env var MUST win over `override:` arguments**
    (`src/runtime/discover-manifest.ts:74-87`; asserted in
    `src/runtime/discover-manifest.test.ts:47-52`). Top-level escape hatch.

22. **Browser subpath MUST NOT pull in node-only modules** (header comment in
    `src/browser/index.ts:6-21`). The main `.` barrel pulls in supervisor / docker / identity which
    import `node:path` + `node:fs`; even though Vite externalizes them, every property access throws
    at module-init in the browser. Verified by inspecting the built `dist/browser/index.mjs` for
    `import "node:*"` lines.

23. **`EndpointName` string values MUST match the literal record keys consumers key off**
    (`src/runtime/service.test.ts:208-220`). Renaming silently splits producer from consumer
    (codegen emitters, playwright helpers, on-disk manifest schema).

---

## Failure modes

### Vite preset

| Trigger                                    | Current behavior                                                                                                            | Recovery                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `$PORT` env var set to a non-numeric value | `Number(process.env.PORT)` returns NaN; falls through to `\|\| port` and uses the option default (`src/vite/index.ts:112`). | Set `$PORT` to a valid integer or unset it.                                            |
| Per-stack manifest doesn't exist           | Vite alias resolves to a non-existent path; first import of the codegen-emitted `manifest.ts` fails at bundle time.         | Run `devstack up` / `devstack apply` to materialize the manifest.                      |
| User `extend.server.hmr` is `false`        | Pass-through; HMR disabled (`src/vite/index.ts:124-126`).                                                                   | Documented behavior — user-supplied wins.                                              |
| Concurrent `vite` runs without supervisor  | Both pick `options.port` default; second binds-fail on EADDRINUSE.                                                          | Each app picks a distinct `options.port` fallback (`examples/arena/vite.config.ts:3`). |

### Vitest preset

| Trigger                                                                   | Current behavior                                                                                   | Recovery                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------- |
| User's `vitest.config.ts` imports `@effect/vitest` but it's not installed | `Cannot find package '@effect/vitest'` at runtime (the optional peer warning was the only signal). | `pnpm add -D @effect/vitest`. |
| No unit tests in the project                                              | `passWithNoTests: true` lets it pass silently (`src/vitest/define-config.ts:31`).                  | Intentional behavior.         |

### Playwright preset

| Trigger                                                                               | Current behavior                                                                                                                                                                                                                                   | Recovery                                                                                  |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Manifest doesn't exist at config-load time (cold start)                               | `webServer` falls back to `conventionalUrl(endpoint)` (`src/playwright/web-server.ts:109-122`). The spawned `pnpm dev` materializes the real manifest.                                                                                             | Designed behavior.                                                                        |
| Endpoint not in conventional-routes AND no manifest                                   | Throws `no manifest at … and endpoint 'X' has no conventional URL fallback` (`src/playwright/web-server.ts:113-121`).                                                                                                                              | Use a supported endpoint name, or run `devstack apply` first to materialize the manifest. |
| Endpoint name typo (not in manifest, conventional fallback failed for another reason) | Throws `no endpoint 'X' in manifest at <path>. Check the plugin that's supposed to emit it.` (`src/playwright/web-server.ts:127-133`).                                                                                                             | Fix the typo or wire the plugin to publish that endpoint.                                 |
| Manifest exists but is malformed (missing `services` / `app`)                         | Throws `manifest at <path> does not match the manifest schema (hand-edited shape ...). RECOVERY: rm -rf .devstack/manifest.json .devstack/stacks/*/manifest.json && devstack apply` (`src/runtime/read-stack-context.ts:154-164`).                 | Run the suggested recovery.                                                               |
| Manifest exists but is corrupt JSON                                                   | Throws `manifest at <path> is not valid JSON. ... RECOVERY: rm <path> && devstack apply` (`src/runtime/read-stack-context.ts:141-149`).                                                                                                            | Run the suggested recovery.                                                               |
| `webServer.command` (default `pnpm dev`) exits non-zero before timeout                | Playwright reports startup failure.                                                                                                                                                                                                                | Read the spawned process's stderr; bring up the stack manually to diagnose.               |
| Test exceeds `webServer.timeout` (default 300s for preset, 120s for low-level)        | Playwright kills the spawn and reports timeout.                                                                                                                                                                                                    | For walrus/seal cold-start (first image pull), bump to ~900s.                             |
| User does not populate `globalThis.__devstackDAppKit__`                               | `connectAs` throws `connectAs: globalThis.__devstackDAppKit__ missing. Add ...` with instructions (`src/playwright/helpers.ts:47-51`).                                                                                                             | Add the slot assignment in the app's `dapp-kit.ts`.                                       |
| `connectAs` cannot find Dev Wallet                                                    | Throws `connectAs: Dev Wallet not registered` (`src/playwright/helpers.ts:54`).                                                                                                                                                                    | Check that the dev-wallet emitter ran and registered the wallet.                          |
| `connectAs` label doesn't match any account                                           | Throws `connectAs: no account labelled "X" on Dev Wallet` (`src/playwright/helpers.ts:58-60`).                                                                                                                                                     | Fix the label or check the manifest accounts list.                                        |
| Test process killed without graceful shutdown                                         | Could orphan vite. The `gracefulShutdown` wiring prevents this for Playwright-driven runs.                                                                                                                                                         | For other launchers, ensure SIGTERM propagation.                                          |
| `loadStackKeypair` called for an account that hasn't been funded yet                  | `ENOENT` → throws `[devstack/playwright] no account key at <path> for 'X'. Either the account name is wrong, or the supervisor hasn't funded it yet — run \`devstack up\` (or \`devstack apply\`) first.` (`src/playwright/artifacts.ts:107-114`). | Run the recovery, or wait for funding.                                                    |
| `loadStackManifest` called before `devstack up`                                       | Throws `ManifestDiscoveryError` via `discoverManifestPath({required: true})` (`src/playwright/artifacts.ts:63-75`).                                                                                                                                | Run `devstack up`.                                                                        |

### Runtime (`manifest-emit`)

| Trigger                                                                         | Current behavior                                                                                                                                                                            | Recovery                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Atomic-write fails (disk full, EACCES)                                          | `ManifestError` raised; current code does `Effect.catch` + `Effect.logWarning` and returns `false` (`src/runtime/manifest-emit.ts:126-132`). Reader is left with whatever was there before. | Free disk space / fix permissions; next 500ms tick re-attempts.              |
| `Schema.encodeUnknownSync` rejects (`gatherManifest` produced a shape mismatch) | `ManifestError` raised with the offending field path; same `Effect.catch + log + return false` behavior (`src/runtime/manifest-emit.ts:115-123`).                                           | Fix the registry shape that's diverging.                                     |
| Identity not provided                                                           | Compile-time error (Effect requirement); won't reach runtime.                                                                                                                               | Provide Identity layer.                                                      |
| `chmod` fails after rename                                                      | `Effect.ignore({log: true})` swallows it with a log line (`src/runtime/manifest-emit.ts:139`).                                                                                              | File still written with whatever mode rename inherited; next tick re-chmods. |

### Runtime (`readStackContext`)

| Trigger                                         | Current behavior                                                                                                              | Recovery                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Manifest missing                                | `ManifestDiscoveryError` (phase: `required-missing` or `walk-up` depending on which precedence branch fired).                 | Run `devstack up` or check env var paths. |
| Manifest corrupt JSON                           | `ManifestShapeError(phase: 'parse')` with `RECOVERY: rm ... && devstack apply` (`src/runtime/read-stack-context.ts:141-149`). | Run the recovery.                         |
| Manifest wrong shape                            | `ManifestShapeError(phase: 'shape')` with same RECOVERY recipe (`src/runtime/read-stack-context.ts:154-164`).                 | Run the recovery.                         |
| Effect surface caller wants structured handling | Both error types have `Schema.TaggedErrorClass` so `Effect.catchTags({ ManifestDiscoveryError, ManifestShapeError })` works.  | Use `Effect.catchTags`.                   |

### Browser

No runtime failures at this layer — it's a pure re-export. The historical failure (blank page,
"Module 'node:path' has been externalized for browser compatibility") was the reason for the
subpath; the subpath PREVENTS that class of failure by partitioning the import graph.

---

## Persistence model

### Survives `devstack` restart (process-local supervisor restart)

- `.devstack/stacks/<stack>/manifest.json` on disk (written by `emitManifest`, read by every
  consumer).
- `.devstack/stacks/<stack>/runtime/accounts/<name>.key` files (written elsewhere; consumed by
  `loadStackKeypair`).

### Survives snapshot

The build-integration component itself doesn't deal with snapshots, but the manifest is part of the
supervisor's persistent state and is regenerated deterministically from the registries on the next
supervisor run. The keypair files survive snapshot because they're written by the account funding
step.

### Wiped on `devstack wipe`

Per the cli component (outside this doc's scope), `devstack wipe` would delete `.devstack/`. The
build-integrations would then fall back to cold-start URL behavior on the next read.

### Process-local only

- The `defineEndpoint` declaration registry in `engine/define-endpoint.ts` (`declarations` Map at
  line 65). Module-init populates it from `endpoint-names.ts`; tree-shaking concern noted at
  `src/runtime/conventional-routes.ts:16-22,30-37`.
- `process.env.PORT`, `process.env.DEVSTACK_*` — read at each helper call, not cached.
- The Vite / Vitest / Playwright preset returns are fresh `UserConfig` / `PlaywrightTestConfig`
  objects each call; no caching.

---

## Modes & variants

The component spans multiple build tools, each with its own modes. Per the template's MUST:
table-form, one column per mode, one row per lifecycle dimension. "Same" cells acceptable.

### Vite modes

| Dimension         | dev (`vite`)                                                                                                               | build (`vite build`)                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Container         | none — vite spawns in the host process                                                                                     | none — esbuild + rolldown via vite                                                                                                        |
| Startup sequence  | Read `$PORT` / `DEVSTACK_STACK` env, compute manifest alias, return `UserConfig`. Vite mounts server on the resolved port. | Same `UserConfig`; vite runs the build instead of serving. `$PORT` is irrelevant.                                                         |
| Ready criteria    | Vite reports dev server up                                                                                                 | Vite reports build complete                                                                                                               |
| Persistence       | None at this layer (vite owns its dev cache)                                                                               | Produces `dist/` (per vite defaults)                                                                                                      |
| Teardown          | SIGTERM from `pnpm dev` parent → vite cleanup → port released                                                              | Process exits naturally                                                                                                                   |
| Failure modes     | Manifest alias resolves to missing file: bundle error at first import. Port collision: EADDRINUSE.                         | Same alias-resolution failure mode applies. No port collision.                                                                            |
| Dependencies      | `@vitejs/plugin-react`, `@tailwindcss/vite`, `vite`                                                                        | Same                                                                                                                                      |
| Hard requirements | All Vite invariants 1-6 apply.                                                                                             | Invariants 5 (`build.target: 'es2022'`) and 6 (manifest alias) apply. Invariants 1-4 (port / HMR / allowedHosts / watch) are server-only. |

### Vitest modes

| Dimension         | run (`vitest run`)                                                                                              | watch (`vitest` / `vitest --watch`)                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Container         | none                                                                                                            | none                                                                          |
| Startup sequence  | Vitest loads `vitest.config.ts` → `defineDevstackVitestConfig` returns a config object. Vitest runs tests once. | Same config object; Vitest watches `src/**/*.{test,spec}.ts?(x)` and re-runs. |
| Ready criteria    | Tests complete                                                                                                  | Watcher runs                                                                  |
| Persistence       | None                                                                                                            | None                                                                          |
| Teardown          | Process exits                                                                                                   | Ctrl-C → vitest exits                                                         |
| Failure modes     | `Cannot find package '@effect/vitest'` if not installed and used.                                               | Same                                                                          |
| Dependencies      | `vitest`, optionally `@effect/vitest`                                                                           | Same                                                                          |
| Hard requirements | Invariants 7-8 apply (peer + passWithNoTests).                                                                  | Same                                                                          |

There is **no chain-mode dimension** in vitest today — the deleted `withDevstack(handle)` shim was
the chain-mode hook. The current pattern (per the header comment) is to call `@effect/vitest`'s
`it.layer(stack.layer)` directly in the test file, which doesn't go through this preset.

### Playwright modes

| Dimension         | local dev (`!CI`)                                                                                                                                                                      | CI (`CI=1`)                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Container         | none directly — Playwright spawns headless chromium; supervisor (spawned via `pnpm dev`) brings up its containers separately                                                           | Same                                                                                            |
| Startup sequence  | Load config → resolve manifest (cold-start fallback OK) → spawn `pnpm dev` UNLESS already running (`reuseExistingServer: true`) → wait for `webServer.url` (300s default) → run tests. | Same, except `reuseExistingServer: false` — always spawn fresh.                                 |
| Ready criteria    | `webServer.url` responds                                                                                                                                                               | Same                                                                                            |
| Persistence       | Snapshots in `e2e/` (Playwright defaults). Manifest file persists across runs (reused if `reuseExistingServer` hits).                                                                  | Same; persistence may or may not survive across CI jobs depending on runner cache.              |
| Teardown          | SIGTERM via `gracefulShutdown` to `pnpm dev` shell → supervisor finalizers → vite SIGTERM. SIGKILL after 10s.                                                                          | Same                                                                                            |
| Failure modes     | All the playwright failure modes in the table above. No retries.                                                                                                                       | All the same, plus `retries: 2`. `forbidOnly: true` (test files with `test.only` fail the run). |
| Dependencies      | `@playwright/test`, the supervisor itself                                                                                                                                              | Same                                                                                            |
| Hard requirements | Invariants 9-14 apply. `reuseExistingServer: true` is load-bearing for dev iteration speed.                                                                                            | Invariants 9-14 apply.                                                                          |
| Reporter          | `'list'`                                                                                                                                                                               | `[['github'], ['list']]` — GitHub Actions annotations + list output.                            |
| `forbidOnly`      | `false`                                                                                                                                                                                | `true`                                                                                          |
| `retries`         | `0`                                                                                                                                                                                    | `2`                                                                                             |

Playwright also has headed vs. headless dimensions configured via CLI flags, but the preset doesn't
differentiate them — it just configures the
`projects: [{name: 'chromium', use: { ...devices['Desktop Chrome'] }}]`.

### Browser sub-package

Single mode — pure re-exports; no variants.

### Runtime sub-component

| Dimension         | producer (`emitManifest` in supervisor)                                                                                                | consumer-sync (`readStackContextSync` in Playwright)                                                           | consumer-Effect (`readStackContext` in CLI / codegen)                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Container         | none                                                                                                                                   | none                                                                                                           | none                                                                                      |
| Startup sequence  | Acquire reads `Identity` + `ExtrasResolved`; eager `snapshotAndWrite`; fork scoped 500ms repeater; register finalizer for final flush. | `discoverManifestPath({required: true})` → `readFileSync` → `parseAndDecode` → `project`. Throws on any error. | Same logic wrapped in `Effect.tryPromise` / `Effect.try` with structured failure channel. |
| Ready criteria    | Eager write returned                                                                                                                   | Returns `StackContext`                                                                                         | Effect succeeds                                                                           |
| Persistence       | `.devstack/stacks/<stack>/manifest.json` 0o600                                                                                         | None                                                                                                           | None                                                                                      |
| Teardown          | Final-flush snapshot on scope close                                                                                                    | None                                                                                                           | None                                                                                      |
| Failure modes     | Atomic write / chmod / encode failures are caught + logged + return `false`; next tick retries. Cause is preserved.                    | `ManifestDiscoveryError` (missing) / `ManifestShapeError` (corrupt or wrong shape) thrown verbatim.            | Same errors on the Effect failure channel.                                                |
| Dependencies      | All 14 service registries + `Identity` + `ExtrasResolved` + `Scope`                                                                    | Filesystem + the manifest file existing somewhere up the walk-up.                                              | Same                                                                                      |
| Hard requirements | Invariants 15-18, 20, 23.                                                                                                              | Invariants 13, 21, 23.                                                                                         | Same as sync.                                                                             |

---

## Test coverage

### `src/vite/index.test.ts` — `defineDevstackViteConfig`

Six `it` blocks under `describe('defineDevstackViteConfig')` (`src/vite/index.test.ts:4`):

- `emits the canonical plugin set + server defaults at minimum invocation` (lines 5-13) — asserts at
  least 2 plugins (react + tailwind), `build.target === 'es2022'`,
  `allowedHosts === ['.localhost']`, `hmr.clientPort === 5175`,
  `watch.ignored === ['**/.devstack/**']`.
- `honors the port option as $PORT fallback` (lines 15-25) — deletes `$PORT`, asserts the configured
  option fallback wins.
- `lets the supervisor-assigned $PORT win over the configured fallback` (lines 27-37) — sets
  `$PORT=5199`, asserts that wins over `port: 5176`.
- `aliases the hardcoded manifest path to the active stack` (lines 39-52) — sets
  `DEVSTACK_STACK=test`, asserts the resolve.alias entry points to
  `<appDir>/.devstack/stacks/test/manifest.json`.
- `uses the flat manifest path on the main stack` (lines 54-67) — deletes `DEVSTACK_STACK`, asserts
  the alias points to `<appDir>/.devstack/manifest.json` (the special-case `main` path).
- `appends extraPlugins after the bundled react+tailwind set` (lines 69-75) — asserts the marker
  plugin is appended last.
- `passes through unknown top-level keys via extend` (lines 77-80) — asserts `cacheDir` from
  `extend` lands at top level.

### `src/vitest/index.test.ts` — peer-dependency contract

One `it` block under `describe('vitest subpath peer dependency contract')`:

- `declares @effect/vitest as an optional peer` (lines 21-24) — asserts the `peerDependencies` and
  `peerDependenciesMeta` entries in `package.json`.

### `src/vitest/define-config.test.ts` — `defineDevstackVitestConfig`

Two `it` blocks under `describe('defineDevstackVitestConfig')`:

- `emits the canonical test config at minimum invocation` (lines 5-10) — asserts `include`,
  `exclude`, `passWithNoTests`.
- `merges user-supplied test fields over the defaults` (lines 12-16) — asserts user
  `passWithNoTests: false` wins; `include` survives.

### `src/playwright/define-config.test.ts` — `defineDevstackPlaywrightConfig`

Four `it` blocks under `describe('defineDevstackPlaywrightConfig')` plus `beforeEach`/`afterEach`
env management (lines 9-28):

- `emits the canonical playwright config at minimum invocation` (lines 30-39) — asserts `testDir`,
  `fullyParallel: false`, `workers: 1`, `use.trace`, `use.screenshot`, first project is chromium.
- `defaults webServer timeout to 300s` (lines 41-45).
- `honors the timeout option (e.g. for walrus cold-start)` (lines 47-51) — asserts
  `timeout: 900_000` propagates.
- `passes through use overrides via extend.use` (lines 53-60) — asserts `extend.use.trace` wins
  while preset defaults survive.

### `src/playwright/helpers.test.ts` — public surface + selector contracts

Source-text assertions (no real browser invocation).

Three `it` blocks under `describe('playwright/helpers — public surface')`:

- `exposes connectAs and selectAccount` (lines 34-37).
- `connectAs accepts (page, label) — arity 2` (lines 39-44).
- `selectAccount accepts (select, name) — arity 2` (lines 46-48).

Three `it` blocks under `describe('playwright/helpers — selector contracts')` (lines 51-76):

- `connectAs queries mysten-dapp-kit-connect-button + connect-modal` (lines 56-59).
- `connectAs filters the dev wallet by the literal text 'Dev Wallet'` (lines 61-67).
- `connectAs reads kit from globalThis.__devstackDAppKit__` (lines 69-75).

The file deliberately omits `connectAs` happy-path coverage (lines 13-20) — handled by example apps'
real e2e suites against a live dev wallet.

### `src/playwright/web-server.test.ts` — webServer / baseURL

`beforeEach` / `afterEach` (lines 49-65) set up a tmp manifest dir and env-vars; teardown restores.

Six `it` blocks under `describe('webServer()')`:

- `resolves dev-server URL from manifest + stamps PLAYWRIGHT=1 + 10s SIGTERM` (lines 68-81) —
  asserts URL, `command`, `timeout`, `env.PLAYWRIGHT`, and
  `gracefulShutdown: {signal: 'SIGTERM', timeout: 10_000}`.
- `resolves sui-rpc URL via the nested services.sui.rpc projection` (lines 83-91).
- `cold-start: with no manifest on disk, falls back to the conventional URL` (lines 93-104).
- `cold-start fallback honors DEVSTACK_STACK by prefixing the host` (lines 106-112).
- `throws when the endpoint is not in the manifest` (lines 114-122).
- `throws a clear error on a malformed manifest (no top-level services)` (lines 124-151) — asserts
  the schema-reject path with the RECOVERY recipe; specifically DOES NOT NPE.
- `throws on a manifest with services but missing app` (lines 153-169).
- `throws on cold-start when the endpoint has no conventional fallback` (lines 171-182).
- `respects opts.command / opts.timeout / opts.extend` (lines 184-200).

Two `it` blocks under `describe('baseURL()')`:

- `returns the bare URL string for the named endpoint` (lines 204-209).
- `mirrors webServer cold-start fallback when no manifest exists` (lines 212-217).

One `it` block under `describe('readAppName behavior (via cold-start URL)')`:

- `strips @scope/ prefix from package.json name` (lines 221-241) — chdirs into a fake app with
  `name: '@my-org/my-app'` and asserts the cold-start URL is `http://dev.my-app.localhost:5175`.

### `src/runtime/discover-manifest.test.ts` — `discoverManifestPath`

`beforeEach` / `afterEach` (lines 22-45) for tmp dir + env-var restoration.

Eleven `it` blocks at the top level of `describe('discoverManifestPath')`:

- `returns the path from DEVSTACK_MANIFEST_PATH when set and the file exists` (lines 47-52).
- `returns undefined when DEVSTACK_MANIFEST_PATH points at a missing file` (lines 54-57).
- `throws on a missing DEVSTACK_MANIFEST_PATH when required: true` (lines 59-64).
- `returns the override path when it exists, ignoring walk-up` (lines 66-74).
- `finds the stack-scoped manifest at the cwd level` (lines 76-81).
- `ignores a stale flat manifest — only stack-scoped paths count` (lines 83-92) — load-bearing for
  invariant 13.
- `honors the DEVSTACK_STACK env var when picking the stack-scoped path` (lines 94-102).
- `walks up from a nested cwd to find the stack-scoped manifest at a parent dir` (lines 104-111).
- `returns undefined when no candidate exists anywhere up the tree` (lines 113-119).
- `throws a guiding error on miss when required: true` (lines 121-129).
- `honors an explicit stateDir option that overrides .devstack` (lines 131-137).

Two `it` blocks under nested `describe('nested-project walk-up')` (lines 149-177):

- `returns the inner manifest when cwd is inside the inner project (closest wins)` (lines 161-166).
- `returns the outer manifest when cwd is inside the outer project but outside the inner one` (lines
  168-176).

### `src/runtime/read-stack-context.test.ts` — `readStackContext{Sync}`

`beforeEach` / `afterEach` (lines 60-80) for tmp dir + env-var restoration.

Three `it` blocks under `describe('well-formed manifest')`:

- `readStackContextSync — projects sui, dev, wallet, endpoint(name)` (lines 87-103).
- `readStackContext (Effect) — same projection via the Effect surface` (lines 105-110).
- `walks up from a nested cwd via DEVSTACK_STATE_DIR + DEVSTACK_STACK` (lines 112-119).

Three `it` blocks under `describe('malformed manifest')`:

- `readStackContextSync — wrong shape … throws ManifestShapeError` (lines 127-147).
- `readStackContext (Effect) — wrong shape fails with ManifestShapeError on the failure channel`
  (lines 149-161).
- `readStackContextSync — corrupt JSON throws ManifestShapeError with phase=parse` (lines 163-178).

Three `it` blocks under `describe('missing manifest')`:

- `readStackContextSync — no manifest on disk throws ManifestDiscoveryError` (lines 186-196).
- `readStackContextSync — explicit manifestPath that does not exist throws ManifestDiscoveryError`
  (lines 198-207).
- `readStackContext (Effect) — missing manifest surfaces ManifestDiscoveryError on the failure channel`
  (lines 209-220).

### `src/runtime/manifest-emit.test.ts` — `emitManifest`

`beforeEach` / `afterEach` (lines 65-71) for tmp output dir.

Five `it.effect` blocks under `describe('emitManifest')`:

- `eager-writes a well-formed manifest on acquire (consumers can read immediately)` (lines 75-100) —
  seeds registries, runs `emitManifest`, asserts the file exists immediately and the parsed body
  matches.
- `writes the manifest with mode 0o600 (extras may be sensitive)` (lines 102-111).
- `propagates Extras into app.extras` (lines 113-126).
- `final flush on scope close picks up late-registered state` (lines 128-155) — registers wallet
  endpoint AFTER acquire returns, then closes the scope, asserts the final-flush finalizer wrote the
  late registration to disk.
- `honors the explicit output path override` (lines 157-167).

### `src/runtime/service.test.ts` — `gatherManifest`

Five `it.effect` blocks under `describe('gatherManifest')`:

- `builds a snapshot from seeded registries` (lines 97-127) — seeds pkgs, endpoints, accounts,
  coins; asserts every projection (services.sui.rpc/faucet/network, walrus, app.wallet,
  packages.hello, accounts.alice, coins.musdc).
- `omits services.sui when no sui-rpc endpoint is registered` (lines 129-136).
- `passes the extras argument through to app.extras` (lines 138-143).
- `gatherManifest reflects late eps.register calls` (lines 150-173) — load-bearing for the slow-tick
  re-snapshot pattern.
- `manifest postgres endpoint URL never contains credentials` (lines 181-199) — invariant 19.

One `it` block under `describe('EndpointName constants')`:

- `match the canonical registry string values` (lines 209-219) — locks down the literal strings
  every consumer keys off.

### `src/runtime/extras-consistency.test.ts` — `ExtrasResolved` consistency

One `it.effect` block under `describe('ExtrasResolved consistency')`:

- `manifest.app.extras and stack-handle extras.ts carry the SAME blob` (lines 70-110) — uses a
  counter `Ref` that increments on every call; asserts the function is called exactly once total
  across both producers (manifest-emit and codegen StackHandleEmitter).

### `src/browser/`

No tests. The 27-LOC file is a barrel re-export; correctness is asserted by the build-time check
(header comment lines 18-20): `dist/browser/index.mjs` must contain no `import "node:*"` lines.

---

## Pain points today

1. **The `runtime/` directory is cross-cutting and doesn't cleanly belong to the build-integrations
   component.** Service code (every `services/*.ts` factory) imports `EndpointName` from it; codegen
   emitters import `gatherManifest` from it; CLI commands import `readStackContext` from it;
   build-integrations import `discoverManifestPath`, `readStackContextSync`, `conventionalUrl`. The
   directory name "runtime" obscures that it's really "manifest produce + consume". See Open
   questions for the scope-ownership debate.

2. **Endpoint name <→ manifest-field mapping is in three places.** `runtime/endpoint-names.ts`
   declares `defineEndpoint(...)` with `manifestField: {path: 'services.sui.rpc'}` (line 30-32). The
   grouper in `runtime/service.ts` reads the metadata (`manifestLeafUnder` lines 55-61) for the
   structured projection. The flat-endpoint lookup table in `runtime/read-stack-context.ts:96-115`
   independently re-maps the same endpoints. Adding a new endpoint can leave one of the three out of
   sync silently — only invariant 23's regression test catches it for `EndpointName.*` literal
   values, not for the manifest-field path.

3. **`runtime/conventional-routes.ts` carries a tree-shaking footgun.** The comment at lines 16-22
   explains that a bare value-import of `endpoint-names.ts` got stripped by rolldown, leaving
   `CONVENTIONAL_ROUTES` empty at module-init. The current workaround is an IIFE
   `if (EndpointName.SUI_RPC === undefined) throw` (lines 34-37) that anchors the value-import.
   Subtle and fragile — any future refactor of the import structure could re-introduce this.

4. **`webServer` cold-start fallback can lie silently.** When no manifest exists, the helper
   computes `conventionalUrl(endpoint)` and returns it as the URL. The user gets no warning that the
   fallback fired. If the supervisor's eventual manifest disagrees with the conventional URL
   (different stack name, different port), playwright's `webServer.url` wait would never resolve.
   (Comment at `src/playwright/web-server.ts:95-103` says they should converge — but it's an
   unenforced convention.)

5. **`connectAs` couples devstack to `@mysten/dapp-kit`'s web-component names.** Renames upstream
   silently break every consumer's e2e. The source-text assertion in `helpers.test.ts:56-66` would
   catch the selector rename in unit test, but not catch a behavior change in dapp-kit that requires
   a different flow.

6. **`globalThis.__devstackDAppKit__` is a side-channel contract.** The example app must spread the
   slot assignment into its `dapp-kit.ts` (`src/playwright/helpers.ts:18-22` lists the boilerplate).
   Forgetting it produces a confusing "kit is undefined" runtime error. No type-system help on the
   user's side.

7. **`reuseExistingServer: !process.env.CI`** can mask real problems on a dev machine when a stale
   supervisor is left running between e2e iterations. Manifest may be on disk but stale; tests pass
   against yesterday's state.

8. **Vite preset hard-codes `react()` + `tailwindcss()`.** Apps that don't want React or Tailwind
   have no clean way to opt out — `extraPlugins` can only ADD, not REMOVE. The merge logic in
   `stripHandledKeys` doesn't help here. See Opportunities.

9. **`webServer.timeout` precedence is awkward.** The low-level `webServer()` defaults to 120_000
   (`src/playwright/web-server.ts:45`), but the preset overrides to 300_000
   (`src/playwright/define-config.ts:46`). Two different defaults for the same knob depending on
   entry point.

10. **`manifest-emit` swallows write failures into `Effect.logWarning` + `return false`**
    (`src/runtime/manifest-emit.ts:126-132`). Repeated failures don't degrade the supervisor; the
    consumer's read just gets stale data. There's no surface saying "the manifest write is broken".

11. **`Vite` peer is "optional"** in `package.json:74-77,90-92`. A user importing
    `@mysten-incubation/devstack/vite` without `vite` installed gets a load-time error. The
    "optional" categorization is to support callers who use other subpaths (`/playwright`,
    `/vitest`) without Vite — but the runtime error is unfriendly when they DO need Vite.

12. **The browser sub-package's bundle hygiene check is manual** (`src/browser/index.ts:18-20`
    comment says "check `dist/browser/index.mjs` after a build: it must NOT contain any
    `import "node:*"` lines"). No automated test gates a regression.

13. **`sdk-coin.ts` lives in `runtime/`** but is exported via `services/package.ts:140`.
    Cross-component file with no obvious home; the comment explains "lives in `runtime/` because the
    manifest's `SdkCoinEntry` is the canonical destination" but a reader landing in runtime/ doesn't
    know to look in services/package.ts for the re-export.

14. **Manifest schema and codegen are tightly coupled but not in the same component.** The schema in
    `runtime/manifest-schema.ts` defines what codegen emits. Schema additions require coordinated
    changes across at least `manifest-schema.ts`, `service.ts` (grouper), `endpoint-names.ts` (if a
    new endpoint), `read-stack-context.ts` (projection), and the codegen emitter that consumes it.

15. **No version field in the manifest.** A manifest written by an older devstack and read by a
    newer one (or vice versa) has no version discriminator. Schema-decode failures are the only
    signal; the `RECOVERY: ... && devstack apply` recipe is the only response.

---

## Open questions

1. **Scope of `runtime/`** — The task brief notes 2283 LOC and asks whether it's "service-runtime
   helpers" or build-integration substrate. The answer is **both**: services produce manifest data
   via the registries that `gatherManifest` reads; build integrations consume the resulting on-disk
   manifest. The doc treats runtime/ as build-integration substrate because every read path
   (Playwright `webServer`, Vite alias-target, CLI `status`) lives in build-integration adjacent
   code. But the WRITE path (`emitManifest`) belongs to the supervisor lifecycle. **Architecture
   should resolve whether `runtime/` is one component or two (read-substrate + write-substrate).**

2. **Vitest devstack lifecycle** — The deleted `withDevstack(handle)` shim used to bring up a stack
   inside vitest. The header comment at `src/vitest/index.ts:9-17` says the replacement pattern is
   `@effect/vitest`'s `it.layer(stack.layer)`. But the same header (line 20) ALSO mentions a
   `../playwright/setup-devstack.ts` as "out-of-band bring-up for non-Effect harnesses" — that file
   does NOT exist anywhere under `src/playwright/`. Either the comment is stale, or the file was
   never written. **OPEN QUESTION: Is there an out-of-band devstack-bring-up path for non-Effect
   vitest, or is the `it.layer` pattern the only one?**

3. **What does the example apps' Playwright suite assert about `connectAs`?** The unit tests in
   `helpers.test.ts` pin selectors but not behavior. The deeper coverage is "by the example apps'
   playwright e2e suites that run against a live dev wallet". We do not enumerate those suites here.
   **OPEN QUESTION: Where are the live-browser tests that cover `connectAs` happy-path documented?**

4. **`webServer.url` cold-start convergence is unenforced** — Comment in
   `src/playwright/web-server.ts:95-103` says "the URL we computed converges with what the
   supervisor wires". **OPEN QUESTION: Is there a test anywhere that asserts these two URLs MATCH
   for every registered endpoint?** None found in the visible test files.

5. **`gracefulShutdown` SIGTERM propagation** — Tested at the `webServer.gracefulShutdown` config
   level (`web-server.test.ts:80`) but not for the actual SIGTERM → pnpm → supervisor → vite chain.
   **OPEN QUESTION: Is there an integration test that asserts the entire process tree cleans up?**
   Commit message 41366505 (referenced in comments) suggests the fix was empirical, not test-driven.

6. **`@mysten/sui` is NOT in `peerDependencies`** (per `package.json:62-92` inspection; it's in
   `dependencies` at line 60). But the `loadStackKeypair` helper depends on
   `@mysten/sui/cryptography` and `@mysten/sui/keypairs/ed25519`. Browser-side
   `localnetWalrusOptions` re-export chain may or may not pull `@mysten/sui` into the browser
   bundle. **OPEN QUESTION: Is the bundle-hygiene story (`browser/` doesn't pull in `node:*`)
   automatically verified, or does the same manual-check disclaimer apply to
   non-node-but-still-large deps like `@mysten/sui`?**

7. **`DEVSTACK_STATE_DIR` is consumed by `discoverManifestPath` but `vite/index.ts` hard-codes
   `'./.devstack/'`** (`src/vite/index.ts:73-77, 100`). If a user sets
   `DEVSTACK_STATE_DIR=.custom-state`, the supervisor would write to `.custom-state/...` but Vite's
   alias-target wouldn't follow. **OPEN QUESTION: Should the Vite preset honor
   `DEVSTACK_STATE_DIR`?**

8. **`runtime/` has 2283 LOC, ~60% of the doc's total scope LOC.** That's a lot of substrate for a
   build-integration doc. Per the template, in-scope means the file goes here; per the brief's
   actual concern, service code produces data into the manifest. \*\*OPEN QUESTION: Should
   `manifest-schema.ts` and `service.ts` (the grouper) be its own doc, with `discover-manifest.ts` +
   `read-stack-context.ts` + `conventional-routes.ts`
   - `endpoint-names.ts` staying with build-integrations?\*\*

9. **`sdk-coin.ts`**'s home is unclear — placed in `runtime/` but exported via
   `services/package.ts`. Documented here per "every file under `runtime/`" in the brief, but it's
   not build-integration code. **OPEN QUESTION: Move to `services/coin/` and re-export from
   `runtime/` for the manifest projection?**

10. **`Wave 6.5` references in `endpoint-names.ts:108-109`** mention
    `notes/review-followups.md §8.5` and `packages/devstack/notes/sui-fork-integration.md` for the
    `SUI_CHECKPOINT_VOLUME` keep-decision. Those notes weren't consulted in this read pass. **OPEN
    QUESTION: Is the `SUI_CHECKPOINT_VOLUME` constant still load-bearing, or has the sui-fork
    integration moved past it?**

11. **`coins` section in the manifest carries `sdkCoin`** which is fully derivable from
    `(type, decimals)` via `toSdkCoin()` (`runtime/sdk-coin.ts:19-30`, used at
    `src/runtime/service.ts:330`). It's stored in the on-disk manifest anyway. **OPEN QUESTION: Why
    store the derived value? Possibly to lock the value in case `toSdkCoin` evolves — but no comment
    explains.**

12. **`reuseExistingServer: !process.env.CI`** — a single boolean derived from env. Some users may
    want CI to also reuse (e.g. test sharding where a previous shard left a stack up). **OPEN
    QUESTION: Is this settable via `options.webServer.extend.reuseExistingServer`, or does the
    user's `extend` get clobbered by the `...opts.extend` spread at
    `src/playwright/web-server.ts:63`?** The spread suggests user-supplied `reuseExistingServer`
    would win, but documented as opaque behavior.

---

## Opportunities noticed

1. **Vite preset hard-codes React + Tailwind.** A non-React app cannot use
   `defineDevstackViteConfig`. Refactor to factor `{plugins: [react(), tailwindcss()]}` into the
   default but allow `options.framework: 'react' | 'preact' | 'vanilla'` or accept `options.plugins`
   as a full replacement rather than `extraPlugins` (append-only). Comment for context:
   `src/vite/index.ts:30-32` already separates the bundled plugins from `extraPlugins`.

2. **Three-place endpoint metadata** (declaration in `endpoint-names.ts`, structured projection in
   `service.ts`, flat lookup in `read-stack-context.ts:96-115`). The first two share metadata via
   `defineEndpoint`. The third independently re-derives the mapping. Consolidate so adding an
   endpoint = one declaration. The grouper's `manifestLeafUnder` (lines 55-61) is the pattern —
   extend it to drive the flat lookup table too.

3. **Browser bundle hygiene check is manual.** Add a built-time test:

   ```
   it('browser bundle contains no node:* imports', () => {
     const dist = readFileSync('dist/browser/index.mjs', 'utf8');
     expect(dist).not.toMatch(/from\s+['"]node:/);
   });
   ```

   per the disclaimer in `src/browser/index.ts:18-20`.

4. **`sdk-coin.ts` location.** Move to `services/coin/sdk-coin.ts`. It's tested by manifest tests
   but conceptually belongs with the Coin primitive. Update the `services/package.ts:140` re-export
   and the manifest grouper import accordingly.

5. **`webServer.timeout` default split** between low-level (120s) and preset (300s) is confusing.
   Unify on 300s (the realistic cold-start window) for both; cite the walrus/seal cold-start comment
   at `src/playwright/web-server.ts:19-21` and `src/playwright/define-config.ts:16`.

6. **Cold-start URL convergence is asserted by humans, not tests.** Generate a test that, for each
   endpoint in `listEndpointDeclarations()` with `manifestField` set, verifies the conventional URL
   pattern matches what the manifest grouper would emit given a known Identity. Catches drift
   between the two derivations.

7. **`Effect.logWarning + return false`** in `manifest-emit.ts:126-132` silently degrades. Add a
   `WarningSink` channel (or surface a `failed` field on the eager-write return) so the supervisor
   can prominently display "manifest writes are failing" in the TUI / status output. Or tear the
   supervisor down on repeated failures.

8. **`globalThis.__devstackDAppKit__` slot has no type-level help.** Ship a helper in
   `@mysten-incubation/devstack/browser` (or a new `@mysten-incubation/devstack/dapp-kit-bridge`
   subpath) that exposes `registerDevstackDAppKit(kit: typeof dAppKit): void` so the app doesn't
   manually mutate `globalThis`. Side-effect: consolidates the slot name in one module instead of
   duplicated in the helper + the README the user is supposed to follow.

9. **`Manifest` schema lacks a `manifestVersion` field.** Add one; makes schema migrations explicit
   and surfaces "this manifest is from v1, current is v2" instead of a confusing
   `does not match the manifest schema` error.

10. **`DEVSTACK_STATE_DIR` is honored by `discoverManifestPath` but ignored by Vite's per-stack
    alias path.** Either (a) propagate the env var into the Vite preset or (b) drop the env var
    entirely (no one in the visible code overrides it). Inconsistency is worse than either extreme.

11. **The Vitest preset is a single-knob 17-line module that exists almost entirely to lock down
    `include` / `exclude` / `passWithNoTests`.** Either:
    - Inline it (one-line `defineConfig({test: {...}})` in each consuming app) and delete the
      preset; or
    - Extend it to actually do something — e.g. a `vi.beforeAll` that brings up a devstack handle,
      matching the deleted `withDevstack` shim. The current "config defaults preset" doesn't pull
      its weight given the comment-to-code ratio.

12. **`runtime/conventional-routes.ts:30-45`** has a tree-shaking-defense IIFE. Refactor
    `listEndpointDeclarations()` to be a function call at a top-level binding outside of any
    conditional branch, or have the helper consume `EndpointName` as an explicit parameter —
    eliminates the "value import gets stripped" footgun.

13. **`webServer.command` defaults to `'pnpm dev'`** (`src/playwright/web-server.ts:43`). Hard-coded
    for pnpm. A consumer using npm or yarn has to override. Could detect the lockfile in the app dir
    or accept `options.packageManager`.

14. **`@playwright/test`'s `test`/`expect` re-export** in `src/playwright/index.ts:54` is convenient
    but creates a `@mysten-incubation/devstack/playwright` vs. `@playwright/test` import duality in
    user code. Document the convention more loudly, or skip the re-export.

15. **Five test files share boilerplate** for env-var save/restore + tmpdir setup/teardown
    (`discover-manifest.test.ts:14-45`, `read-stack-context.test.ts:53-80`,
    `web-server.test.ts:44-65`, `define-config.test.ts:9-28`, `manifest-emit.test.ts:65-71`). Factor
    a `withDevstackEnv()` test helper.

16. **`extras-consistency.test.ts`** is logically about the codegen component (it tests
    `StackHandleEmitter` agreement with `emitManifest`). Lives under `runtime/`, presumably because
    that's where the bug was fixed. **Opportunity:** move to a top-level `tests/integration/`
    directory or to the codegen component.

17. **The `Manifest` schema's `accounts` and `coins` use `Schema.Record`** but `packages` does too.
    There's no per-section variation; could collapse to a single
    `Schema.Record(Schema.String, EntrySchema)` helper applied three times. Minor.

18. **`EndpointName.SUI_CHECKPOINT_VOLUME` exists but no factory publishes it**
    (`src/runtime/endpoint-names.ts:96-113` comment). Dead-code candidate per the comment's "Don't
    delete this even though no current factory publishes it" — but the same comment says it'll be
    needed. Schedule a review when the sui-fork integration lands.

19. **`web-server.ts`'s error messages enumerate supported endpoints** in a hard-coded list (lines
    116-119:
    `'sui-rpc, sui-faucet, sui-graphql, walrus-aggregator, walrus-publisher, seal-key-server'`).
    Derive from `listEndpointDeclarations().filter(d => d.conventional !== undefined)` so adding a
    new conventional endpoint updates the error message automatically.

20. **`Browser` subpath is 27 LOC but its rationale lives in the comment header** (lines 1-21). If
    the import-graph rules ever change (e.g. devstack moves to dual-runtime where the main barrel is
    browser-safe), the subpath could be deleted. Worth re-checking annually.
