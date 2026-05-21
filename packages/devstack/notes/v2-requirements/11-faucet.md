# faucet

## Purpose

The **faucet** subsystem is devstack's centralized coin-funding facade. It exists to give any
account (or other primitive that needs balance) a single `requestCoin(coinType, address, amount)`
entry point that dispatches to a per-coin **strategy** — the SUI HTTP faucet for `'SUI'`, a Walrus
exchange `exchange_all_for_wal` Move call for `'WAL'`, a `0x2::coin::mint_and_transfer` against a
held `TreasuryCap` for user-published coins, or anything else a plugin author registers via
`Faucet({ strategies })`.

The subsystem is split across TWO locations today:

1. **`engine/faucet.ts`** — a low-level HTTP client (`requestFunds` / `requestFundsOnce`) that POSTs
   to a Sui faucet binary's `/v2/gas` endpoint with retry, jitter, per-attempt timeout, and
   wall-clock budget. This is wire-level transport; it does NOT know about strategies or coins
   beyond SUI. (`packages/devstack/src/engine/faucet.ts:1-259`)
2. **`services/faucet/`** — a `LayeredTag` (`Faucet(...)`) that wraps an in-memory
   `Ref<Map<coinType, FaucetStrategy>>` and a dispatch closure. It is **auto-mounted** by
   `devstack(...)` on every stack (via `compose/defaults.ts:fillDefaults`) so callers like
   `Account({ funding })` always find a registered strategy.
   (`packages/devstack/src/services/faucet/index.ts:1-265`)

Critically, **there is no faucet container, no faucet host-process script, no faucet socket of its
own**. The localnet "faucet" the SUI HTTP strategy talks to is the `sui-faucet` HTTP server
**embedded in the sui-localnet container** (started by `sui start --with-faucet=0.0.0.0:9123` in the
vendored `images/sui/` Dockerfile path — see `services/sui.ts:971`). The Faucet service in
`services/faucet/index.ts` is **purely in-memory**: a strategy registry plus dispatcher, no process,
no socket, no on-disk state. The "container, sub-process, or host script?" question for the faucet
subsystem itself is "none of the above — it's a thin in-memory dispatcher whose strategies wrap
external resources."

## Current implementation

### Engine-side HTTP client

| File                                          | LOC | Summary                                                                                                                                                                                              |
| --------------------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/devstack/src/engine/faucet.ts`      | 259 | The wire-level `SuiHttpFaucetError` tagged error, the `requestFundsOnce` single-shot POST, and the `requestFunds` retry/backoff/timeout wrapper. Posts `FixedAmountRequest` to `<faucetUrl>/v2/gas`. |
| `packages/devstack/src/engine/faucet.test.ts` | 204 | Pins the three failure-mode shapes (`fetch rejection`, non-OK HTTP, body-level `status: { Failure }`) of `requestFundsOnce`; covers the `maxAttempts` / `timeoutMs` override path on `requestFunds`. |

### Service layer (strategy registry + dispatcher)

| File                                                  | LOC | Summary                                                                                                                                                                                               |
| ----------------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/devstack/src/services/faucet/index.ts`      | 265 | The `FaucetTag` Context.Service, `FaucetLive` Layer, `Faucet(...)` LayeredTag factory, `FaucetStrategy` interface, and `FaucetRequestError` tagged error. Auto-mountable.                             |
| `packages/devstack/src/services/faucet/index.test.ts` | 165 | Locks the lifecycle classification: scope-local `Ref<Map>` per layer build, in-memory only (no upstream resource deps), concurrent scopes hold disjoint registries, unknown coinType failure message. |

### Strategies

| File                                                                         | LOC | Summary                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/devstack/src/services/faucet/strategies/sui-http.ts`               | 48  | The `coinType: 'SUI'` strategy. Thin wrapper around `engine/faucet.ts`'s `requestFunds`. `amount` is **ignored** — the SUI HTTP faucet returns a fixed grant.                                                            |
| `packages/devstack/src/services/faucet/strategies/treasury-cap-mint.ts`      | 71  | The `coinType: '<fully-qualified-Move-type>'` strategy. Builds a `0x2::coin::mint_and_transfer` tx against a held `TreasuryCap` and signs via a caller-supplied `Account`. `amount === 0n` is a no-op.                   |
| `packages/devstack/src/services/faucet/strategies/treasury-cap-mint.test.ts` | 109 | Mints when `amount > 0n`, no-ops on `0n`, wraps signing failures in `FaucetRequestError`.                                                                                                                                |
| `packages/devstack/src/services/faucet/strategies/wal-exchange.ts`           | 81  | The `coinType: 'WAL'` strategy. Builds a `wal_exchange::exchange_all_for_wal` Move call paid in SUI; `amount` is **SUI MIST to spend** (not WAL units to receive). `amount === 0n` falls back to a `defaultPaymentMist`. |
| `packages/devstack/src/services/faucet/strategies/wal-exchange.test.ts`      | 111 | Dispatches via admin signer with default payment when `amount === 0n`, honors non-zero amount as MIST payment, wraps signing failures in `FaucetRequestError`.                                                           |

### Totals

- **Src LOC:** 259 (engine/faucet.ts) + 265 (services/faucet/index.ts) + 48 (sui-http) + 71
  (treasury-cap-mint) + 81 (wal-exchange) = **724 LOC**.
- **Test LOC:** 204 (engine/faucet.test.ts) + 165 (services/faucet/index.test.ts) + 109
  (treasury-cap-mint.test.ts) + 111 (wal-exchange.test.ts) = **589 LOC**.
- **Grand total in-scope:** 1313 LOC across 9 files.

### Adjacent files referenced (NOT in scope; documented elsewhere)

- `packages/devstack/src/services/sui.ts:381-477` — `faucetReadyProbe` +
  `buildWaitForTransactionsReady`. Lives in the Sui service doc (`05-sui.md`) but called out here
  because the **probe is what guarantees the faucet is funds-transferable** before any account
  funding POST.
- `packages/devstack/src/services/account.ts:457-541` (ephemeral-funded SUI path), `:551-585`
  (cross-cutting funding loop) — primary engine-side consumer.
- `packages/devstack/src/services/walrus/internal.ts:572-583` — registers `walExchangeStrategy`
  post-deploy.
- `packages/devstack/src/services/package/internal.ts:256-280` — registers `treasuryCapMintStrategy`
  per published coin.
- `packages/devstack/src/compose/defaults.ts:26-41` — auto-mounts `Faucet({hidden: true})` if the
  user didn't add one.

## Configuration

### `defineDevstack` config keys

None directly on the `defineDevstack(...)` config. The faucet subsystem is configured at the per-ref
boundary, not at the stack-config level.

### `Faucet({...})` factory options

`packages/devstack/src/services/faucet/index.ts:202-218` (`FaucetOptions`):

| Key          | Type                            | Default    | Meaning                                                                                                                                                                                                        |
| ------------ | ------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | `string`                        | `'faucet'` | Tag name suffix (`faucet/<name>`). Multiple faucets are technically possible but unused today. (`index.ts:209,222`)                                                                                            |
| `strategies` | `ReadonlyArray<FaucetStrategy>` | `[]`       | Strategies registered at acquire-time AFTER the built-in SUI HTTP strategy. Later registrations win for overlapping `coinType`. (`index.ts:207, 240-244`)                                                      |
| `hidden`     | `boolean`                       | `false`    | Suppress the dashboard TUI row. The auto-included faucet from `fillDefaults` sets this to `true`; explicit `Faucet({...})` from user code gets a visible row by default. (`index.ts:217, 253; defaults.ts:38`) |

### `SuiHttpStrategyOptions`

`packages/devstack/src/services/faucet/strategies/sui-http.ts:14-23` — knobs for the SUI HTTP
strategy specifically:

| Key           | Type     | Default                      | Meaning                                                                  |
| ------------- | -------- | ---------------------------- | ------------------------------------------------------------------------ |
| `faucetUrl`   | `string` | required                     | Base URL. Strategy appends `/v2/gas` internally. (`sui-http.ts:17, 31`)  |
| `timeoutMs`   | `number` | 90_000 (from `requestFunds`) | Wall-clock budget forwarded to `requestFunds`. (`sui-http.ts:20, 33-34`) |
| `maxAttempts` | `number` | 15 (from `requestFunds`)     | Max retries forwarded to `requestFunds`. (`sui-http.ts:22, 34-35`)       |

### `requestFunds` per-call options

`packages/devstack/src/engine/faucet.ts:179-209`:

| Key              | Type                               | Default                          | Source line                                                                                |
| ---------------- | ---------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------ |
| `faucetUrl`      | `string`                           | required                         | `faucet.ts:180`                                                                            |
| `address`        | `string`                           | required                         | `faucet.ts:181`                                                                            |
| `onAttempt`      | `(attempt, error) => Effect<void>` | undefined                        | `faucet.ts:188` — used by `services/account.ts:518-521` to update the TUI phase per retry. |
| `timeoutMs`      | `number`                           | `DEFAULT_TIMEOUT_MS` = 90_000    | `faucet.ts:195, 212`; constant at `:72`.                                                   |
| `maxAttempts`    | `number`                           | `DEFAULT_MAX_ATTEMPTS` = 15      | `faucet.ts:203, 213`; constant at `:70`.                                                   |
| `initialDelayMs` | `number`                           | `DEFAULT_INITIAL_DELAY_MS` = 500 | `faucet.ts:209, 214`; constant at `:71`.                                                   |

**OPEN QUESTION:** The JSDoc on `requestFunds.maxAttempts` says "Defaults to 40"
(`engine/faucet.ts:198-200`), but the actual `DEFAULT_MAX_ATTEMPTS` constant is **15**
(`engine/faucet.ts:70`). The JSDoc is stale relative to the C14 fix described in the comments at
`:64-69`. The same `40` figure appears in `services/account.ts:157` (`faucetMaxAttempts` JSDoc) and
in `engine/faucet.test.ts:138`. The accurate value is 15.

Hard-coded constants (NOT user-configurable):

- `BACKOFF_FACTOR = 1.5` (`engine/faucet.ts:73`) — exponential growth factor.
- `FAUCET_FETCH_TIMEOUT_MS = 5_000` (`engine/faucet.ts:97`) — per-`fetch` AbortSignal deadline,
  distinct from the outer wall-clock budget.
- Jitter is `Schedule.jittered`'s default, [0.8, 1.2) (`engine/faucet.ts:79-80`).

### `Account({ kind: 'ephemeral-funded' })` faucet overrides

`packages/devstack/src/services/account.ts:139-160`:

| Key                 | Type     | Default                                | Meaning                                                                |
| ------------------- | -------- | -------------------------------------- | ---------------------------------------------------------------------- |
| `faucetTimeoutMs`   | `number` | undefined → 90_000 from `requestFunds` | Wall-clock budget for the implicit SUI top-up. (`account.ts:153, 526`) |
| `faucetMaxAttempts` | `number` | undefined → 15 from `requestFunds`     | Retry attempts. (`account.ts:159, 527-529`)                            |

### Indirect knobs via `Sui(...)` factory

The faucet subsystem reads `sui.faucet.host` and `sui.faucet.container` off the resolved `SuiTag`
value. The Sui factory's faucet plumbing (see `05-sui.md`) determines what URL the SUI HTTP strategy
targets:

- `Sui({ localnet: { faucetUrl } })` (`services/sui.ts:596`) — externally-managed RPC branch
  overrides the faucet base.
- `Sui({ network: 'testnet', testnet: { faucetUrl } })` (`services/sui.ts:606`).
- `Sui({ network: { rpc, faucet } })` custom branch (`services/sui.ts:619, 721`).
- `Sui({ network: 'mainnet' })` — `sui.faucet` is `undefined`;
  `Account({ kind: 'ephemeral-funded' })` fails at acquire-time (`account.ts:471-481`).
- `Sui({ network: 'mainnet-fork' | 'testnet-fork' | 'devnet-fork' })` — no faucet; `Account`
  auto-promotes to `fundEphemeralOnFork` impersonation (`account.ts:456-469`).

### CLI flags

None. The faucet subsystem has no CLI surface of its own. (The `devstack` CLI commands `up`, `wipe`,
`snapshot`, etc. don't take faucet-specific flags.)

### Env vars

None read by the faucet subsystem directly. `SUI_FAUCET_URL` is set by the **Sui CLI invocation**
wrapper (`packages/devstack/src/engine/sui-cli.ts:411-421`) when forwarding the faucet URL to a
`sui` subprocess for Move builds — that's outbound CLI plumbing, not faucet-side configuration.

## Capabilities CONSUMED

### From other services / components

- **`SuiTag`** (`services/faucet/index.ts:61, 235-238`) — read via `Effect.serviceOption(SuiTag)` at
  `Faucet(...)` acquire-time to discover the resolved faucet URL (`suiOpt.value.faucet.host`). The
  optional yield means the Faucet Layer builds successfully even when no Sui is in scope (unit
  tests).
- **`SuiTag.faucet.host`** (`Endpoint`) — the routed host URL the SUI HTTP strategy POSTs against
  (e.g. `http://devstack-<stack>.faucet.localhost:9123`). Read at `services/faucet/index.ts:237` and
  in the Sui-ready probe at `services/sui.ts:1163`.
- **`SuiTag.waitForTransactionsReady()`** (`services/account.ts:497-507`) — NOT consumed by the
  faucet subsystem directly, but consumed by `Account` BEFORE the first faucet POST. This is the
  "cheap faucet probe" the task brief references (see Hard requirements).
- **A user `Account` (the cap holder)** — for `treasuryCapMintStrategy`
  (`treasury-cap-mint.ts:33-34`) and `walExchangeStrategy` (`wal-exchange.ts:41-42`). The strategy
  holds a reference to the `Account` and calls `signer.signAndExecute(tx)` on each funding request.
- **A resolved `WalExchangeHandle`** — for `walExchangeStrategy` (`wal-exchange.ts:30-33, 38-39`).
  Resolved by `walrusLocalCluster` after the Walrus deploy step.

### Engine resources

- **`Effect.tryPromise`** wrapping `fetch` (`engine/faucet.ts:106-122`). The faucet is the only
  devstack subsystem (besides Sui's own probes) that calls `fetch` directly without going through a
  docker/host abstraction.
- **`AbortSignal.timeout(5_000)`** (`engine/faucet.ts:113`) — per-fetch deadline.
- **`Ref.make<Map<string, FaucetStrategy>>`** (`services/faucet/index.ts:150`) — the strategy
  registry. Per-layer-build, NOT module-level.
- **`Ref.make<number>` / `Ref.make<SuiHttpFaucetError | undefined>`** (`engine/faucet.ts:223-224`) —
  attempt counter + last-error tracker for the retry wrapper.
- **`Schedule.exponential` + `Schedule.jittered` + `Schedule.both` + `Schedule.recurs`**
  (`engine/faucet.ts:75-82`) — bounded exponential backoff with jitter.
- **`Effect.timeoutOrElse`** (`engine/faucet.ts:239-256`) — wall-clock budget enforcement.
- **`Effect.withSpan('Faucet.requestFunds')`** (`engine/faucet.ts:259`) — observability span.
- **`Effect.annotateCurrentSpan({ 'faucet.url', 'faucet.address' })`** (`engine/faucet.ts:218-221`).
- **`Layer.build(FaucetLive)`** (`services/faucet/index.ts:229`) — explicit Layer.build inside the
  `Faucet(...)` factory body so the registry lifetime equals the tag's scope.

### Runtime resources

- **HTTP(S)** to `<faucetUrl>/v2/gas` (`engine/faucet.ts:104`). For the in-stack localnet case, this
  is the Traefik-routed hostname `devstack-<stack>.faucet.localhost:9123` (`services/sui.ts:1060`).
  For externally-managed or testnet, it's whatever the user supplied.
- **No fs**. The faucet subsystem writes nothing to disk.
- **No subprocesses**. No `Docker.exec`, no `host-script`, no spawned binaries.
- **No ports leased**. The strategy registry has no listening socket. The `sui-faucet` port (9123)
  is leased by the Sui service, not the faucet subsystem (`engine/docker/router.ts:182`,
  `services/sui.ts:97`).
- **No locks**. No file locks, no `Leasing` consumption from the faucet subsystem itself.

### Surfaces

- **TUI phase updates** via `setPhase(...)` only inside the consumers
  (`services/account.ts:496, 508, 520, 571`). The faucet subsystem proper doesn't call `setPhase`;
  the `onAttempt` callback on `requestFunds` (`engine/faucet.ts:188`) lets callers (like
  `account.ts:518-521`) surface retry attempts in their own TUI row.
- **Log sink** via Effect's default logger when spans are emitted.
- **Dashboard row** when not `hidden: true`. The auto-mounted faucet is hidden; user-added
  `Faucet({...})` shows a row titled `faucet.<name>` (`services/faucet/index.ts:251-253`).
- **`displayTitle`** (`services/faucet/index.ts:251`) — TUI title rendering.

### External

- **HTTP POST** to `<faucetUrl>/v2/gas` with body `{"FixedAmountRequest": {"recipient": <address>}}`
  (`engine/faucet.ts:104, 109-112`).
- **`@mysten/sui` `Transaction` builder** — for the `treasuryCapMintStrategy`
  (`treasury-cap-mint.ts:6, 50-55`) and `walExchangeStrategy` (`wal-exchange.ts:6, 57-67`).

### Effect / Layer / Context machinery

- `Context.Service` (`services/faucet/index.ts:142`) — the `FaucetTag` key.
- `Layer.effect(FaucetTag, Effect.gen(...))` (`services/faucet/index.ts:147-179`) — the `FaucetLive`
  layer.
- `Effect.serviceOption(FaucetTag)` (consumers — `account.ts:552`, `package/internal.ts:261`,
  `walrus/internal.ts:573`) — best-effort yield that fails-soft when Faucet isn't in scope.
- `Effect.serviceOption(SuiTag)` (`services/faucet/index.ts:235`) — optional yield from inside the
  Faucet factory.
- `tag(...)` from `advanced/tag.ts` (`services/faucet/index.ts:60, 224-264`) — the `LayeredTag`
  factory.
- `LayeredTag<'faucet', unknown, never, never>` (`services/faucet/index.ts:264`) — exported tag
  shape.
- `Schema.TaggedErrorClass` (`engine/faucet.ts:32-48`, `services/faucet/index.ts:68-77`) — for the
  two error classes.

### Imports from other workspace packages

- `@mysten/sui/transactions` (`treasury-cap-mint.ts:21`, `wal-exchange.ts:23`) — `Transaction`
  builder.

### npm dependencies

- `effect` — `Effect`, `Ref`, `Schedule`, `Schema`, `Context`, `Layer`.
- `@effect/vitest` — `describe`, `it`, `expect` (test-only).
- `@mysten/sui/transactions` (strategies only).

The faucet subsystem has NO native dependencies, no docker dependency, no fs dependency.

## Capabilities PRODUCED

### Endpoints

**None.** The faucet subsystem does NOT expose an HTTP endpoint or socket of its own. The localnet
`:9123` port belongs to the sui-localnet container (which runs the `sui-faucet` binary as part of
`sui start --with-faucet`) — see `services/sui.ts:97 (LOCAL_FAUCET_PORT)` and
`services/sui.ts:971 ('--with-faucet=0.0.0.0:9123')`.

### State-store entries

**None.** The faucet subsystem holds no `StateStore` keys. Confirmed by
`services/faucet/index.test.ts:121-137` — the `FaucetLive` Layer builds without `StateStoreConfig`
in context.

### Events emitted

**None directly.** Indirectly: `setPhase(...)` calls from consumers emit phase-change events the TUI
consumes, but the faucet itself doesn't emit through the event bus.

### Files written

**None.** No on-disk persistence at all.

### CLI commands registered

**None.**

### Routes registered

**None on the router.** (The `sui-faucet` route at port 9123 is registered by the Sui service via
`defineEntrypoint({ name: 'sui-faucet', port: 9123 })` in `engine/docker/router.ts:182`.)

### TypeScript exports consumed elsewhere

From `services/faucet/index.ts`:

- `Faucet` (factory) — re-exported via `services/index.ts:117`, used by
  `compose/defaults.ts:16, 38`.
- `FaucetTag` (Context key) — consumed by `services/account.ts:58, 552`,
  `services/package/internal.ts:26, 261`, `services/walrus/internal.ts:46, 573`.
- `FaucetLive` (Layer) — consumed by `services/faucet/index.test.ts` only.
- `Faucet` interface — implicit via `FaucetTag`.
- `FaucetStrategy` interface — consumed by all 3 strategy files; exposed on `/advanced`
  (`advanced/index.ts:142`).
- `FaucetOptions` — re-exported `services/index.ts:117`, `advanced/index.ts:140`.
- `FaucetRequestError` (class) — re-exported in `index.ts:166` (main API surface) and
  `advanced/index.ts:143`. Consumed in `account.ts:573`.

From `engine/faucet.ts`:

- `requestFunds` (function) — consumed by `services/faucet/strategies/sui-http.ts:11` and
  `services/account.ts:57, 509`.
- `requestFundsOnce` (function) — exported for unit tests only (`engine/faucet.test.ts:19`). NOT
  consumed in production.
- `SuiHttpFaucetError` (class) — consumed at `services/account.ts:531` for the `Effect.catchTag`
  boundary.

From the strategies:

- `suiHttpStrategy` — consumed at `services/faucet/index.ts:62, 237` (auto-registered) and exported
  on `advanced/index.ts:145` for plugin authors.
- `treasuryCapMintStrategy` — consumed at `services/package/internal.ts` for the
  auto-register-per-published-coin path.
- `walExchangeStrategy` — consumed at `services/walrus/internal.ts:47, 576` and exported on
  `advanced/index.ts:146`.
- `WalExchangeHandle` (interface) — `wal-exchange.ts:29-33`. Used by `walrusLocalCluster` to express
  the cap shape.
- `TreasuryCapMintStrategyOptions`, `SuiHttpStrategyOptions`, `WalExchangeStrategyOptions` —
  option-bag types.

### Container images / volumes produced

**None.**

### Strategy registry (runtime state PRODUCED inside the FaucetTag service)

- `Map<coinType, FaucetStrategy>` — keyed by canonical coin name (`'SUI'`, `'WAL'`) or
  fully-qualified Move type (`'0xpkg::module::TYPE'`). Mutable via `Ref.update`
  (`services/faucet/index.ts:152-157`). Scope-local — fresh per `Layer.build`.

### Faucet service API surface

`packages/devstack/src/services/faucet/index.ts:121-138`:

- `register(strategy: FaucetStrategy): Effect.Effect<void>` — register/overwrite a strategy for
  `strategy.coinType`. Last write wins.
- `requestCoin(coinType: string, address: string, amount: bigint): Effect.Effect<void, FaucetRequestError>`
  — dispatch. Unknown `coinType` fails with `FaucetRequestError` whose message names the registered
  set.
- `listFundable: Effect.Effect<ReadonlyArray<string>>` — snapshot of currently-registered coin
  types. Per JSDoc at `index.ts:136-137`, the manifest emitter "fold[s] this into
  `coins[*].fundable`" — but a search across `engine/` and `compose/` finds NO production consumer
  of `listFundable` outside the test files (`services/account.test.ts:415, 459, 510` use it as a
  stub field, `services/faucet/index.test.ts` exercises it). **OPEN QUESTION:** Is `listFundable`
  actually wired into a manifest emitter today, or is the JSDoc forward-looking? See Open questions
  section.

## Lifecycle

### Startup

There is **no faucet startup sequence per se** — the faucet subsystem is in-memory and constructs
synchronously inside its `Layer.build`. The ordered sequence below is the **end-to-end funding
flow** for the canonical `Account({ kind: 'ephemeral-funded' })` path on a localnet stack:

1. **Sui service comes up** (out of scope here; see `05-sui.md`). Sui's localnet container starts
   via `sui start --with-faucet=0.0.0.0:9123 --with-indexer=... --with-graphql=0.0.0.0:9125`
   (`services/sui.ts:967-1034`).
2. **Sui's three-probe ready gate.** `Effect.all([rpcProbe, faucetProbe, graphqlProbe])`
   (`services/sui.ts:1116`). The `faucetProbe` is a CHEAP `GET /` (socket-level) — it deliberately
   does NOT POST `/v2/gas` because that would actually transfer SUI from the dispenser
   (`services/sui.ts:1087-1097`). This is the "cheap faucet probe" the task brief references.
3. **`FaucetTag` is published.** `Layer.build(FaucetLive)` runs inside the `Faucet(...)` factory
   body (`services/faucet/index.ts:229`). The `Ref<Map>` is created empty.
4. **Built-in SUI strategy auto-registers.** `Effect.serviceOption(SuiTag)` reads the resolved Sui
   value; if `sui.faucet !== undefined`, the SUI HTTP strategy is registered against
   `sui.faucet.host` (`services/faucet/index.ts:235-238`).
5. **Caller-supplied strategies register last.** Anything in `Faucet({ strategies: [...] })` runs
   after the built-in so user overrides win (`services/faucet/index.ts:242-244`).
6. **Per-coin strategies auto-register from siblings during the cycle:**
   - `walrusLocalCluster` registers `walExchangeStrategy` after Walrus deploy resolves the exchange
     object (`services/walrus/internal.ts:572-583`).
   - `publishMove` registers `treasuryCapMintStrategy` for each published coin in
     `Package({ coins })` (`services/package/internal.ts:256-280`).
7. **`Account` consumes the SUI strategy.** When `Account({ kind: 'ephemeral-funded' })` acquires:
   - `sui.waitForTransactionsReady()` is called FIRST (`services/account.ts:497-507`) — this is the
     **expensive, real-tx-roundtrip ready-probe** at `services/sui.ts:406-425` (POST `/v2/gas` with
     a stable throwaway recipient + assert the response body is `status: "Success"`). It's memoized
     via `Effect.cached` (`services/sui.ts:475`) so parallel accounts share one resolution.
   - Then `requestFunds(...)` runs (`services/account.ts:509-540`). The 90s wall-clock budget begins
     ticking here.
8. **Cross-cutting `funding` loop.** If `Account` declared a `funding:` spec, after the SUI-side
   ephemeral path completes, the body yields `FaucetTag` (best-effort) and dispatches each
   `[coinType, amount]` through `faucet.requestCoin` (`services/account.ts:551-585`).

What blocks what:

- The strategy registry needs `SuiTag` resolved at acquire time (best-effort) BUT the Faucet Layer
  build does NOT topologically require `SuiTag` — declared `upstreamKeys: []`
  (`services/faucet/index.ts:262`). The optional `Effect.serviceOption` yield doesn't impose a
  dep-graph edge.
- Consumers (`Account`, `Package`'s coin registration, `Walrus`'s WAL strategy register) DO declare
  `FaucetTag` as an upstream so the scheduler places them after Faucet
  (`engine/dep-graph.test.ts:282-284, 372-383`).
- `Account({ kind: 'ephemeral-funded' })` additionally gates on Sui's `waitForTransactionsReady`
  before its first faucet POST — this is the documented mitigation for the "HTTP socket bound but tx
  pipeline not ready" race.

Parallelism:

- Multiple accounts in the same stack request funds **in parallel** — `Schedule.jittered`
  (`engine/faucet.ts:80`) was added specifically because pre-jitter, "every account's retry schedule
  landed on the same wall-clock tick, thundering-herd hammering the faucet"
  (`engine/faucet.ts:65-69`).
- Walrus's WAL-strategy register and Package's TreasuryCap-mint register happen sequentially inside
  their respective primitives' acquire bodies; not parallelized with Account's SUI requests.

### Ready criteria

The Faucet service is "ready" the instant `Layer.build(FaucetLive)` completes — synchronous, no
probe. There's no external readiness signal to expose.

The **strategies** become useful when their underlying resource is ready:

- SUI HTTP strategy — ready when `sui.faucet.host` is non-null AND the upstream `sui-faucet`
  binary's tx pipeline accepts requests (gated by Sui's `waitForTransactionsReady` /
  `faucetReadyProbe`).
- WAL exchange strategy — ready after the walrus exchange object is published.
- TreasuryCap mint strategy — ready after `publishMove` captures the `TreasuryCap` from
  `objectChanges`.

### Restart behavior

The Faucet has **per-cycle state**. On a supervisor restart (warm re-up, or after a fail-fast):

- The strategy registry is built fresh in the new cycle's `Layer.build` — it does NOT persist or
  rehydrate (`services/faucet/index.test.ts:34-58` locks this).
- All strategies are re-registered from scratch during the new cycle's acquire phase. The SUI HTTP
  strategy gets a freshly-read `sui.faucet.host` (in case the routed hostname shifted), and Walrus /
  Package re-register their per-cycle strategies after re-resolving exchange object / TreasuryCap
  from cache.
- **Nothing in the Faucet itself is idempotent across cycles** because nothing in the Faucet itself
  persists across cycles. The idempotency you might expect (e.g. "don't fund an already-funded
  account") lives elsewhere — in `seedWalForAccounts` for walrus seed accounts, in account
  warm-resume keypair persistence, etc.

The downstream `sui-faucet` binary inside the Sui container persists internal state (recent-tx
ledger, rate-limit windows) in the container's writable layer — Sui's responsibility, not the faucet
subsystem's.

### Teardown

There's nothing for the Faucet subsystem to tear down. No sockets, no files, no children:

- The `Ref<Map>` is GC'd when the surrounding scope closes.
- No finalizer registered by `Layer.effect` (`services/faucet/index.ts:147-179`) — `Layer.effect`'s
  constructor only runs an acquire effect.
- No grace window, no shutdown signal.

The Sui container's `sui-faucet` HTTP server tears down with the Sui container
(`stopGraceSeconds: 30` per `services/sui.ts:1006`); not the faucet subsystem's responsibility.

## Hard requirements / invariants

These are the load-bearing constraints the existing implementation has either crystallized through
bug fixes (C14, etc.) or pinned in tests. Each is cited.

### IR-1: Strategy registry MUST be scope-local, never module-level

**Cite:** `services/faucet/index.ts:144-179` (`FaucetLive` body creates the `Ref<Map>` inside
`Effect.gen`, not at module load). `services/faucet/index.test.ts:34-58` asserts two fresh
`FaucetLive.provide(...)` blocks see disjoint registries.

**Rationale:** Two parallel stacks (concurrent `pnpm dev` invocations of different `devstack(...)`
configs in the same process) must hold disjoint strategy maps. A module-level `Ref` would leak
strategies across stacks and silently mis-fund. `services/faucet/index.test.ts:139-164` further pins
disjoint registries for concurrent `Effect.provide(FaucetLive)` blocks.

### IR-2: The auto-mounted Faucet MUST be hidden in the TUI

**Cite:** `compose/defaults.ts:31-39` (`fillDefaults` passes `{ hidden: true }`).
`services/faucet/index.ts:253` (the `hidden` flag flows through to the LayeredTag's display
options).

**Rationale:** Auto-included infra the user didn't type shouldn't show up as a dashboard row that
the user has to mentally model. User-supplied `Faucet({...})` does NOT pass `hidden: true` so it
remains visible.

### IR-3: SUI HTTP strategy auto-registers only when `sui.faucet !== undefined`

**Cite:** `services/faucet/index.ts:235-238`.

**Rationale:** On mainnet (`sui.faucet === undefined`), auto-registering would produce a strategy
that POSTs to a non-existent URL — confusing failure. Instead, no SUI strategy is registered, and an
`Account({ kind: 'ephemeral-funded' })` user gets the actionable "configured Sui has no faucet"
error at acquire-time (`services/account.ts:471-481`).

### IR-4: Re-registering for the same `coinType` MUST overwrite (last write wins)

**Cite:** `services/faucet/index.ts:152-157` (uses `new Map(m); next.set(...)`).
`services/faucet/index.test.ts:61-103` asserts the override semantics (override hits, original
doesn't).

**Rationale:** Tests stubbing built-in strategies depend on this. Caller-supplied
`Faucet({ strategies: [...] })` overriding the built-in SUI strategy depends on this
(`services/faucet/index.ts:206-208`).

### IR-5: A non-OK HTTP status MUST raise SuiHttpFaucetError, NOT succeed

**Cite:** `engine/faucet.ts:129-146`, asserted at `engine/faucet.test.ts:112-131`.

**Rationale:** During sui-localnet warm-up, the `sui-faucet` HTTP socket is bound BEFORE the
underlying validator can transfer coins; that window returns `503 Service Unavailable`. A naive
`response.ok ? success : fail` would already do this — the test exists as a regression guard against
"simplifying" the `if (!response.ok)` check.

### IR-6: A 200 OK body with `status: { Failure }` MUST raise SuiHttpFaucetError, NOT succeed

**Cite:** `engine/faucet.ts:147-176`, asserted at `engine/faucet.test.ts:52-75`.

**Rationale:** The sui-faucet binary returns `{"status": {"Failure": {"Internal": "..."}}}` with
HTTP 200 when it accepted the request but couldn't execute the underlying tx (gas object stale,
consensus hiccup). Treating that as success would mark the account as funded when no coins moved.
This is the **most load-bearing assertion in the engine-side helper** — header comment at
`engine/faucet.test.ts:1-15` explicitly calls this out: "The body-Failure case is the load-bearing
one — during sui-localnet warm-up the faucet HTTP socket binds before the underlying tx pipeline is
ready, and a naive `response.ok ? success : retry` would mark funding as complete when no coins were
actually transferred."

### IR-7: Per-fetch deadline MUST be short (5s) relative to the wall-clock budget (90s)

**Cite:** `engine/faucet.ts:89-97` (`FAUCET_FETCH_TIMEOUT_MS = 5_000`).

**Rationale:** The `sui-faucet` binary internally retries the underlying SUI transfer tx twice with
~30s timeouts, so a request against a cold chain blocks for ~60s before returning 500. That burns
most of the 90s budget in one shot. By aborting at 5s we let the outer retry loop hammer the faucet
quickly — when the chain catches up, the next attempt lands in <1s.

### IR-8: Retry MUST jitter

**Cite:** `engine/faucet.ts:75-82` (`Schedule.jittered`). Comment at `:64-69` records the pre-fix
history.

**Rationale:** Pre-fix, "every account's retry schedule landed on the same wall-clock tick,
thundering-herd hammering the faucet." Jitter spreads concurrent account retries.

### IR-9: Account funding MUST gate on `sui.waitForTransactionsReady()` before the first faucet POST

**Cite:** `services/account.ts:484-507`.

**Rationale:** Sui's three-probe socket gate (`services/sui.ts:1116-1142`) passes as soon as the
HTTP servers are bound; the underlying validator may still be mid-genesis and return body-level
`Failure` for several seconds afterward. Centralizing the wait on the `sui` primitive (memoized via
`Effect.cached` — `services/sui.ts:475`) lets every parallel ephemeral-funded account share one
resolution instead of each spending its own retry budget rediscovering the same fact.

### IR-10: `waitForTransactionsReady` is keyed off the faucet URL specifically

**Cite:** `services/sui.ts:434, 466-477`.

**Rationale:** No faucet → `waitForTransactionsReady` is a no-op (`services/sui.ts:470-473`); the
chain is presumed always-transferable (mainnet reads, corporate fork without funding flows). This
means a localnet stack misconfigured with an externally-managed RPC but no `faucetUrl` will skip the
probe — by design.

### IR-11: `FaucetLive` Layer build MUST require NO upstream context

**Cite:** `services/faucet/index.ts:147` (`Layer.Layer<FaucetTag>` — no `R` channel beyond `never`).
`services/faucet/index.test.ts:121-137` asserts the runtime equivalent: building with NO additional
layers must succeed.

**Rationale:** Faucet is auto-mounted by `fillDefaults`. Requiring upstream context would block
auto-mount on stacks that don't have that context — defeating the "every stack has a faucet so
Account({funding}) finds something to dispatch through" invariant.

### IR-12: `treasuryCapMintStrategy.request({amount: 0n})` MUST be a no-op (no Move call)

**Cite:** `services/faucet/strategies/treasury-cap-mint.ts:47-49`, asserted at
`treasury-cap-mint.test.ts:57-79`.

**Rationale:** Minting zero units is meaningless and the `0x2::coin::mint_and_transfer` Move call
may fail or produce dust events for `u64(0)`.

### IR-13: `walExchangeStrategy.request({amount: 0n})` MUST fall back to `defaultPaymentMist`

**Cite:** `services/faucet/strategies/wal-exchange.ts:55-56`.

**Rationale:** The matching `Walrus({ local: { seedPaymentMist } })` semantic for "explicit listing
without explicit amount" — gives the user a sensible default.

### IR-14: WAL strategy `amount` is denominated in SUI MIST, NOT WAL units

**Cite:** `services/faucet/index.ts:103-106` (interface JSDoc) and
`services/faucet/strategies/wal-exchange.ts:15-20`.

**Rationale:** The Move call signature is `exchange_all_for_wal(exchange, sui_payment)` — the caller
specifies what to spend, the exchange returns "whatever the rate gives you." Documented at the
interface level so plugin authors writing their own WAL strategies don't break the contract.

### IR-15: Strategies' `R` channel MUST resolve to `never` at the FaucetStrategy boundary

**Cite:** `services/faucet/index.ts:115-118` — the interface pins `R = never`.

**Rationale:** Strategies that internally need context (e.g. `SuiTag` for `treasuryCapMintStrategy`)
must close over it at construction time (`treasury-cap-mint.ts:25-35` takes `signer: Account` as a
constructor argument, not a context dep). This keeps `faucet.requestCoin(coinType, ...)` free of
unexpected context requirements at the dispatch site.

### IR-16: `Faucet({...})` upstreamKeys MUST be `[]`

**Cite:** `services/faucet/index.ts:254-263`.

**Rationale:** The body reads `SuiTag` via `Effect.serviceOption` — optional fold, safe with or
without Sui. An empty upstream set silences the "missing `__upstreamKeys`" warning AND lets the
scheduler treat Faucet as a true leaf. Sibling stack members that depend on the faucet declare it in
their own `upstreamKeys` (e.g. `Account` consumes `FaucetTag` and the dep-graph closure picks it up
— verified at `engine/dep-graph.test.ts:282-284, 378-383`).

## Failure modes

### FM-1: `fetch` rejection (ECONNREFUSED / DNS / TLS)

- **Trigger:** Network layer rejects the POST. Most common pre-readiness: `ECONNREFUSED` while the
  `sui-faucet` HTTP server is still binding.
- **Current behavior:** `Effect.tryPromise.catch` wraps as `SuiHttpFaucetError` with
  `message: 'faucet request failed'` and the original error as `cause` (`engine/faucet.ts:115-122`).
  Asserted at `engine/faucet.test.ts:96-110`.
- **Recovery:** `requestFunds`'s retry schedule catches it. Default 15 attempts × exponential
  backoff × jitter within a 90s budget.

### FM-2: HTTP non-2xx response

- **Trigger:** `sui-faucet` returns 5xx (503 / 500) — typically during warm-up before the
  validator's tx pipeline is ready.
- **Current behavior:** `engine/faucet.ts:129-146` reads `response.text()` best-effort, fails with
  `SuiHttpFaucetError` carrying `exitCode: response.status` and `stderr: <body>`. Asserted at
  `engine/faucet.test.ts:112-131`.
- **Recovery:** Same retry schedule.

### FM-3: HTTP 200 OK with `status: { Failure }` body

- **Trigger:** Faucet accepted the request but couldn't execute the underlying tx (gas object stale,
  consensus hiccup, mid-genesis).
- **Current behavior:** `engine/faucet.ts:154-176` parses JSON, fails with `SuiHttpFaucetError`
  carrying the JSON-stringified `Failure` payload in both `message` and `stderr`. Asserted at
  `engine/faucet.test.ts:52-75`.
- **Recovery:** Same retry schedule. THIS is the case the `waitForTransactionsReady` gate at
  `services/account.ts:497-507` is designed to eliminate at the wall-clock head — once
  `waitForTransactionsReady` resolves, subsequent body-Failure responses should be rare.

### FM-4: JSON parse failure on 200 OK body

- **Trigger:** Faucet returned 200 with a non-JSON body (extremely unusual; would indicate an
  upstream bug or a misrouted hit).
- **Current behavior:** `engine/faucet.ts:154-163` wraps as `SuiHttpFaucetError` with
  `message: 'faucet response was not valid JSON'`. Not explicitly tested.
- **Recovery:** Retry schedule, though likely to recur.

### FM-5: Per-fetch timeout (5s) elapses

- **Trigger:** A single POST hangs for more than 5s (typically because the faucet is blocked on a
  stuck downstream tx).
- **Current behavior:** `AbortSignal.timeout(FAUCET_FETCH_TIMEOUT_MS)` (`engine/faucet.ts:113`)
  aborts the fetch; the resulting `AbortError` falls through `tryPromise.catch` as
  `SuiHttpFaucetError`. Not explicitly tested.
- **Recovery:** Retry schedule. The 5s per-fetch cap protects the 90s wall-clock budget from being
  burned by one hung request.

### FM-6: Wall-clock budget (90s) exhausted

- **Trigger:** Every retry in 90s failed. Usually means the chain is genuinely broken or
  unreachable.
- **Current behavior:** `Effect.timeoutOrElse` (`engine/faucet.ts:239-256`) produces a
  `SuiHttpFaucetError` whose message includes `n attempts; last error: <last.message>` and forwards
  `last.stderr` / `last.exitCode`. Asserted at `engine/faucet.test.ts:180-203` (the `timeoutMs`
  override path).
- **Recovery:** None internal. Surfaces as `AccountError(phase: 'fund')`
  (`services/account.ts:531-540`) and fails the supervisor cycle.

### FM-7: Retry schedule exhausted before wall-clock budget

- **Trigger:** `maxAttempts` (default 15) retries all failed but wall-clock still has budget
  remaining.
- **Current behavior:** `Schedule.both(Schedule.recurs(maxAttempts))` (`engine/faucet.ts:81`) exits
  the retry loop; the final failed Effect bubbles. Asserted at `engine/faucet.test.ts:144-178` for
  the override path.
- **Recovery:** None. The error type is the same `SuiHttpFaucetError` whose retries failed.

### FM-8: Unknown coinType in `Faucet.requestCoin`

- **Trigger:** Caller passes a `coinType` no strategy is registered for.
- **Current behavior:** `services/faucet/index.ts:160-172` fails with `FaucetRequestError` whose
  message lists every registered coin type. Asserted at `services/faucet/index.test.ts:105-119`.
- **Recovery:** None automatic. The user needs to wire a strategy for that coin (typically via
  `Faucet({ strategies: [...] })` or by adding the underlying primitive that auto-registers —
  `Walrus({local})` for WAL, `Package({ coins })` for user coins).

### FM-9: Strategy signing failure (`walExchangeStrategy` / `treasuryCapMintStrategy`)

- **Trigger:** The cap-holder signer's `signAndExecute(tx)` fails (gas object stale, network blip,
  cap object stale).
- **Current behavior:** `Effect.mapError` wraps the inner `SignAndExecuteError` in
  `FaucetRequestError` carrying `coinType`, `address`, `amount`, and the original cause
  (`treasury-cap-mint.ts:57-68`, `wal-exchange.ts:69-79`). Asserted at
  `treasury-cap-mint.test.ts:81-108` and `wal-exchange.test.ts:83-110`.
- **Recovery:** None internal — the strategy does NOT retry. The outer caller
  (`Account({ funding })`) maps the failure to `AccountError(phase: 'fund')`
  (`services/account.ts:573-582`).

### FM-10: Sui faucet has no `faucet` field (mainnet, suiCustom w/o faucet)

- **Trigger:** User configured `Sui({ network: 'mainnet' })` or a custom network without `faucet`,
  then declared `Account({ kind: 'ephemeral-funded' })`.
- **Current behavior:** `services/account.ts:471-481` fails at acquire-time with
  `AccountError(phase: 'fund')`: "Account: '...' is ephemeral-funded but the configured Sui has no
  faucet. Use {kind: 'keystore'|'env'|'inline'} for accounts on this network, or pick the default
  localnet which exposes a faucet."
- **Recovery:** None automatic. User changes the account spec.

### FM-11: Chain never becomes funds-transferable

- **Trigger:** `sui.waitForTransactionsReady()` exhausts its 90s budget without seeing a
  `status: "Success"` from `faucetReadyProbe`.
- **Current behavior:** `services/sui.ts:437-453` fails with
  `SuiError(phase: 'wait-for-transactions-ready')` and a multi-line diagnostic message naming the
  typical causes (mid-genesis cold start; inconsistent on-disk state from a prior SIGKILL'd
  shutdown) and recovery (`pnpm exec devstack wipe --yes && pnpm exec devstack up`).
  `services/account.ts:498-506` wraps this as `AccountError(phase: 'fund')`.
- **Recovery:** User-initiated wipe-and-retry per the diagnostic.

## Persistence model

### What survives restart

**Nothing.** The strategy registry is rebuilt every supervisor cycle (see IR-1).

### What survives snapshot

**Nothing.** `devstack snapshot save` does not capture any faucet state. The Sui container's
writable layer (which contains `/root/.sui` chain state including the faucet binary's internal
recent-tx ledger) IS captured by snapshot — but that's Sui's responsibility, not the faucet
subsystem's.

### What gets wiped on `devstack wipe`

**Nothing belonging to the faucet subsystem.** Wipe targets:

- per-stack docker network/volumes (Sui).
- per-stack `.devstack/stacks/<stack>/.keys/<name>.key` (Accounts).
- state-store entries.

The faucet has no state in any of these.

### What is process-local only

**Everything in the faucet subsystem.** The `Ref<Map<coinType, FaucetStrategy>>` is process-local
AND scope-local (per layer build).

## Modes & variants

The faucet subsystem itself is **single-mode** (in-memory dispatcher) — but its consumer-facing
behavior varies sharply based on which Sui network is in scope. The table below documents what **the
SUI HTTP funding path** does in each mode, since that's the consumer surface most affected.

For non-SUI coins (`WAL`, user `TreasuryCap` coins), the behavior is independent of network mode —
the strategy works wherever the underlying chain accepts the signed Move call (i.e. localnet +
testnet/mainnet via user-supplied accounts).

| Dimension             | Localnet (default)                                                                                                                                                                                                                                                                                                                                                                  | Live (`testnet`)                                                                                                                                                                                                                                                            | Live (`mainnet`)                                                                                                                    | Custom (`network: {rpc, faucet}`)                                      | Fork (`*-fork`)                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Container**         | None (faucet subsystem). The `sui-faucet` HTTP server runs INSIDE the sui-localnet container as part of `sui start --with-faucet=0.0.0.0:9123` (`services/sui.ts:971`).                                                                                                                                                                                                             | None. Targets the public Sui testnet faucet (e.g. `https://faucet.testnet.sui.io/v2/gas` or whatever `Sui({testnet:{faucetUrl}})` overrides).                                                                                                                               | None. No faucet exists for mainnet; `sui.faucet === undefined`.                                                                     | None. If `faucet` is set, it's a user-managed URL devstack just dials. | None — but the **fork has no faucet at all**. `sui-fork` container does not run `--with-faucet`.                                                          |
| **Startup sequence**  | (1) Sui container boots `sui start --with-faucet=...`. (2) Sui's three-probe gate confirms `:9123` HTTP socket bound (`services/sui.ts:1092-1101`). (3) Faucet Layer builds. (4) SUI HTTP strategy auto-registers against `sui.faucet.host`. (5) `Account` calls `sui.waitForTransactionsReady` to wait for funds-transferable tx pipeline. (6) `Account` POSTs via `requestFunds`. | Same as localnet steps 3-4. Steps 1-2 are skipped (no localnet container). Step 5 (`waitForTransactionsReady`) DOES still run (`services/sui.ts:466-477` runs for any non-undefined `faucetUrl`).                                                                           | Steps 3-4 are SKIPPED — `sui.faucet === undefined` so no SUI HTTP strategy registers (`services/faucet/index.ts:236-238`).          | Same as testnet — runs steps 3-6 if `sui.faucet !== undefined`.        | Steps 3-4 are SKIPPED — `sui-fork` doesn't expose a faucet. Account auto-promotes to `fundEphemeralOnFork` impersonation (`services/account.ts:456-469`). |
| **Ready criteria**    | Strategy registered + `waitForTransactionsReady` resolves (probe POST returns `status: "Success"`).                                                                                                                                                                                                                                                                                 | Same probe runs against the public faucet. **OPEN QUESTION:** does the public testnet faucet honor the same `{FixedAmountRequest:{recipient:...}}` body shape that `faucetReadyProbe` POSTs against a stable throwaway address? Behavior in restricted networks unverified. | Auto-mounted Faucet is still in scope but has no SUI strategy. Any `Account({kind:'ephemeral-funded'})` fails fast at acquire-time. | Same as testnet/localnet.                                              | N/A — funding doesn't go through Faucet's SUI HTTP path.                                                                                                  |
| **Persistence**       | The sui-localnet container's writable layer holds the faucet's recent-tx ledger across `docker stop`/`docker start` (Sui's `images/sui/` Dockerfile path). Faucet subsystem itself: none.                                                                                                                                                                                           | None (public faucet is external state).                                                                                                                                                                                                                                     | N/A.                                                                                                                                | None — external faucet, user's responsibility.                         | N/A.                                                                                                                                                      |
| **Teardown**          | Container stops with `stopGraceSeconds: 30` (Sui). `sui-faucet` PID 1 doesn't trap SIGINT (Sui upstream bug — `services/sui.ts:978-1006`) so the validator exits 137 on every cycle. Faucet subsystem: synchronous GC of the `Ref<Map>`.                                                                                                                                            | Faucet subsystem: GC. External: nothing to tear down.                                                                                                                                                                                                                       | N/A.                                                                                                                                | Same as testnet.                                                       | N/A for funding path; fork tears down separately.                                                                                                         |
| **Failure modes**     | FM-1 (ECONNREFUSED during boot), FM-2 (503 warm-up), FM-3 (body Failure during warm-up), FM-11 (chain never funds-transferable).                                                                                                                                                                                                                                                    | FM-1/2/3 still possible against a degraded public faucet. Add: rate-limiting from a public endpoint not modeled in retry.                                                                                                                                                   | FM-10 (no faucet configured).                                                                                                       | FM-1/2/3 against user's faucet.                                        | N/A for faucet path.                                                                                                                                      |
| **Dependencies**      | Sui container fully up + `sui.faucet.host` reachable.                                                                                                                                                                                                                                                                                                                               | `sui.faucet.host` reachable (public network).                                                                                                                                                                                                                               | None (path not exercised).                                                                                                          | User's faucet URL reachable.                                           | Sui fork up + `sui.fork.seed.addresses` populated (different code path).                                                                                  |
| **Hard requirements** | All IRs apply. IR-3 is satisfied (Sui has `faucet`). IR-9 is critical here.                                                                                                                                                                                                                                                                                                         | All IRs apply. IR-9 still gates first POST.                                                                                                                                                                                                                                 | IR-3 produces the "skipped" branch. IR-10 (no faucet → no probe) holds.                                                             | All IRs apply.                                                         | IR-3 produces "no SUI strategy" — funding flows through impersonation instead.                                                                            |

**Faucet sub-modes** (non-network-dependent variants):

| Sub-mode                     | Distinguishing knob                                                       | Behavior                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Auto-mounted hidden faucet   | `fillDefaults` adds `Faucet({hidden:true})` when user didn't supply one   | Built-in SUI strategy auto-registers; not visible in TUI. (`compose/defaults.ts:31-38`)             |
| User-supplied visible faucet | User writes `Faucet({strategies: [...]})` in stack                        | Same as auto + extra strategies; visible TUI row. (`services/faucet/index.ts:216-217`)              |
| Override built-in            | User writes `Faucet({strategies: [suiHttpStrategy({faucetUrl: '...'})]})` | Caller-supplied SUI strategy registered AFTER built-in → wins. (`services/faucet/index.ts:240-244`) |

## Test coverage

### `packages/devstack/src/engine/faucet.test.ts`

Documented in header (`:1-15`) as pinning the three failure shapes of `requestFundsOnce` and the
override-path on `requestFunds`. Uses a `beforeEach`/`afterEach` to monkey-patch `globalThis.fetch`
per test, and `extractSuiHttpFaucetError(exit)` to pull the typed error out of an `Exit.Failure`
regardless of where it lands in the `Cause` tree.

**`describe('requestFundsOnce')`** — pure single-shot semantics:

- **`it.effect('treats a 200 body-level status: { Failure } as a SuiHttpFaucetError')`** (`:52-75`)
  — Mocks `fetch` to return `200 {status: {Failure: {Internal: 'gas object stale'}}}`. Asserts the
  Effect fails with a `SuiHttpFaucetError` whose message matches `/Failure/` and includes the inner
  `Internal` payload string. This is IR-6.
- **`it.effect('resolves cleanly on a status: "Success" body')`** (`:77-94`) — Mocks
  `200 {status: 'Success', coins_sent: [...]}` and asserts the Effect completes. Locks the happy
  path.
- **`it.effect('surfaces fetch rejection (network error) as a SuiHttpFaucetError')`** (`:96-110`) —
  Mocks `fetch` to throw `ECONNREFUSED`. Asserts the wrapped error has
  `message: 'faucet request failed'`, correct `url` and `address`. This is IR-5/FM-1.
- **`it.effect('non-OK HTTP status maps to SuiHttpFaucetError carrying status text')`** (`:112-131`)
  — Mocks `fetch` to return `503 Service Unavailable` with body `'upstream unavailable'`. Asserts
  `message` contains `'503'`. Documents the third failure branch and serves as regression guard
  against "simplifying" the `if (!response.ok)` check away (per `:115-117`). This is IR-5/FM-2.

**`describe('requestFunds — configurable retry budget')`** — retry/timeout override path. Uses
`it.live` (real clock) NOT `it.effect` because `Schedule.exponential` would freeze the `TestClock`
indefinitely:

- **`it.live('maxAttempts override bounds the retry schedule (fail-fast against a broken faucet)')`**
  (`:145-178`) — Forces `maxAttempts: 2, initialDelayMs: 1, timeoutMs: 4_000` against a
  perpetually-rejecting fetch. Asserts elapsed < 2s AND call count is 2-3 (initial + retries).
  Regression guard against silent ignore of `maxAttempts`.
- **`it.live('timeoutMs override surfaces in the wall-clock failure message')`** (`:180-203`) —
  Forces a tiny `timeoutMs: 100` with large `initialDelayMs: 200` so the wall-clock branch fires
  before the schedule exhausts. Asserts the final error's message contains `'100ms'`. Locks IR /
  FM-6's message format.

### `packages/devstack/src/services/faucet/index.test.ts`

Header (`:1-19`) calls out: locks the lifecycle classification — per-cycle state, in-memory only,
ambient mount. Strategy dispatch is exercised by the per-strategy test files plus engine integration
tests.

**`describe('Faucet lifecycle classification')`:**

- **`it.effect('strategy registry is scope-local — fresh Ref<Map> per layer build')`** (`:34-58`) —
  Builds `FaucetLive` twice in sequence (`Effect.provide(FaucetLive)` twice). First scope registers
  `'STUB-A'`; second scope must see an empty registry. IR-1.
- **`it.effect('register/listFundable/requestCoin reflect the in-memory registry shape')`**
  (`:61-103`) — Registers a recording strategy; asserts `listFundable` returns it; asserts
  `requestCoin` invokes it; re-registers the same `coinType` with an override and asserts later
  wins. IR-4.
- **`it.effect('unknown coinType fails with FaucetRequestError naming the registered set')`**
  (`:105-119`) — Registers `'SUI'`, then calls `requestCoin('NOPE', ...)`. Asserts failure. FM-8.
- **`it.effect('FaucetLive holds no own state-store / filesystem resources')`** (`:121-137`) —
  Builds `FaucetLive` with NO additional layers and yields the tag. Confirms the runtime equivalent
  of `Layer.Layer<FaucetTag, never, never>`. IR-11.
- **`it.effect('two concurrent FaucetLive scopes hold disjoint registries')`** (`:139-164`) —
  `Effect.all` with `concurrency: 'unbounded'` over two independent `Effect.provide(FaucetLive)`
  blocks, one registering `'LEFT'` and one registering `'RIGHT'`. Asserts each sees only its own.
  IR-1.

### `packages/devstack/src/services/faucet/strategies/treasury-cap-mint.test.ts`

Header (`:1-6`) calls out: unit-level — verifies dispatch via cap-holder signer, no-op on 0n, error
wrapping. Round-trip lives in package integration test against a real localnet.

**`describe('treasuryCapMintStrategy')`:**

- **`it.effect('mints when amount > 0n via the cap-holder signer')`** (`:30-55`) — Stubs the
  signer's `signAndExecute` to record invocation. Calls
  `strategy.request({address, amount: 1_000_000n})`. Asserts the stub was invoked and the strategy's
  `coinType` equals the configured Move type.
- **`it.effect('no-ops on amount === 0n')`** (`:57-79`) — Stubs the signer (recording). Calls
  `strategy.request({..., amount: 0n})`. Asserts the stub was NOT invoked. IR-12.
- **`it.effect('wraps signing failures in FaucetRequestError carrying coin type and address')`**
  (`:81-108`) — Stubs the signer to fail with a synthetic `SignAndExecuteError`. Asserts the
  strategy fails with a `FaucetRequestError` instance whose `coinType` / `address` / `message` carry
  the inner cause's message. FM-9.

### `packages/devstack/src/services/faucet/strategies/wal-exchange.test.ts`

Header (`:1-7`) calls out: unit-level — assertion via stub signer rather than tx-body inspection
(Transaction.toJSON requires a resolved sender).

**`describe('walExchangeStrategy')`:**

- **`it.effect('dispatches the swap via the admin signer with the default payment when amount is 0n')`**
  (`:30-57`) — Stubs the signer's `signAndExecute` recording. Calls
  `strategy.request({..., amount: 0n})` with `defaultPaymentMist: 500_000_000n`. Asserts the stub
  was invoked AND `strategy.coinType === 'WAL'`. IR-13.
- **`it.effect('honors a non-zero amount as the SUI MIST payment')`** (`:59-81`) — Same recording
  stub; calls with `amount: 123_000_000n`. Asserts the stub was invoked. (Doesn't introspect tx body
  since `Transaction.toJSON` needs a sender — comment at `:1-7` explains the limitation.) IR-14.
- **`it.effect('wraps signing failures in FaucetRequestError')`** (`:83-110`) — Stubs the signer to
  fail with a synthetic `SignAndExecuteError('gas budget too low')`. Asserts the strategy fails with
  a `FaucetRequestError` whose `coinType: 'WAL'`, `address`, and `message` carry the inner cause's
  message. FM-9.

### Adjacent test coverage (referenced — owned by other docs)

- `packages/devstack/src/services/account.test.ts` lines 400-510 —
  `funding spec dispatches each entry through Faucet.requestCoin`, including the WAL coin and a
  user-Coin LayeredTag. These exercise the **consumer surface** and provide a deterministic-stub
  `Faucet` (`{ requestCoin, listFundable }`) so the account funding loop can be tested without a
  real chain.
- `packages/devstack/src/engine/dep-graph.test.ts:282-284, 372-383` — locks `@devstack/FaucetTag` as
  a dep-graph key.
- Integration tests under `examples/*/playwright/...` — the full SUI HTTP roundtrip against a real
  `sui-localnet` container is covered transitively by every example app's `Account('alice')` boot.

## Pain points today

### PP-1: Two error classes for the same surface area

`SuiHttpFaucetError` (engine-side wire error, `engine/faucet.ts:32-48`) and `FaucetRequestError`
(service-side strategy error, `services/faucet/index.ts:68-77`) coexist. `suiHttpStrategy` wraps the
former in the latter (`sui-http.ts:37-46`); `account.ts:531` catches `SuiHttpFaucetError` directly
bypassing the strategy registry, while `:573` catches `FaucetRequestError` from the strategy
registry. Net effect: two parallel error paths for SUI funding — one direct (`account.ts:509` →
`requestFunds` → `SuiHttpFaucetError`), one via Faucet (`account.ts:572` →
`faucet.requestCoin('SUI', ...)` → `FaucetRequestError`). Pretty-error.ts has to handle both
(`engine/pretty-error.ts:33` mentions `SuiHttpFaucetError`).

### PP-2: Engine-side `requestFunds` is invoked directly from `account.ts`, bypassing the strategy registry

`services/account.ts:509-540` calls `requestFunds(...)` directly for the `ephemeral-funded` SUI
top-up — it does NOT go through `faucet.requestCoin('SUI', ...)`. This means the auto-mounted SUI
HTTP strategy isn't actually used during the implicit funding step of `ephemeral-funded` accounts;
it's only used during the cross-cutting `funding:` loop (`account.ts:551-585`). The
auto-registration in `services/faucet/index.ts:235-238` is therefore dead code for the most common
funding path. **Architectural smell: the engine-side helper and the service-layer registry are two
ways to do the same thing.**

### PP-3: Engine-side / service-side split inflates the surface area

The two halves — `engine/faucet.ts` (HTTP client) and `services/faucet/` (registry) — are tightly
coupled in practice: the SUI strategy is a thin wrapper around `requestFunds`, and `account.ts`
consumes BOTH. The split adds two import paths, two error classes, and an indirection
(`suiHttpStrategy(opts)`) that wraps `requestFunds(opts)` 1:1 with no added behavior beyond
`mapError`. Could collapse to one module.

### PP-4: `requestFundsOnce` is exported but only used by tests

`engine/faucet.ts:99-177` defines `requestFundsOnce` as a "single-shot helper exported so unit tests
can pin the body-level Failure detection without paying the retry / 90s-timeout cost." But it's now
exported from the engine entrypoint via `engine/faucet.ts` → consumed only at
`engine/faucet.test.ts:19`. Could be hoisted to `_internal` or kept module-private.

### PP-5: Stale `40` references in JSDoc and test assertions

The `DEFAULT_MAX_ATTEMPTS` was changed to 15 in the C14 fix (`engine/faucet.ts:64-69`), but the
JSDoc at `engine/faucet.ts:198-200`, `services/account.ts:156-157`, and the test header comment at
`engine/faucet.test.ts:135` still say 40. Documentation drift.

### PP-6: `listFundable` has no production consumer

`services/faucet/index.ts:136-137` declares `listFundable` and the JSDoc says "Manifest emitters
fold this into `coins[*].fundable`." But a grep across `engine/`, `compose/`, and
`services/manifest*` finds zero consumers — only test stubs use it
(`services/account.test.ts:415,459,510`) and the lifecycle tests (`services/faucet/index.test.ts`).
Either the manifest emitter never adopted it, or this is forward-looking dead API.

### PP-7: Faucet "service" is barely a service

The `FaucetTag` interface is
`register(strategy) + requestCoin(coinType, address, amount) + listFundable`. The implementation is
`Ref<Map>` + dispatch. There's no concurrency control of its own, no fairness, no rate-limiting, no
metrics, no logging beyond the Effect spans annotated inside `requestFunds`. It's essentially a
typed mutable map. The "service" framing exists to plug it into the LayeredTag /
`Effect.serviceOption` consumption pattern — but compared to e.g. `SuiTag` (which carries a
`Client`, ready-probe closures, chainId), `FaucetTag` is light enough that the "service" abstraction
may be overkill.

### PP-8: Two flavors of "auto-register a per-resource strategy"

- Walrus → `walExchangeStrategy` (`walrus/internal.ts:572-583`).
- Package coins → `treasuryCapMintStrategy` (`package/internal.ts:256-280`).

Both follow the same pattern: yield FaucetTag via `serviceOption`, build a strategy, call
`register`. The pattern is duplicated, with subtly different "skip on missing context" rules. Could
be a shared helper, or a sibling-export-mode convention on the FaucetStrategy interface.

### PP-9: `SuiHttpStrategyOptions.timeoutMs` / `maxAttempts` forwarded but not configurable from the auto-mount path

The auto-registered SUI HTTP strategy in `services/faucet/index.ts:237` passes only `faucetUrl` — no
way to override timeout/attempts. Users wanting custom retry budgets must override the strategy
entirely via `Faucet({strategies: [suiHttpStrategy({faucetUrl, timeoutMs: ...})]})`. Account's
`faucetTimeoutMs` / `faucetMaxAttempts` overrides only flow through the direct `requestFunds` path
(PP-2), NOT through the auto-mounted strategy.

### PP-10: Sui's "cheap" probe vs `requestFunds`'s retry both racing for warm-up readiness

`services/sui.ts:1092-1101` (cheap socket-level `GET /` faucet probe in the three-probe ready gate)
AND `services/sui.ts:434-464` (`waitForTransactionsReady` — expensive real-tx probe) AND
`engine/faucet.ts:225-258` (retry loop in `requestFunds`) all overlap during cold-start. They were
added at different times to plug different races. Could be consolidated, OR the layering rationale
could be more sharply documented.

## Open questions

### OQ-1: Is `listFundable` consumed anywhere in production?

`services/faucet/index.ts:136-137` claims "Manifest emitters fold this into `coins[*].fundable`." A
grep across `engine/`, `compose/`, and `services/` (excluding the faucet directory itself and test
files) finds no consumer. Is this dead JSDoc, a never-shipped feature, or wired through some path
the grep missed? Resolving this determines whether `listFundable` belongs in the v2 contract at all.

### OQ-2: Does `Sui({network: 'testnet'})` actually exercise the SUI HTTP strategy against a real public faucet, and if so what does the response shape look like?

`engine/faucet.ts` is hard-coded to the `{FixedAmountRequest:{recipient:...}}` body shape and the
`{status: 'Success' | { Failure }}` response shape (`:111, :154-176`). These match the `sui-faucet`
Rust binary's `/v2/gas` endpoint. Does the public testnet faucet at `faucet.testnet.sui.io` honor
the same path/shape? `faucetReadyProbe` (`services/sui.ts:406-425`) is wired against any
non-undefined `faucetUrl` — so testnet stacks DO run the probe. Behavior in restricted networks
unverified.

### OQ-3: Can two parallel devstack stacks both run faucets simultaneously?

The faucet subsystem is in-memory and scope-local (IR-1 + `services/faucet/index.test.ts:139-164`)
so the registries don't collide. But the **underlying sui-localnet faucet** is per-stack — each
`Sui()` ref boots its own per-stack container (`services/sui.ts:886` —
`networkName = suiNetworkName(identity)` folds `Identity.stack`), and each container runs its own
`sui-faucet` on its own routed hostname (`devstack-<stack>.faucet.localhost:9123` via Traefik). So
yes — parallel stacks each get their own faucet path. **Confirmed** for the faucet subsystem; the
parallel-stack invariant for the Sui container itself is documented in `05-sui.md`.

### OQ-4: What's the rate-limit behavior of the SUI HTTP strategy on testnet?

Public Sui testnet faucet has rate limits not modeled by `requestFunds`'s retry loop. If a stack
with many `ephemeral-funded` accounts hits the limit, the failure shape is presumably HTTP 429 or
similar — which would hit FM-2 and retry, but the wall-clock budget is sized for a localnet
cold-start (90s), not for live-network rate-limit waits. No tests exercise this.

### OQ-5: Is `requestFundsOnce`'s export-for-test-only stance still warranted?

It's only consumed by `engine/faucet.test.ts:19`. If we want the engine API surface to shrink, this
could be module-private and the test could either be rewritten against `requestFunds` with
`maxAttempts: 1` OR moved to a `__test__` re-export.

### OQ-6: Does the v2 design want one Faucet service or per-coin strategies as separate services?

Today there's one `FaucetTag` and a single `Ref<Map>` indexed by coin type. An alternative is one
tag per coin type (`SuiFaucetTag`, `WalFaucetTag`, ...), each provided by its own Layer. The
single-registry choice was made for plugin-author UX (one register call from any context). Whether
v2 keeps this is an explicit design question; documenting it here as an open question rather than a
recommendation.

### OQ-7: What's the right error shape after the strategy auto-registration race?

In the cross-cutting `funding:` loop (`services/account.ts:551-585`), when a user requests `WAL` but
`walrusLocalCluster` hasn't run yet (e.g. wrong dep ordering, no `Walrus()` in the stack), the
failure is "no strategy registered for 'WAL'" with the registered-set listed. Is that enough? Users
who never added `Walrus()` may not know they were expected to; users who added it but
downstream-of-this-account may be confused about ordering. The current error message doesn't
distinguish.

### OQ-8: Should the `Faucet({hidden})` knob exist at all?

`fillDefaults` hardcodes `hidden: true` for the auto-mount (`compose/defaults.ts:38`). User-supplied
`Faucet({...})` defaults to visible. This means the `hidden` parameter has effectively two values
driven by two callers, neither of whom typically touches it explicitly. Could be inferred from
context ("was I auto-mounted by fillDefaults?") instead of a user-typed knob.

### OQ-9: Where does the manifest emitter document the faucet endpoint?

`cli/commands/_manifest-render.ts:18-19` emits `sui-faucet` as a service URL. This is the Sui
service emitting its faucet URL — not the Faucet subsystem emitting anything. So at the manifest
level, the faucet is rendered as a property of `Sui` not as a first-class service entry. Should the
v2 manifest carry a `coins[*].fundable: boolean` field driven by `listFundable`? See OQ-1.

## Opportunities noticed

### ON-1: Collapse `engine/faucet.ts` + `services/faucet/strategies/sui-http.ts` into one file

The strategy is a 1:1 wrapper around `requestFunds` with `mapError`. Splitting them across `engine/`
and `services/` adds two import paths and two error classes (`SuiHttpFaucetError` +
`FaucetRequestError`) for the same surface. v2 could fold the engine-side helper into a private
subroutine of the strategy.

### ON-2: Have `Account({kind: 'ephemeral-funded'})` route through `faucet.requestCoin('SUI', ...)` instead of `requestFunds(...)` directly

This eliminates PP-2 — the implicit SUI top-up would go through the same dispatch path as the
explicit `funding: { SUI }` case. Side benefit: the auto-mounted SUI HTTP strategy becomes
load-bearing instead of dead code. Side risk: the per-account `faucetTimeoutMs` /
`faucetMaxAttempts` overrides need a path through the strategy (today they don't — PP-9).

### ON-3: Make strategies' auto-registration declarative

`walrusLocalCluster` and `publishMove` both implement the same "yield FaucetTag → register a
strategy → fail-soft if Faucet not in scope" pattern (PP-8). Could be a
`FaucetStrategy.autoRegister(strategy)` helper exported from the faucet module, or expressed
declaratively as a strategy-builder ref the consumer's tag emits.

### ON-4: Lift the warm-up race mitigation out of the user-visible API

`requestFunds`'s 90s wall-clock + 15-attempt + jitter schedule + `waitForTransactionsReady` gate
were all bolted on to fix specific races (C14, "thundering herd," "validator not
funds-transferable"). v2 could express the underlying invariant ("first faucet POST happens after a
single shared funds-transferable barrier") as a tag composition pattern instead of a per-call
retry-loop knob.

### ON-5: `FaucetStrategy` could be one of the canonical "plugin author surface" examples

The interface is small (`coinType + request`), the registry semantics are clear, and the
per-strategy tests are tight. This is a cleaner example of a pluggable subsystem than the `Codegen`
/ `Renderer` plugin surfaces — useful for the v2 plugin-author docs to reference.

### ON-6: `Ref<Map>` could be `SubscriptionRef<Map>` so the dashboard reflects late-registered coins live

`listFundable` is a snapshot. If the dashboard wants to render "what can I fund right now"
reactively (e.g. show WAL appearing as fundable once `walrusLocalCluster` registers it mid-cycle), a
`SubscriptionRef` would surface this without polling. This would make `listFundable` itself
live-render and may unlock the documented-but-unwired manifest emission (OQ-1).

### ON-7: Standardize "amount unit per strategy" via a brand or schema

The interface JSDoc (`services/faucet/index.ts:97-114`) carefully documents that `amount` means
different things per strategy (ignored for SUI, MIST for WAL, raw u64 for user coins). This is
footgunny at the call site. v2 could brand the amount with a per-strategy unit tag, or always
denominate in coin-native smallest units with an explicit per-strategy converter.

### ON-8: Move the C14 schedule constants to a shared "warmup-friendly retry profile" abstraction

`DEFAULT_MAX_ATTEMPTS = 15`, `DEFAULT_INITIAL_DELAY_MS = 500`, `DEFAULT_TIMEOUT_MS = 90_000`,
`BACKOFF_FACTOR = 1.5`, jitter `[0.8, 1.2)` — this profile is also useful for the indexer-db ready
probe (`services/sui.ts:518-520`) and other warm-up paths. Could be a named retry-profile
(`warmupRetry`) shared across primitives.

### ON-9: Adjacent cleanup — `engine/sui-cli.ts:411-421` sets `SUI_FAUCET_URL` env var for Move-build subprocesses

This is faucet-adjacent plumbing that lives in the Sui CLI wrapper. v2 could decide whether the Move
build needs the faucet URL at all (typically no — building doesn't dispense gas), or push the env
var to a more specific spawn site.

### ON-10: The cheap socket-level `faucetProbe` in Sui's ready gate (`services/sui.ts:1092-1101`) is currently distinct from `requestFundsOnce`

Both POST/GET to the faucet, both interpret HTTP-level responses, but with slightly different shape
(one GETs `/`, the other POSTs `/v2/gas` with a structured body). v2 could unify the "is the faucet
HTTP server up?" probe with the "is the faucet tx pipeline live?" probe as a two-stage helper
exported from the faucet module instead of from the Sui module.

### ON-11: Pretty-error rendering for `FaucetRequestError`

`engine/pretty-error.ts:33` references `SuiHttpFaucetError` (the engine-side one) but not
`FaucetRequestError`. Verify the latter has a pretty-rendering path; if not, plugin-authored
strategy failures may render less helpfully than built-in SUI failures.
