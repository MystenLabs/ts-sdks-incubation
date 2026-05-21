# account

## Purpose

The `account` component is the per-named-account factory + per-stack identity layer for devstack.
Each call to `Account('alice')` produces a `LayeredTag` that, when the stack runs, acquires a
`Keypair`/`Signer` for the name `alice`, derives its Sui address, optionally funds it through the
ambient `Faucet`, registers the resolved `{name, address}` pair into `AccountRegistry` (so codegen +
the manifest can surface it), and yields a resolved `Account` value that exposes `signAndExecute` /
`signTransaction` / `signPersonalMessage` closures. The factory is the canonical "give me a signer
named `alice`" primitive for `Package`, `Action`, `Wallet`, `DeepbookMarketMaker`, etc.

The bare `Account('alice')` form is sized for the "ephemeral local dev account" case — fresh Ed25519
keypair on first boot, persisted under `.devstack/stacks/<stack>/runtime/accounts/<name>.key` so
warm restarts reuse the same address, and auto-funded from the ambient `sui.faucet` (or via
fork-mode impersonation when the stack runs against a `sui-fork`). The discriminator API
(`{kind: 'keystore'|'env'|'inline'|'signer'|'impersonate'}`) covers the production / external-signer
/ fork-impersonation paths from the same factory. A cross-cutting `funding:` field works on every
branch and dispatches through `Faucet.requestCoin` so any source can be topped up with SUI / WAL /
user-defined coins at acquire time.

## Current implementation

In-scope files:

- `src/services/account.ts` — 1360 LOC. The whole component: factory `Account(name, opts?)`,
  `AccountSource` / `AccountSpec` discriminated union, per-source acquisition (`acquireEphemeral`,
  `acquireFromKeystore`, `acquireFromEnv`, `decodeKeypair`, signer/impersonate branches),
  keystore-alias-file resolver, on-disk keypair persistence (write-with-EXCL race protection +
  chmod), fork-mode `fundEphemeralOnFork`, the `signAndExecute` / `signTransaction` /
  `signPersonalMessage` closures, the gRPC-tx-result → `TxResult` adapter (`deriveObjectChanges`,
  `mapBalanceChanges`, `mapGrpcTxResult`), and the `LayeredTag` wrapper with `__kind='account'` /
  `__pluginName='account'` stamps. (`services/account.ts:363-816`)
- `src/services/account.test.ts` — 667 LOC. Per-source-discriminator unit suite. Covers
  bare/`'ephemeral-funded'` (with warm-start address persistence), `'inline'` (Ed25519 + Secp256k1),
  `'keystore'` (alias-file + address fallback + miss), `'env'` (present + missing), `'signer'` (kp +
  address override), funding Record form, funding array form (bare-Coin + LayeredTag refs), and the
  two error-path tests for `'ephemeral-funded'` (failing `waitForTransactionsReady`, missing
  `sui.faucet`). (`services/account.test.ts:77-637`)
- `src/services/account.fork.test.ts` — 81 LOC. Phase-2 fork-mode pure-TS shape tests. Asserts the
  structured `AccountError` shape raised when fork mode lacks seed addresses (P2.T5), when
  `{kind:'impersonate'}` is used outside fork mode, and a `ForkUnsupportedError` sanity check. Also
  imports `executeImpersonated` + `DEFAULT_FORK_GAS_BUDGET` to fail loudly if those exports drift.
  Container-driven fork cases (P2.T1 fund-by-impersonate, P2.T3 publish-on-fork, P2.T4 mixed
  signing, P2.T6 fork-greeting) live in `*.docker.test.ts` files (not in scope here).
  (`services/account.fork.test.ts:19-81`)

Account-related portions of out-of-scope files (referenced for completeness):

- `src/engine/registries.ts:45-48` — `AccountRecord` interface (`{name, address}`).
- `src/engine/registries.ts:246-249, 323-327, 390` — `AccountRegistry` `Context.Service` class,
  `AccountRegistryLive` layer, `publishAccount` + `requireAccountRegistry` helpers, and inclusion in
  `RegistriesLive`.
- `src/engine/errors.ts:140-149` — `AccountError` tagged class.
- `src/engine/phases.ts:65-66` — `AccountPhases = ['load-key', 'decode-key', 'write-key', 'fund']`.

Totals:

- src LOC (in scope): 1360.
- test LOC (in scope): 748.

## Configuration

Configuration is consumed exclusively at `Account(name, opts?)` call time. There are NO
`defineDevstack` keys, NO CLI flags, and NO env vars that read directly into the Account body. The
single env-var read at acquire time is the user-named `process.env[source.key]` for
`{kind: 'env', key}` — see below. Environment inheritance through transitive engine paths (e.g.
`DEVSTACK_STATE_DIR` flowing into `servicePath`) is documented in the state-store / paths
components, not here.

Per-call inputs accepted by `Account(name, opts?)`:

- `name` — `string`. The account name. Validated against `/^[a-z0-9][a-z0-9._-]{0,63}$/` at the
  factory boundary (`services/account.ts:353-361`); the value is used as the `account/${name}` tag
  id, the on-disk path component (`.../runtime/accounts/<name>.key`), the manifest-side
  `accounts.<name>` key, and (per comment at `services/account.ts:340-352`) docker labels like
  `devstack.account=<name>` for stack pruning. Lower-case alphanumeric + `._-`; must start with a
  letter or digit; max 64 chars.
- `opts?` — `AccountSpec | undefined`. Discriminated by `kind:`; the bare `{}` form (no `kind`) is
  treated as `{kind: 'ephemeral-funded'}` (`services/account.ts:374-376`). Optional `funding?` field
  on every variant.

`opts.kind` (six variants, see `AccountSource` in `services/account.ts:138-243`):

| Variant                        | Extra fields                                                  | Defaults                                                                                                                                                  | Read at file:line                                                                                             |
| ------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `'ephemeral-funded'` (default) | `faucetTimeoutMs?: number`, `faucetMaxAttempts?: number`      | `faucetTimeoutMs` defaults to 90000 ms (90 s); `faucetMaxAttempts` defaults to 40 — both via `requestFunds` fallback (`engine/faucet.ts:212-213`).        | `services/account.ts:138-160`; passed to `requestFunds` at `services/account.ts:526-529`                      |
| `'keystore'`                   | `alias: string`, `path?: string`                              | `path` defaults to `~/.sui/sui_config/sui.keystore` via `defaultKeystorePath()` (`services/account.ts:1189-1190`).                                        | `services/account.ts:161-169`; `1079, 1189-1190`                                                              |
| `'env'`                        | `key: string`, `scheme?: 'ed25519'\|'secp256k1'\|'secp256r1'` | `scheme` is reserved/unused; scheme inferred from bech32 prefix.                                                                                          | `services/account.ts:170-186`; `acquireFromEnv` reads `process.env[source.key]` at `services/account.ts:1145` |
| `'inline'`                     | `privateKey: string` (bech32 `suiprivkey1...`)                | none                                                                                                                                                      | `services/account.ts:187-199`                                                                                 |
| `'signer'`                     | `signer: Signer`, `address?: string`                          | If `address` omitted, `signer.toSuiAddress()` is called (`services/account.ts:431-435`).                                                                  | `services/account.ts:200-221`                                                                                 |
| `'impersonate'`                | `sender: string`                                              | Refused outside `sui.runtime === 'forked'` (`services/account.ts:417-427`); routes signing through `executeImpersonated` (`services/account.ts:612-663`). | `services/account.ts:222-243`                                                                                 |

`opts.funding` (cross-cutting, applies to any `kind:`):

- Record form — `Record<string, bigint>` (e.g. `{ SUI: 100_000_000n, WAL: 5_000_000_000n }`). Keys
  are coin-type strings (built-in short names `'SUI'`/`'WAL'` or fully-qualified Move types).
  (`services/account.ts:262-287, 569`)
- Array form — `ReadonlyArray<AccountFundingEntry>` (`{coin, amount}`). `coin` is a bare value
  `{fullCoinType: string}` or a `LayeredTag<...>` yielding one.
  (`services/account.ts:254-259, 561-568`)
- Resolved-coin-type lookup is `resolveFundingCoinType` — `Context.isKey` discriminates LayeredTag
  vs bare-Coin (`services/account.ts:300-315`).

Indirect configuration consumed:

- `Sui` tag's `network`, `runtime`, `faucet?`, and `fork?` — read at acquire time.
  `runtime: 'forked'` auto-promotes ephemeral-funded to fork-impersonation funding
  (`services/account.ts:456-469`); `runtime: 'forked'` is required for `{kind: 'impersonate'}`
  (`services/account.ts:418-427`); `runtime !== 'forked'` requires `sui.faucet` for ephemeral-funded
  (`services/account.ts:471-481`).
- `StateStoreConfig` — provides `stateDir`/`stack`/`network`, transitively driving the
  `runtime/accounts/` path under `servicePath('accounts')` (`services/account.ts:991`,
  `engine/service-paths.ts:100-115`).
- `DEVSTACK_STATE_DIR` env var — indirectly via `resolveRuntimeRoot` in
  `engine/service-paths.ts:64-67` (out of scope but observable).

## Capabilities CONSUMED

EXHAUSTIVE list. Cite file:line for every dependency.

### Other services / components

- `SuiTag` — yielded inside the body to read `sui.runtime`, `sui.faucet?.host`, `sui.fork`,
  `sui.client`, and to call `sui.waitForTransactionsReady()` before the first faucet POST.
  (`services/account.ts:53, 392, 471-507, 626-664, 668-684`). Declared as a hard upstream in
  `upstreamKeys: [SuiTag.key, ...]` (`services/account.ts:799-805`).
- `FaucetTag` (from `services/faucet/index.ts`) — yielded **optionally** via `Effect.serviceOption`
  (`services/account.ts:58, 552-554`). Used to dispatch `funding:` entries via
  `faucet.requestCoin(coinType, address, amount)`. If absent, the funding pass is a noop (deliberate
  test-ergonomics behavior; `services/account.ts:547-585`). NOT in `upstreamKeys` — the
  optional-fold mounts at runtime when present.
- `Coin`-shaped `LayeredTag` values — yielded inside the funding-array iteration via the tag's
  `useSync` accessor (`services/account.ts:299-315, 561-568`). When `funding` entries carry
  `LayeredTag<..., {fullCoinType: string}, ...>` refs, those tags ARE added to `upstreamKeys` via
  `Context.isKey` discrimination (`services/account.ts:799-804`).

### Engine resources

- `Leasing` (`engine/leasing.ts:29`) — yielded for `withExclusive(address, work)` to serialize
  per-address sign+execute work; one permit per address. (`services/account.ts:56, 393, 615, 666`).
  Documented in `services/account.ts:790-798` as a `Context.Service` satisfied by InfraLive (NOT a
  stack member), so it stays out of `upstreamKeys`.
- `FileSystem.FileSystem` (`@effect/platform`) — yielded in `acquireEphemeral` for `fs.exists`,
  `fs.readFileString`, `fs.makeDirectory`, `fs.chmod`
  (`services/account.ts:990, 994-1014, 1051-1062`).
- `StateStoreConfig` (`engine/state-store.ts`) — transitively consumed via `servicePath('accounts')`
  (`services/account.ts:991`, `engine/service-paths.ts:100-115`).
- `publishAccount` (`engine/registries.ts:325`) — called at `services/account.ts:587` once the
  address resolves. This is a thin wrapper that yields `AccountRegistry` and appends an
  `AccountRecord`. (`services/account.ts:55`).
- `requestFunds` (`engine/faucet.ts:179`) — called for the SUI faucet HTTP funding path on
  ephemeral-funded non-fork stacks. (`services/account.ts:57, 509-540`).
- `tag` / `setPhase` / `LayeredTag` (`advanced/tag.ts`) — `tag(name, build, opts)` is the underlying
  constructor wrapping the body into a `LayeredTag`; `setPhase(...)` is yielded to push narration
  into the TUI row. (`services/account.ts:52, 389-806, 410-465, 508`).
- `stringifyCause` (`engine/stringify-cause.ts`) — used when constructing `SignAndExecuteError` from
  `Effect.tryPromise` catches in the sign closures. (`services/account.ts:61, 681, 726, 746, 755`).
- `Effect.fn(...)` span-naming wrapper around the body — names the span `account(<name>)`
  (`services/account.ts:391`).
- `Effect.annotateCurrentSpan` — stamps `'account.name'`, `'account.source'`, `'sui.runtime'`,
  `'account.address'` onto the surrounding span (`services/account.ts:403-407, 447`).

### Runtime resources (filesystem)

- Reads + writes the file `<runtimeRoot>/accounts/<name>.key` for ephemeral-funded persistence
  (`services/account.ts:991-1067`).
- Reads `~/.sui/sui_config/sui.keystore` (or `source.path` override) plus the sibling `sui.aliases`
  for `{kind: 'keystore'}` (`services/account.ts:1078-1138, 1198-1240, 1189-1190`).
- `nodeFs.writeFile(..., {flag: 'wx', mode: 0o600})` — exclusive write so concurrent first-time
  `acquireEphemeral(name)` calls don't clobber each other (`services/account.ts:1028-1046`). The
  losing fiber gets `EEXIST`, falls into the re-read branch.
- `fs.chmod` (best-effort, no-op on Windows) — tightens to 0o600 file / 0o700 dir on every read AND
  write path (`services/account.ts:1009, 1014, 1061, 1065`, `1256-1268`).

### Surfaces

- `setPhase(...)` calls feed the TUI row narration. Phases used: `'loading keystore'`,
  `'binding signer'`, `'binding impersonation slot'`, `'fork-impersonate funding'`,
  `'awaiting chain funds-transferable'`, `'requesting funds'`, `'funding <coinType>'`,
  `'requesting funds (attempt N, last: …)'` (during retry-progress).
  (`services/account.ts:410-465, 496, 508, 519-521, 571`).
- `displayTitle: 'accounts.${name}'` +
  `display: (s) => ({title: 'accounts.${s.name}', primary: s.address})`
  (`services/account.ts:781-785`). The engine entry stamps `accounts.alice` instead of the raw
  `account/alice` tag key (cross-ref: `engine/engine.ts:119-121`).
- `__kind: 'account'`, `__pluginName: 'account'` stamps on the returned tag
  (`services/account.ts:812-815, 779-780`). These flow into TUI section grouping + plugin
  attribution.

### External

- `globalThis.fetch` (transitively, through `engine/faucet.ts::requestFundsOnce`) — POST to
  `${faucetUrl}/v2/gas` for ephemeral-funded non-fork. The Account body never calls `fetch`
  directly; `requestFunds` does.
- gRPC `client.signAndExecuteTransaction({signer, transaction, include})` via `sui.client` —
  `services/account.ts:670-678`. Resolves through the SDK's `SuiGrpcClient` against the active
  fullnode.
- `sui.client.waitForTransaction({digest})` — called after both the signed and the impersonated
  execution paths so a follow-up tx referencing a created object doesn't race the indexer
  (`services/account.ts:644-651, 722-729`).
- `sui.fork.impersonate(seed, tx)` — fork-mode funding (`services/account.ts:965`) and impersonation
  tx submission (`services/account.ts:626-642`).

### Effect/Layer/Context machinery

- `Context.isKey(coin)` — discriminates `LayeredTag` vs bare-Coin in funding array entries
  (`services/account.ts:308`).
- `Context.Service<..., LeasingShape>` type wrapper at the `Leasing` import site.
- `Effect.gen`, `Effect.fn`, `Effect.succeed`, `Effect.fail`, `Effect.all`, `Effect.try`,
  `Effect.tryPromise`, `Effect.catchTag`, `Effect.mapError`, `Effect.flatMap`,
  `Effect.serviceOption`, `Effect.retry`, `Effect.timeoutOrElse`, `Effect.orElseSucceed`,
  `Effect.ignore`, `Effect.as`, `Effect.annotateCurrentSpan`, `Effect.void` — all standard.
  (`services/account.ts` import line 40, body).
- `Schedule.spaced('300 millis')` — used for the "Dependent package not found on-chain" bounded
  retry (`services/account.ts:697`).
- `FileSystem.FileSystem` tag — yielded directly inside `acquireEphemeral`
  (`services/account.ts:990`).
- `Schema.Struct`, `Schema.Literals`, `Schema.Unknown`, `Schema.String` — used to author the
  runtime-validation mirror `AccountSchema` (`services/account.ts:108-116`).

### Imports from other workspace packages

- `@mysten/sui/cryptography` — `decodeSuiPrivateKey`, `encodeSuiPrivateKey`, `SignatureScheme`,
  `Signer`, `Keypair` (`services/account.ts:41-49`).
- `@mysten/sui/keypairs/ed25519` — `Ed25519Keypair` (`services/account.ts:46, 1016, 1177`).
- `@mysten/sui/keypairs/secp256k1` — `Secp256k1Keypair` (`services/account.ts:47, 1179`).
- `@mysten/sui/keypairs/secp256r1` — `Secp256r1Keypair` (`services/account.ts:48, 1181`).
- `@mysten/sui/client` — `SuiClientTypes` (only used as a type for `addressOwner`,
  `deriveObjectChanges`, `mapBalanceChanges`, `mapGrpcTxResult`)
  (`services/account.ts:50, 1297, 1304-1349`).
- `@mysten/sui/transactions` — `Transaction` (used to build the fork-mode `pay_sui` funding tx)
  (`services/account.ts:51, 961-963`).
- `effect` — `Context`, `Effect`, `FileSystem`, `Schedule`, `Schema` (`services/account.ts:40`).

### npm dependencies

- `node:fs/promises` — `nodeFs.writeFile`, `nodeFs.readFile`, `nodeFs.chmod`. Used directly
  (bypassing the Effect FileSystem) for: the EXCL write path (`services/account.ts:1028-1046`); the
  keystore + aliases file reads (`services/account.ts:1080-1087, 1207-1210`); the chmod fallback
  (`services/account.ts:1263-1266`).
- `node:os` — `nodeOs.homedir()`, `nodeOs.tmpdir()` (latter only in tests).
- `node:path` — `nodePath.join` for default keystore path resolution (`services/account.ts:1190`).

### Other internal imports

- `../engine/errors.js::AccountError` (`services/account.ts:54`).
- `../engine/leasing.js::Leasing` (`services/account.ts:56`).
- `../engine/state-store.js::StateStoreConfig` (`services/account.ts:59`).
- `../engine/service-paths.js::servicePath` (`services/account.ts:60`).
- `../engine/registries.js::publishAccount` (`services/account.ts:55`).
- `../engine/faucet.js::requestFunds` (`services/account.ts:57`).
- `./faucet/index.js::FaucetTag` (`services/account.ts:58`).
- `../engine/shared.js` — `Account` (re-exported as `AccountValue`), `BalanceChange`,
  `SignAndExecuteError`, `SuiObjectChange`, `TxResult` (`services/account.ts:62-68`).
- `./sui.js::SuiTag, Sui` (`services/account.ts:53`).
- `../advanced/tag.js::tag, setPhase, LayeredTag` (`services/account.ts:52`).

## Capabilities PRODUCED

What this exposes to others.

### Endpoints

None. The Account component produces no network endpoint, no socket, no HTTP/gRPC listener of its
own. All exposed surface is process-internal (closures + registry entries).

### State-store entries

NONE — Account does not write to the engine `stateStore`. The persisted secret lives in a plain file
(see Files written). This is a notable shape — Account is the only persistent service in devstack
that bypasses the `StateStoreKeys` builder convention (cross-ref: `engine/state-store-keys.ts` has
no `accountKey` entry).

### Events emitted

No standalone events. Status narration goes through `setPhase` (consumed by the TUI engine) — not a
discrete event bus.

### Files written

- `<runtimeRoot>/accounts/<name>.key` — bech32 `suiprivkey1...` string (Ed25519). Written with
  `O_EXCL` on first-time generation; mode 0o600; parent dir mode 0o700.
  (`services/account.ts:991, 1013-1014, 1028-1046, 1061-1065`)
- Resolved path examples (from `engine/service-paths.ts:78-81`):
  - localnet / fork: `<appDir>/.devstack/stacks/<stack>/runtime/accounts/<name>.key`
  - live nets: `<appDir>/.devstack/networks/<network>/runtime/accounts/<name>.key`
  - `DEVSTACK_STATE_DIR=$D` override: `$D/runtime/accounts/<name>.key`

The path scheme is a comment-promised contract: the module header (`services/account.ts:1-35`) and
the persistence comment (`services/account.ts:981-985`) both name "runtime/accounts/<name>.key" —
the `.keys/` form in the file header comment (`services/account.ts:11`) appears to be stale
documentation.

### CLI commands registered

None. Account does not register any CLI surface.

### Routes registered

None. Account does not register HTTP/gRPC routes.

### TypeScript exports consumed elsewhere

From `services/account.ts`:

- `Account(name, opts?)` — the factory function (re-exported via `services/index.ts` → root
  `index.ts:52`). Consumed by user code in stacks (`devstack(alice, hello)` pattern in
  `compose/devstack.ts:178`), by `Package({ signer: alice })` (`services/coin.ts:415` and
  equivalents), by `Wallet({ accounts: [alice, bob] })` (`services/wallet.ts:38-41, 55`), by
  `Dev`/`Action` factories indirectly.
- `Account` type (`= AccountValue`) — the per-account resolved shape (`services/account.ts:101`).
  Re-exported from `engine/shared.ts` as the canonical projection. Consumers:
  `services/wallet/internal.ts:30, 56, 93, 481-490`, `services/coin.ts:37, 415`, codegen emitters
  that read `accounts.<name>.address`.
- `AccountSpec`, `AccountSource`, `AccountFunding`, `AccountFundingEntry` types — public spec
  surface (`services/account.ts:138-326`).
- `AccountSchema` — runtime-validation Schema mirror (`services/account.ts:108-116`).

### Registry entries written

- One `AccountRecord = {name, address}` per `Account(name, ...)` instance, written via
  `publishAccount` (`services/account.ts:587`). Dedup by `name`, last-write-wins
  (`runtime/service.ts:276`).
- Read at finalization by `gatherManifest` (`runtime/service.ts:256, 320-323`); becomes
  `manifest.accounts[name] = {address}` in the on-disk manifest.
- Codegen `StackHandleEmitter` reads this and emits `<outputDir>/accounts.ts` →
  `export const accounts = { alice: '0x…', … } as const`
  (`codegen/emitters/stack-handle.ts:50-63, 174-178`).

### Container images / volumes produced

None.

### Span / observability surface

- Each per-account acquisition is wrapped in a `Effect.fn('account(<name>)')` span.
  (`services/account.ts:391`)
- Attributes set on the span: `account.name`, `account.source`, `sui.runtime`, `account.address`.
  (`services/account.ts:403-407, 447`)
- Leasing wraps signing work in `Leasing.withExclusive` spans with `address` attribute
  (`engine/leasing.ts:61`).

## Lifecycle

### Startup (per-account)

The Account body runs as a single Effect inside the surrounding `LayeredTag`'s Layer, gated by the
`upstreamKeys` it declares (`SuiTag.key` plus any funding LayeredTag refs). Ordered steps
(services/account.ts:391-815):

1. `yield* SuiTag` — block until the `Sui` primitive is ready and read its current shape (network,
   runtime, faucet?, fork?, client, `waitForTransactionsReady`). (`services/account.ts:392`)
2. `yield* Leasing` — bind the per-address semaphore service. (`services/account.ts:393`)
3. Stamp span attributes (`account.name`, `account.source`, `sui.runtime`).
   (`services/account.ts:403-407`)
4. Branch on `source.kind`:
   - `'keystore'|'env'|'inline'` → `setPhase('loading keystore')` (`services/account.ts:410-411`)
   - `'signer'` → `setPhase('binding signer')` (`services/account.ts:412`)
   - `'impersonate'` → `setPhase('binding impersonation slot')`, verify `sui.runtime === 'forked'`
     (fail with `AccountError(phase: 'fund')` otherwise). (`services/account.ts:413-428`)
5. `acquireSigner(name, source)` (`services/account.ts:429, 826-849`):
   - `'ephemeral-funded'` → `acquireEphemeral` (FS-touching; persists key)
   - `'keystore'` → `acquireFromKeystore` (FS read of keystore + aliases)
   - `'env'` → `acquireFromEnv` (reads `process.env[source.key]`)
   - `'inline'` → `decodeKeypair(name, source.privateKey)`
   - `'signer'` → `Effect.succeed(source.signer)`
   - `'impersonate'` → `Effect.succeed(makeImpersonateSigner(source.sender))`
6. Resolve address: `source.address` (signer with override) > `source.sender` (impersonate) >
   `signer.toSuiAddress()`. (`services/account.ts:430-435`)
7. Lowercase scheme — `signer.getKeyScheme().toLowerCase()` (`services/account.ts:444-445`).
8. Stamp `account.address` attribute (`services/account.ts:447`).
9. If `source.kind === 'ephemeral-funded'`:
   - If `sui.runtime === 'forked' && sui.fork !== undefined`:
     `setPhase('fork-impersonate funding')` +
     `fundEphemeralOnFork({name, sui, newAddress: address})` (`services/account.ts:456-469`)
   - Else: refuse if `sui.faucet === undefined` (typed `AccountError`); else
     `setPhase('awaiting chain funds-transferable')` + `sui.waitForTransactionsReady()` (typed
     mapping of `SuiError` → `AccountError(phase: 'fund')`); then `setPhase('requesting funds')` +
     `requestFunds({...})` (typed mapping of `SuiHttpFaucetError` → `AccountError(phase: 'fund')`).
     (`services/account.ts:471-541`)
10. Cross-cutting funding pass (`!fundingIsEmpty`): yield `Effect.serviceOption(FaucetTag)`; if
    Some, normalize Record/array forms into `[coinType, amount]` pairs (resolving LayeredTag refs
    via `useSync`); for each, `setPhase('funding <coinType>')` +
    `faucet.requestCoin(coinType, address, amount)` (catch `FaucetRequestError` →
    `AccountError(phase: 'fund')`). If None, silently noop. (`services/account.ts:547-585`)
11. `yield* publishAccount({name, address})` — register the `{name, address}` record in
    `AccountRegistry`. (`services/account.ts:587`)
12. Build `signAndExecuteImpersonate` (impersonate path) AND `signAndExecuteSigned` (signed path);
    pick the one matching `source.kind === 'impersonate'`. (`services/account.ts:612-739`) Both wrap
    their wire calls in `leasing.withExclusive(address, …)`.
13. Build `signTransaction` + `signPersonalMessage` closures over the underlying `signer` (or
    throwing placeholders for impersonate, via `makeImpersonateSigner`).
    (`services/account.ts:741-759`, `859-898`)
14. Return the resolved `Account` value:
    `{name, address, publicKey, scheme, source: 'impersonate'|'real', signAndExecute, signTransaction, signPersonalMessage}`.
    (`services/account.ts:761-776`)

What blocks what:

- The body cannot start until `SuiTag` is ready — the layer scheduler enforces this via
  `upstreamKeys: [SuiTag.key, …]` (`services/account.ts:799-805`).
- Ephemeral-funded on non-fork blocks on `sui.waitForTransactionsReady()` BEFORE the first faucet
  POST. The comment at `services/account.ts:485-495` notes this is the central wait: the Sui
  primitive memoizes the result via `Effect.cached`, so multiple parallel accounts share one
  resolution rather than spending their own retry budgets.
- Account body holds the Leasing permit ONLY around sign-execute work (per-call), not over its
  acquisition. Acquisition is parallel-safe across accounts.

What runs in parallel:

- Multiple `Account(...)` instances within one stack acquire concurrently — only `SuiTag` and any
  cited coin tags gate them. Per-account funding doesn't serialize against other accounts (different
  addresses).

### Ready criteria

The Account is "ready" (yieldable as a resolved `Account` value) when the body's final `return`
runs. That requires (in order): Sui is up, the signer is acquired, the address is funded (whichever
path), and the `AccountRegistry.publishAccount` write has landed. The engine's per-tag status flips
to `ready` at the same point — `setPhase` calls drive the row's interim narration while the body
progresses.

There is NO separate "Account.healthCheck" / external probe. The component is a producer of values,
not a long-lived server.

### Restart behavior

- **Process restart (warm)**: The persisted `.../runtime/accounts/<name>.key` file exists;
  `acquireEphemeral` short-circuits (`services/account.ts:994-1010`) by reading the bech32,
  re-tightening permissions (best-effort chmod), and decoding via `decodeKeypair`. The same address
  is recovered. NO new faucet drip is requested per re-acquisition — the fund step runs again
  unconditionally (faucet/fork-impersonate is not idempotent at this layer; it relies on
  `requestFunds`'s own retry/dedup logic). NOTE: The `'ephemeral-funded'` ALWAYS runs the funding
  step on every acquire; there is no "already funded" short-circuit in the body.
  (`services/account.ts:449-541`)
- **Cold restart with empty `.../runtime/accounts/`**: A fresh keypair is generated; the new address
  is persisted; funding runs from scratch.
- **Idempotent ops**: keystore reads, env reads, inline decodes, signer-branch acquisitions are pure
  and idempotent. The EXCL-write path makes ephemeral-funded keypair generation idempotent under
  concurrency: the loser falls back to reading the winner's key (`services/account.ts:1028-1062`).
- **Non-idempotent**: faucet drips (each acquire re-funds), fork-mode `pay_sui` transfers (each
  acquire re-transfers 1 SUI), cross-cutting `funding:` Faucet dispatches (each acquire re-invokes
  `requestCoin`).

### Teardown

- The component has NO custom teardown. The `LayeredTag`'s scope ends naturally with the stack; no
  finalizer registers a sweep, no on-disk file is deleted at scope exit.
- The Leasing semaphore for an address persists for the lifetime of the `Leasing` service
  (engine-scoped); it is released when the engine layer is finalized.
- No grace window — the body produces a value and the value's closures live on inside other Effects
  until the surrounding stack scope closes.

What survives:

- The persisted `.key` file survives teardown, process restart, and `devstack stop` (anything short
  of `devstack wipe`).
- The in-memory `AccountRegistry` does NOT survive — it's rebuilt by re-acquiring each Account tag
  on the next cycle. The manifest emit (`runtime/service.ts:320-323`) bridges the gap by dumping the
  resolved set to `manifest.json` so external tools / codegen can read it post-mortem.

## Hard requirements / invariants

Load-bearing constraints — cited to file:line or asserting test.

- **HR-1. Account name shape**: `name` MUST match `/^[a-z0-9][a-z0-9._-]{0,63}$/`. Enforced at the
  factory boundary (`services/account.ts:353-361`). Rationale (`services/account.ts:340-352`): the
  string flows into (a) the `account/${name}` tag id (must be unique + collision-safe), (b) the
  on-disk path, (c) the manifest key, (d) docker labels for stack pruning. Allowing `..`, `/`, or
  shell metacharacters would let a typo silently traverse a directory or break docker's label
  parser.
- **HR-2. EXCL write for ephemeral keypair persistence**: Concurrent first-time
  `acquireEphemeral(name)` calls MUST use `fs.writeFile(..., {flag: 'wx'})` so two parallel
  generators can't both win and clobber each other. (`services/account.ts:1021-1046`) — "without
  this each one generates its OWN keypair and the second `writeFileString` clobbers the first,
  leaving the loser with a Keypair whose secret isn't on disk." The loser falls back to reading the
  winner's persisted key.
- **HR-3. File permissions**: Keypair files MUST be 0o600, parent dir 0o700. Re-tightened on
  warm-start (`services/account.ts:1009, 1014, 1061, 1065`) in case an older run wrote under a
  permissive umask. Best-effort — Windows silently no-ops.
- **HR-4. Scheme lowercased at boundary**: `scheme` MUST be lowercase
  (`'ed25519'`/`'secp256k1'`/`'secp256r1'`) when surfaced to downstream consumers. Comment at
  `services/account.ts:436-443` documents the previous bug — `signer.getKeyScheme()` returns
  mixed-case ('ED25519' / 'Secp256k1'); the bare cast pre-fix silenced TS without converting;
  downstream consumers (manifest serialization, on-chain Move type matching, the dev-wallet adapter)
  read the field expecting lowercase and quietly diverged.
- **HR-5. `Sui.waitForTransactionsReady` BEFORE first faucet POST**: For `ephemeral-funded` on
  non-fork stacks, the body MUST yield `sui.waitForTransactionsReady()` BEFORE calling
  `requestFunds`. Comment at `services/account.ts:485-495`: the supervisor's Sui-ready gate is
  socket-level only; the faucet HTTP server may be bound while the validator is still mid-genesis
  (returns 200 OK with body `{status: {Failure: …}}`). The retry budget would absorb this race
  per-account, but centralizing the wait at `sui` (memoized via `Effect.cached`) lets every
  ephemeral-funded account share one cached resolution. Asserted by the
  `waitForTransactionsReady fails` test in `services/account.test.ts:565-611`.
- **HR-6. `withExclusive(address, …)` around sign+execute**: Two parallel `signAndExecute` calls
  from the same address MUST be serialized via Leasing. Comment at `services/account.ts:589-593`:
  "two parallel sign+execute calls from the same signer race the gas-coin object's version and one
  fails with LockedSharedObject". Enforced by `leasing.withExclusive(address, …)`
  (`services/account.ts:615, 666`).
- **HR-7. `waitForTransaction` AFTER tx submit**: Both signed and impersonated execution paths MUST
  call `sui.client.waitForTransaction({digest})` before returning. Comment at
  `services/account.ts:716-721`: "Without this, a follow-up tx that references an object created
  here (e.g. a `publish` → `tx.moveCall(${packageId}::…)` sequence) can race the indexer and fail
  with 'Dependent package not found on-chain' even though the publish reported success."
  Cross-reference the bounded retry at `services/account.ts:695-699` for the same race surfaced as a
  gRPC error.
- **HR-8. Impersonation only on fork mode**: `{kind: 'impersonate'}` MUST fail with
  `AccountError(phase: 'fund')` when `sui.runtime !== 'forked'`. (`services/account.ts:418-427`).
  Asserted shape-wise in `services/account.fork.test.ts:43-58`.
- **HR-9. Fork-mode ephemeral funding requires seed addresses**: `sui-fork` has no faucet;
  `fundEphemeralOnFork` MUST fail with `AccountError(phase: 'fund', account)` when
  `sui.fork.seedAddresses` is empty. (`services/account.ts:938-948`). Asserted shape-wise in
  `services/account.fork.test.ts:21-41`.
- **HR-10. Ephemeral-funded requires `sui.faucet` on non-fork**: (`services/account.ts:471-480`).
  Asserted by the `no faucetUrl` test in `services/account.test.ts:613-636`.
- **HR-11. `upstreamKeys` strict-ordering**: The Account tag MUST declare `SuiTag.key` plus every
  funding-array LayeredTag ref's key. (`services/account.ts:799-804`). Without this, the layer build
  sees no dependency edge between Sui/coin tags and the account, and the body races ahead — yielding
  "Service not found: sui" at runtime. Coin entries from the funding-array form enter the list ONLY
  when they are `LayeredTag` refs (`Context.isKey === true`); bare-Coin shape carries no key.
- **HR-12. `FaucetTag` consumed via `Effect.serviceOption`**: The funding-pass MUST be a noop when
  no Faucet is in scope. Comment at `services/account.ts:547-551`: "rare — only unit tests that
  build the Account layer without devstack(...); non-empty `funding` with no Faucet is treated as a
  noop rather than a failure to keep test ergonomics from regressing." Asserted by the
  `funding spec dispatches …` test paths in `services/account.test.ts:400-540`.
- **HR-13. The bare `Account('alice')` MUST equal `Account('alice', {kind: 'ephemeral-funded'})`**:
  The ergonomic-shorthand branch at `services/account.ts:374-376` widens `opts === undefined` and
  `opts` without `kind` to `{kind: 'ephemeral-funded'}`. Asserted by the matching tests at
  `services/account.test.ts:78-152`.
- **HR-14. `signTransaction` / `signPersonalMessage` on impersonate MUST throw**:
  `makeImpersonateSigner` returns a synthetic signer whose `signTransaction` and
  `signPersonalMessage` throw synchronously to surface accidental usage from a caller that bypassed
  the per-account `signAndExecute` wrapping. (`services/account.ts:874-895`)
- **HR-15. Bounded retry on "Dependent package not found on-chain"**: The signed execution path
  retries up to 6 times at 300ms spacing on this specific message. (`services/account.ts:686-699`).
  Anything else (unfunded account, invalid args, etc.) fails fast. Comment at
  `services/account.ts:686-694` explains the gRPC vs JSON-RPC parity rationale.
- **HR-16. AccountError signing vs acquisition split**: Signing failures MUST surface as
  `SignAndExecuteError`, NOT `AccountError`. `AccountError` is the _acquisition_ error (faucet
  failed, keystore unreadable, etc.). (`services/account.ts:97-99` — explicit contract in the
  type-doc.)

## Failure modes

For each failing path: trigger, current behavior, recovery.

- **Invalid account name** (matches `ACCOUNT_NAME_RE` violation):
  - Trigger: `Account('Alice/v2')`, `Account('foo bar')`, etc.
  - Current behavior: synchronous `TypeError` at factory-call time (NOT in the body) —
    `services/account.ts:354-360`. The error message names the regex.
  - Recovery: user fixes the name.

- **Keystore file missing / unreadable**:
  - Trigger: `{kind: 'keystore'}` with a non-existent path; FS-level error.
  - Current behavior: `AccountError(phase: 'load-key', cause: <FS error>)`.
    (`services/account.ts:1082-1088`)
  - Recovery: user installs Sui CLI / supplies a valid `path:`.

- **Keystore is invalid JSON** / empty:
  - Trigger: `{kind: 'keystore'}` against malformed file.
  - Current behavior:
    `AccountError(phase: 'load-key', message: 'keystore at <path> is not valid JSON' | 'keystore at <path> is empty')`.
    (`services/account.ts:1093-1106`)
  - Recovery: user re-creates a valid keystore.

- **Alias not found in keystore**:
  - Trigger: `{kind: 'keystore', alias: 'does-not-exist'}` against a real keystore.
  - Current behavior:
    `AccountError(phase: 'load-key', message: 'keystore at <path> has no entry matching alias/address …')`.
    (`services/account.ts:1130-1137`). Asserted by `services/account.test.ts:301-334`.
  - Recovery: user uses the right alias / address.

- **Env var missing**:
  - Trigger: `{kind: 'env', key: 'X'}` with `process.env.X === undefined || ''`.
  - Current behavior: `AccountError(phase: 'load-key', message: \`env var 'X' is not set for account
    '<name>'\`)`. (`services/account.ts:1146-1152`). Asserted by `services/account.test.ts:542-563`.
  - Recovery: user sets the env var.

- **Bech32 decode failure** (`{kind: 'inline'|'env'|'keystore'}` with malformed value):
  - Trigger: invalid `suiprivkey1...` string.
  - Current behavior: `AccountError(phase: 'decode-key', message: \`failed to decode private key for
    '<name>'\`, cause)`. (`services/account.ts:1166-1171`)
  - Recovery: user fixes the secret.

- **Unsupported signature scheme** (e.g. MultiSig, ZkLogin, Passkey):
  - Trigger: bech32 prefix decodes to a non-`'ED25519'|'Secp256k1'|'Secp256r1'` scheme.
  - Current behavior: synchronous `Error` thrown inside `keypairForScheme`
    (`services/account.ts:1183-1186`). NOT wrapped in an `AccountError`; surfaces as an Effect
    defect.
  - Recovery: user picks a supported scheme. (NOTE: this is a divergence from the rest of the file's
    typed-error pattern — see Pain points.)

- **Faucet POST fails persistently** (`'ephemeral-funded'` on non-fork):
  - Trigger: `requestFunds` exceeds wall-clock budget OR exhausts `maxAttempts`. Underlying
    `SuiHttpFaucetError` from `engine/faucet.ts:32`.
  - Current behavior: `AccountError(phase: 'fund', cause: SuiHttpFaucetError, message: \`Account:
    failed to fund '<name>' via <faucetUrl>\`)`. (`services/account.ts:530-540`)
  - Recovery: user fixes the chain / faucet OR lowers `faucetTimeoutMs` to fail fast.

- **`waitForTransactionsReady` fails** (chain never becomes funds-transferable):
  - Trigger: validator wedged mid-genesis; `Sui.waitForTransactionsReady` returns `SuiError`.
  - Current behavior: `AccountError(phase: 'fund', cause, message: \`Account: '<name>' aborted
    before funding — chain never became funds-transferable:
    …\`)`. (`services/account.ts:497-507`). Asserted by `services/account.test.ts:565-611`.
  - Recovery: user restarts the chain / removes the chain.

- **`sui.faucet === undefined` for ephemeral-funded on non-fork**:
  - Trigger: `Sui({network: 'testnet'})` (no faucet) + bare `Account('alice')`.
  - Current behavior: `AccountError(phase: 'fund', message)` pointing the user at
    `{kind: 'keystore'|'env'|'inline'}` or the default localnet. (`services/account.ts:471-481`).
    Asserted by `services/account.test.ts:613-636`.
  - Recovery: user picks a non-ephemeral source for non-localnet stacks.

- **Cross-cutting funding entry fails**:
  - Trigger: `Faucet.requestCoin(coinType, …)` returns `FaucetRequestError` (no strategy / strategy
    errored).
  - Current behavior: `AccountError(phase: 'fund', cause: FaucetRequestError, message: \`Account:
    '<name>' funding of <amount>n <coinType> failed: …\`)`. (`services/account.ts:572-583`)
  - Recovery: user registers a strategy or removes the coin from `funding:`.

- **Sign+execute fails**:
  - Trigger: gRPC error, tx status `success: false`, or `waitForTransaction` rejection.
  - Current behavior: `SignAndExecuteError` (plain discriminated union, NOT
    `Schema.TaggedErrorClass`) at `services/account.ts:679-732`. Subtags by message — see HR-15 for
    the "Dependent package not found on-chain" bounded retry.
  - Recovery: caller catches per-call.

- **Impersonate-mode `signTransaction` / `signPersonalMessage` called**:
  - Trigger: caller bypasses `Account.signAndExecute` and reaches for `signTransaction` directly on
    an impersonation account.
  - Current behavior: synchronous `Error` thrown with a clear "impersonation placeholder" message
    naming the bypass. (`services/account.ts:874-895`)
  - Recovery: caller routes through `signAndExecute`.

- **Fork mode without seed addresses**:
  - Trigger: `sui.runtime === 'forked'` but `sui.fork.seedAddresses.length === 0` and a bare
    `Account('alice')`.
  - Current behavior: `AccountError(phase: 'fund', account: '<name>', message)` pointing at
    `Sui({fork:{seed:{addresses:[…]}}})`. (`services/account.ts:938-948`). Asserted shape-wise in
    `services/account.fork.test.ts:21-41`.
  - Recovery: user configures seed addresses.

- **`{kind: 'impersonate'}` outside fork mode**:
  - Trigger: see HR-8.
  - Current behavior: `AccountError(phase: 'fund', message)`. (`services/account.ts:418-427`).
    Asserted in `services/account.fork.test.ts:43-58`.
  - Recovery: user switches to a `'<net>-fork'` network OR removes the `kind: 'impersonate'` spec.

- **EXCL write race**:
  - Trigger: two concurrent `acquireEphemeral(name)` on the same name + tmpdir.
  - Current behavior: the loser gets `EEXIST`, falls into the re-read branch, and uses the winner's
    persisted key. (`services/account.ts:1028-1063`). Implicitly covered by the "warm-start same
    address" assertion in `services/account.test.ts:130-150`.
  - Recovery: automatic.

## Persistence model

- **Survives process restart**:
  - `<runtimeRoot>/accounts/<name>.key` (the bech32 keypair file). All addresses recovered
    identically on warm-start. (`services/account.ts:991-1067`).
  - That file ALSO survives `devstack stop` and any normal scope teardown — no finalizer deletes it.

- **Survives snapshot save / restore**:
  - The whole `runtime/` tree (which includes `runtime/accounts/`) is the snapshot tar payload
    (`engine/service-paths.ts:5-13`). `snapshot save` tars `runtime/` plus `state.json` plus opt-in
    extras. So per-account `.key` files DO survive snapshot save and are restored verbatim on the
    target machine. The keypair material is portable; the address is replayable.

- **Wiped by `devstack wipe`**:
  - `devstack wipe` removes `.devstack/stacks/<stack>/` (cross-ref convention; the wipe surface is
    outside this component). The `runtime/accounts/<name>.key` files go away with it. Next acquire
    generates a fresh keypair and a NEW address.
  - This is the only mechanism that invalidates `alice`'s identity. There is no in-band cache
    invalidation, no `wipeAccount(name)` surface.

- **Process-local only (NOT persisted)**:
  - The Leasing semaphore for an address (process-local, never serialized).
  - The `AccountRegistry`'s in-memory snapshot (rebuilt per cycle by re-yielding each Account tag).
  - The TUI row state for `accounts.<name>`.
  - The closures `signAndExecute` / `signTransaction` / `signPersonalMessage` (they close over the
    `signer`, the `sui.client`, and the per-instance `leasing` reference).
  - The keystore-file read for `{kind: 'keystore'}` is process-local — devstack does NOT copy the
    keystore into `.devstack/`.

- **Not persisted but recomputed on demand**:
  - The `Account.publicKey: Uint8Array` projection (`signer.getPublicKey().toRawBytes()`).
  - The `Account.source` discriminator (`'real' | 'impersonate'`) — derived from the spec at acquire
    time.

## Modes & variants

Account exposes six SOURCE variants (`AccountSource.kind`) and three SUI RUNTIME modes
(`Sui.runtime: 'bundled' | 'external' | 'forked'`) plus an OFFLINE-network surface. The runtime mode
interacts non-trivially with the source — bare `Account('alice')` (`'ephemeral-funded'`) behaves
differently on `'bundled'` vs `'forked'`. The matrix:

### Source × Runtime

| Dimension         | `'ephemeral-funded'` × `bundled`/`external`                                                                                                                                                                                                                                                                                                               | `'ephemeral-funded'` × `forked`                                                                                                                                                                                                                                                                                                                                                         | `'keystore'`                                                                                                                                                                                                                                                                      | `'env'`                                                                                                                                                                   | `'inline'`                                                                                                                                         | `'signer'`                                                                                                                                                                        | `'impersonate'` (forked only)                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container         | Inherits Sui's. No container of its own.                                                                                                                                                                                                                                                                                                                  | Same.                                                                                                                                                                                                                                                                                                                                                                                   | Same.                                                                                                                                                                                                                                                                             | Same.                                                                                                                                                                     | Same.                                                                                                                                              | Same.                                                                                                                                                                             | Same.                                                                                                                                                                                                                                         |
| Startup sequence  | (1) yield Sui+Leasing; (2) setPhase('awaiting chain funds-transferable'); (3) `sui.waitForTransactionsReady`; (4) load-or-generate keypair under `runtime/accounts/<name>.key`; (5) setPhase('requesting funds'); (6) `requestFunds` against `sui.faucet.host`; (7) optional cross-cutting funding; (8) `publishAccount` (`services/account.ts:471-587`). | (1) yield Sui+Leasing; (2) generate-or-read ephemeral keypair; (3) setPhase('fork-impersonate funding'); (4) `fundEphemeralOnFork` — build pay_sui tx splitting 1 SUI off `tx.gas`, transfer to new address, `sui.fork.impersonate(seed, tx)` (`services/account.ts:917-979`); (5) optional cross-cutting funding; (6) `publishAccount`. NO faucet POST, NO `waitForTransactionsReady`. | (1) yield Sui+Leasing; (2) setPhase('loading keystore'); (3) read `source.path` or default keystore + sibling aliases; (4) resolve alias→address (or fall back to direct address match); (5) decode the matching entry; (6) optional cross-cutting funding; (7) `publishAccount`. | (1) yield Sui+Leasing; (2) setPhase('loading keystore'); (3) read `process.env[source.key]`; (4) decode bech32; (5) optional cross-cutting funding; (6) `publishAccount`. | (1) yield Sui+Leasing; (2) setPhase('loading keystore'); (3) decode `source.privateKey`; (4) optional cross-cutting funding; (5) `publishAccount`. | (1) yield Sui+Leasing; (2) setPhase('binding signer'); (3) use `source.signer` directly (NEVER calls `getSecretKey()`); (4) optional cross-cutting funding; (5) `publishAccount`. | (1) yield Sui+Leasing; (2) setPhase('binding impersonation slot'); (3) refuse if `sui.runtime !== 'forked'`; (4) `acquireSigner` returns the no-op `makeImpersonateSigner(sender)`; (5) optional cross-cutting funding; (6) `publishAccount`. |
| Ready criteria    | Body returns the resolved `Account` value. Address persisted to disk; faucet drip POST returned success; registry entry written.                                                                                                                                                                                                                          | Body returns. Address persisted to disk; pay_sui-via-impersonate tx confirmed via `waitForTransaction`; registry entry written.                                                                                                                                                                                                                                                         | Body returns. NO funding by default — caller's funding spec (if any) ran.                                                                                                                                                                                                         | Same.                                                                                                                                                                     | Same.                                                                                                                                              | Same.                                                                                                                                                                             | Body returns. NO keypair held; `signAndExecute` will route through `executeImpersonated`.                                                                                                                                                     |
| Persistence       | `runtime/accounts/<name>.key` bech32 file (0o600). Persists across restarts; restored from snapshot tar.                                                                                                                                                                                                                                                  | Same.                                                                                                                                                                                                                                                                                                                                                                                   | None. The keystore file is the user's; devstack only reads it.                                                                                                                                                                                                                    | None. The env var is the user's.                                                                                                                                          | None. The bech32 is literal in config.                                                                                                             | None. The signer is supplied by the caller.                                                                                                                                       | None. The sender address is literal in config.                                                                                                                                                                                                |
| Teardown          | None custom. File survives.                                                                                                                                                                                                                                                                                                                               | Same.                                                                                                                                                                                                                                                                                                                                                                                   | Nothing to tear.                                                                                                                                                                                                                                                                  | Same.                                                                                                                                                                     | Same.                                                                                                                                              | Same.                                                                                                                                                                             | Same.                                                                                                                                                                                                                                         |
| Failure modes     | HR-5, HR-10, faucet POST timeouts, bech32 decode failures.                                                                                                                                                                                                                                                                                                | HR-9 (missing seed addresses), `sui.fork.impersonate` errors.                                                                                                                                                                                                                                                                                                                           | Keystore missing / invalid JSON / alias miss / decode failure.                                                                                                                                                                                                                    | Env var missing / decode failure.                                                                                                                                         | Decode failure.                                                                                                                                    | None at acquisition — the signer is assumed valid. (Address override branch trusts `source.address`.)                                                                             | HR-8 (refuses outside fork mode); HR-14 (synchronous throw if non-`signAndExecute` sign called).                                                                                                                                              |
| Dependencies      | `SuiTag`, `Leasing`, `FileSystem`, `StateStoreConfig`, `requestFunds`, `publishAccount`. Faucet via `serviceOption`.                                                                                                                                                                                                                                      | `SuiTag`, `Leasing`, `FileSystem`, `StateStoreConfig`, `sui.fork.impersonate`, `publishAccount`. Faucet via `serviceOption`.                                                                                                                                                                                                                                                            | `SuiTag`, `Leasing`, `nodeFs` (NOT the Effect FS for this branch — uses `node:fs/promises` directly), `publishAccount`. Faucet via `serviceOption`.                                                                                                                               | `SuiTag`, `Leasing`, `process.env`, `publishAccount`. Faucet via `serviceOption`.                                                                                         | `SuiTag`, `Leasing`, `publishAccount`. Faucet via `serviceOption`.                                                                                 | `SuiTag`, `Leasing`, `publishAccount`. Faucet via `serviceOption`.                                                                                                                | `SuiTag` (with `runtime === 'forked'` + `fork`), `Leasing`, `publishAccount`. Faucet via `serviceOption`.                                                                                                                                     |
| Hard requirements | HR-1 — HR-7, HR-10 — HR-13, HR-15, HR-16.                                                                                                                                                                                                                                                                                                                 | HR-1 — HR-3, HR-4, HR-6 — HR-9, HR-11 — HR-13, HR-16.                                                                                                                                                                                                                                                                                                                                   | HR-1, HR-4, HR-6, HR-11 — HR-13, HR-16.                                                                                                                                                                                                                                           | Same.                                                                                                                                                                     | Same.                                                                                                                                              | Same.                                                                                                                                                                             | HR-1, HR-4, HR-6 — HR-9, HR-11 — HR-14, HR-16.                                                                                                                                                                                                |

### `live` network participation

The prompt asks: "does account participate at all, or is it a no-op? Document."

- **Account participates on every network.** It is not network-gated as a primitive. What changes is
  which `kind:` is appropriate:
  - On `localnet` (typically `runtime: 'bundled'`): bare `Account('alice')` works (ephemeral-funded
    via the bundled faucet).
  - On `mainnet|testnet|devnet` (`runtime: 'external'`, typically no `sui.faucet`): bare
    `Account('alice')` fails with `AccountError(phase: 'fund')` (HR-10). Users MUST pick
    `{kind: 'keystore'|'env'|'inline'|'signer'}` to load production secrets.
  - On `*-fork` (`runtime: 'forked'`): bare `Account('alice')` auto-promotes to fork-impersonation
    funding (no faucet exists). `{kind: 'impersonate', sender}` becomes available for executing AS a
    real on-chain address without holding its key.

There is NO mode in which Account is a no-op. The `publishAccount({name, address})` registry write
happens on every successful acquire, so `manifest.accounts[name].address` is always populated
post-run.

## Test coverage

### `src/services/account.test.ts` — `describe('Account(name, opts?) — source discriminator')`

The suite stubs `globalThis.fetch` to return 200 OK for any `${faucetUrl}/v2/gas` POST so
ephemeral-funded tests don't need a real localnet. Each test layers a mock `SuiTag` (variable faucet
URL) + `StateStoreConfig` (per-test tmpdir) on top of a shared
`TestBaseLayer = EngineLive + NodeFileSystemLayer + AccountRegistryLive + LeasingLive`.
(`services/account.test.ts:38-69`)

Per-`it.effect` block:

- **'bare `Account(name)` resolves to ephemeral-funded shape'** (`services/account.test.ts:78-107`)
  — asserts that `Account('alice')` (no opts) yields `address` starting with `'0x'` and
  `scheme === 'ed25519'`. Pins HR-13 (ergonomic shorthand) end-to-end against the layer build.
- **"explicit kind: 'ephemeral-funded' matches the bare form"** (`services/account.test.ts:109-152`)
  — asserts the explicit and bare forms produce the same address AND that warm-start (re-yielding
  under the same tmpdir) recovers the persisted address. Pins HR-13 explicitly AND HR-2 (EXCL
  write + warm-start re-read).
- **"kind: 'inline' loads a literal suiprivkey"** (`services/account.test.ts:154-176`) — generates a
  known Ed25519 keypair off-stack, passes it as a `suiprivkey1...` bech32, asserts `address` matches
  the off-stack derivation and `scheme === 'ed25519'`.
- **"kind: 'inline' carries through scheme for Secp256k1"** (`services/account.test.ts:178-197`) —
  same shape but with `Secp256k1Keypair`, pins HR-4 (lowercase scheme projection) for non-Ed25519.
- **"kind: 'keystore' loads a suiprivkey from a Sui-CLI keystore file by alias"**
  (`services/account.test.ts:199-266`) — writes two real Sui-CLI-shape files (`sui.keystore` +
  `sui.aliases`) to a tmpdir, with two keypairs (alice, bob). The aliases file's `public_key_base64`
  carries `flag || pubkey` (the canonical Sui CLI encoding). Asserts that
  `Account('alice', {kind: 'keystore', alias: 'alice', path})` resolves the right entry via the
  alias-resolution loop.
- **"kind: 'keystore' falls back to address matching when alias file is absent"**
  (`services/account.test.ts:268-299`) — writes only the keystore (no aliases sibling). Passes the
  on-chain address as `alias:`. Asserts the fallback path resolves the entry by direct address
  match.
- **"kind: 'keystore' fails AccountError when no entry matches the alias"**
  (`services/account.test.ts:301-334`) — writes one keystore entry, asks for
  `alias: 'does-not-exist'`. Asserts `AccountError(phase: 'load-key')` with message matching
  `/no entry matching alias\/address/`.
- **"kind: 'env' reads process.env[key]"** (`services/account.test.ts:336-360`) — sets
  `process.env[envKey] = bech32`, asserts the resolved address. Cleans up the env var afterward.
- **"kind: 'signer' uses the supplied Signer directly"** (`services/account.test.ts:362-382`) —
  passes a real `Ed25519Keypair` as `signer`. Asserts address matches the keypair's derived address;
  scheme is lowercased.
- **"kind: 'signer' honors a caller-supplied address override"**
  (`services/account.test.ts:384-398`) — passes `address: '0xdeadbeef'`. Asserts the resolved
  address is the override (NOT the signer's natural address).
- **'funding spec dispatches each entry through Faucet.requestCoin'**
  (`services/account.test.ts:400-441`) — wires a recording-fake `FaucetTag` Layer; passes
  `funding: {SUI: 100n, WAL: 50n}` alongside a `signer`. Asserts the recorder captured both
  `requestCoin` calls in order, keyed by the resolved address. Pins HR-12's positive path and the
  Record-form funding contract.
- **'funding array-form accepts bare Coin values (reads fullCoinType directly)'**
  (`services/account.test.ts:443-491`) — passes
  `funding: [{coin: {fullCoinType: '0x2::sui::SUI'}, amount: 100n}, ...]`. Asserts the bare-Coin
  shape resolves to the literal `fullCoinType` string synchronously.
- **'funding array-form accepts LayeredTag coin refs (yields fullCoinType)'**
  (`services/account.test.ts:493-540`) — builds a minimal Coin-shaped `LayeredTag` via `tag(...)`,
  passes it as `funding: [{coin: coinTag, amount: 42n}]`. Asserts the LayeredTag branch yields the
  ambient-context value and reads `fullCoinType` from it. Pins `Context.isKey`-discrimination at
  `services/account.ts:308`.
- **"kind: 'env' fails AccountError when the env var is missing"**
  (`services/account.test.ts:542-563`) — deletes the env var; asserts
  `AccountError(phase: 'load-key')` with message matching `/env var/`.
- **"kind: 'ephemeral-funded' surfaces AccountError(fund) when waitForTransactionsReady fails"**
  (`services/account.test.ts:565-611`) — supplies a `mockSuiWithFailingReady` whose
  `waitForTransactionsReady` returns a `SuiError`. Asserts the propagation:
  `AccountError(phase: 'fund')` with message matching `/funds-transferable/`. Pins HR-5 (must wait
  before funding) AND the wrapping behavior.
- **"kind: 'ephemeral-funded' fails AccountError when Sui has no faucetUrl"**
  (`services/account.test.ts:613-636`) — `mockSui(undefined)` so `sui.faucet === undefined`. Asserts
  `AccountError(phase: 'fund')` with message matching `/faucet/i`. Pins HR-10.

Test helpers (`services/account.test.ts:639-667`):

- `extractError(exit)` — pulls a typed `AccountError` out of an `Exit.Failure`'s `Cause` tree via
  `Cause.findErrorOption`. Used by every error-path assertion.
- `stubFaucet()` — monkey-patches `globalThis.fetch` to return 200 OK; returns a `restore()` for the
  `finally` block.

### `src/services/account.fork.test.ts` — `describe('Account fork-mode (Phase 2)')` + `describe('executeImpersonated unit shape')`

This file is a SHAPE-only suite — it does NOT exercise the layer build. It asserts the structured
`AccountError` shapes raised in fork-mode code paths.

- **'P2.T5: fork-mode Account without seed addresses fails with a typed AccountError'**
  (`services/account.fork.test.ts:21-41`) — constructs the exact
  `AccountError(phase: 'fund', account: 'alice', message: …)` shape `fundEphemeralOnFork` raises.
  Asserts: `instanceof AccountError`, `phase === 'fund'`, `account === 'alice'`, message contains
  `/seed address/` AND `/Sui\(\{fork: \{seed: \{addresses/`. Pins HR-9's error message format. NOTE:
  This is a non-integration assertion — the test constructs the error directly rather than driving
  the body. The actual code-path enforcement lives at `services/account.ts:938-948`.
- **'P2.T5: impersonate-mode Account outside fork mode fails with AccountError'**
  (`services/account.fork.test.ts:43-58`) — same shape: constructs the exact
  `AccountError(phase: 'fund', …)` shape `services/account.ts:418-427` raises when
  `{kind: 'impersonate'}` meets `sui.runtime !== 'forked'`. Asserts message contains `/impersonate/`
  AND `/sui.runtime/`. Pins HR-8.
- **'Phase 1 R1 guard still trips on fork-mode-config-specific assertion'**
  (`services/account.fork.test.ts:60-72`) — sanity check that `ForkUnsupportedError` (from
  `engine/errors.ts:34`) remains the right tag for fork-only-fullnode-method failures.
  Cross-component link — the error is raised by `services/sui` not by Account, but is documented
  here because `Account.signAndExecute` is the downstream surface that surfaces it.
- **'executeImpersonated unit shape: exports the helper + default gas budget'**
  (`services/account.fork.test.ts:76-80`) — asserts `executeImpersonated` and
  `DEFAULT_FORK_GAS_BUDGET === 100_000_000n` exist as exports from `./sui/impersonate.js`. Drift
  guard — if those exports rename or disappear, Account's impersonation routing breaks
  (`services/account.ts:612-663` uses `sui.fork.impersonate(sender, tx)` which wraps
  `executeImpersonated`).

Container-driven cases (NOT in this file; gated by `RUN_FORK_DOCKER_TESTS=1`):

- P2.T1 (fund-by-impersonate end-to-end), P2.T3 (publish-on-fork), P2.T4 (mixed signing modes),
  P2.T6 (fork-greeting example app).

## Pain points today

- **`runtime/accounts/<name>.key` writes bypass `stateStore`**: Account is the only persistent
  service in devstack that writes to disk WITHOUT going through the `StateStoreKeys` builder
  (cross-ref: `engine/state-store-keys.ts` has no account entry, but every other persisted artifact
  does). The persistence comment at `services/account.ts:981-985` explains the "runtime/" convention
  but doesn't justify why this state isn't a `stateStore` value. Snapshot save / restore happens to
  cover it because the tar is `runtime/`-rooted, but invalidation / wipe semantics aren't co-located
  with the rest of the state-store wipe surface. Cross-component implication: any v2 redesign that
  consolidates persistence under `StateStoreKeys` would need to migrate account keys or carve out a
  documented exception.
- **Stale doc comment for the on-disk path**: The module header (`services/account.ts:11`) names the
  path as `.devstack/stacks/<stack>/.keys/<name>.key` (a `.keys/` directory) while the actual
  implementation writes under `<runtimeRoot>/accounts/<name>.key` via `servicePath('accounts')`
  (`services/account.ts:991`). The factory comment (`services/account.ts:344`) ALSO names `.keys/`.
  The implementation comment (`services/account.ts:981-985`) names `runtime/accounts/`. This is a
  documentation drift — readers reaching for the header to find the file will look in the wrong
  place.
- **Stale `accounts({...})` comment in `engine.ts`**: `engine/engine.ts:322` references "per-account
  tags inside an `accounts({...})` handle" — there is no such composite factory. The API is
  per-account `Account('alice')` calls; the composite `accounts` only exists as the codegen output
  bag (`<outputDir>/accounts.ts`). The comment misleads anyone navigating to find the multi-account
  factory.
- **`unsupported signature scheme` throws a raw `Error` instead of `AccountError`**:
  `keypairForScheme` (`services/account.ts:1183-1186`) throws a `new Error(...)` for
  MultiSig/ZkLogin/Passkey — bypassing the file's otherwise-consistent `AccountError` discipline.
  This surfaces as an Effect defect (not a typed failure channel). Inconsistent with the rest of the
  error model.
- **`scheme.toLowerCase()` cast is a known historical bug-fix carrying scar tissue**:
  `services/account.ts:436-445` documents that the bare cast (`as AccountValue['scheme']`) used to
  silence TS without converting, causing manifest serialization / Move-type-matching / dev-wallet to
  diverge. The fix is correct, but the comment trail is a tell that the underlying contract (SDK
  returns mixed-case; we want lowercase) should probably live closer to the SDK boundary or in
  `engine/shared.ts`'s Account type-doc rather than as a recurring TODO-style comment.
- **Funding-pass dispatches sequentially through `for…of`**: `services/account.ts:570-583` walks
  `entries` in series, awaiting each `faucet.requestCoin` before the next. For 5+ coin types per
  account, this becomes the dominant per-account latency. No `Effect.all` parallelism — likely
  intentional (faucet strategies may be wire-rate-sensitive) but undocumented.
- **`acquireFromKeystore` uses raw `node:fs/promises` instead of the Effect `FileSystem` it
  injects**: `acquireEphemeral` uses `fs = yield* FileSystem.FileSystem` for reads/writes
  (`services/account.ts:990, 994-1014, 1051-1065`) but ALSO falls back to `nodeFs.writeFile` for the
  EXCL write (`services/account.ts:1028-1046`) because the Effect FS lacks an O_EXCL flag.
  `acquireFromKeystore` (`services/account.ts:1080-1138`) goes all-in on `nodeFs.readFile` and never
  yields `FileSystem.FileSystem`. The split is pragmatic but the inconsistency creates two FS
  surfaces in one file.
- **The `kindOmitted` flag is computed but never used after the
  `if (!kindOmitted) { /* empty block */ }` at `services/account.ts:457-462`**: That branch is a
  no-op TODO with a comment about "hint in the error if their seed addresses are empty" — leftover
  from a partially-landed change.
- **`SignAndExecuteError` is a plain discriminated union (`_tag: 'SignAndExecuteError'`), not a
  `Schema.TaggedErrorClass`**: every other error in the file uses
  `AccountError extends Schema.TaggedErrorClass<>`. The `SignAndExecuteError` is hand-rolled
  (`engine/shared.ts:119-123`) and never gets registered with the Effect `pretty-error` /
  `Cause.prettyErrors` pipeline. Comment at `engine/engine.ts:392-398` (`rawFailure`) calls this
  out: the JSON projection has to special-case the plain-object discriminated union.
- **`fundEphemeralOnFork` picks the first seed address blindly** (`services/account.ts:951-955`): no
  load balancing, no fallback to other seeds on failure, no documented contract on "which seed funds
  which account". For multi-seed configs the lack of distribution policy will surface as one seed
  running out of gas first.
- **`source` field on the resolved `Account` value is THREE-VALUED at the type level
  (`'real' | 'impersonate' | undefined`)** (`engine/shared.ts:158`) but the implementation always
  sets one of the two strings (`services/account.ts:772`). The optional-on-type is for backward
  compat with consumers that have not yet been updated; an unreleased project should drop the `?`.
- **`Account.publicKey` is `Uint8Array` (`engine/shared.ts:144`) — but the impersonate path returns
  a 32-byte zero buffer** (`services/account.ts:867-869`). Consumers that treat `publicKey` as
  authoritative (e.g. signature-verify before tx submit) silently see a zero key for impersonate
  accounts. The `source: 'impersonate'` discriminator is the only signal; the type doesn't
  communicate "publicKey is unreliable for impersonate".

## Open questions

- **Should `runtime/accounts/<name>.key` be a `StateStoreKeys` entry**? Right now it bypasses the
  typed-key registry; future invalidation (e.g. selective wipe per account) has no
  `StateStoreKeys.account(name)` to grep for.
- **Is there a `wipeAccount(name)` surface anywhere**? Could not find one in the in-scope files;
  possibly lives in the CLI / supervisor (out of scope here).
- **What is the intended `accounts({...})` factory**? The comment at `engine/engine.ts:322` refers
  to "per-account tags inside an `accounts({...})` handle"; the codegen output
  (`codegen/emitters/stack-handle.ts:50-63`) uses the `accounts` namespace; but no factory accepting
  an object literal exists in `services/account.ts` or `services/index.ts`. OPEN QUESTION: was a
  composite factory planned and dropped, or is the comment a forward-reference to v2?
- **For `'ephemeral-funded'` warm-start, what guarantees does the user have about the on-chain
  balance**? The body re-runs the funding step on every acquire, but the faucet's idempotence policy
  is the faucet's, not the Account's. OPEN QUESTION: should warm-start short-circuit funding when
  the persisted address has a positive balance?
- **`scheme?: 'ed25519'|'secp256k1'|'secp256r1'` is documented as "Reserved for a future raw-hex
  form" on the `'env'` source (`services/account.ts:184-186`) — is this field actually live or
  always-undefined**? Currently always undefined since `decodeKeypair` reads the scheme from the
  bech32 prefix.
- **Does `services/account.fork.test.ts:Phase 1 R1 guard` belong in Account's scope at all**? It
  constructs a `ForkUnsupportedError` and the test is named "executeImpersonated unit shape" — these
  feel like they should live in `services/sui.fork.test.ts` / `services/sui/impersonate.test.ts`,
  not under `account.fork.test.ts`. OPEN QUESTION: split out or keep as a load-bearing drift guard?
- **`fundEphemeralOnFork`'s default `1 SUI`** (`services/account.ts:916, 962`) — is the 1-SUI
  constant per the fork's gas accounting (e.g. "any realistic dev tx fits") OR per the seed
  manifest's pre-seeded balance (i.e. how many ephemeral accounts can one seed fund before running
  dry)? Comment names the former; no upper bound on count is documented.
- **`upstreamKeys` doesn't include `Faucet`** but DOES include `SuiTag` + funding LayeredTag refs.
  Comment at `services/account.ts:790-798` explains: Faucet is consumed via `Effect.serviceOption`
  (optional). OPEN QUESTION: is the optional-Faucet path actually used in production, or only in
  unit tests? If it's only test-ergonomics, the production codepath has a "always-present Faucet"
  invariant the type doesn't enforce.

## Opportunities noticed

- **Consolidate the on-disk path documentation**: three places
  (`services/account.ts:11, 344, 981-985`) name the storage path, and two of them are wrong
  (referring to `.keys/` instead of `runtime/accounts/`). One source of truth, derived from
  `servicePath('accounts')`.
- **Replace `accounts({...})` stale comment in `engine/engine.ts:322`** with the actual API:
  "per-`Account(name)`-registered tags".
- **Promote `AccountSchema` to engine/shared.ts**: the runtime-validation Schema mirror
  (`services/account.ts:108-116`) is co-located with the factory but the underlying `Account` type
  already lives in `engine/shared.ts`. Moving the Schema next to the type prevents future drift.
- **Promote the "unsupported signature scheme" path to `AccountError(phase: 'decode-key')`**:
  `services/account.ts:1183-1186` is the only non-`AccountError` throw in the file; unifying it
  gives the engine's typed-catch a complete error surface for account acquisition.
- **Eliminate the dead `if (!kindOmitted) { /* empty */ }` branch**: `services/account.ts:457-462`.
- **Consider making `SignAndExecuteError` a `Schema.TaggedErrorClass`**: would let
  `Cause.prettyErrors` walk it natively, dropping the special-case in
  `engine/engine.ts::rawFailure`. Cross-component impact — `engine/shared.ts` and every consumer of
  `account.signAndExecute(...)` would need a touch.
- **Add a doc-link from the bare `Account('alice')` form to the auto-promotion fork branch**: today
  the body's fork-promotion is buried in a comment at `services/account.ts:395-402, 449-469`. A user
  reading the factory signature has no way to know that bare-form behavior changes silently when the
  ambient `Sui` is in fork mode.
- **The `Effect.fn('account(<name>)')` span name + the `setPhase` narration overlap**: both surface
  "what is this account doing right now" but via different observability paths. A pass through the
  engine to unify them (or to make `setPhase` automatically annotate the active span) would reduce
  duplication.
- **Parallelize cross-cutting `funding:` dispatches** via
  `Effect.all(..., {concurrency: 'unbounded'})` for accounts that declare multiple coin types, gated
  by a per-strategy "is concurrent-safe" flag from the Faucet service. Today the serial `for…of`
  (`services/account.ts:570-583`) is the dominant per-account cold-start time for stacks with >3
  funded coins.
- **Document the snapshot-save behavior of per-account keys** in the `Persistence model` template
  fragment: today the only place that documents it is `engine/service-paths.ts:5-13` (the
  whole-runtime-tar contract). The Account-specific implication (keys are portable across machines)
  isn't called out anywhere a user would look.
- **Surface seed-address fan-out for fork-mode funding**: `fundEphemeralOnFork` picks
  `seedAddresses[0]` (`services/account.ts:951-955`). For configs with multiple seeds, round-robin
  or random selection would distribute load.
- **`makeImpersonateSigner` could be moved to `services/sui/impersonate.ts`** alongside
  `executeImpersonated` and `DEFAULT_FORK_GAS_BUDGET` — keeps the fork-only synthetic signer next to
  the other fork-only helpers, and keeps `services/account.ts` smaller. Discovered while reading
  `services/account.fork.test.ts:76-80`.
- **Tag stamps `__kind` and `__pluginName` are redundant** with `kind: 'account'` +
  `plugin: 'account'` already passed to the `tag(...)` factory at `services/account.ts:778-781`. The
  post-hoc `Object.assign(accountTag, {__kind, __pluginName})` at `services/account.ts:812-815`
  looks like a transitional double-stamp; one of the two should be eliminated when the substrate v2
  lands. (Cross-ref: `advanced/tag.ts` for which form is canonical.)
