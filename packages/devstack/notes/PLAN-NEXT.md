# devstack — remaining work

Companion to `STATE.md` (current state) and `PLAN.md` (architecture).
Captures what's left, ordered by dependencies + user-visible impact.
Each chunk is sized roughly like the ones in commits ba4015b..758d16b
on `integrate-devstack` — substantial but bounded, with a clear "done"
criterion.

## Phase 5 — functional completion

What this unblocks: real walrus committee, real seal flow without
hand-supplied BLS keys, sui indexer/graphql, walrus.proxy. After
Phase 5 lands, devstack is a true superset of the old devstack's
running behavior.

### 5a — per-stack docker network primitive

New `dockerNetwork` runner that creates+owns a `<app>-<stack>` network
with a stable per-(app, stack) `/24` (deterministic-octet hash, same
formula the old devstack uses). `dockerContainer` and `dockerOneShot`
gain `network: string | Dep<string>`, `networkAlias: string`,
`ip?: string` config so plugins join the network as named DNS members.

- **Dependencies**: none (foundation for the rest of Phase 5).
- **Done when**: sui-localnet joins the network with alias
  `sui-localnet`; the walrus deploy container reaches it via the alias
  instead of `host.docker.internal`.

### 5b — seal image build via dockerImage

Vendor seal's Dockerfile under `src/plugins/seal/docker/` (downloads
`seal-cli` + `key-server` from the GitHub release — no compile, unlike
walrus). Wire `seal.image` and replace the
`mystenlabs/seal-key-server:latest` placeholder.  Mechanical port of
the sui/walrus image-build pattern.

- **Dependencies**: none.
- **Done when**: `seal({})` builds its image content-addressed and the
  key-server container chains it via `Dep<void, string>`.

### 5c — seal keygen via dockerOneShot

New `seal.keygen` producer running `seal-cli genkey` once via
`dockerOneShot`, parsing stdout for master + public BLS12-381 keys,
persisting under `<stackDir>/.keys/seal-master-key.json`. Output is
both a Dep (consumed by 5d) and a host file (consumed by the
key-server container's `MASTER_KEY` env).

- **Dependencies**: 5b (uses the seal image).
- **Done when**: `sealLocalnet({...})` no longer requires the caller
  to supply `publicKeyHex` — it consumes
  `keygen.get('publicKey')` instead.

### 5d — sui indexer-db + GraphQL

Postgres sidecar (`sui.indexer-db` via `dockerContainer` joining 5a's
network with alias `sui-indexer-db`); sui-localnet container args add
`--with-indexer=postgres://…sui-indexer-db…` + `--with-graphql=0.0.0.0:9125`.
Adds a `sui.get('graphql')` Dep returning the host URL.

- **Dependencies**: 5a (postgres alias on the per-stack network).
- **Done when**: `sui.get('graphql')` resolves and apps using
  `SuiGraphQLClient` against it work end-to-end.

### 5e — walrus committee on per-stack network

Storage-node containers get fixed IPs `10.<octet>.0.10..` and network
aliases `walrus-node-<i>.localhost`. Deploy container's
`WALRUS_LISTENING_IPS` switches from the current `0.0.0.0` placeholder
to the real IPs; `WALRUS_NETWORK` switches from `host.docker.internal`
to the in-network `sui-localnet:9000`.

- **Dependencies**: 5a.
- **Done when**: a 4-node walrus committee actually comes up and
  accepts blob writes against a real localnet.

### 5f — walrus.seedWal

A `runTransaction` (or thin `define()` if extra deps are needed) over
the WAL exchange — small Move call swapping SUI for WAL on each
declared account. Direct port of old devstack's `walrus.seedWal`.

- **Dependencies**: signer Dep + sui rpc Dep + walrus.register's
  `exchangeObject` Dep.
- **Done when**: faucet'd accounts have WAL after `accounts.fund`.

### 5g — walrus.proxy nginx vhost

`dockerContainer` running nginx with a generated config fronting all
storage nodes on a single host port via Host-header vhost routing.
Direct port from old devstack.

- **Dependencies**: 5e (committee on per-stack network).
- **Done when**: the SDK can talk to all walrus nodes through one
  host port.

## Phase 6 — depth + integration tests

### 6a — docker-commit snapshots

`dockerContainer.snapshot:` config (`commit: true | false`,
`quiesce: 'pause' | 'stop' | 'none'`); on snapshot save, the runner
pauses + commits the container to a tag captured into snapshot state;
on restore, the container starts from that tag instead of the
original image. Restores chain state across `docker rm`.

- **Dependencies**: 5a (committed images sit on per-stack labels for
  GC).
- **Done when**: `snapshot save` + `reset --purge` + `snapshot
  restore` returns a working sui+walrus localnet without re-deploying.

### 6b — end-to-end docker-gated integration tests

Real sui + walrus committee bring-up; real publish via
`deepbookLocalnet` / `sealLocalnet`; real pool creation. Gated like
the existing docker-image tests (`itDocker`).

- **Dependencies**: Phase 5 + 6a.
- **Done when**: `pnpm test --run integration` exercises the happy
  path with all plugins live.

## Phase 7 — release shape

Devstack stays a single package; plugins ship as subpath exports
(`@mysten-incubation/devstack/plugins`). No per-plugin package split.

7b (examples cutover) and 7c (README + migration + rc) both shipped —
five examples + the create-devstack-app scaffold are on devstack,
along with the supporting `walletApp` / `registerCoin` /
`deepbookMarketMaker` plugin ports, the `Endpoint.pairUrl` /
`Package.captured` / `manifest.extras` shape extensions, and the
`/react` subpath helpers. Old `packages/devstack-a/` stays in the tree
(intentionally — both manifests are supported by the dev-wallet
adapter and the panels for migrating consumers).

## Smaller polish (ad-hoc, no specific phase)

- Snapshot pruning / GC for old per-stack `<id>-<label>.json` files
  (capture-and-restore pile up over a long dev session).
- More signer flavors as consumers ask (multisig, zkLogin). Explicitly
  not on the critical path.
- `runTransaction.deps` already landed earlier; deepbook-pools could
  fold back from raw `define()` to the helper if a future cleanup pass
  wants the consistency.

## Recommended sequencing

```
5a ──┬── 5d
     ├── 5e ── 5f
     │       └─ 5g
     └── (5b ── 5c) (parallel; independent of 5a)
            ↓
            sealLocalnet upgraded

5{a-g} ── 6a ── 6b ── 7b ── 7c     (all shipped)
```

5a was the keystone — Phase 5 + 6 + 7 all complete.

## What's explicitly NOT in this plan

- Cross-stack networking (multi-stack peer-to-peer). Stacks stay
  isolated; the per-stack network in 5a only joins members within
  one stack.
- Live-net (testnet/mainnet) deploy automation for `sealLocalnet` /
  `deepbookLocalnet`. They're explicitly localnet-only by name; live
  deploys go through the host sui CLI today.
- A JSON manifest writer. The `manifest` plugin emits typed TS;
  `snapshot.json` is the inter-process state of record.
- Removing the old `packages/devstack-a/` until 7b lands and consumers
  cut over.
