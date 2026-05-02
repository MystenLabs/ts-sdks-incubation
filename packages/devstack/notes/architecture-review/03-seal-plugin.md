# Seal plugin

**Verdict**: A− — Strong, with one structural omission worth calling out. The cleanest demonstration in the devstack of the build-then-extract pattern paying off.

## Architecture

Four linear actions gated by the reconciler: `seal.build → seal.publish → seal.register → seal.key-server`. The image build is pure BuildKit: `--build-context seal-src=https://github.com/MystenLabs/seal.git#<rev>` fetches the seal repo without ever touching the host filesystem (`build.ts:62`). The Dockerfile (`Dockerfile:27`) `COPY --from=seal-src` pulls source for both the `key-server` and `seal-cli` Rust binaries plus stages `move/seal` at `/opt/seal/move-package` for later extraction. Multi-arch native build avoids the Rosetta perf hit upstream's `mainnet` image would impose on M-series.

`seal.register` does the structurally-interesting work: it shells `seal-cli genkey` inside the image to mint a BLS12-381 master key, caches it on host disk under `.devstack/stacks/<stack>/.keys/seal-master-key.json`, then sends a `key_server::create_and_transfer_v2_independent_server` Move call to bind the public key to a freshly-created `KeyServer` object on the local sui chain. Object id flows back through `objectChanges` and into `registry.ns<SealNamespace>('seal').keyServer.register(...)`. A generated YAML at `.generated/seal-config.yaml` (network: `!Devnet` pointing `node_url` at `http://sui-localnet:9000`, `server_mode: !Open`) is mounted into the container at `/etc/seal/key-server-config.yaml` — the comment at `index.ts:319` notes the env-only mode silently routes traffic at the public devnet fullnode, which is exactly the kind of failure mode that justifies a generated file. The container joins the per-app docker network so the `node_url` alias resolves.

## Problem fit

Yes — this is a believable seal dev experience. The frontend `SessionKey.create → signPersonalMessage → seal_approve dry-run → SealClient.decrypt` flow exercised in `examples/private-content` works end-to-end against the local key server. The `entry fun seal_approve(id, file, ctx)` policy in `vault.move:100` uses only shared-object refs + `ctx.sender()`, which is what Seal's `onlyTransactionKind` dry-run actually supports — the comment in `vault.move:30` makes that constraint explicit. Capability-gated decryption via the `Cap` hint object + `authorized` table lookup is idiomatic. The threshold-1 single-server mode means apps can't *test* threshold semantics, but they can prototype every other primitive (encrypt, IBE id binding, session keys, on-chain policy gating).

## Integration

The `prepareSource` mechanism on `definePublishAction` is the right hook: it lets seal supply a Move package whose source lives inside an image rather than on disk, with proper cleanup. `extractUpstreamSource` does this generically via `docker create` + `docker cp`. The manifest namespace works through `Registry.ns<SealNamespace>('seal')`, gets serialized into `manifest.json#registry.seal.keyServer[]`, and read by `examples/private-content/src/generated/deployment.ts:14` — the round-trip is typed end-to-end on the consumer side (`SealView`). Frontend `lib/seal.ts:8` correctly sets `SEAL_THRESHOLD = 1` and `verifyKeyServers: false` because the SDK has no way to verify a self-signed dev key.

## Customizability + gaps

`SealPluginOptions` exposes only `rev` and `apiPort`. Notable absences:

1. **No multi-key-server mode.** The plugin assumes a single `KeyServer` and `SEAL_THRESHOLD = 1`, hardcoded both in plugin (`SEAL_KEY_SERVER_NAME = 'devstack-local'`) and consumer. To exercise threshold-2-of-3, a developer would need to fork the plugin.
2. **No Permissioned mode.** `server_mode: !Open` is hardcoded in `writeSealConfigYaml`. Permissioned mode would require a master-key-share registration flow that doesn't exist.
3. **Master key is a fresh `seal-cli genkey` per stack**, with no override. Reproducing a known identity across stacks for golden-test scenarios isn't possible.
4. **No `_seal` proxy is needed**, correctly. Walrus needs `_walrus` because nodes register internal `https://10.0.0.x` URLs in committee data + use self-signed certs; seal's key-server has no on-chain URL committee, just a single `keyServerUrl` the plugin chose, so the browser can hit `127.0.0.1:2024` directly. The asymmetry is a feature.

The healthcheck (`index.ts:332`) hard-codes `Client-Sdk-Version: 0.4.18` — a quiet coupling to the consumer SDK version that will rot if the SDK middleware tightens its check.

## Testing

**Zero unit tests for the plugin itself.** The seal plugin contains pure-ish helpers (`decodePrefixedHex`, `writeSealConfigYaml`, the genkey-output parser, `getStatus`'s staleness checks) that are each plausibly unit-testable, and none have coverage. Compare to the imports plugin (`move-toml.test.ts`, `index.test.ts`, `resolve.test.ts`). The e2e at `examples/private-content/e2e/seal-flow.spec.ts` is excellent (real Vite, real chain, real walrus, real key server, alice→bob grant flow), but it can only catch end-of-pipeline regressions.

## Top recommendations

1. **Add `seal/index.test.ts`** covering `getStatus`'s four invalidation branches, `decodePrefixedHex`, `writeSealConfigYaml` output stability, and the `seal-cli genkey` parser. Mirror `actions/publish.test.ts`.
2. **Pull the SDK version pin out of the healthcheck** into a `SEAL_SDK_VERSION` constant alongside `SEAL_REV`, with a comment cross-referencing the upstream `version_validation.rs` middleware. Today it's buried in a shell-string at `index.ts:337`.
3. **Surface `keyServerName` and a `master?: { masterKey, publicKey }` override in `SealPluginOptions`** so an app can pin a known identity for golden tests (and to remove the magic string `'devstack-local'`).
4. **Document the multi-key-server gap** in either the plugin doc-comment or `docs/`. Right now `SealKeyServer.publicKey` is captured but never exposed via `SealView` on the consumer; the registry shape suggests an array, the consumer reads `[0]`, and there is no path to populate `[1..]`.
5. **Consider exposing `serverMode: 'Open' | 'Permissioned'`** as a future-facing option, even if Permissioned isn't wired yet — at minimum block construction with a clear "not yet supported" error so the absence is discoverable from the plugin signature, not from reading source.
