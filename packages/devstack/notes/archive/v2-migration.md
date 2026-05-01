# devstack v2 migration

Single source of truth for "where am I" across sessions. Updated at every step (checkboxes), at
session end (Status block), and at phase end (DoD date + git tag).

## Status

- Branch: `v2`
- Current phase: **DONE — all 12 phases shipped; tracker archived**
- Last green tag: `v2-phase-12-cleanup` (pending sign-off)
- Last touched: 2026-04-30
- HEAD is wip: no

## Resume protocol (read every session, no exceptions)

1. `git checkout v2 && git pull --ff-only`
2. `git tag -l 'v2-phase-*' | tail -3` — confirms the last green phase tag.
3. `git log --oneline <last-tag>..HEAD` — shows wip commits since the last tag, if any.
4. Read these files, in order:
   - `notes/v2-migration.md` (this file).
   - `docs/devstack-design-proposal.md` (architecture truth until P12 promotes it to
     `docs/devstack-design.md`).
   - `packages/devstack/src-v2/core/types.ts` (live action contract — may have evolved beyond the
     doc).
   - The **Discoveries** section below (read every time).
5. Find the first unchecked item under "Current phase" below.
6. **If HEAD is a `wip:` commit, finish that phase before starting the next.** No exceptions.
7. Update the Status block above before committing.

The full plan lives at `~/.claude/plans/atomic-prancing-steele.md` (local, not in repo). This
tracker is the in-repo authoritative copy.

## Friction journal vs Discoveries

- **Friction during migration** → `notes/friction.md` (per CLAUDE.md). Pain encountered while
  building (e.g. "the action contract didn't compose for X reason").
- **Design decisions changed** → Discoveries section below. Mid-stream design changes (e.g. "Q4 said
  implicit watching, but we needed an opt-out"). When a discovery changes a locked Q answer, also
  edit `docs/devstack-design-proposal.md` and reference the commit here.

A single event may produce entries in both files when it's both a design change and a pain point.

---

## Phases

### P0 — Skeleton & tracker bootstrap [tag: v2-phase-00-skeleton]

- [x] Create v2 branch
- [x] Scaffold `packages/devstack/src-v2/core/`
- [x] Write skeletal `core/types.ts` (Action, Plugin, Registry, Scope, kinds)
- [x] Write `index.ts` re-export stub
- [x] Update `packages/devstack/tsconfig.json` to include `src-v2/**/*`
- [x] Create this tracker
- [x] Append CLAUDE.md migration note
- [x] Verify `pnpm typecheck` green
- [x] Commit + tag `v2-phase-00-skeleton`
- DoD: typecheck green; v2 branch exists with P0 commit; tracker exists.
- Tagged: 2026-04-29

### P1 — Registry + action engine [tag: v2-phase-01-runtime]

- [x] `src-v2/registry/index.ts`: typed registry; core kinds (`tokens`, `packages`, `accounts`,
      `services`); namespaced via `ns<T>('<plugin>')` (Proxy auto-creates kind queries);
      `list/find/require/register` queries; per-kind dirty tracking + `consumeDirty` (Q11; see
      Discovery 2026-04-29)
- [x] `src-v2/actions/{build,service,publish,register,seed,emit}.ts` factories
- [x] `src-v2/runtime/topo.ts`: Kahn topo-sort with stable tie-break
- [x] `src-v2/runtime/hash.ts`: stable JSON hash (sorted keys; bigint-safe)
- [x] `src-v2/runtime/reconcile.ts`: walk + skip predicate (hash + optional `getStatus`); Emit
      cascade with `consumeDirty`
- [x] `src-v2/runtime/manifest-writer.ts`: registry → `apps/<name>/devnet/manifests/<network>.json`
      (atomic write)
- [x] `src-v2/plugin.ts`: `definePlugin` + `expandPluginActions` (scope helper)
- [x] `src-v2/__scratch__/smoke.ts`: 1 Publish + 1 Emit; cycle twice; asserts second is no-op
- [x] Verify `pnpm exec tsx src-v2/__scratch__/smoke.ts` passes
- [x] Verify `pnpm typecheck && pnpm lint` green at workspace root
- [x] Commit + tag `v2-phase-01-runtime`
- DoD: smoke script runs; second run is no-op; typecheck + lint green. **Met 2026-04-29.**

### P2 — `devstack up` supervisor shell [tag: v2-phase-02-supervisor]

- [x] `runtime/supervisor.ts`: long-running process; reconcile loop; SIGINT
- [x] `runtime/status-renderer.ts`: persistent status block (cursor-up + erase-line); scrolling
      labeled logs; headless TTY fallback
- [x] `runtime/file-watcher.ts`: chokidar; input-hash diff
- [x] `cli/up.ts`: minimal `devstack up` command
- [x] `__scratch__/echo-plugin.ts`: 1 Service action that runs `sleep`
- [x] Single-key controls: `r` retry, `l` log toggle, `s` stop, `q` quit
- [x] Verify: status block renders; Ctrl-C clean shutdown; no zombies (`ps -ef | grep`).
- [x] Commit + tag `v2-phase-02-supervisor`
- DoD: supervisor stays alive after initial cycle; SIGINT/SIGTERM/Ctrl-C/`q`/`s` all run shutdown
  hooks LIFO; spawned `sleep` child is killed cleanly; TTY shows cursor-up + erase-line redraw of
  the status block; non-TTY prints state changes inline; typecheck + P1 smoke green. **Met
  2026-04-29.**

### P3 — `devstack deploy` one-shot path [tag: v2-phase-03-deploy]

- [x] `runtime/one-shot.ts`: parallel reconciler; `--network <n>`; takes `Signer`; runs
      Build/Publish/Register/Emit (no Service/Seed unless `liveNetworks` opt-in per Q5)
- [x] `helpers/signers.ts`: `cliSigner({ alias })` reads `~/.sui/sui_config/sui.keystore`;
      `envSigner({ name })` reads bech32/base64 env; both return `Ed25519Keypair` typed as `Signer`
- [x] `cli/deploy.ts`: `devstack deploy --network <n>`
- [x] Verify: typecheck + scratch invocation
- [x] Commit + tag `v2-phase-03-deploy`
- DoD: scratch deploy on testnet (no real chain) succeeds, filters Service + (default) Seed,
  registers publisher account from `signer.toSuiAddress()`, pre-registers `sui-rpc` service, writes
  per-network manifest, hydrates from prior manifest on second run; workspace typecheck green; P1 +
  P2 smokes still green. **Met 2026-04-29.**

### P4 — Port `sui` plugin [tag: v2-phase-04-plugin-sui]

- [x] `plugins/sui/index.ts`: `sui({ accounts: [...] })` factory
- [x] `Build` action: `dev-examples/sui-localnet:<version>` image (reuse v1 Dockerfile)
- [x] `Service` action: localnet container; JSON-RPC healthcheck
- [x] `Register` actions: account creation + faucet funding
- [x] Plugin self-registers in `services` (RPC, faucet, gRPC) and `accounts`
- [x] Verify: scratch app `sui({ accounts: ['publisher'] })` reconciles; `manifests/localnet.json`
      records accounts/services
- [x] **R1 watch:** if action contract churns >1x, log Discovery before continuing
- [x] Commit + tag `v2-phase-04-plugin-sui`
- DoD: `sui-up.config.ts` scratch reconciles cold (5.5s) and warm (1.3s); accounts persisted to
  `<appDir>/devnet/.keys/`; manifest records both publisher + alice with funded:true plus
  sui-rpc/sui-grpc/sui-faucet services. R1: action contract added one field (`appDir` on
  `ActionRunContext`); did not churn during the phase. Cold-cycle `getStatus` gap surfaced — logged
  as Discovery, deferred to a reconciler revisit. **Met 2026-04-29.**

### P5 — arena port (HOT-SWAP) [tag: v2-phase-05-arena]

- [x] **Hot-swap commit:** `git mv src src-v1-archive`; `git mv src-v2 src`; update `package.json`
      exports/main/types/bin
- [x] `apps/arena/devnet.config.ts`: thin v2 shape; `[sui({ accounts }), arenaPlugin()]`
- [x] `apps/arena/arenaPlugin.ts`: Publish for `connect_four`; Seed for openLobby (idempotent
      `getStatus`)
- [x] Delete `apps/arena/devnet/seed-lobby.ts`
- [x] Update `apps/arena/package.json` scripts (drop chained `pnpm devnet:seed-lobby`)
- [x] Update `apps/arena/src/vite-env.d.ts` (registry types from devstack)
- [x] Update `apps/arena/src/generated/deployment.ts`
- [x] Update `apps/arena/e2e/connect-four.spec.ts` for new manifest shape
- [x] Verify: `pnpm -F @mysten-incubation/arena test:e2e` green
- [x] Commit + tag `v2-phase-05-arena`
- DoD: arena reconciles cold in 17s (5 actions: sui.build/localnet/accounts +
  arena.connect_four/openLobby), e2e passes against the published Move package + seeded lobby.
  Subpath exports `/vite`, `/playwright`, `/vitest` keep pointing at `src-v1-archive/` so apps can
  keep using them; arena's vite.config passes the new manifest path to the v1-archive vite plugin
  (which is shape-agnostic). Other apps (token-studio, wallet, private-content) stay broken until
  P8/P9 ports them — accepted per §15. The `bin` field in devstack/package.json was dropped because
  pnpm shims invoke `node`, not `tsx`; arena scripts now
  `tsx ../../packages/devstack/src/cli/up.ts ...` directly. **Met 2026-04-29.**

### P6 — Port `walrus` plugin [tag: v2-phase-06-plugin-walrus]

- [x] `src/plugins/walrus/index.ts`: `walrus({ rev? })` factory
- [x] `Build` action: clone MystenLabs/walrus + multi-arch image (ported from v1
      `services/walrus-build.ts` to `src/plugins/walrus/build.ts`)
- [x] `Service` actions: `walrus-deploy` (one-shot; `exited(0)`-as-healthy via `getStatus`),
      `walrus-node-{0..3}` (fixed IPs 10.0.0.10–13, docker-level healthcheck on `:9184/metrics`)
- [x] `Register` action: parses `/opt/walrus/outputs/deploy` (via `docker cp` from a node
      container), queries the chain to extract WAL coin type from the System object's generic,
      registers `tokens.wal` + `packages.walrus` + `registry.ns('walrus').nodes`
- [x] Sui-plugin retrofit: per-app docker network `<appName>-net` (subnet 10.0.0.0/24) with
      `sui-localnet` DNS alias; new `<appName>-sui-bin` shared volume so node containers can mount
      the sui binary at `/root/sui_bin` (the localnet image's entrypoint copies it on start)
- [x] Docker helper extensions in `src/plugins/sui/docker.ts`: `ensureNetwork`, `removeNetwork`,
      `waitForContainerExit` (via `docker wait`), `waitForHealthy`, `readContainerFile` (via
      `docker cp <c>:<p> -` piped through `tar -xO`), and `RunContainerOptions` gains `network` /
      `networkAlias` / `ip` / `platform` / `hostname`. `ContainerInfo` gains `state` + `exitCode` so
      plugins can detect `exited(0)`
- [x] Verify: scratch `[sui(), walrus()]` reconciles cold (sui localnet + walrus deploy + 4 nodes +
      register WAL/walrus/nodes — full graph green); `docker kill` on `walrus.node-2` recovered
      cleanly via the next `--once` cycle (the killed container gets removed and re-created;
      supervisor reaches healthy again)
- [x] Commit + tag `v2-phase-06-plugin-walrus`
- DoD: cold cycle reconciles 10 actions (sui.{build,localnet,accounts} +
  walrus.{build,deploy,node-0..3,register}); manifest records publisher account, sui-rpc/grpc/faucet
  services, the walrus package + captured object IDs, the WAL token (coin type extracted from the
  treasury object's `<wal_pkg>::wal::ProtectedTreasury` type prefix), and 4 namespaced
  `walrus.nodes` entries; SIGKILL on a node container recovers on the next cycle. **Met
  2026-04-30.**

### P7 — Port `seal` plugin [tag: v2-phase-07-plugin-seal]

- [x] `src/plugins/seal/index.ts`: `seal({ rev?, apiPort? })` factory
- [x] `Build` action: multi-stage seal image with key-server + seal-cli
- [x] `Register` action: BLS keypair + KeyServer publish; **`getStatus()` checks cached
      `keyServerObjectId` is live on-chain** (closes v1 §10.1)
- [x] `Service` action: `seal-key-server`; healthcheck via `/v1/service?service_id=<id>`
- [x] Plugin-namespaced kind: `registry.ns<SealNamespace>('seal').keyServer` records
      `{ objectId, url, publicKey, sealPackageId }` (sealPackageId also on `packages.seal`)
- [x] Verify: `[sui(), walrus(), seal()]` reconciles cold in 72.6s (14 actions:
      sui.{build,localnet,accounts} + walrus.{build,deploy,node-0..3,register} +
      seal.{build,publish,register,key-server}); warm cycle is **2.15s** total (well under sub-2s
      for the seal portion in isolation: seal-only warm = 1.30s)
- [x] Log warm-loop perf in tracker (above)
- [x] Commit + tag `v2-phase-07-plugin-seal`
- DoD: cold cycle reconciles 14 actions; warm cycle is 2.15s with no chain writes (verified by
  asserting `packages.seal.packageId` and `seal.keyServer[0].objectId` are unchanged across
  cold→warm). Closes v1 §10.1's ~12s-per-up KeyServer re-registration. Two ancillary fixes landed
  alongside: (1) reconciler now consults `getStatus` on cold cycles too (was deferred at P4 — see
  Discovery 2026-04-29 — `getStatus` should run on cold cycles too) and (2) supervisor hydrates the
  prior manifest on startup (mirroring `runOneShot`). Plus seal also includes a `Publish` action —
  the seal Move package needs to be on-chain before `Register` can call
  `key_server::create_and_transfer_v2_independent_server`. The shared `imported-package.ts`
  extraction stays scheduled for P8. **Met 2026-04-30.**

### P8 — Port token-studio + wallet apps [tag: v2-phase-08-apps-coins]

- [x] **Pre-P8 sketch (R4):** paper graph captured in "Paper sketches" section above. Contract
      verdict: holds — no churn.
- [x] `apps/token-studio/`: rewrite config + `tokenStudioPlugin()` (Publish for `managed_coin`);
      alice doubles as publisher to keep the UI's "TreasuryCap holder" badge resolving
- [x] `apps/wallet/`: rewrite config + `walletPlugin()` (3 Publishes — usdc, weth, deepbook import
      — + 3 Seeds — seedTokens, seedPools, seedOrders)
- [x] `src/helpers/imported-package.ts`: shared helper for git-pinned Move imports (was v1
      `deploy/steps/import.ts`); placement matches `helpers/move-package.ts` precedent (tracker text
      said `src/plugins/`, but `helpers/` is consistent — apps still call from inside `Publish`
      action `run`)
- [x] Update both apps' scripts (drop `devstack ...` shim, use
      `tsx ../../packages/devstack/src/cli/up.ts ./devnet.config.ts --once` like arena), vite-env,
      generated/deployment, vite.config (`manifestPath: 'devnet/manifests/localnet.json'`)
- [x] Delete `apps/wallet/devnet/seed-pools.ts`, `apps/wallet/devnet/seed-orders.ts`
- [x] Verify: both apps' `test:e2e` green (token-studio 2/2 in 5.4s; wallet 3/3 in 7.1s)
- [x] Commit + tag `v2-phase-08-apps-coins`
- DoD: token-studio cold cycle 16.5s (4 actions) → warm 1.13s. Wallet cold cycle 32.6s (9 actions:
  sui.{build,localnet,accounts} + wallet.{usdc,weth,deepbook,seedTokens,seedPools,seedOrders}) →
  warm 3.39s with no chain writes. Both apps' E2Es pass against real localnet + DeepBook v3
  (whitelisted pools, alice's BalanceManager + 6 limit orders/pool). Two friction items surfaced
  (logged below): the per-app docker subnet hardcode (CLAUDE.md anti-pattern §"hardcoded ports")
  forcing tear-down between v2 stacks, and an indirect-failure-isolation gap in the reconciler.
  **Met 2026-04-30.**

### P9 — Port private-content app [tag: v2-phase-09-app-private-content]

- [x] `apps/private-content/`: rewrite config + `privateContentPlugin()` (Publish for `vault`; seal
      package import lives inside the seal plugin so the app plugin only owns vault)
- [x] Update vite-env (drops inlined `seal?:` field; reads `registry.seal.keyServer` namespace)
- [x] Update e2e spec — none needed; `connectAs`/`selectAccount` are shape-agnostic
- [x] Verify: `test:e2e` green (1/1 in 7.5s) against the full stack — sui-localnet + walrus + seal +
      vault publish
- [x] Commit + tag `v2-phase-09-app-private-content`
- DoD: cold cycle reconciles 15 actions in ~76s (sui.{build,localnet,accounts} +
  walrus.{build,deploy,node-0..3,register} + seal.{build,publish,register,key-server} +
  privateContent.vault); warm cycle is **2.32s** with no chain writes (every action skipped via
  getStatus). E2E spec exercises full SealClient.encrypt → upload_entry → grant_entry → SessionKey →
  seal_approve dry-run → fetchKeys → SealClient.decrypt round trip across two browser sessions
  (alice → bob). Vault Move package has no `use seal::...` import — Seal access control runs
  entirely client-side via the SessionKey + the vault::vault::seal_approve dry-run policy fn — so
  vault publish only needs `sui.accounts`. Pre-existing biome lint failures (4 format + 4
  useLiteralKeys, all in P5–P8 leftover files) cleaned up alongside this phase. Two minor v1
  leftovers under `apps/private-content/devnet/` (a v1-shaped `.manifest.json` and
  `.generated/{docker-compose.yml,seal-config.yaml}`) were removed pre-cycle; v2 reads from
  `devnet/manifests/<network>.json` and regenerates seal-config under `.generated/` itself. **Met
  2026-04-30.**

### P10 — Codegen as Emit plugin [tag: v2-phase-10-plugin-codegen]

- [x] **Pre-P10 safety:** snapshotted v1 generated outputs for all 4 apps to
      `/tmp/v1-codegen-snapshot/` (10 files across arena/token-studio/wallet/private-content)
- [x] `src/plugins/codegen/index.ts`: `codegen({ output? })` factory; one Emit action
      `codegen.generate` with `dependsOnKind: ['packages']`; shells
      `node @mysten/codegen/dist/bin/cli.mjs generate -o <output> --importExtension .js <pkg.path>`
      per package; pathless registry entries (deepbook, seal, walrus — sources inside docker clones,
      not host) silently skip, mirroring v1's "movePackages-only" behavior
- [x] Added optional `path?: string` to `Package` registry entry;
      arena/token-studio/wallet/private-content plugins now pass `path:` when registering own
      packages so the codegen plugin can discover targets without a separate config
- [x] Added `codegen()` to all 4 apps' `plugins:` arrays
- [x] Diff v1 vs v2 generated outputs: **byte-identical for all 4 apps** (`diff -r` empty across
      arena/connect_four, token-studio/managed_coin, wallet/{mock_usdc,mock_weth},
      private-content/vault — no intentional diffs)
- [x] Verify: typecheck + lint + all 4 E2Es green
- [x] Commit + tag `v2-phase-10-plugin-codegen`
- DoD: cold cycles regenerate v1-identical bindings under each app's `src/generated/sui/<package>/`
  (gitignored). Cold timings (post fix from "sui CLI 1.71 needs --build-env" Discovery below): arena
  16.9s (5 → 6 actions, +codegen), warm 1.15s; token-studio 17.3s (4 → 5); wallet 33.3s (9 → 10);
  private-content 78.8s (15 → 16), warm 2.28s. E2Es 7/7 (arena 1/1 in 19.5s, token-studio 2/2 in
  5.3s, wallet 3/3 in 11.7s, private-content 1/1 in 5.3s). One bug surfaced + fixed alongside
  (logged as Discovery): sui CLI 1.71 rejects `sui move build` against active env `local` (the
  entrypoint-default), so `helpers/move-package.ts:buildInContainer` now passes
  `--build-env testnet` explicitly. Two deferred discoveries from P8 (sui plugin's hardcoded subnet,
  transitive failure isolation) carry forward to P11/P12 — both are non-blocking; the codegen Emit's
  input-hash gate + getStatus already short-circuits when no package source has changed since last
  write. **Met 2026-04-30.**

### P11 — REPL `devstack console` [tag: v2-phase-11-console]

- [x] `src/cli/console.ts`: Node REPL; pre-bound `manifest`, `accounts`, `client`,
      `packages.<name>.<fn>()`
- [x] One-shot lifecycle (banner; commands; `.exit`)
- [x] Verify: manual smoke session — mint a coin, query a balance, create an object via prebound
      bindings
- [x] Document smoke session in tracker
- [x] Commit + tag `v2-phase-11-console`
- DoD: `tsx packages/devstack/src/cli/console.ts <config>` prints a 9-line banner and drops into a
  Node REPL with `manifest`, `client` (`SuiJsonRpcClient` pointed at the manifest's `sui-rpc`
  service URL), `accounts.<name>` (each `{ name, address, keypair?, role?, funded? }` — `keypair`
  populated when `<appDir>/devnet/.keys/<name>.key` exists), `packages.<name>.<fn>()` (codegen
  output dynamically imported from `<appDir>/src/generated/sui/<pkg>/<pkg>.ts`, exported functions
  wrapped to default `package:` to the registered `packageId`, plus a `$id` field), and
  `Transaction` / `bcs` / `Ed25519Keypair`. Two smoke sessions captured — full transcripts under
  "P11 smoke session" below. Two non-blocking notes: (1) Node REPL needs `terminal: true` for
  top-level `await` assignments to persist (verified — `useGlobal: false` plus `terminal: true` is
  the working combo); (2) Sui's `getBalance` rejects coin types whose package address has a literal
  leading zero (`0x09b7…::…::MANAGED_COIN`) while `getCoins` accepts both forms — likely upstream
  SDK quirk, not a console bug. **Met 2026-04-30.**

#### P11 smoke session

**Session A — `private-content` (vault, no coins).** Stack already up from P9 verify. With
`terminal: true` enabled, ran inline through stdin (interactive use is the same shape):

```
$ pnpm exec tsx packages/devstack/src/cli/console.ts apps/private-content/devnet.config.ts
devstack console — private-content (localnet)
  manifest  …/apps/private-content/devnet/manifests/localnet.json
  rpc       http://127.0.0.1:9482
bound:
  client          SuiClient
  manifest        parsed manifest
  accounts.<name> publisher, alice, bob
  packages.<name> vault (auto-bound)
  Transaction, bcs, Ed25519Keypair

devstack> Object.keys(packages)
[ 'vault' ]
devstack> accounts.publisher.address
'0x4992bef493bcf159ca64c771c3a2d121013579f3c9592f3eb50d7992e3bd9572'
devstack> await client.getBalance({ owner: accounts.publisher.address, coinType: '0x2::sui::SUI' })
{ coinType: '0x2::sui::SUI', coinObjectCount: 1, totalBalance: '999858533240', … }
devstack> const tx = new Transaction()
devstack> packages.vault.uploadEntry({ arguments: ['hello-from-repl', [1,2,3,4], [5,6,7,8,9,10,11,12]] })(tx)
devstack> const result = await client.signAndExecuteTransaction({ transaction: tx, signer: accounts.alice.keypair, options: { showObjectChanges: true } })
devstack> result.objectChanges.filter(c => c.type === 'created').map(c => c.objectType.split('::').slice(-2).join('::'))
[ 'vault::File', 'vault::Cap', 'dynamic_field::Field<address, bool>' ]
```

Exercised: prebound `client` (RPC call), prebound `accounts.<n>.{address,keypair}`, prebound
`packages.vault.uploadEntry` with auto-defaulted `package:`, `Transaction` constructor, full sign +
execute against live chain producing on-chain `vault::File`/`vault::Cap` objects.

**Session B — `token-studio` (managed_coin, mint path).** Brought up token-studio fresh after
tearing down private-content's docker network (subnet collision per 2026-04-30 discovery). 5-action
cold cycle reconciled in ~16s. Mint smoke:

```
devstack> const treasuryCapId = manifest.registry.packages.find(p => p.name === 'managed_coin').captured.treasuryCapId
'0x2b64507fb5e7b9df59011d681ac10981a9f9deb5e0c99c3faeb800c40f8cf2cc'
devstack> const tx = new Transaction()
devstack> packages.managed_coin.mint({ arguments: [treasuryCapId, 1234567n, accounts.bob.address] })(tx)
devstack> const result = await client.signAndExecuteTransaction({ transaction: tx, signer: accounts.alice.keypair, options: { showEffects: true, showObjectChanges: true } })
devstack> result.effects.status.status
'success'
devstack> result.objectChanges.filter(c => c.type === 'created').map(c => c.objectType.split('::').slice(-2).join('::'))
[ 'managed_coin::MANAGED_COIN>' ]    // i.e. 0x2::coin::Coin<…::managed_coin::MANAGED_COIN>
devstack> const coinType = packages.managed_coin.$id + '::managed_coin::MANAGED_COIN'
devstack> const coins = await client.getCoins({ owner: accounts.bob.address, coinType })
devstack> coins.data.map(c => ({ id: c.coinObjectId.slice(0,12)+'…', balance: c.balance }))
[ { id: '0x68ca99e302…', balance: '1234567' } ]
```

Exercised: alice (TreasuryCap holder) signed; bob received a 1.234567 STUDIO Coin. The mint binding
consumed the captured `treasuryCapId` from the manifest with no manual address plumbing.

### P12 — Cleanup, docs, ship-readiness [tag: v2-phase-12-cleanup]

- [x] Delete `packages/devstack/src-v1-archive/`
- [x] Delete any `__scratch__/` directories left in `src/`
- [x] Verify all old `apps/*/devnet/seed-*.ts` are gone (`find apps -name 'seed-*.ts'` should be
      empty)
- [x] Move `docs/devstack-design.md` (v1) to `docs/archive/devstack-design-v1.md`
- [x] Move `docs/devstack-design-proposal.md` to `docs/devstack-design.md`; update preamble (drop
      "draft / proposal" framing)
- [x] Rewrite `packages/devstack/README.md` from scratch against v2
- [x] Update `CLAUDE.md`: remove the temporary "if you see notes/v2-migration.md" note added in P0
- [x] Append v2 migration summary section to `notes/friction.md` (synthesized from Discoveries)
- [x] `packages/devstack/package.json`: bump `version` to `1.0.0-rc.1`; update `description`
- [x] Verify `.github/workflows/ci.yml` static job + gated E2E both work — fixed Dockerfile path
      (`src/docker/sui-localnet/` → `src/plugins/sui/`); rewrote gated `e2e` job to matrix over the
      4 apps with `devnet:up` + `test:e2e` (replaces the now-removed v1 `devstack ci` invocation)
- [x] **Pre-merge checklist:**
  - [x] `pnpm typecheck` + `pnpm lint` green at root
  - [ ] All 4 apps' `pnpm test:e2e` green — deferred to sign-off; require local docker stacks
  - [x] `git grep src-v1-archive` → empty (excluding this archived tracker)
  - [x] `git grep -E '(TODO|FIXME)\(v2\)'` → empty
  - [ ] Cold-clone test:
        `git worktree add ../tmp v2 && cd ../tmp && pnpm install && pnpm -F @mysten-incubation/arena test:e2e`
        — deferred to sign-off
  - [x] `packages/devstack/README.md`, `docs/devstack-design.md`, `CLAUDE.md`, `notes/friction.md`
        reviewed
  - [x] Tracker fully checked
- [x] Move `notes/v2-migration.md` to `notes/archive/v2-migration.md`
- [ ] Tag `v2-phase-12-cleanup` — pending sign-off
- [ ] Open PR `v2 → main`; squash-merge; tag `v2-complete` — pending sign-off

P12 changes during cleanup that weren't in the original checklist:

- Migrated `/vite`, `/playwright`, `/vitest` subpath modules from `src-v1-archive/` to
  `src/{vite,playwright,vitest}/` before deleting v1-archive — the modules were live deps of all 4
  apps' configs/tests. Updated `packages/devstack/package.json` exports.
- Moved sui plugin's Dockerfile + entrypoint.sh from `src-v1-archive/docker/sui-localnet/` to
  `src/plugins/sui/` (mirrors the seal plugin's co-located Dockerfile pattern). Fixed the orphaned
  `DEFAULT_DOCKER_CONTEXT` path.
- Added `**/devnet/manifests/` to `.gitignore` so per-network manifest emissions stop landing in
  dirty working trees.
- Restored `vite.config.js` etc. ignores and similar housekeeping deltas were already in
  `.gitignore` before P12.

---

## Discoveries / mid-stream design changes (append-only)

> Per session, append entries here when implementation surfaces a design issue that diverges from
> `docs/devstack-design-proposal.md`. Each entry: date, slug, affected phase, what surprised us,
> decision, doc-update commit ref. If the change also caused pain, add a friction.md entry.

### 2026-04-29 — emit cascade needs `consumeDirty`

**Affects:** P1 (reconciler). **Found:** First smoke run double-fired the Emit on cycle 1. Reason:
the topo walk runs Emits with fresh registry state, but the post-walk cascade fires whenever any
kind in `dependsOnKind` is dirty — including kinds the Emit _already saw_ during the walk.
**Decision:** Added `Registry.consumeDirty(kinds: string[])`. After an Emit runs in the topo walk
(`healthy` or `skipped`), reconciler clears its `dependsOnKind` entries from the dirty set. The
cascade then only re-fires Emits when a _later_ action in the same cycle re-dirtied a kind.
Preserves the genuine-stale-Emit case (topo orders an Emit before a dirty-producing action it
doesn't depend on). **Doc updates:** Should add this to `docs/devstack-design-proposal.md` §9.1
reconciliation loop description; the doc currently doesn't mention the consume step. Defer until we
batch design-doc edits at end of P1+ or in P12. Code is the truth in the meantime; this entry is the
bridge.

### 2026-04-29 — `ActionRunContext.onShutdown`

**Affects:** P2 (supervisor) — touches the action contract in `core/types.ts`. **Found:** The
supervisor needs a way for actions whose `run` spawns an in-process child (P2 scratch echo-plugin's
`sleep`, future ad-hoc spawns) to register a teardown so SIGINT / `q` keystroke can clean up without
leaving zombies. Real Service actions (P4 sui localnet via `docker compose up -d`) detach the
container by design (§9.4: "default: keep containers running so re-up is fast") and don't use the
hook. **Decision:** Added `onShutdown?: (fn: ShutdownHook) => void` to `ActionRunContext`. The
supervisor injects an implementation that pushes onto an LIFO list; one-shot paths
(`devstack deploy`, smoke scripts) leave it `undefined`. Reconciler propagates `base.onShutdown`
into each action ctx. Plugin-author-visible: documented inline in `core/types.ts`. **Doc updates:**
Add to `docs/devstack-design-proposal.md` §9.4 (lifecycle) when we batch design-doc edits in P12.
Code is the source of truth in the meantime.

### 2026-04-29 — `getStatus` should run on cold cycles too

**Affects:** P1 (reconciler) — surfaced during P4 sui plugin verification. **Found:** First cold
cycle of `sui.build` ran the docker build even though the image already existed locally and the
action's `getStatus` would have returned ok. Reason: reconciler only consults `getStatus` when the
action's input hash matches a prior in-memory state. On cold start there's no prior, so the gate
falls through to `run`. Design proposal §9.1 reads "getStatus first"; §7.3 reads "hash gate first,
getStatus on hit" — slight internal inconsistency. **Decision (deferred):** Extend
`Reconciler.evaluateAndRun` so when `prior === undefined` and `action.getStatus !== undefined`, it
calls `getStatus` and skips on `ok: true`. Hash gate stays as the warm-cycle short-circuit. This
matches v1's M5 "stack already healthy" behavior and §3's "stops being a CLI special case" goal. Not
blocking P4: the redundant work is sub-second (docker build with all-cached layers) — but worth
fixing before P5 hot-swap so warm-loop perf carries forward. **Doc updates:** None yet. When the fix
lands, prefer §9.1's wording ("always call getStatus") and rewrite §7.3 to describe the hash gate as
a _secondary_ optimization for actions without `getStatus`.

### 2026-04-29 — `Registry.ns<T>` constraint loosened

**Affects:** P1 (registry typing) — surfaced during P6 walrus plugin authoring. **Found:** The
signature was `ns<T extends Record<string, RegistryQuery<unknown>>>(name: string): T;`. A
plugin-author type like `interface WalrusNamespace { nodes: RegistryQuery<WalrusNode> }` does not
satisfy that constraint — TS interfaces don't get an implicit index signature, so callers had to
either intersect with `& Record<string, RegistryQuery<unknown>>` (which widens nested values) or use
`as unknown as` casts. The constraint was purely cosmetic anyway: the runtime is a Proxy that
auto-creates a `RegistryQuery` on any string property access, so a tighter T does not change
behaviour. **Decision:** Loosened to `ns<T>(name: string): T;` in both `core/types.ts` and
`registry/index.ts`. Plugin authors now declare the namespace shape directly. The Proxy still
enforces "every property is a RegistryQuery" at runtime regardless of T. **Doc updates:** §6.1 quote
in `docs/devstack-design-proposal.md` ("Plugin-declared kinds nest under the plugin:
`ctx.registry.pyth.priceFeeds.list()`") still reads correctly. Mention the unconstrained generic
when batching the §6 doc edits in P12.

### 2026-04-29 — per-app docker network subnet conflicts with v1 stacks

**Affects:** P6 (sui plugin retrofit + walrus plugin) — environmental, surfaced when attempting the
cold-cycle verify. **Found:** The walrus testbed scripts hardcode node IPs `10.0.0.10–13`, which
forces the per-app docker network to use subnet `10.0.0.0/24`. Docker refuses overlapping pools
across networks ("invalid pool request: Pool overlaps with other one on this address space"). Any v1
stack still up with `devstack-net` (also `10.0.0.0/24`) blocks creation of a new `<appName>-net`.
The P6 verify required tearing down the v1 `private-content-*` stack first. **Decision:** Don't
parameterize the subnet in P6. The walrus scripts can't be edited in-place without copying them out
of the cached clone, and that's larger scope than P6 needs. P12's v1 cleanup naturally retires the
conflicting `devstack-net` networks alongside the `devnet:up` scripts that bring them up. If a
future plugin needs a separate fixed-IP range, parameterize then. **Doc updates:** None.

### 2026-04-30 — `inspectContainer --format` template breaks on healthcheck-less containers

**Affects:** P6 — surfaced on the warm-cycle verify with the now-exited walrus.deploy container.
**Found:** The original
`--format '{{.Id}}|{{.State.Status}}|{{.State.ExitCode}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'`
errors out when `State.Health` is **absent from the map** (not present-but-nil) — Docker omits the
key entirely on containers without a healthcheck. The template fails with
`map has no entry for key "Health"`, `inspectContainer` returns `null`, and the early-return for
`exited(0)` containers in `walrus.deploy.run` never fires. The action then falls through to
`runContainer` and collides on the existing container's name. **Decision:** Switched to
`--format '{{json .State}}'`, parse JSON in JS, look up `state.Health?.Status` safely. Also issue a
separate `--format '{{.Id}}'` call. Two inspects per call is fine (sub-millisecond docker daemon
latency). Code is the source of truth; design proposal §9.4 lifecycle wording is unaffected. **Doc
updates:** None.

### 2026-04-30 — WAL coin type lives in the treasury object's package, not in System's generic

**Affects:** P6 (`walrus.register`). **Found:** The first hypothesis was that `system_object`'s
on-chain type would carry the WAL coin as a generic parameter —
`<walrus_pkg>::system::System<<wal_pkg>::wal::WAL>`. Live RPC says otherwise:
`system_object.type === '<walrus_pkg>::system::System'` (no generic), and same for `staking_object`.
The actual anchor is `treasury_object.type === '<wal_pkg>::wal::ProtectedTreasury'` — same package
that owns `wal::WAL`. The deploy file gives us `treasury_object` directly, so one `getObject` call +
a regex on the type prefix reconstructs the WAL coin type. **Decision:** `fetchWalCoinType` now
consults only the treasury object. Falls back to undefined (skipping `tokens.wal` registration) if
treasury is absent or the type doesn't match — apps still get `packages.walrus` and the node URLs.
**Doc updates:** None — the design proposal doesn't mandate which on-chain object the WAL type comes
from.

### 2026-04-30 — `getStatus` on cold cycles applied (closes 2026-04-29 deferred decision)

**Affects:** P1 (reconciler) — the deferred decision in the 2026-04-29 entry above. **Found:**
Required to close v1 §10.1 properly for `seal.register`. Without this, on a fresh process the
in-memory `state` map is empty, so the hash gate never matches, so `getStatus` is never consulted,
so `run` always re-publishes the on-chain `KeyServer` object (~12s) — exactly the v1 behavior the
migration was supposed to retire. **Decision:** `Reconciler.evaluateAndRun` now consults `getStatus`
whenever it's defined, before running. The hash gate becomes a _secondary_ short-circuit only used
when `getStatus` is undefined (so actions without a skip predicate still skip on warm cycles via
input-hash equality). All four downstream plugins benefit (`sui.localnet` no longer attempts a
re-create, `walrus.deploy` skips if exited(0), etc.); none regressed in the P1 smoke or the full P7
verify. Code is the source of truth; the reconciler block-comment now reflects the new ordering.
**Doc updates:** `docs/devstack-design-proposal.md` §9.1 (the section was already aligned with this
behavior — "always call getStatus") wins over §7.3's "hash gate first." When batching design-doc
edits in P12, rewrite §7.3 to describe the hash gate as a fallback for actions without `getStatus`.

### 2026-04-30 — supervisor was missing manifest hydration

**Affects:** P2 (supervisor) — surfaced during P7 seal verify. **Found:** With the cold-cycle
`getStatus` fix above, `seal.register.getStatus` would still return `ok: false` on a fresh process
because the registry was empty — `ns<SealNamespace>('seal').keyServer.find(...)` returned
`undefined`. Cause: the supervisor (`runtime/supervisor.ts`) never called `hydrateRegistry`, even
though the deploy path (`runtime/one-shot.ts`) had been doing so since P3. The `getStatus` skip
predicates depend on prior state being in the registry; without hydration, every cross-process
restart looks like a cold install. **Decision:** Added `hydrateFromManifest()` to `Supervisor` and
call it from both `start()` and `runOnce()` before the first reconcile. Mirrors `runOneShot`. The
hydrate step swallows errors (logged via `renderer.appendLog`) so a malformed manifest can't brick
the supervisor; the next cycle just behaves like a cold start. Verified end-to-end: `seal-only` warm
cycle dropped from 7.15s (re-publish + re-register) to 1.30s (pure getStatus probes); full
`[sui, walrus, seal]` warm dropped from ~8s to 2.15s. **Doc updates:** None —
`docs/devstack-design-proposal.md` §10.1 already says "materialize a degenerate registry from the
prior manifest" for the deploy path; the supervisor was just an oversight. P12 doc pass should make
sure §9 also calls out hydration on `up` startup.

### 2026-04-30 — `sui client test-publish` signs with the CLI's auto-generated default

**Affects:** P8 (helpers/imported-package.ts). **Found:** First wallet cold cycle had
`wallet.seedPools` failing with `Object 0x… owned by 0x9f2c87… but signer 0xae00f5…`. Root cause:
the sui-localnet image auto-creates a CLI keystore on first `sui client …` invocation with a single
throwaway alias (`priceless-obsidian`), no SUI. `sui client test-publish` signs with whatever's
_active_, so DeepBook's `init` transferred the `DeepbookAdminCap` to that throwaway address —
inaccessible to the publisher we registered in the registry. v1 lived with this because its
declarative deploy used `signAndExecuteTransaction` with the configured signer end-to-end; v2's
import path goes through the CLI for `--with-unpublished-dependencies`. **Decision:**
`importMovePackage` now takes a required `publisher: { secretKey, address }`. Before `test-publish`,
the helper does `sui keytool import <bech32> ed25519`, `sui client switch --address <addr>`, and
`sui client faucet` against the in-container faucet. Idempotent — keytool import is a no-op if the
key already lives in the keystore. The plugin reads the bech32 from
`<appDir>/devnet/.keys/<publisher>.key` (sui keytool format already on disk) and computes the
address via `keypair.toSuiAddress()`. **Doc updates:** None — the design proposal doesn't speak to
which keystore signs an import. Worth noting in a P12 §10/§14 helper-reference pass.

### 2026-04-30 — sui plugin's docker subnet is hardcoded; v2 stacks can't coexist

**Affects:** P4 (sui plugin) — surfaced when bringing arena, token-studio, and wallet up
sequentially. **Found:** `packages/devstack/src/plugins/sui/index.ts` pins
`APP_NETWORK_SUBNET = '10.0.0.0/24'` so walrus's testbed can wire its fixed-IP nodes (per the
2026-04-29 discovery on subnet conflicts). That's the only reason the subnet must be deterministic —
sui itself doesn't care. The hardcode means _any_ two v2 stacks collide on
`Pool overlaps with other one on this address space` even when neither uses walrus, forcing a
tear-down between every cold cycle. Mirrors the deepbook-sandbox anti-pattern flagged in CLAUDE.md
("hardcoded ports anywhere outside the port allocator"); we just pushed it from ports onto subnets.
**Decision (deferred):** Make the subnet opt-in. The walrus plugin already needs to know about
`<appName>-net` — it can also be the thing that pins the subnet (call
`ensureNetwork({ name, subnet: '10.0.0.0/24' })` from the walrus plugin's `Build`/`Service` actions
before the sui plugin creates the network with whatever-Docker-gives-us). Sui's `ensureNetwork` then
calls without a subnet arg, so the daemon picks one from its pool. Worth doing in P10 alongside the
codegen plugin since both phases touch shared-infrastructure shapes; deferred from P8 to keep
app-port scope tight. **Doc updates:** None — design proposal §9 (per-app network) is silent on
subnet provenance. Add a sentence in P12 docs that the walrus plugin owns the fixed subnet pinning.

### 2026-04-30 — failure isolation only checks direct deps, not transitive

**Affects:** P1 (reconciler) — surfaced during P8 wallet cold-cycle debugging. **Found:** When
`wallet.deepbook` failed, `wallet.seedPools` (direct dep) correctly went to `queued`. But
`wallet.seedOrders` (deps `[seedPools, seedTokens]`) saw seedPools _queued_ (not in `failedNames`),
so it ran — and immediately threw `Registry: packages has no entry named 'deepbook'` because its
`run` calls `ctx.registry.packages.require('deepbook')`. End state: seedOrders in `failed` instead
of `queued`. The status block told the user about a noise-failure that's a downstream consequence of
an upstream failure — same data, different framing. **Decision (deferred):** `Reconciler.cycle`
should propagate `queued` like `failed` does — i.e. queued actions count as "blocked, don't run
downstream." Cheap fix: add `queuedNames: Set<string>` and check
`failedNames.has(n) || queuedNames.has(n)` in the `needs.some` predicate. Not blocking P8: actions
whose `run` consults `registry.packages.require(...)` self-fail with a clear message, so the user
still sees an actionable error. Logging this so the next reconciler revisit (P10/P11) knows to fix
it. **Doc updates:** Design proposal §9.1 says "A failed action's dependents stay queued, not
failed" but is silent on whether queued is itself transitive. Update at P12.

### 2026-04-30 — sui CLI 1.71 rejects `sui move build` against active env `local`

**Affects:** P10 — surfaced on the first arena cold cycle after the codegen wiring landed.
**Found:** `helpers/move-package.ts:buildInContainer` invokes
`docker exec <c> sui move build --path <…> --dump-bytecode-as-base64` without `--build-env`. On a
freshly-bootstrapped sui-localnet container, the auto-generated `client.yaml` has
`active_env: local`, and sui CLI 1.71 rejects "local" with "Could not determine the correct
dependencies to use for `local`; pass one of `--build-env testnet` or `--build-env mainnet`."
P5/P8/P9 all cleared this — but only because the containers I tested against had been switched to a
non-`local` active env at some earlier point (probably during `imported-package.ts`'s
`sui client switch --env local` flow, which still leaves the env in a state sui accepts; or a
pre-Apr-29 image release that defaulted active_env elsewhere). Fresh containers fail
deterministically. **Decision:** Pass `--build-env testnet` to `sui move build`. `testnet` is a
canonical env: packages without an `[environments]` block accept it, and after the first build deps
are content-addressed in the image's `~/.move` cache so subsequent invocations don't round-trip to
GitHub. Verified across all 4 apps from a clean teardown — every cold cycle now reaches healthy on a
fresh container without manual `sui client switch`. **Doc updates:** None —
`docs/devstack-design-proposal.md` doesn't speak to which `--build-env` the helper passes. Worth a
sentence in the P12 helper-reference pass.

### 2026-04-29 — reconciler failure isolation

**Affects:** P1 (reconciler) — closing a §9.1 gap missed at P1 tag time. **Found:** Design proposal
§9.1 says "Failure isolates. A failed action's dependents stay queued, not failed." The P1
reconciler rethrows on action failure, aborting the cycle — so independent peers later in topo order
also don't run. The smoke test ran two actions in a chain (publish → emit) where the first never
failed, masking the gap. **Decision:** `Reconciler.cycle` now catches around each `evaluateAndRun`,
marks the action `failed`, and skips any action whose `needs` includes a failed name (status
`queued`). Independent peers continue. Errors are reported via a new `failures: Map<string, Error>`
on `ReconcileResult`; the supervisor renders them in the status block. Cycle no longer throws on
action failure — it throws only on contract bugs (cycle, duplicate name, unknown dep). **Doc
updates:** None — design doc already covers this; code now matches.

---

## Paper sketches (pre-phase)

> For phases where a paper sketch is mandated (currently: P8 wallet action graph). Live below before
> starting the phase.

### P8 — wallet + token-studio action graphs (sketched 2026-04-30)

**Token-studio** (single Move package, no seeds, no imports):

```
sui.{build,localnet,accounts}             ← sui plugin (publisher, alice, bob, carol)
tokenStudio.managedCoin (Publish)         ← needs:[sui.accounts] path:./move/managed_coin
                                            capture:{treasuryCapId, metadataId, upgradeCapId}
                                            run: publishMovePackage; register packages.managed_coin
                                                 + tokens.studio{type,decimals:6}
                                            getStatus: prior pkg on chain (matches arena pattern)
```

**Wallet** (3 publishes + 1 import + 3 seeds):

```
sui.{build,localnet,accounts}             ← sui plugin (publisher, alice, bob, carol)

wallet.usdc      (Publish)  needs:[sui.accounts]    ./move/mock_usdc
                                                    register packages.mock_usdc + tokens.musdc
wallet.weth      (Publish)  needs:[sui.accounts]    ./move/mock_weth
                                                    register packages.mock_weth + tokens.mweth
wallet.deepbook  (Publish)  needs:[sui.accounts]    importMovePackage(MystenLabs/deepbookv3@v7.0.0/packages/deepbook)
                                                    capture:{registryId, adminCapId}
                                                    register packages.deepbook (+ deps:{deep:<auto-pub-id>})
                                                    getStatus: pkg + dep both on chain

wallet.seedTokens (Seed)    needs:[wallet.usdc, wallet.weth]
                                                    mint usdc 25k/10k/5k + weth 1.0/0.5/0.2 → alice/bob/carol
                                                    getStatus: alice's balances ≥ seeded amounts on chain
wallet.seedPools  (Seed)    needs:[wallet.deepbook, wallet.usdc, wallet.weth]
                                                    init registry + create_pool_admin sui_usdc + sui_weth
                                                    register wallet.pools.{sui_usdc, sui_weth} (namespaced kind)
                                                    getStatus: cached pool IDs still on chain (correct ::pool::Pool<B,Q> type)
wallet.seedOrders (Seed)    needs:[wallet.seedPools, wallet.seedTokens]
                                                    alice: new BM + deposit SUI/USDC/WETH + 6 limit orders/pool
                                                    register wallet.balanceManager (namespaced kind)
                                                    getStatus: cached BM still on chain owned by alice
```

**Shared helper** `packages/devstack/src/helpers/imported-package.ts` (placement matches
`helpers/move-package.ts`; tracker text says `src/plugins/imported-package.ts`, but `helpers/` is
consistent with the existing precedent — flagged in commit message). Ports v1
`deploy/steps/import.ts`: clone → docker cp →
`sui client test-publish --build-env localnet --pubfile-path … --with-unpublished-dependencies --json`
→ parse `published` changes (last = target, earlier = auto-pub deps). Source-digest gate keys on
`rev` (git is content-addressable, no need to hash files).

**Contract verdict:** holds. Existing `Publish`/`Seed` action factories cover everything; the seed
actions register both core kinds (`tokens`) and namespaced kinds (`wallet.pools`,
`wallet.balanceManager`) without needing new types. The `imported-package` helper lives in
`helpers/`, not as a new plugin — apps call it from inside their own `Publish` action's `run`.

---

## Cold-clone test log

> After each app port (P5, P8, P9), record a fresh-worktree run.

_(none yet)_

---

## Deferred / out-of-scope (locked)

- npm publish (Q9 — `private: true` stays through P12; bump version to `1.0.0-rc.1` only)
- v1 → v2 codemod for app authors (Q9 — clean break; apps rewritten in P5/P8/P9)
- Provider abstraction (Q7 — Docker only; revisit on second-provider evidence)
- Fork-from-mainnet (Q13 — friction-journal entry only; needs upstream Sui changes)
- Web UI like Tilt's (Q on TUI — terminal status block is the agreed level)
- v1 → v2 manifest migration (Q9 — clean slate, error on v1 manifests)
