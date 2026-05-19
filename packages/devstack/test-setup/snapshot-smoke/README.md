# Snapshot smoke playbook

Per-plugin save → wipe → restore runbooks. Each verifies that a snapshot taken with a given service
active actually restores that service's state.

The vitest suite at `packages/devstack/src/engine/snapshot.test.ts` covers the engine layer
(state.json, runtime/ tar, extras, mode bits) against a mocked filesystem; **these playbooks cover
the live system end-to-end** — Docker containers, on-chain state, real upstream tools. They're the
test surface that should have caught the original v4 snapshot regressions but didn't, because no
such surface existed.

## Prereqs

- Docker daemon running.
- `pnpm install` and `pnpm turbo build` are up to date.
- A fresh `.devstack/` for each plugin (or run `pnpm devstack wipe --yes` between plugin runs).

## Running

Each plugin has a documented runbook below. The shape is the same for every one:

1. Bring up the example app (`pnpm dev` in `examples/<app>`).
2. Drive some side-effect that produces persistent state (transfer, blob, pool, etc.) and record the
   observable.
3. `pnpm devstack snapshot save <label>` in the example dir.
4. Tear down: `Ctrl-C` the supervisor, then `pnpm devstack wipe --yes` to discard the writable
   layer + named volumes.
5. `pnpm devstack snapshot restore <label>`.
6. Bring the example back up. Assert the observable from step 2 is identical (same balance, same
   blob contents, same pool ids, same addresses).

If step 6 sees a regenesised chain / fresh keys / missing artifacts, the plugin's snapshot path is
broken — open a bug pointing at the specific runbook step.

---

## A. sui localnet (chain state)

**Example:** `examples/arena` or `examples/wallet`. Any app with a sui-localnet primitive works.

1. `cd examples/arena && pnpm dev`. Wait for the TUI to show all rows green.
2. From a second shell:
   ```
   curl -s -X POST http://localhost:9123/v1/gas \
     -H 'content-type: application/json' \
     -d '{"FixedAmountRequest":{"recipient":"0xalice..."}}'
   ```
   (Use a real funded alice address from `cat .devstack/stacks/main/runtime/accounts/alice.key` and
   derive its address, or use the in-TUI account list.) Record alice's balance via:
   ```
   curl -s http://localhost:9000 -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"suix_getBalance","params":["0xalice..."]}'
   ```
3. `pnpm devstack snapshot save sui-checkpoint`.
4. `Ctrl-C` the supervisor. `pnpm devstack wipe --yes`.
5. `pnpm devstack snapshot restore sui-checkpoint`.
6. `pnpm dev` again. Re-run the balance query. **Assert: identical balance.** The chainId in the
   manifest should also be identical to step 2 — confirming the localnet is the same chain, not a
   regenesised sibling.

**What this catches:** the original v4 regression — named-volume mounts meant `docker commit`
captured an empty writable layer. After this runbook, the writable-layer flip +
`docker commit + save` of `sui.localnet` guarantees the RocksDB is in the snapshot.

---

## B. walrus (deploy outputs + chain state)

**Example:** `examples/private-content`.

1. `cd examples/private-content && pnpm dev`. Wait for all rows green, especially
   `walrusLocalCluster`.
2. Store a blob via the example UI or:
   ```
   walrus --config <network-config> store <some-file>
   ```
   Record the blob id.
3. Snapshot:
   ```
   pnpm devstack snapshot save walrus-checkpoint
   ```
4. Tear down + wipe (`Ctrl-C`, then `pnpm devstack wipe --yes`).
5. Restore + boot:
   ```
   pnpm devstack snapshot restore walrus-checkpoint
   pnpm dev
   ```
6. Read the blob back. **Assert: same bytes.** Also verify in `.devstack/stacks/main/state.json`
   that `walrus/deploy/v1:...` entries are present (cache hit on warm start → no re-deploy).

**What this catches:** the walrus deploy outputs at `runtime/walrus/<name>/deploy/` MUST ride the
snapshot, and the state-store gate MUST prevent a re-deploy that would mint fresh node keys on top
of the chain-registered committee. Phase 3.4 added the "gate present but dir missing → fail loudly"
detector; this runbook also exercises the happy path.

---

## C. seal (master key + chain state)

**Example:** `examples/private-content`.

1. Boot. Wait for `seal.<name>` row to be ready.
2. Note the on-chain `KeyServer` pubkey:
   ```
   curl -s http://localhost:9000 -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"sui_getObject","params":["<key-server-object-id>"]}' \
     | jq '.result.data.content.fields.publicKey'
   ```
3. Encrypt + decrypt a payload via the example UI. Record both halves.
4. `snapshot save seal-checkpoint`. Tear down + wipe. Restore.
5. Boot again. Verify:
   - `cat .devstack/stacks/main/runtime/seal/master-key.env` matches the value from before (file
     owned by current user, mode 0o600).
   - The `KeyServer` pubkey on chain (step 2) is unchanged.
   - The encrypted payload from step 3 still decrypts to the same plaintext.

**What this catches:** the seal master-key.env must survive the round-trip — pre-Phase-3 the file
was unlinked on scope close, which would have made restore unable to start the key-server.

---

## D. deepbook full stack (pools + margin + indexer + server + pyth)

**Example:** `examples/deepbook-full` (P5.T0b — added in Phase 5 of the deepbook plugin expansion).
`examples/wallet` covers the simpler core-pools-only path; deepbook-full exercises every primitive.

1. Boot `examples/deepbook-full`. Wait for the deepbook market maker row + the indexer / server rows
   to be ready.
2. Note the full deepbook state surface:
   ```
   jq '.services.deepbook' .devstack/manifest.json
   ```
   This includes pool ids, indexer metrics URL, server REST URL, margin pool ids, and the registered
   pools list. Also note the pyth state:
   ```
   jq '.services.pyth' .devstack/manifest.json
   ```
3. Place a limit order via the Trading UI. Read the order book through `/ticker` to confirm the
   order landed. Mint 100 DEEP via the Mint UI; record alice's DEEP balance.
4. `snapshot save deepbook-full-checkpoint`. Tear down + wipe. Restore.
5. Boot again. Re-read the manifest's pool ids, indexer + server URLs, margin pool ids, and pyth
   state. **Assert: identical IDs** (state-store cache hit → no re-publish, no re-create on chain).
   The order book and minted DEEP balance from step 3 must also be preserved (chain state survived
   the snapshot cycle). The codegen-emitted `src/generated/deepbook-config.ts` must be byte-identical
   to the pre-snapshot version (P5.T10 in the plan).

---

## E. packages (Move publish cache)

**Example:** any with `Package(...)` refs (`arena`, `wallet`, etc.).

1. Boot. Note the published package IDs:
   ```
   jq '.packages' .devstack/manifest.json
   ```
2. Snapshot. Tear down + wipe. Restore.
3. Boot. Re-read the manifest's package IDs. **Assert: identical.** Cross-check by running
   `sui client object <packageId>` against the restored localnet — the package should still exist on
   chain.

---

## F. accounts (ephemeral keys)

**Example:** any with `Account(...)` refs.

1. Boot. Note the addresses + balances of alice, bob, etc. from the TUI's account section (or the
   wallet panel).
2. Snapshot. Tear down + wipe. Restore.
3. Boot. **Assert: same addresses** (key files restored verbatim) AND **same balances** (chain state
   restored). On-chain tx history should NOT include faucet requests in the second cycle — accounts
   should resume from cache without re-funding.

---

## G. dev wallet (token + dapp-kit pairing)

**Example:** any UI example with `Wallet(...)` ref.

1. Boot. Pair the dev wallet via the manifest's `pairUrl` (open in browser). Record the token by
   reading `.devstack/stacks/main/runtime/wallet/token`.
2. Sign a transaction via the paired flow — observe success.
3. Snapshot. Tear down + wipe. Restore.
4. Boot. The same paired session in the browser should still work (no re-pair UX). The token file
   should be identical.

**What this catches:** the wallet token used to be re-minted every boot. Phase 3.3 added
read-existing-or-mint so snapshot restore preserves the pairing.

---

## H. dapp-kit + codegen (deterministic outputs, no persistent state)

**Example:** any UI example.

1. Boot. Note the codegen output hash:
   ```
   find src/devstack -type f -name '*.ts' -exec sha256sum {} + | sort | sha256sum
   ```
2. Snapshot (the codegen output is NOT in the snapshot — it's deterministic from the manifest, so a
   restore re-emits it).
3. Tear down + wipe. Restore. Boot.
4. Re-run the hash. **Assert: identical** (same on-chain packageIds in → same bindings out).

**What this catches:** codegen output must remain stable across the restore — anything that re-emits
to a different shape on identical inputs indicates a non-determinism bug in the emitter.

---

## CI integration

Phase 4.3 wires runbook A (sui) plus one of {B, C, D} into a new
`.github/workflows/devstack-e2e.yml` that runs on every PR. The runner uploads the snapshot tarball
as a build artifact when the run goes red so the failure can be reproduced locally by extracting it.

See that workflow for the canonical "minimal end-to-end smoke" that PRs must pass — anything richer
(full 8-plugin matrix) belongs in a manual nightly run.

## Migration note (one-time)

If you have a `.devstack/` directory created by a pre-Phase-3 build, the new code uses different
paths for service runtime state:

| Service         | Pre-Phase-3                                     | Phase 3+                        |
| --------------- | ----------------------------------------------- | ------------------------------- |
| Account keys    | `.devstack/stacks/<stack>/.keys/<name>.key`     | `runtime/accounts/<name>.key`   |
| Seal master-key | `.devstack/stacks/<stack>/.seal/master-key.env` | `runtime/seal/master-key.env`   |
| Wallet token    | `.devstack/stacks/<stack>/wallet.token`         | `runtime/wallet/token`          |
| Walrus deploy   | `.devstack/walrus/<stack>/<name>/deploy/`       | `runtime/walrus/<name>/deploy/` |

The old locations become orphaned but are harmless — they just sit on disk. Run
`pnpm devstack wipe --yes` once to clean up; the next boot mints fresh keys/tokens under the new
paths. (We don't ship a migrate- in-place shim because the project is pre-publish — see AGENTS.md.)
