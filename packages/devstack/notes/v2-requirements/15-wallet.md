# wallet

## Purpose

The devstack wallet is a dev-only **server-backed signer** that lets browser-based example apps
under `examples/*` use accounts pinned in `devstack.config.ts` for signing **without ever shipping
private keys into the frontend bundle**. It runs as a single long-lived Node `http.Server` on the
supervisor host, exposes a small HTTP protocol under `/api/v1/devstack/*`, and is paired with the
in-page `DevstackSignerAdapter` (from `packages/dev-wallet`) which is the actual wallet-standard
wallet the dApp consumes. The wallet has NO chain client of its own — it is purely a router from
HTTP requests → resolved `Account` values' Effect-flavored sign closures.

Per the user memory note "devstack-wallet replaced by server-backed signer adapter", this **is** the
only wallet model in devstack v2 — no in-browser keypair wallet is bundled here; the legacy
"devstack-wallet" lives only in package memory as a name. The browser-side `DevstackSignerAdapter`
is the wallet-standard surface; `walletApp(...)` (in this package) is its server.

Term definitions used throughout (reader has zero project context):

- **Stack**: a single devstack supervisor invocation tied to one `(app, stack)` identity pair (e.g.
  `arena/main`). One wallet per stack.
- **Tag**: a devstack `LayeredTag<Name, Value, Requires, Errors>` — the project's Effect-flavored
  equivalent of `Context.Tag`. Yielding a tag in an Effect resolves its `Value`.
- **Identity**: the `(app, stack, network)` triple, an `Effect.Service` injected at supervisor boot
  (`engine/identity.ts`).
- **Endpoint registry**: an in-process map (`engine/registries.ts:38-43`, `:317-321`) of
  `{ name, url, kind?, pairUrl? }` records published by services and read by the manifest writer.
- **Manifest**: `.devstack/manifest.json` — the on-disk projection of the endpoint registry +
  per-service state, written by `runtime/manifest-emit.ts` and consumed by example apps' codegen
  output.
- **Router**: a long-lived Traefik container (`engine/docker/router.ts`) that fronts every devstack
  endpoint on well-known ports and routes by `Host:` header to per-stack hostnames like
  `wallet.<app>.localhost:5180`.
- **File-provider YAML**: dynamic Traefik config dropped under
  `~/.devstack/traefik/dynamic/<id>.yml` to register a host process (not a docker container) as a
  router upstream.
- **`Account`** (the engine type, `engine/shared.ts:141-174`): the resolved value of an account tag,
  carrying `address`, `publicKey`, `scheme`, optional `source: 'real' | 'impersonate'`, and three
  Effect-flavored sign closures.

## Current implementation

Files in scope (LOC count + one-line summary, totals at the bottom):

### Factory + facade

- `services/wallet.ts` — **61 LOC**. Thin user-facing facade. Exports
  `Wallet({ accounts, allowedOrigins?, port?, bindAddress? })` which calls `walletApp(...)` and
  wraps it with `makeService('wallet', 'app', ...)`. The plan-rule "always explicit" lives here:
  `devstack(...)` never auto-mounts a wallet (`services/wallet.ts:1-9`).

### Server body

- `services/wallet/internal.ts` — **712 LOC**. The whole service body: HTTP server, token
  mint/persist, file-provider YAML write, signing handlers (`sign-transaction`,
  `sign-personal-message`), accounts handler, health probe, CORS + Origin enforcement, bearer-token
  auth (constant-time compare), 64 KiB body cap, request-id correlation logging, scope-finalizer
  teardown. Exports `walletApp(options)` and the `WalletApp` value-shape
  `{ url, pairUrl, endpoint, localPort }`.

### Wire-level protocol

- `services/wallet/protocol.ts` — **44 LOC**. `WalletHttpPath` const-object naming the 4 implemented
  routes (`HEALTH`, `ACCOUNTS`, `SIGN_TX`, `SIGN_PERSONAL_MESSAGE`) plus 4 reserved-but-stubbed
  fork-control routes (`FORK_STATUS`, `FORK_ADVANCE_CLOCK`, `FORK_ADVANCE_CHECKPOINT`,
  `FORK_IMPERSONATIONS`). Duplicated byte-for-byte in
  `packages/dev-wallet/src/adapters/devstack-paths.ts` (see `protocol.ts:9-15`).

### Wallet-specific error

- `engine/errors.ts:215-221` — `WalletAppError` tagged class with
  `{ phase: 'listen', message, cause? }`. The closed phase set is `WalletAppPhases = ['listen']`
  (`engine/phases.ts:166-167`).

### Tests (in scope for spec encoding)

- `services/wallet.test.ts` — **230 LOC**. The finalizer pinning test: forces wallet scope close +
  asserts the same `127.0.0.1:port` re-binds without `EADDRINUSE`. Also pins the router-hostname URL
  shape.
- `services/wallet/protocol.test.ts` — **33 LOC**. Coherence guard: imports both `WalletHttpPath`
  and `DEVSTACK_WALLET_HTTP_PATH` from dev-wallet and asserts byte-for-byte key+value equality.
- `services/wallet/protocol.integration.test.ts` — **538 LOC**. End-to-end wire test: real
  `Ed25519Keypair`-backed Account, full HTTP round-trip for accounts/sign-tx/sign-personal-message,
  cryptographic verification under `@mysten/sui/verify`, plus CSRF/auth negatives (missing Origin →
  403, wrong bearer → 401).

**Totals**:

- Source: **817 LOC** (wallet.ts 61 + wallet/internal.ts 712 + wallet/protocol.ts 44).
- Tests: **801 LOC** (wallet.test.ts 230 + protocol.test.ts 33 + protocol.integration.test.ts 538).
- Phase enum (one literal): `engine/phases.ts:166` — 1 LOC.
- Error shape: `engine/errors.ts:215-221` — 7 LOC.

## Configuration

Every knob a caller can set affecting this component. There is no `defineDevstack`-level wallet
config and no wallet-specific env vars — the wallet is opted into per-stack by constructing
`Wallet({...})` and passing it to `devstack(...)`.

### `WalletOptions` (user-facing, `services/wallet.ts:37-49`)

| Key              | Type                                                | Default       | Notes                                                                                                                                                                                                                                                | Citation                                   |
| ---------------- | --------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `accounts`       | `ReadonlyArray<LayeredTag<any, Account, any, any>>` | — (required)  | Account refs the wallet UI exposes. Each is yielded for ordering AND its resolved `Account` value is keyed by address into the sign handler.                                                                                                         | `services/wallet.ts:40-41`                 |
| `allowedOrigins` | `ReadonlyArray<string>`                             | `undefined`   | Extra CORS origins merged on top of the auto-derived `http://dev.<app>.localhost:<vite-port>` + `http://localhost:<vite-port>`.                                                                                                                      | `services/wallet.ts:43-44`                 |
| `port`           | `number`                                            | `5180`        | Preferred host port for the HTTP listener. Routed through `PortAllocator` — sibling stacks scan forward.                                                                                                                                             | `services/wallet.ts:46`                    |
| `bindAddress`    | `string`                                            | `'127.0.0.1'` | NIC the HTTP server binds. **The JSDoc on `services/wallet.ts:47` says `'127.0.0.1'` but the JSDoc on `services/wallet/internal.ts:75-78` says default `'0.0.0.0'`** — the actual default at `internal.ts:128` is `'127.0.0.1'` (security-hardened). | `services/wallet.ts:47`, `internal.ts:128` |

### `WalletAppOptions` (internal, `services/wallet/internal.ts:49-80`)

Identical shape, just the lower-level form `walletApp(...)` consumes. The facade in
`services/wallet.ts` does optional-key folding to translate between them.

### Environment variables read

The wallet body reads:

- `DEVSTACK_ROUTER_DYNAMIC_DIR` (transitively, via `writeFileProvider`) — directory for traefik
  file-provider YAML. Default `~/.devstack/traefik/dynamic`. Verified by the test harness setting it
  to a tmpdir in `services/wallet.test.ts:97-101` and
  `services/wallet/protocol.integration.test.ts:126-130`.
- `DEVSTACK_STATE_DIR` (transitively, via `servicePath('wallet', 'token')` → `state-store.ts`) —
  overrides the on-disk state root. Reads at `engine/service-paths.ts:65`.

The wallet does NOT directly read `DEVSTACK_APP_DIR`, `DEVSTACK_STACK`, `DEVSTACK_NETWORK`,
`DEVSTACK_APP`, etc. — those reach the wallet only via the `Identity` service.

### No CLI flags

No `devstack` subcommand adds wallet-specific flags. The wallet is always part of the user's stack
build.

## Capabilities CONSUMED

EXHAUSTIVE list:

### Other services / tags

- **`SuiTag`** (`services/sui.js`) — yielded for ordering (`services/wallet/internal.ts:88`). The
  wallet body does NOT read any field off the resolved `Sui` value; the yield exists solely so the
  topological scheduler places the wallet strictly after Sui is ready. Lifted into `upstreamKeys` at
  `services/wallet/internal.ts:293` so Layer.build sees the edge.
- **Account tags** (each `LayeredTag<any, Account, any, any>` in `options.accounts`) — yielded once
  each at boot to (a) impose dependency ordering (account funding must complete before the wallet
  accepts traffic) and (b) capture each resolved `Account` into the
  `accountsByAddress: Map<string, Account>` (`services/wallet/internal.ts:93-97`). Also lifted into
  `upstreamKeys` (`internal.ts:293`).

### Engine resources

- **`PortAllocator`** (`engine/port-allocator.js`) — yielded at `services/wallet/internal.ts:104`.
  `allocator.allocate(preferredPort)` scans forward from the preferred port;
  `allocator.release(port)` runs in the scope finalizer (`internal.ts:209`). Failures translated to
  `WalletAppError(phase: 'listen', ...)`.
- **`Identity`** (`engine/identity.js`) — yielded at `internal.ts:135`. Read fields: `identity.app`,
  `identity.stack` (used in `routerHostname` and `routerId`). Also used as the implicit input to
  `servicePath('wallet', 'token')` via `StateStoreConfig`.
- **`StateStoreConfig`** (`engine/state-store.js`) — read with `Effect.serviceOption` at
  `internal.ts:141` (not via the usual `yield* StateStoreConfig` because the wallet must boot in
  test contexts without a state store). When present, `servicePath('wallet', 'token')` resolves the
  canonical token path; when absent, a fallback path is computed directly from `Identity` +
  `resolveAppDir()` + `RUNTIME_DIR_NAME` (`internal.ts:147-155`).
- **`servicePath('wallet', 'token')`** (`engine/service-paths.ts:100-115`) — typed builder for
  `<stateDir>/runtime/wallet/token`. Validates `'wallet'` matches `^[a-z][a-z0-9-]{0,63}$` and
  `mkdir -p`s the dir.
- **`resolveAppDir()`** (`engine/resolve-app-dir.js`) — called inline at `internal.ts:148` in the
  fallback branch.
- **`RUNTIME_DIR_NAME`** (`engine/service-paths.ts:46`) — string `'runtime'` for the fallback path.
- **`writeFileProvider({...})`** (`engine/docker/router.ts:573`) — writes the traefik file-provider
  YAML at `internal.ts:233-238`. Errors caught with `Effect.catchTag('DockerError', ...)` and logged
  at warn level — boot continues even if the YAML write fails (the supervisor's direct-port URL
  still works).
- **`removeFileProvider(id)`** (`engine/docker/router.ts:594`) — finalizer at `internal.ts:245`.
- **`routerEntrypoint('vite' | 'wallet')`** (`engine/docker/router.ts`) — looks up the well-known
  port number for an entrypoint name (5175 for vite, 5180 for wallet). Used both at
  `internal.ts:158` (vite port for auto-allowedOrigins) and `internal.ts:223` (wallet port for the
  public URL). A missing `'wallet'` entrypoint translates to
  `WalletAppError(phase: 'listen', 'router entrypoint not registered')` (`internal.ts:224-231`).
- **`routerHostname(identity, 'wallet' | 'dev')`** (`engine/router-hostname.ts:22`) — composes
  `wallet.<app>.localhost` (main) or `<stack>.wallet.<app>.localhost` (non-main). Used at
  `internal.ts:157,222`.
- **`routerId(identity, 'wallet')`** (`engine/router-hostname.ts:34`) — composes
  `<app>-<stack>-wallet`. Used at `internal.ts:232,245`.
- **`publishEndpoint({...})`** (`engine/registries.ts:317-321`) — publishes the wallet endpoint
  record. Called at `internal.ts:262-267` with
  `{ name: 'wallet-app', url, kind: 'wallet', pairUrl }`.
- **`EndpointName.WALLET_APP`** (`runtime/endpoint-names.ts:132`) — canonical name string
  `'wallet-app'`.
- **`writeFileAtomic`** (`engine/atomic-write.js`) — used to write the token file with mode `0o600`
  (`internal.ts:695`).
- **`stringifyCause`** (`engine/stringify-cause.js`) — formats errors for log lines + 400/500
  response bodies (`internal.ts:506,529,549,594`).
- **`tag(name, body, classification)`** (`advanced/tag.js`) — defines the wallet's LayeredTag.
  Classification block at `internal.ts:276-294` declares `kind: 'service'`, `plugin: 'wallet'`,
  `displayTitle: 'wallet'`, a redacting `display` projection, and `upstreamKeys`.
- **`setPhase(...)`** (`advanced/tag.js`) — called at `internal.ts:168` with
  `'starting http server'`.
- **`makeService('wallet', 'app', ...)`** (`advanced/make-service.ts`) — stamps `__kind: 'app'` +
  `__pluginName: 'wallet'` (`services/wallet.ts:60`).

### Effect/Layer/Context machinery

- `Effect.gen` / `Effect.tryPromise` / `Effect.catchTag` / `Effect.fail` / `Effect.context<never>()`
  / `Effect.addFinalizer` / `Effect.serviceOption` / `Effect.orElseSucceed` / `Effect.withSpan` /
  `Effect.annotateCurrentSpan` / `Effect.annotateLogs` / `Effect.logInfo` / `Effect.logWarning` /
  `Effect.runPromiseWith` / `Effect.callback` — all standard Effect surface.
- `Context` import is used for the `Context.Context<never>` type annotation passed to handlers
  (`internal.ts:13,332`).
- **`supervisorCtx = yield* Effect.context<never>()`** at `internal.ts:177` — critical: the wallet
  captures the supervisor's full fiber context (logger sink, tracer, FiberRefs) and replays it via
  `Effect.runPromiseWith(supervisorCtx)` on every async request handler
  (`internal.ts:359,535,545,600,610`). Without this, signing requests would run on a fresh default
  runtime, losing TUI log sink + traces.

### Node runtime / system

- `node:crypto` (`randomBytes`) — token mint at `internal.ts:693` and per-request correlation IDs at
  `internal.ts:342`.
- `node:fs/promises` (`nodeFs.readFile`) — read-existing-or-mint at `internal.ts:681`.
- `node:http` (`createServer`, `IncomingMessage`, `ServerResponse`, `Server`) — the HTTP server
  itself.
- `node:path` (`join as joinPath`) — fallback token-path composition (`internal.ts:147-155`).

### npm dependencies

- `effect` — `Context`, `Effect`.

### Imports from other workspace packages

- None at runtime. The wallet body never imports from `@mysten-incubation/dev-wallet` (that's the
  deliberate-acyclic-edge invariant from `services/wallet/protocol.ts:9-15`). The integration test
  imports `DevstackSignerAdapter` + `parseDevstackToken` from
  `@mysten-incubation/dev-wallet/adapters`, but that's test-only.
- `@mysten/sui/keypairs/ed25519`, `@mysten/sui/transactions`, `@mysten/sui/utils`,
  `@mysten/sui/verify` — test-only (integration test).

### Endpoints / sockets

- One **HTTP server** bound to `bindAddress:port`. Default `127.0.0.1:5180` (preferred;
  port-allocator may pick higher).
- One **traefik file-provider entry** pointing the public hostname (`wallet.<app>.localhost:5180`)
  at upstream `http://host.docker.internal:<localPort>` (`internal.ts:233-238`).

## Capabilities PRODUCED

What the wallet exposes to others:

### Resolved tag value: `WalletApp` (`services/wallet/internal.ts:35-47`)

When a downstream service yields the wallet tag, it gets:

```
{
  url: string,            // router-fronted public URL — e.g. "http://wallet.<app>.localhost:5180"
  pairUrl: string,        // url + "/#token=<32-hex>"
  endpoint: { name: 'wallet-app', url: string },
  localPort: number,      // actual 127.0.0.1 bind port (post-allocator)
}
```

No in-tree service currently yields the wallet tag for its value — the wallet is a leaf (apps
consume it via the manifest / endpoint registry).

### Endpoint registry entry

Published via `publishEndpoint(...)` at `services/wallet/internal.ts:262-267`:

```
{
  name: 'wallet-app',      // EndpointName.WALLET_APP constant
  url: 'http://wallet.<app>.localhost:5180',  // (or <stack>.wallet.<app>.localhost:5180 for non-main)
  kind: 'wallet',
  pairUrl: 'http://wallet.<app>.localhost:5180/#token=<32-hex>',
}
```

This entry is read by:

- `runtime/service.ts:211-215` (`groupApp`), which projects it into the on-disk manifest under
  `app.wallet: { url, pairUrl }` (`runtime/manifest-schema.ts:199-204`).
- The TUI's manifest-tab view.
- Codegen — emits `dapp-kit-config.ts` that calls `createDevstackAdapterFromManifest(manifest)`
  (`packages/dev-wallet/src/adapters/devstack-adapter.ts:318-327`).

### HTTP routes (the wire protocol)

All under the path prefix `/api/v1/devstack/*`. Auth gate: mandatory `Origin` header (must be in
`allowedOrigins`) + `Authorization: Bearer <token>` (constant-time compare).

| Method  | Path                                     | Auth | Request body                                           | Response (200)                                                 | Citations                                                      |
| ------- | ---------------------------------------- | ---- | ------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------- |
| GET     | `/api/v1/devstack/health`                | yes  | —                                                      | `{ ok: true }`                                                 | `services/wallet/protocol.ts:27`, `internal.ts:448-451`        |
| GET     | `/api/v1/devstack/accounts`              | yes  | —                                                      | `{ accounts: [{ name, address, scheme, publicKey, source }] }` | `protocol.ts:28`, `internal.ts:452-455`, `internal.ts:477-492` |
| POST    | `/api/v1/devstack/sign-transaction`      | yes  | `{ address: string, txBytes: base64 }`                 | `{ suiSignature, txBytes }`                                    | `protocol.ts:29`, `internal.ts:456-459`, `internal.ts:494-557` |
| POST    | `/api/v1/devstack/sign-personal-message` | yes  | `{ address: string, message OR messageBytes: base64 }` | `{ signature, bytes }`                                         | `protocol.ts:30`, `internal.ts:460-463`, `internal.ts:559-622` |
| OPTIONS | (any /api/v1/devstack/\*)                | no   | —                                                      | `204` + CORS headers                                           | `internal.ts:415-420`                                          |

The other 4 path constants (`FORK_STATUS`, `FORK_ADVANCE_CLOCK`, `FORK_ADVANCE_CHECKPOINT`,
`FORK_IMPERSONATIONS`) are declared in `protocol.ts:38-41` but **not wired to a handler**. They fall
through to the catch-all `404 { error: "no route for METHOD URL" }` at `internal.ts:464-466`. The
browser-side fork-relay (`packages/dev-wallet/src/adapters/fork-relay.ts`) targets these paths;
today they 404. Comment at `protocol.ts:36-37` and at
`packages/dev-wallet/src/adapters/devstack-paths.ts:25-29` calls this out as a known stub pending
P5.8.4.

Response bodies for the success path on POST `/sign-transaction`:
`{ suiSignature: <result.signature>, txBytes: <result.bytes> }` — note the asymmetric field-name
pair (the SDK's signer returns `{ bytes, signature }`; the server renames `bytes → txBytes` and
`signature → suiSignature`). `/sign-personal-message` uses the original `{ signature, bytes }` field
names. Tests pin both shapes (`services/wallet/protocol.integration.test.ts:346-356,400-407`).

Error responses:

- `400` `{ error: "invalid request body: ..." }` — body parse failed, address missing,
  txBytes/message missing or non-base64.
- `401` `{ error: "unauthorized" }` — bearer mismatch.
- `403 forbidden origin` (text/plain) — Origin header sent but not in allowlist.
- `403 Origin header required` (text/plain) — no Origin on `/api/v1/devstack/*`.
- `404 { error: "no route for METHOD URL" }` — unknown `/api/v1/devstack/*` path.
- `404 { error: "no account for address '...'" }` — unknown address on sign.
- `404 not found` (text/plain) — non-`/api/v1/devstack/*` path.
- `500 { error: "signTransaction failed: ..." }` / `{ error: "signPersonalMessage failed: ..." }` —
  the Account's sign closure failed.

### File written

- `<stateDir>/runtime/wallet/token` — 32 hex chars (UTF-8), file mode `0o600`. Written via
  `writeFileAtomic` (`internal.ts:695`). Read-existing-or-mint at boot (`internal.ts:678-712`).

### Files written transiently (cleaned by finalizer)

- `<dynamicDir>/<routerId>.yml` — traefik file-provider YAML registering the wallet's host process
  as a router upstream. Path inferred from `engine/docker/router.ts:426-464` + the call at
  `internal.ts:233-238`. Removed at scope close (`internal.ts:245`).

### State-store entries

**None.** The wallet token is a file artifact (`runtime/wallet/token`), not a state-store record.
There is no `StateStoreKeys.walletToken(...)` builder in `engine/state-store-keys.ts` (verified by
grep — the only `wallet` reference in that file is a comment about a sui→wal exchange,
`state-store-keys.ts:54`).

### Events emitted

None. The wallet does not publish to any event bus.

### CLI commands registered

None. The wallet has no `devstack wallet ...` subcommand.

### TypeScript exports consumed elsewhere

From `services/wallet.ts`:

- `Wallet` (the factory) — re-exported by the package's public entry; consumed by
  `examples/*/devstack.config.ts`.
- `WalletOptions` — type.

From `services/wallet/internal.ts`:

- `walletApp`, `WalletAppOptions`, `WalletApp` — internal (consumed only by `wallet.ts` + the two
  test files).

From `services/wallet/protocol.ts`:

- `WalletHttpPath` — internal (consumed only by `internal.ts` + the two test files; mirrored in
  dev-wallet).
- `WalletHttpPathValue` — type, internal.

### Container images / volumes

None. The wallet runs as a host Node process; no docker image, no volume.

### TUI display

`display: (s) => ({ title: 'wallet', primary: redactToken(s.pairUrl) })`
(`services/wallet/internal.ts:285`). `redactToken` replaces `#token=<hex>` with `#token=<redacted>`
(`internal.ts:298-299`) so a screen-share / scrollback doesn't leak signing capability. The
unredacted pairUrl is still in the manifest at `app.wallet.pairUrl` for programmatic consumers.

## Lifecycle

### Startup (ordered)

1. **Wait for `SuiTag`** (`internal.ts:88`). Pure ordering — no field read.
2. **Resolve every account tag**, populate `accountsByAddress` (`internal.ts:93-97`). Iterating with
   `yield*` per account means account-acquisition errors propagate as the wallet's own boot error.
3. **Allocate a port** via `PortAllocator.allocate(preferredPort ?? 5180)` (`internal.ts:104-116`).
   Forward-scan on conflict. Failure → `WalletAppError(phase: 'listen')`.
4. **Resolve bind address** — default `'127.0.0.1'` (`internal.ts:128`).
5. **Resolve `Identity`** for hostname + auto-allowedOrigins (`internal.ts:135`).
6. **Resolve token path**: prefer `servicePath('wallet', 'token')`; fall back to
   `<appDir>/.devstack/stacks/<stack>/runtime/wallet/token` when `StateStoreConfig` is absent
   (`internal.ts:141-155`).
7. **Read existing token or mint a new one** (`internal.ts:156`, body at `internal.ts:678-712`):
   - If the file exists AND trimmed content is 32 hex chars, reuse it (so warm-start +
     snapshot-restore preserves the dev-wallet pairing).
   - Otherwise mint `randomBytes(16).toString('hex')` and `writeFileAtomic` with mode `0o600`.
   - Write failure logged at warn level (the manifest pairUrl still carries the token).
8. **Compose `allowedOrigins`**: auto-derive `http://dev.<app>.localhost:<vite-port>` +
   `http://localhost:<vite-port>` (vite port pulled from `routerEntrypoint('vite')`, fallback
   `5175`), then merge `options.allowedOrigins` (`internal.ts:158-166`).
9. **`setPhase('starting http server')`** (`internal.ts:168`).
10. **Capture supervisor context** via `Effect.context<never>()` (`internal.ts:177`).
11. **Start the HTTP server** via `Effect.tryPromise → startHttpServer(...)`
    (`internal.ts:178-194`). Failure → `WalletAppError(phase: 'listen')`. Annotate span with port +
    bind address (`internal.ts:195`).
12. **Install scope finalizer**: `closeAllConnections()` → `server.close()` (awaited) →
    `allocator.release(port)` (`internal.ts:204-211`).
13. **Look up the `'wallet'` router entrypoint** (`internal.ts:222-231`). Missing →
    `WalletAppError(phase: 'listen')`.
14. **Write traefik file-provider YAML** for `http://host.docker.internal:<localPort>`
    (`internal.ts:233-244`). Docker errors caught + warn-logged (boot continues).
15. **Install file-provider removal finalizer** (`internal.ts:245`).
16. **Compose `url` + `pairUrl`** (`internal.ts:247-254`). Token rides in the URL **fragment**
    (`#token=...`), not a query param.
17. **`publishEndpoint(...)`** with name `'wallet-app'`, kind `'wallet'`, url + pairUrl
    (`internal.ts:262-267`).
18. **Return the `WalletApp` value** (`internal.ts:269-274`).

What blocks what (Layer.build ordering):

- The wallet's `upstreamKeys: [SuiTag.key, ...options.accounts]` (`internal.ts:293`) is the
  load-bearing hint to the topological scheduler — without it the wallet body's `yield* SuiTag` +
  per-account yields would land in level 0 and fail with "Service not found: account/<name>" on the
  first account yield (callout in the comment block at `internal.ts:286-293`).

### Parallel safe

- Per-request signing — every handler is its own async fiber under the captured supervisor context.
  No global locks in the wallet body. The underlying `Account.signTransaction` Effect may have its
  own contention (faucet, etc.), but those are the account's concern.
- Multiple sibling stacks — the port allocator's forward-scan + per-stack router hostname keep
  concurrent stacks from colliding. Verified end-to-end by the integration test's per-test
  ephemeral-port helper (`services/wallet/protocol.integration.test.ts:151-165`).

### Ready criteria

Two layered notions:

- **Tag-resolution ready** — when the wallet tag's body returns, the HTTP server has bound
  (`server.listen` callback fired). Downstream services that yield the wallet tag observe this. This
  is the only "ready" the engine surfaces.
- **Browser-pair-ready** — implicit; the pairUrl includes the token in its fragment, so the moment
  the manifest contains `app.wallet.pairUrl`, browsers can pair. No health-probe step is required —
  `publishEndpoint` is fired only after `startHttpServer` resolves.

No `chainProbe` / `HEAD /api/v1/devstack/health` polling loop exists in the wallet's own boot path.
The `/health` endpoint is for browser-side use only.

### Restart behavior

What's idempotent:

- **Token reuse**: warm starts read the existing `runtime/wallet/token` and reuse it
  (`internal.ts:684-691`). The dev-wallet pairing the user completed in a previous session keeps
  working without a re-pair UX.
- **Port allocation**: scans forward if the previous-cycle port is somehow still bound (shouldn't
  happen post-finalizer but the scan handles racey EADDRINUSE).
- **File-provider YAML**: `writeFileProvider` writes by id — replaces any prior YAML at the same
  path.

What needs cleanup before restart:

- **Bound port**: the wallet's finalizer `closeAllConnections()` + `await close()` ensures the port
  is genuinely free before allocator release. The whole point of `wallet.test.ts:165-229` is to pin
  this — if it regresses, the next `pnpm dev` hits `EADDRINUSE`.
- **File-provider YAML**: removed by `removeFileProvider(walletRouterId)` finalizer
  (`internal.ts:245`).

### Teardown

Ordered shutdown:

1. **Last finalizer first** (Effect runs finalizers in LIFO): `removeFileProvider(walletRouterId)`
   removes the traefik dynamic YAML.
2. **Previous finalizer**: `server.closeAllConnections()` immediately drops keep-alive sockets, then
   `server.close(cb)` waits for the close callback before resuming, then `allocator.release(port)`.
3. **No explicit grace window** in the wallet body — `closeAllConnections` is hard-immediate so
   there's no "drain in-flight requests" semantic. In-flight `signTransaction` Effects continue
   under the captured supervisor context until they complete; their socket may be closed but the
   work continues (any `res.end()` will fail silently).

### What survives teardown

- **Token file** (`runtime/wallet/token`) — never deleted by the wallet itself (only by
  `devstack wipe`).
- **Manifest** — the prior cycle's `app.wallet.pairUrl` lives in `.devstack/manifest.json` until
  rewritten.

## Hard requirements / invariants

The "this MUST happen or X fails" list, each load-bearing constraint cited.

### Finalizer protocol (port release)

**`server.closeAllConnections()` → `server.close(cb)` awaited → `allocator.release(port)`** — this
exact order (`internal.ts:204-211`). The test `wallet.test.ts:165-229` exists solely to pin it:
closes the wallet scope, then asserts the same `127.0.0.1:port` re-binds without `EADDRINUSE`.
Without `closeAllConnections`, a browser tab from the dev wallet holding an open `fetch` keeps the
port bound after the supervisor exits and the next session's `pnpm dev` fails
(`wallet.test.ts:1-18`).

### `upstreamKeys` MUST include `SuiTag.key` + every account tag

(`internal.ts:293`.) The wallet body yields `SuiTag` then iterates `options.accounts` yielding each.
Layer.build doesn't see those yields as edges unless they're lifted into `upstreamKeys` — without
the lift, the wallet lands in level 0 and fails with "Service not found: account/<name>"
(`internal.ts:286-292`).

### `supervisorCtx` MUST be captured BEFORE `startHttpServer`

(`internal.ts:177`.) Each HTTP handler is dispatched outside the wallet's own Effect fiber via
`Effect.runPromiseWith(supervisorCtx)(...)`. Without the captured context, sign handlers run on a
fresh default runtime: TUI logger sink, tracer, and FiberRefs the supervisor set are all lost —
sign-tx requests log to stderr instead of the TUI, and traces don't propagate.

### Origin header REQUIRED on every `/api/v1/devstack/*` request

(C12, `internal.ts:421-434`.) Even though the bearer-token check would catch most cases, non-browser
tooling (curl, service workers, `file://` pages) omits Origin and would sail through with only
bearer. The mandatory-Origin check closes that bypass. Pinned by
`protocol.integration.test.ts:418-452` (`signing endpoints reject missing Origin`).

### Token comparison MUST be constant-time

`safeBearerEquals(a, b)` at `internal.ts:311-318`. `===` on strings short-circuits at the first
mismatch, leaking the token byte-by-byte to a remote attacker via timing. The length-mismatch
shortcut at line 312 is acceptable (token length is public knowledge — it's always 32 hex chars).

### Token MUST NOT appear in log lines

(`internal.ts:436-447`.) Only `bearerValid: boolean` rides log entries. `auth` and `expectedAuth`
flow only into `safeBearerEquals` (returns a boolean). The error-log path on token-write failure
logs the PATH, not the token (`internal.ts:705-709`).

### Token MUST live in URL fragment (not query) on `pairUrl`

(C13, `internal.ts:248-254`.) Fragments aren't sent to the server (so they can't land in access
logs) and most browsers don't write them to referrer headers. The dev-wallet adapter reads
`url.hash` (`packages/dev-wallet/src/adapters/devstack-adapter.ts:279`).

### Token file MUST be mode `0o600`

(`internal.ts:695`.) The token grants signing capability; world-readable would leak it via co-tenant
processes on a shared host.

### Body cap MUST be enforced BEFORE buffering

(`MAX_BODY_BYTES = 64 * 1024`, `internal.ts:324`; check at `internal.ts:633-639`.) An unbounded
`for await` on the body would let a malicious client OOM the supervisor by streaming gigabytes of
payload. 64 KiB is well above the largest expected sign-tx body (a few KB).

### `accountsByAddress` keyed by **address**, not name

(`internal.ts:93-97`.) The sign endpoints look up by address (`internal.ts:520,585`). Keying by name
would force every browser-side `signTransaction({ address })` call to do a reverse-lookup the server
can't do.

### Default `bindAddress` MUST be `'127.0.0.1'`

(HIGH-SEC1, `internal.ts:117-128`.) Signing endpoints must not be exposed to other devices on the
LAN. The combination "127.0.0.1 + traefik fronts via `host.docker.internal`" works because modern
Docker Desktop (4.x+) routes `host.docker.internal` through the host loopback. Override to
`'0.0.0.0'` only for devcontainer / WSL setups where the browser lives on a different network
interface.

### Token must be 32 hex chars on the wire

The on-disk shape sanity-check at `internal.ts:687-691` rejects anything else and re-mints. The
integration test asserts the produced token matches `/^[0-9a-f]{32}$/`
(`protocol.integration.test.ts:199`). 16 bytes of `randomBytes` → 32 hex chars (`internal.ts:693`).

### File-provider YAML write is NOT load-bearing

(`internal.ts:239-244`.) DockerError on YAML write is logged at warn and boot continues. The direct
`http://localhost:<port>` form still works for callers that read `localPort` off the manifest. The
router-fronted hostname stops working but the wallet itself is up.

## Failure modes

For each thing that can fail: trigger, current behavior, recovery path.

### Boot failures

| Trigger                                                                                  | Current behavior                                                            | Recovery                                                                             |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **PortAllocator can't find a free port near 5180** (`internal.ts:106-115`)               | `WalletAppError(phase: 'listen')` → supervisor boot fails                   | Free a port; reboot. No retry.                                                       |
| **`http.Server.listen` fails** (e.g. EACCES on a privileged port, `internal.ts:178-194`) | `WalletAppError(phase: 'listen')`                                           | Pick a different port via `WalletOptions.port`.                                      |
| **`routerEntrypoint('wallet')` returns undefined** (`internal.ts:224-231`)               | `WalletAppError(phase: 'listen', 'router entrypoint not registered')`       | Bug: `defineEntrypoint({ name: 'wallet', port: 5180 })` at `router.ts:195` must run. |
| **Account tag resolution fails** (`internal.ts:94-97`)                                   | The account's own error propagates (e.g. `AccountError`)                    | Fix the account spec.                                                                |
| **Token file write fails** (ENOSPC, EROFS, `internal.ts:694-709`)                        | Warn-logged, boot continues with the freshly-minted in-memory token         | The manifest pairUrl still carries the token; UX degrades to "must pair every boot". |
| **Token file exists but malformed** (not 32 hex chars, `internal.ts:687-691`)            | Re-mint silently                                                            | Same as fresh boot. (Note: existing browser-side pairings break — no notification.)  |
| **`writeFileProvider` DockerError** (`internal.ts:239-244`)                              | Warn-logged ("file-provider YAML write failed (continuing on direct port)") | Router-fronted hostname unreachable; direct `localPort` form works.                  |

### Runtime failures

| Trigger                                                               | Current behavior                                                                                                 | Recovery                                                                            |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **`Origin` missing on `/api/v1/devstack/*`**                          | `403 Origin header required` (`internal.ts:429-434`)                                                             | Browser sends Origin automatically; non-browser clients are intentionally rejected. |
| **`Origin` not in `allowedOrigins`**                                  | `403 forbidden origin` (`internal.ts:404-409`)                                                                   | Add the origin to `WalletOptions.allowedOrigins`.                                   |
| **Bearer token missing or wrong**                                     | `401 { error: 'unauthorized' }` (`internal.ts:443-447`)                                                          | Re-pair via the pairUrl fragment.                                                   |
| **Unknown address on sign**                                           | `404 { error: "no account for address '...'" }` (`internal.ts:521-523,586-588`)                                  | Browser shows the right account picker.                                             |
| **`txBytes` / `message` not valid base64**                            | `400 { error: "<field> is not valid base64: ..." }` (`internal.ts:526-533,591-597`)                              | Caller fix.                                                                         |
| **JSON parse failure on body**                                        | `400 { error: 'invalid request body: ...' }` (`internal.ts:503-509,567-573`)                                     | Caller fix.                                                                         |
| **Body exceeds 64 KiB**                                               | `readJsonBody` throws → `400 { error: 'invalid request body: ... exceeds 64-kB cap' }` (`internal.ts:636-638`)   | Caller fix.                                                                         |
| **`account.signTransaction(bytes)` fails**                            | `500 { error: 'signTransaction failed: ...' }`, warn-log via captured supervisor context (`internal.ts:544-556`) | Depends on underlying account failure (faucet, etc.).                               |
| **`account.signPersonalMessage(bytes)` fails**                        | `500 { error: 'signPersonalMessage failed: ...' }` (`internal.ts:609-621`)                                       | Same.                                                                               |
| **Unknown `/api/v1/devstack/*` path** (incl. the four FORK\_\* paths) | `404 { error: 'no route for METHOD URL' }` (`internal.ts:464-466`)                                               | Wire up the route (P5.8.4 for fork-control).                                        |
| **Non-`/api/v1/devstack/*` path**                                     | `404 not found` (text/plain) (`internal.ts:468-470`)                                                             | The wallet doesn't serve a UI here (see "OPEN QUESTION" below).                     |
| **`OPTIONS` preflight**                                               | `204` + CORS headers if Origin allowed (`internal.ts:415-420`)                                                   | —                                                                                   |

### Teardown failures

- If `server.closeAllConnections` is missing (Node < 18.2): `closeAllConnections?.()` is
  optional-chained (`internal.ts:208`). Devstack requires Node ≥ 24 so this never fires, but a stale
  Node would silently skip the call and risk EADDRINUSE on restart.

## Persistence model

### Survives restart

- **`runtime/wallet/token`** — 32-hex token written 0o600. The whole point: warm starts AND snapshot
  restores reuse this so existing browser-side pairings keep working. Read-existing-or-mint at
  `internal.ts:156, 678-712`.

### Survives snapshot

- `runtime/wallet/token` rides inside `runtime.tar` (the snapshot's blanket capture of `runtime/`,
  `engine/snapshot.ts:10`). Restore extracts it; the next boot's read-existing-or-mint path picks it
  up and the same token is published in the new manifest's pairUrl. Rationale spelled out at
  `internal.ts:660-671`.

### Wiped by `devstack wipe`

- The `wipe` subcommand removes the entire per-stack state dir `.devstack/stacks/<stack>/`
  (`cli/commands/wipe.ts:25`), which includes `runtime/wallet/token`. After wipe the next boot mints
  a fresh token and any prior dev-wallet pairing is invalidated.

### Process-local only

- `accountsByAddress: Map<string, Account>` — rebuilt on every boot from the account tag yield.
- `supervisorCtx` — captured per boot.
- `allowedOrigins` — derived per boot from `Identity` + user opts.
- The HTTP server, the allocator-held port, the file-provider YAML — all per-cycle (per
  `services/wallet.ts:22-30`).

## Modes & variants

The wallet is **single-mode**. There is no live-net vs. localnet vs. fork-mode branching at the
wallet layer — the wallet body only `yield* SuiTag` for ordering and never reads any chain-mode
field. The `WalletOptions.accounts` array can mix `'real'` accounts (devstack-held keypair) and
`'impersonate'` accounts (fork-mode impersonation slots), and the protocol surfaces the
discriminator to the browser via `accounts[].source`, but the server-side flow is identical: route
to `account.signTransaction(bytes)`, return the result.

Brief description in lieu of a table:

- One process model: long-lived host Node `http.Server` (not a docker container).
- One singleton per stack (`services/wallet.ts:6-8`).
- One ambient-policy: NOT ambient — explicit opt-in via `Wallet({...})`
  (`services/wallet.ts:11-14`).
- One persistence story: token file only.
- One teardown story: `closeAllConnections` → `close` → port release → file-provider remove.
- One auth model: bearer token + mandatory Origin in allowlist.

There is no "fallback / no-wallet" mode in the wallet itself. If the user doesn't construct
`Wallet(...)`, the wallet doesn't run. Apps that need to handle "wallet absent" do so by checking
`manifest.app.wallet === undefined` (`createDevstackAdapterFromManifest` returns `null` in that
case, `packages/dev-wallet/src/adapters/devstack-adapter.ts:321-322`).

## Test coverage

### `services/wallet.test.ts` (230 LOC)

**Describe blocks**:

- `walletApp router hostname` (`wallet.test.ts:127`)
  - `it.effect('endpoint URL uses the stack-scoped router hostname on the wallet entrypoint port', ...)`
    (`wallet.test.ts:128-162`) — Constructs `walletApp({ accounts: [alice], port: 41817 })` under
    stub Sui + `app: 'wallet-test', stack: 'main'`. Asserts
    `value.url === 'http://wallet.wallet-test.localhost:5180'` and `pairUrl` starts with
    `http://wallet.wallet-test.localhost:5180/#token=` and `localPort` is a number.

- `walletApp finalizer` (`wallet.test.ts:165`)
  - `it.effect('releases its bound port so a subsequent 127.0.0.1 listener succeeds', ...)`
    (`wallet.test.ts:166-229`) — Yields the wallet inside `Effect.scoped` so the finalizer fires;
    captures `boundPort = value.localPort`; then `net.createServer().listen(boundPort, '127.0.0.1')`
    and asserts it doesn't EADDRINUSE. The load-bearing finalizer-protocol test.

**Stubs**:

- Stub `SuiTag` value with
  `{ network: 'localnet', rpc: {...}, chainId: 'test-chain', client: {}, waitForTransactionsReady: () => Effect.void, runtime: 'bundled' }`
  — only the `yield*` ordering matters.
- Stub `Account` tag with `signTransaction`/`signPersonalMessage`/`signAndExecute` all
  `Effect.die(...)` — the test asserts no HTTP traffic so they're never called.
- Tmp `DEVSTACK_ROUTER_DYNAMIC_DIR` per test.

### `services/wallet/protocol.test.ts` (33 LOC)

**Describe**: `WalletHttpPath ↔ DEVSTACK_WALLET_HTTP_PATH`.

- `it('exposes the same set of keys', ...)` (`protocol.test.ts:14-18`) — Asserts `Object.keys()` of
  both sides are equal.
- `it('maps every key to an identical string', ...)` (`protocol.test.ts:20-32`) — Iterates the union
  of keys, asserts each key maps to the same string on both sides.

The point: if either side drifts (e.g. `internal.ts` adds a new handler but `dev-wallet` doesn't
mirror the path) this test fails loudly.

### `services/wallet/protocol.integration.test.ts` (538 LOC)

**Describe**: `walletApp ↔ DevstackSignerAdapter HTTP protocol`.

- `it.effect('health probe round-trip — token parses, bearer + Origin accepted, body shape matches', ...)`
  (`protocol.integration.test.ts:181-220`) — Stands the wallet up; parses the token off the pairUrl
  via `parseDevstackToken`; asserts token matches `/^[0-9a-f]{32}$/`; `GET /api/v1/devstack/health`
  with `Origin: http://localhost:5175` (auto-allowlist) + `Authorization: Bearer <token>` returns
  `{ ok: true }`.
- `it.effect('DevstackSignerAdapter hydrates accounts off the protocol (server-side adapter wire)', ...)`
  (`protocol.integration.test.ts:222-284`) — Wraps `globalThis.fetch` to inject Origin (Node fetch
  omits it by default; browsers send it). Constructs a
  `DevstackSignerAdapter({ serverOrigin, token })`, calls `.initialize()`, asserts
  `accounts.length === 1`, asserts the address + public key round-trip.
- `it.effect('sign-transaction round-trip produces a signature that verifies under @mysten/sui/verify', ...)`
  (`protocol.integration.test.ts:286-368`) — Builds a real BCS-serializable `Transaction` (with
  `setSender`/`setGasBudget`/`setGasPrice`/`setGasPayment`), POSTs
  `/api/v1/devstack/sign-transaction` with `{ address, txBytes: base64(...) }`. Asserts 200,
  response body has `suiSignature` + `txBytes`, `fromBase64(body.txBytes!)` equals the request
  bytes, and `verifyTransactionSignature(txBytes, body.suiSignature!)` returns the same address.
- `it.effect('sign-personal-message round-trip produces a signature that verifies under @mysten/sui/verify', ...)`
  (`protocol.integration.test.ts:370-416`) — Same but for `/sign-personal-message`. Response body
  uses `{ signature, bytes }` (NOT `{ suiSignature, txBytes }` — different field names by design).
  Verifies under `verifyPersonalMessageSignature`. **Uses request-body field name `messageBytes`**
  (not `message`); the server accepts either via `body['message'] ?? body['messageBytes']`
  (`internal.ts:576`).
- `it.effect('signing endpoints reject missing Origin (C12 — closes the curl/non-browser bypass)', ...)`
  (`protocol.integration.test.ts:418-452`) — POST `/sign-transaction` WITHOUT Origin → asserts 403.
- `it.effect('signing endpoints reject a wrong bearer token (401)', ...)`
  (`protocol.integration.test.ts:454-487`) — POST with
  `Authorization: Bearer 00000000000000000000000000000000` (correctly-shaped but wrong token) →
  asserts 401.
- `it.effect('accounts endpoint surfaces the resolved Account shape (name + address + scheme)', ...)`
  (`protocol.integration.test.ts:489-537`) — GET `/accounts` → asserts response shape
  `{ accounts: [{ name, address, scheme: 'ed25519', publicKey: base64(...), source: 'real' }] }` and
  `fromBase64(publicKey)` matches the raw 32 bytes.

**Test scaffolding**:

- `stubSui` (no-op `SuiTag` value).
- `identityLayer` (`{ app: 'wallet-test', stack: 'main', network: 'localnet' }`).
- `realKeyAccountTag(name)` — generates an `Ed25519Keypair`, builds a real `Account` whose
  `signTransaction`/`signPersonalMessage` defer to `keypair.signTransaction`/`signPersonalMessage`
  via `Effect.tryPromise`. The keypair address is the account address.
- `acquireEphemeralPort()` — binds `net.Server` on `127.0.0.1:0`, reads `address().port`, closes,
  returns. Lets parallel tests each grab a free port.
- `buildStack(app, acct)` — composes `Layer.provideMerge(app.__layer, acct.tag.__layer)` provided
  with `(stubSui + identityLayer + PortAllocatorLive + EndpointRegistryLive)`, mirroring
  `composeStackLayer`.
- Tmp `DEVSTACK_ROUTER_DYNAMIC_DIR` per test.

## Pain points today

### Acyclic-edge duplication: `WalletHttpPath` mirrored in dev-wallet

`services/wallet/protocol.ts:9-15` and `packages/dev-wallet/src/adapters/devstack-paths.ts:1-13`
both carry the same const-object. The byte-equality sync test (`protocol.test.ts`) keeps them in
lock-step but it IS duplication. The forced split exists because devstack peer-deps on dev-wallet
(for codegen-emitted browser glue) and the reverse edge would close a workspace cycle. A future
restructure (e.g. extract `protocol.ts` into a third tiny package both depend on) would eliminate
the mirror.

### Default-port and bind-address JSDoc contradiction

`services/wallet.ts:48` says `bindAddress` defaults to `'127.0.0.1'`;
`services/wallet/internal.ts:75-78` says default `'0.0.0.0'`; the actual code at `internal.ts:128`
does `'127.0.0.1'`. The internal JSDoc is stale and should be aligned with the security-hardened
default that ships.

### Fork-control routes declared but unimplemented

`services/wallet/protocol.ts:31-41` declares `FORK_STATUS` / `FORK_ADVANCE_CLOCK` /
`FORK_ADVANCE_CHECKPOINT` / `FORK_IMPERSONATIONS` and the dev-wallet `fork-relay.ts` already targets
them, but the server-side handlers don't exist — requests fall through to the generic 404. The TODO
at `packages/dev-wallet/src/adapters/devstack-paths.ts:25-29` notes "the matching routes do not yet
exist in `services/wallet/internal.ts`" — pending P5.8.4. This is a known gap.

### Asymmetric field-name pair on sign-transaction response

`/sign-transaction` returns `{ suiSignature, txBytes }` (`internal.ts:543`) but
`/sign-personal-message` returns `{ signature, bytes }` (`internal.ts:608`). The asymmetry is also
reflected in the test assertions (`protocol.integration.test.ts:347-356` vs. `:401-407`). Probably
historical — the SDK's signer returns `{ bytes, signature }` for both, and the sign-tx renaming was
for a specific consumer.

### Dual field-name acceptance on sign-personal-message

`internal.ts:576` does `body['message'] ?? body['messageBytes']` — accepts both. The integration
test uses `messageBytes` (`protocol.integration.test.ts:396`); the JSDoc-style doc at the top of
`internal.ts:302-307` says `/sign-personal-message → { signature, bytes }`. Two field-name
acceptances on a single endpoint is a small mess.

### `routerEntrypoint('vite')` vs the hardcoded `5175` fallback

`internal.ts:158-162` reads `routerEntrypoint('vite')` for the vite port (used in
auto-allowedOrigins) and falls back to `5175` if undefined. The two should be the same constant —
the registry-driven value is the source of truth, but the fallback duplicates the number.

### `WalletAppOptions` and `WalletOptions` are essentially the same

`services/wallet.ts:53-61` does the standard "optional-key fold" between the user-facing
`WalletOptions` and the internal `WalletAppOptions`. They have identical fields. The split exists
because `WalletAppOptions` is internal and a "future" change might break the public contract — but
neither has actually drifted since landing.

### No state-store integration for the token

The token lives at `runtime/wallet/token` (a file artifact) rather than in the state store. This is
reasonable given the file-mode `0o600` requirement (state store is JSON in a single shared file),
but it means the token is invisible to any plugin that introspects the state store. Snapshot capture
happens to tar the whole `runtime/` dir, so persistence Just Works, but a plugin author looking for
"what's persisted by the wallet?" via the state-store keys won't find anything.

### Sign-error logging path uses fire-and-forget `Effect.runPromiseWith(...).catch(() => {})`

`internal.ts:545-552` and `:610-617` swallow log-emit failures so the HTTP response goes through.
Defensible, but it means a logger sink failure during sign-error is invisible. The pattern is
consistent with the response-finish logger (`internal.ts:358-361`) but stands out next to the
`Effect.gen` body's structured error propagation.

### `display` projection redacts `pairUrl` only

`internal.ts:285` redacts the token from the TUI primary line, but the manifest writer still
publishes the full `pairUrl` to `.devstack/manifest.json` (read-mode permissions inherit the dir's
default, NOT 0o600 like the token file). So a hostile process that can read the manifest can still
recover the token. The token file IS 0o600 but the manifest is not.

## Open questions

- **Is there a wallet web UI served at `wallet.<app>.localhost:5180`?** The task description
  mentions "browser-facing UI" but the server body only routes `/api/v1/devstack/*`; everything else
  falls through to `404 not found` (text/plain) (`internal.ts:468-470`). There is no `GET /`
  handler. The browser-side UI is the `DevstackSignerAdapter` running INSIDE the dev-wallet's panel
  UI, which is mounted in the EXAMPLE'S vite dev server (`http://localhost:<vite-port>`), NOT at the
  wallet's port. So the wallet's port is purely an API endpoint. **OPEN QUESTION**: confirm with the
  user that there's no plan to serve a separate paired-wallet UI at this port.
- **What happens to in-flight signs when the wallet's scope closes mid-request?**
  `closeAllConnections()` drops the socket immediately. The
  `Effect.runPromiseWith(supervisorCtx)(account.sign...)` is detached from the wallet's own scope
  (it lives under the supervisor context), so it MAY complete after the wallet body's scope closes.
  **OPEN QUESTION**: is this the intended behavior or a hidden bug — should pending signs be
  cancelled?
- **Why does the wallet auto-derive `http://localhost:<vite-port>` even though it's not
  stack-scoped?** `internal.ts:161` adds `http://localhost:5175` (or vite's actual port). This means
  a sibling stack's vite running on the same `localhost:5175` could pair with this wallet (since
  CORS would let it through). **OPEN QUESTION**: is this intentional cross-stack pairing or a
  security gap given the per-stack assumption everywhere else?
- **Is there a documented migration from a legacy "devstack-wallet" / "v1 wallet"?** The user memory
  note says "devstack-wallet replaced by server-backed signer adapter" but no code in the wallet
  body references a legacy contract. The current implementation is greenfield against the dev-wallet
  `DevstackSignerAdapter`. **OPEN QUESTION**: is the "v1" purely a memory-note label, or is there an
  unreached doc?
- **Why does the integration test use `messageBytes` while the protocol-level docs
  (`internal.ts:302-307`) only mention `message`?** Server accepts both via
  `body['message'] ?? body['messageBytes']` (`internal.ts:576`). **OPEN QUESTION**: which field name
  is canonical going forward — both, or pick one?
- **What's the per-cycle vs long-lived classification of `accountsByAddress`?** The header doc at
  `services/wallet.ts:23-30` mentions the HTTP listener, allocator-held port, and file-provider YAML
  as per-cycle but doesn't classify `accountsByAddress`. It's implicitly per-cycle (rebuilt each
  boot from the account tags) — confirm with the user.
- **Does the wallet need a `/api/v1/devstack/version` route?** None today. Schema drift between
  client/server is caught by the byte-equality `protocol.test.ts`, but only at devstack build time —
  a long-lived browser tab against a freshly-deployed server doesn't get a version signal. **OPEN
  QUESTION**.
- **CORS preflight scope**: `OPTIONS` handler at `internal.ts:415-420` runs BEFORE the path-prefix
  gate, so an `OPTIONS / HTTP/1.1` with an allowed Origin returns 204. This is fine for browser
  preflight but the path isn't checked. **OPEN QUESTION**: intentional?
- **What does the `endpoint: { name, url }` field on the resolved `WalletApp` value
  (`internal.ts:272`) buy callers that `url` alone doesn't?** It's a thinner subset of the
  manifest's endpoint entry, but no in-tree consumer reads it. **OPEN QUESTION**: dead code or
  intended escape hatch?

## Opportunities noticed

- **Collapse `WalletOptions` and `WalletAppOptions`**: they have identical fields
  (`services/wallet.ts:37-49` vs `services/wallet/internal.ts:49-80`). The facade in `wallet.ts`
  exists only to translate between them via an optional-key fold. Either inline `walletApp` into
  `Wallet` or expose `walletApp`'s options directly as the public type.
- **Reconcile the `bindAddress` JSDoc contradiction** (`services/wallet.ts:47` vs
  `services/wallet/internal.ts:75-78`): the actual code defaults to `'127.0.0.1'` per HIGH-SEC1; the
  internal JSDoc is stale.
- **Pick a single field name on `/sign-personal-message`** instead of
  `body['message'] ?? body['messageBytes']` (`internal.ts:576`). The integration test uses
  `messageBytes` but the dev-wallet adapter likely uses one of them. Either rename for consistency
  with `/sign-transaction`'s `txBytes` or commit to `message`.
- **Pick consistent response field names** across `/sign-transaction` (`{ suiSignature, txBytes }`)
  and `/sign-personal-message` (`{ signature, bytes }`). Per the memory note "no compat for
  never-cases" — devstack is unreleased, no migration burden.
- **Either implement the fork-control routes or remove the path constants**:
  `services/wallet/protocol.ts:31-41` declares paths whose handlers don't exist. They 404 today. Per
  the memory note "no compat for never-cases" — keeping unwired constants is the kind of half-done
  state that note targets.
- **Hoist the duplicated `WalletHttpPath` const-object into a tiny third package**: the current
  devstack ↔ dev-wallet mirror exists because of a workspace dependency cycle. A
  `@mysten-incubation/devstack-protocol` or similar with just the const-object would eliminate the
  duplication AND the byte-equality sync test. This is a non-trivial structural change so propose,
  don't unilaterally execute.
- **Add a `StateStoreKeys.walletToken({ stack })` builder** OR explicitly document that the wallet
  token is NOT a state-store record. Today its absence from `engine/state-store-keys.ts` is
  invisible — the comment in that file (`state-store-keys.ts:7-9`) says "a single grep against
  `StateStoreKeys.*` finds every persisted artifact in the devstack", which is misleading because
  the token is persisted but not via state-store.
- **Manifest pairUrl file mode**: the token file is `0o600` but `.devstack/manifest.json` (which
  carries the unredacted pairUrl with token in the fragment) inherits whatever the dir's umask sets.
  If the threat model includes co-tenant process snooping, the manifest should also be `0o600` — or
  the token shouldn't be in the manifest pairUrl at all, only via the side-channel token file.
- **TUI display still leaks the token in the underlying state**: the `display` projection redacts
  (`internal.ts:285`), but anyone with debugger access to `s.pairUrl` sees the token. The
  defense-in-depth would be to not store the unredacted pairUrl on the resolved tag value at all —
  let callers reconstruct it from `localPort` + (out-of-band) token file.
- **Replace the hardcoded `5175` fallback for vite port** (`internal.ts:162`) with a re-read off
  `routerEntrypoint('vite')` — there's no real fallback case
  (`defineEntrypoint({ name: 'vite', port: 5175 })` runs at module load time, `router.ts:196`), so
  the `?? 5175` is dead defensive coding.
- **Per-account upstreamKeys could be folded into a single tag accessor**: `internal.ts:293`'s
  `[SuiTag.key, ...options.accounts]` works but every wallet user passes the same shape. A small
  `walletUpstreams({ sui, accounts })` helper would centralize the convention.
- **Documenting the "single fail-open: `writeFileProvider` DockerError logs and continues" semantic
  somewhere**: `internal.ts:239-244` is one of the few places in the wallet body that doesn't fail
  boot. The classification "router-fronted hostname unreachable; direct-port form works" is
  implicit. A test that pins this — boot a wallet with `DEVSTACK_ROUTER_DYNAMIC_DIR=/dev/null` and
  assert the wallet still publishes the endpoint — would document the invariant in code.
- **The `redactToken` regex `#token=[^&]+` is fine but doesn't cover the (unused-today) query-param
  form**. Defensive: if anyone ever flips to `?token=...`, the redactor needs an update. A regex
  covering both would prevent silent leakage at a future config change.
