# Private-content example

**Verdict**: B+ — Believable as a demo, thin as a product. Densest stress-test of the devstack stack (sui + walrus + seal + custom Move + codegen + walletServer + vite + dev-wallet). Several real-product gaps in the access-control story.

## Architecture

The app threads four runtime services (Sui, Walrus, Seal key server, wallet-server) and one custom Move package through the devstack API with surprisingly little glue. `devstack.config.ts` (43 lines) lists `[sui, walrus, seal, privateContentPlugin, codegen, walletServer, vite]` — the plugin DAG handles ordering. The custom `privateContentPlugin` is a 10-line plugin definition with one `definePublishAction({ name: 'vault', needs: ['sui.accounts'] })`. Notably, vault has no `use seal::...` import; Seal access control is purely client-side through `SessionKey + seal_approve` dry-run, so the publish only needs accounts, not a seal-bootstrap dep.

`main.tsx` augments `DevstackPackageRegistry` with `vault` types via TS module declaration — a clean pattern for end-app extension of devstack's typed package registry. `App.tsx` uses `useDevstackDeployed({ requirePackages: ['vault'] })` as the gate between "no localnet" and "ready" states. Components consume `useDevstackPackage('vault')` for typed Move calls and `useDevstackSignAndExecute` for the wallet round-trip with `invalidateKeys: [['vault']]` for cache busting.

The Walrus + Seal integration is the cleanest demo of devstack's "browser-reachable services" pattern. `lib/walrus.ts:25` uses `createDevstackWalrusClient({ manifest, suiClient, wasmUrl })` — that helper installs a fetch override translating committee URLs from internal Docker IPs to the host-mapped nginx proxy. WASM is loaded with Vite's `?url` import to avoid SPA fallback returning `index.html`. `lib/seal.ts:18` builds a SealClient pinned to `deployment.seal.keyServerObjectId` with `verifyKeyServers: false` (acceptable for self-signed localnet single-server Open mode).

The decrypt flow is textbook: random `freshSealId` → SessionKey + `signPersonalMessage` via dAppKit → onlyTransactionKind tx with `seal_approve(id, file)` → `seal.decrypt`. Move policy fn at `vault.move:100` asserts `table::contains(authorized, sender) && id == file.seal_id` — pure shared-object inputs, which the comment correctly notes is what Seal's onlyTransactionKind dry-run supports.

## Problem fit

Believable as a demo, thin as a product. **Strengths**: shared `File` + owned `Cap` split is correct (Caps are UI-iteration hints; security lives in `authorized` table). Allowlist pattern matches MystenLabs/seal/move/patterns/whitelist.move. **Weaknesses for a real product**:

- **No revocation** (table only has `add`, no `remove`).
- **No key rotation** — `seal_id` is bound forever, so revocation would still let revoked holders decrypt cached blobs.
- **Single key server, threshold=1** in Open mode (no real MPC, no failover).
- **No file metadata beyond name** (no MIME, size, content-hash, version).
- **No chunking** — entire ciphertext is `vector<u8>` round-tripped through walrus.
- **`seal_id` is publicly visible on-chain** which is fine cryptographically but breaks "is this the same file as before" privacy.
- **`Cap` is `key + store`, freely transferable**, but transferring it doesn't actually grant decrypt rights (only `grant` does) — exactly the kind of UX trap that bites users.

## Integration

This example exercises more of the devstack stack than any other in the repo: `sui` + `walrus` + `seal` + custom Move publish + `codegen` + `walletServer` + `vite` + the Playwright `connectAs` adapter. The Seal key-server stack `[sui, walrus, seal]` runs in parallel with vault publish (since vault doesn't import seal). The walrus `?url` WASM dance and the fetch override are the two most non-trivial integration concerns and both are encapsulated by `createDevstackWalrusClient`.

## Customizability + gaps

Two friction marks: `lib/format.ts:1` flags "third copy" of `shortAddress` — pending the planned `@mysten-incubation/ui` package. `Card.tsx:3` is a third copy of the same primitive. The `CurrentAccountSigner` cast in `UploadForm.tsx:25` is awkward — phantom-typed `DAppKit<[]>` constructor mismatch with the typed-network dAppKit. The result-extraction shape `{ Transaction?: { digest? } | FailedTransaction? }` is repeated in `UploadForm.tsx:65` and `GrantForm.tsx:41`; should be a helper. `blobIdToBytes`/`bytesToBlobId` (URL-safe base64 ↔ 32-byte) are app-level concerns that arguably belong in a `@mysten/walrus` utility — their absence is a real gap.

## Testing

`e2e/seal-flow.spec.ts` covers the happy path well: alice upload + self-decrypt sanity-check, grant, fresh-load + `localStorage.clear()` for bob, bob decrypt. Smart touches: scraping the file id from the DOM to avoid the GrantForm picking a stale Cap from prior runs; console.error forwarding for flake debugging.

**Gaps**: no negative paths — bob without cap should fail decrypt with a recognizable error; SessionKey ttl expiry (`ttlMin: 10`) is untested; `seal_approve` `EWrongSealId` branch is untested (would need a corrupted `seal_id`); walrus blob-not-found path; double-grant (no-op) is untested; non-owner attempting `grant_entry` (hits `ENotOwner`) is untested. Vitest config exists but no actual unit tests — `lib/format` arithmetic and `blobIdToBytes` round-trip are obvious targets.

## Top recommendations

1. **Add negative-path e2e tests** — bob without cap, expired session key, EWrongSealId.
2. **Lift `shortAddress`/`labelFor`/`Card`** out of the example into a shared package.
3. **Lift `blobIdToBytes`/`bytesToBlobId`** into `@mysten/walrus` utilities (or `@mysten-incubation/devstack/walrus`).
4. **Document the Cap-vs-authorized-table footgun** in a comment or example doc — transferring a Cap looks like granting access but isn't.
5. **Add unit tests** for `lib/format` arithmetic and `blobIdToBytes` round-trip.
