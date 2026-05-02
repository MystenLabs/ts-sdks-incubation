# Walrus plugin

**Verdict**: B — A solid, deliberately divergent localnet that gets `@mysten/walrus` working in a browser, with a few load-bearing workarounds that need owner notes more than rewrites.

## Architecture

The 7-action graph (`network`, `build`, `deploy`, `node-{0..3}`, `proxy`, `register`, `seedWal`) decomposes the upstream `local-testbed/docker-compose.yaml` along devstack's reconciliation grain — each unit has a meaningful `getStatus`, `needs` are explicit, and idempotence lives where it can be cheaply checked (`exited(0)` for deploy, `running+healthy` for nodes, registry shape for register). The `walrus.network` action's `provides: ['walrus.app-network']` paired with sui's `needs: ['walrus.app-network:before']` is a clean way to express "if walrus is loaded, run this first" without coupling the sui plugin to walrus — and the topo test in `runtime/topo.test.ts:95-107` even covers it.

The fixed-IP design (`10.0.0.10–13` + `dryrun-node-{0..3}` hostnames) is forced by walrus's testbed: the on-chain committee data bakes node URLs into `system_object`, so the IPs/hostnames have to be deterministic at deploy time. Pinning the docker subnet at 10.0.0.0/24 is the right way to keep that working without forking upstream scripts.

The wrapper-Dockerfile-as-string in `build.ts` is unusual but justified — tsup doesn't copy non-source assets, and the only wrapper-level customization is one `sed` injection of `--with-wal-exchange`. Two-stage tags (`<rev>-upstream` cached + `<rev>-r1` wrapper) means iterating on the wrapper doesn't trigger a 10-minute Rust rebuild.

The nginx sidecar terminating self-signed TLS is the genuinely brittle bit — see Top Recommendations.

## Problem fit

For "upload a blob from a browser tab" this is a believable localnet. The seedWal flow correctly routes through the `wal_exchange` package discovered from the chain (rather than hardcoding an address), funds every devstack-declared account, and gets unblocked by the `--with-wal-exchange` injection in the wrapper. After the recent sui-pruning fix, nodes don't strand on `Checkpoint <N> not found`.

What's not modeled at all: epoch transitions (single committee, single epoch lifetime), blob deletion semantics, node recovery, node restaking, or shard reassignment. For dapps that just want to upload/download, that's fine; for anyone testing walrus protocol behavior, this is a happy-path simulator.

## Integration

Sui dependency is well-bounded: subnet pin via the capability handshake, sui binary shared via `<app>-<stack>-sui-bin` named volume into `/root/sui_bin`, and DNS via the `sui-localnet` alias the sui plugin registers. Three concrete couplings, all visible in `index.ts:60` (`appNetworkName`/sui imports) and `index.ts:300` (volume mount).

`createDevstackWalrusClient` (`react/walrus.ts`) is the cleanest piece: read manifest → assert `walrus` package + nodes → install a fetch override that prefix-rewrites `apiUrl → hostApiUrl`. The override correctly handles `Request` objects (rebuilds since `Request.url` is read-only). The dual URL on each `WalrusNode` (`apiUrl` for committee data, `hostApiUrl` for browser fetches) is the right shape for an authoritative on-chain registry plus a side-channel browser tunnel.

## Customizability + gaps

- `rev` is overrideable; the stable cache tag scheme means bumps are cheap.
- `nodeHostPortBase` is the only host-port knob — fine for one stack, but two stacks of the same app will collide (proxy publishes the same `19185-19188` host ports). No port-allocator coordination.
- No aggregator/publisher daemon — the SDK speaks the storage protocol directly, but anyone porting an existing app off public aggregators won't find the legacy HTTP path.
- `n_shards` and committee size are baked into upstream `deploy-walrus.sh`; not surfaced.
- Persistent state across container removal works for `deploy-outputs` (named volume) but the proxy config regenerates from `.generated/` each up.
- The pre-existing "walrus-deploy non-idempotent" bug is closed by the M5.1 stack-already-healthy short-circuit (`reconcile.ts`), not by fixing the deploy script — re-running on a wiped volume re-mutates `Move.toml` inside the image and fails. The current safety net is the `exited(0)` getStatus check; if anything ever invalidates it, the mutation lands.
- The comment in `index.ts:108` ("`_walrus/node-<idx>` proxy installed by `devstackVitePlugins()`") is stale: there is no such vite proxy. Browser reaches host ports directly. The wasmUrl claim ("auto-resolved from `virtual:devstack-walrus-wasm-url`") is also aspirational — `private-content` imports the wasm itself via `?url`. Two stale doc claims worth scrubbing.
- Build downloads `walrus-docs.git` (well, `MystenLabs/walrus.git`) at deploy time via BuildKit git context — fast on cache hit, but offline builds don't work and a dead repo would brick the plugin.

## Testing

Zero walrus-specific runtime coverage. `runtime/topo.test.ts:95-107` proves the capability ordering. No tests for `parseDeployFile`, `fetchWalCoinType`, `writeProxyConfig`, the fetch override, or the seedWal exchange-discovery path. A credible test suite: a unit test for `parseDeployFile` (regex-fragile, multiple optional fields), a unit test for `makeFetchOverride` (string/URL/Request input, prefix-only matching), a vitest with mocked fetch for `fetchWalCoinType`, and one full-stack e2e under `examples/private-content` that does upload + read back via the SDK against a real localnet stack (gated, slow, but the only thing that catches the nginx config drifting from the SDK's actual request shape).

## Top recommendations

1. **Replace the nginx sidecar with per-node host-port mappings on the storage container directly + a dev mode walrus-node flag (or wrapper) that binds plain HTTP locally.** The TLS-terminating reverse proxy exists only because walrus-node insists on self-signed HTTPS and browsers won't trust it. Pushing a `--insecure-listen` (or running stunnel inside each node) eliminates an entire container, removes the `proxy_request_buffering off / client_max_body_size 0` boilerplate, and removes the TLS-mismatch failure mode (where nodes are healthy but the proxy's upstream config is stale).
2. **Vendor `deploy-walrus.sh`/`run-walrus.sh` into `packages/devstack/src/plugins/walrus/scripts/` and copy them in via Dockerfile rather than via git build-context.** Fixes offline builds, removes the upstream-rename failure mode, lets the `--with-wal-exchange` patch be a real diff instead of a `sed` over a string we don't own, and gives you a place to put an idempotent guard on `Move.toml` mutation (closing the latent re-deploy bug at the source).
3. **Fix the two stale doc claims in `index.ts` (`_walrus/node-<idx>` proxy + `virtual:devstack-walrus-wasm-url`).** Either implement them (the wasm virtual module is a 5-line `resolveId`/`load` pair and removes one import line per consuming app) or delete the references. Right now they mislead future contributors about what the vite plugin actually does.
