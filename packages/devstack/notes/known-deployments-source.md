# Known deployments — source tracking

Companion to `src/internal/known-deployments.ts`. Records where each pinned
address came from and how to re-verify on each release.

Last updated: **2026-05-13**

## Process for updating

On each release, walk the table below in order:

1. Re-check the upstream source listed for each `(service, network)` cell.
2. If the value has changed, update `src/internal/known-deployments.ts` AND bump
   the "verified" date in the table here.
3. Add a changeset entry describing the bump so downstream consumers can pin to
   the correct registry snapshot.

## Sources

### DeepBook

| Network | Source                                                                    | Verified   |
| ------- | ------------------------------------------------------------------------- | ---------- |
| testnet | `packages/devstack/src/plugins/deepbook.ts` (orig: `@mysten/deepbook-v3`) | 2026-05-13 |
| mainnet | `packages/devstack/src/plugins/deepbook.ts` (orig: `@mysten/deepbook-v3`) | 2026-05-13 |
| devnet  | n/a — no canonical deployment                                             | n/a        |

Verification: cross-reference `@mysten/deepbook-v3/utils/constants.ts` in the
SDK at the matching release tag, or query the on-chain registry object via
`sui client object <REGISTRY_ID>`.

### Walrus

Source of truth for the on-chain ids is the upstream SDK at
`@mysten/walrus/src/constants.ts` — specifically `TESTNET_WALRUS_PACKAGE_CONFIG`
and `MAINNET_WALRUS_PACKAGE_CONFIG`. Verified against the sibling ts-sdks
checkout at `/Users/michaelhayes/code/ts-sdks/packages/walrus/src/constants.ts`.

| Network | Field              | Source                                                                       | Verified   |
| ------- | ------------------ | ---------------------------------------------------------------------------- | ---------- |
| testnet | systemObjectId     | `@mysten/walrus` `TESTNET_WALRUS_PACKAGE_CONFIG.systemObjectId`              | 2026-05-13 |
| testnet | stakingPoolId      | `@mysten/walrus` `TESTNET_WALRUS_PACKAGE_CONFIG.stakingPoolId`               | 2026-05-13 |
| testnet | exchangeIds (×4)   | `@mysten/walrus` `TESTNET_WALRUS_PACKAGE_CONFIG.exchangeIds`                 | 2026-05-13 |
| testnet | subsidiesPackageId | n/a — SDK doesn't surface a hardcoded value; left `undefined`                | n/a        |
| testnet | nodes              | n/a — committee fetched dynamically by SDK; caller-supplied at factory time | n/a        |
| testnet | aggregatorUrl      | upstream seal example `vercel.json` rewrites                                 | 2026-05-13 |
| testnet | publisherUrl       | upstream seal example `vercel.json` rewrites                                 | 2026-05-13 |
| mainnet | systemObjectId     | `@mysten/walrus` `MAINNET_WALRUS_PACKAGE_CONFIG.systemObjectId`              | 2026-05-13 |
| mainnet | stakingPoolId      | `@mysten/walrus` `MAINNET_WALRUS_PACKAGE_CONFIG.stakingPoolId`               | 2026-05-13 |
| mainnet | exchangeIds        | n/a — mainnet config doesn't expose `exchangeIds` in the SDK                | n/a        |
| mainnet | subsidiesPackageId | n/a — SDK doesn't surface a hardcoded value; left `undefined`                | n/a        |
| mainnet | nodes              | n/a — committee fetched dynamically by SDK; caller-supplied at factory time | n/a        |
| mainnet | aggregatorUrl      | upstream walrus docs (`https://docs.walrus.site/`)                           | 2026-05-13 |
| mainnet | publisherUrl       | upstream walrus docs                                                         | 2026-05-13 |
| devnet  | —                  | n/a — walrus has no canonical devnet                                         | n/a        |

The interface schema deliberately matches the SDK's `WalrusPackageConfig` shape
(`systemObjectId` not `systemPackageId`) — the SDK derives the actual Move
package id at runtime from the system object's type via on-chain query, so we
don't carry a separate `packageId`.

`subsidiesPackageId` stays `undefined` for both registered networks. Subsidies
is an admin/governance concern and the SDK does not pin a hardcoded value;
typical blob-read/write consumers never need it.

`nodes` is optional in the registry. Testnet has 100+ committee members and
the upstream SDK fetches them dynamically from the staking pool — there's no
static list worth pinning. `walrusKnownDeployment({ network, ...})` requires
callers to either pass `nodes: [...]` explicitly or fall back to
`walrusLocalCluster()` for local testing; calling it without `nodes` against
a registered network throws synchronously at factory time.

### Seal

| Network | Field             | Source                                                                                                                | Verified   |
| ------- | ----------------- | --------------------------------------------------------------------------------------------------------------------- | ---------- |
| testnet | keyServerObjectId | `examples/private-content/.devstack/imports/mystenlabs_seal@seal-v0.6.6/docs/content/Pricing.mdx` (`mysten-testnet-1`) | 2026-05-13 |
| testnet | keyServerUrl      | same source as `keyServerObjectId`                                                                                    | 2026-05-13 |
| mainnet | —                 | n/a — Mysten only offers Seal mainnet via Enoki signup; no public default tuple to pin (2026-05-13)                  | n/a        |
| devnet  | —                 | n/a                                                                                                                   | n/a        |

The schema deliberately omits a `publicKey` field. The upstream `@mysten/seal`
client retrieves the BLS12-381 public key dynamically from
`<keyServerUrl>/v1/service` via `retrieveKeyServers(...)`, so pinning a value
in the static registry would be misleading. Consumers that need to verify the
public key should fetch it from the server at runtime.

Verification re-run: re-read `Pricing.mdx` at the latest seal release tag and
cross-check that `mysten-testnet-1`'s object id + URL are unchanged.

## Outstanding gaps

| Service  | Network | Field(s)              | Note                                                                                                                          |
| -------- | ------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| seal     | mainnet | entire entry          | Mysten only offers mainnet seal access via Enoki signup; no canonical default. Add an entry only when a public default exists. |
| deepbook | devnet  | entire entry          | No canonical devnet deepbook deployment; consumers publish via the localnet primitive.                                         |

No other fields are placeholders. The historical `'0x0'` stubs for walrus
`systemPackageId` and seal `publicKey` are gone: `systemPackageId` was renamed
to `systemObjectId` and filled from `@mysten/walrus`; `publicKey` was removed
from the seal shape entirely.

## Verified 2026-05-13

- Walrus testnet + mainnet: schema migrated from `systemPackageId` (Move
  package id, not surfaced by the SDK) to `systemObjectId` (System object id,
  directly available in `WalrusPackageConfig`). Filled `systemObjectId`,
  `stakingPoolId`, and (testnet only) `exchangeIds` from
  `@mysten/walrus/src/constants.ts`. `subsidiesPackageId` stays `undefined`
  on both — not in the SDK. `nodes` made optional + caller-supplied at
  factory time (testnet has 100+, dynamically fetched).
- Seal: removed `publicKey` field from `SealDeployment` (the SDK retrieves
  it dynamically from `/v1/service`). Testnet `keyServerObjectId` +
  `keyServerUrl` unchanged.
- DeepBook testnet + mainnet: unchanged.
