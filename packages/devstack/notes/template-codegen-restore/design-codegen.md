# Codegen reshape — target design

Authoritative target shape for the WS2 full reshape. Producer side (emitters/orchestrator/vite) lands first; consumers migrate against this.

## Principle
`generated/` contains **only what app runtime code imports**. Dev-only + secret artifacts move to `.devstack/stacks/<stack>/generated-extras/` (already gitignored). One combined runtime config; plugins emit first-class sibling configs.

## Target `generated/` layout
```
src/generated/
  .gitignore            (managed, unchanged mechanism)
  config.ts             NEW — combined runtime config (networks + packages + objects)
  seal.ts               sibling (name-keyed) — only when seal in stack
  walrus.ts             sibling — only when walrus in stack
  deepbook.ts           sibling (name-keyed) — only when deepbook in stack
  coins.ts              aggregate — only when coins exist (unchanged)
  bindings/             Move codegen — STAYS (runtime-imported)
```
Deleted from `generated/`: `accounts.ts`, `accounts/`, `packages.ts`, `package/`, `services.ts`, `extras.ts`, `sui/network.ts`, `dapp-kit/config.ts`, and per-instance `seal/<n>.ts`/`deepbook/<n>.ts`/`walrus/network.ts` (flattened to siblings).

## Moved to `.devstack/stacks/<stack>/generated-extras/`
```
accounts.ts    — dev-only name→address map { [name]: {name,address,scheme,source} }
dev-wallet.ts  — secret-bearing { walletUrl, pairUrl, protocolPaths, chain }; 0o600
```
- Reached via NEW `@devstack-dev` alias (mirror `@generated` vite-plugin + tsconfig `paths`). Resolves `.devstack/stacks/<DEVSTACK_STACK>/generated-extras`.
- `dappKitConfig` export renamed → `devWallet`.

## Combined config (`generated/config.ts`)
```ts
export const config = {
  network: "local",                         // active key; default "local", overridable via VITE_DEVSTACK_NETWORK
  networks: {
    local: { chain, mode, rpc, faucet, graphql },   // from sui plugin (was suiNetwork + services.sui)
    // testnet/mainnet appear only if declared on packages' networks (we still need a network entry; see note)
  },
  packages: {
    <name>: {
      mvr: "<mvr-placeholder>",
      packageId: "0x...",                   // convenience = byNetwork[config.network]
      byNetwork: { local: "0x...", testnet?: "0x...", mainnet?: "0x..." },
      objects?: { <captureKey>: "0x...", ... },        // from capture (local) + declared (prod), per active network
    },
  },
  objects: { <package>: { <captureKey>: "0x..." } },    // mirror, per active network
} as const;
export type GeneratedConfig = typeof config;
```
Note: networks beyond `local` only get a full `{chain,mode,rpc,...}` entry when the user is actually applying to that network; for prod-targeting we primarily carry per-network **package/object ids**. A consumer flips `config.network` (env) to select active package ids. For live network endpoints the user supplies their own RPC (document); `networks.testnet.rpc` may be a public default. Keep `networks` minimal — at least `chain` per declared network.

## Per-network package-id API (NEW capability)
Extend `LocalPackageOptions` / `KnownPackageOptions`:
```ts
localPackage('connect_four', {
  sourcePath, publisher,
  networks: {
    testnet: { packageId: '0x...', objects: { registryId: '0x...' } },
    mainnet: { packageId: '0x...', objects: { registryId: '0x...' } },
  },
})
```
- Pure literals, no resolution. Codegen merges resolved-local id into `byNetwork.local` and declared literals into `byNetwork.testnet/mainnet`.
- `objects` source: local = `LocalPackageResolved.captured` (currently never emitted — new path); prod = declared `networks.*.objects`.

## Per-plugin siblings
| plugin | old | new |
|---|---|---|
| seal | `seal/<n>.ts`→`sealBindings` | `seal.ts`→`export const seal` (name-keyed if multiple) |
| walrus | `walrus/network.ts`→`walrus` | `walrus.ts`→`export const walrus` (shape unchanged) |
| deepbook | `deepbook/<n>.ts`→`deepbookBindings` | `deepbook.ts`→`export const deepbook` (name-keyed) |
| coins | `coins.ts`→`coins` | unchanged |
Keep existing typed shapes; only path + export name + (seal/deepbook) name-keying change. Mirror `coin/codegen.ts` aggregation for name-keyed siblings.

## Producer-side change map (Phase 2a — devstack package only)
- `orchestrators/codegen/`: add `aggregateOnly` decl flag (pure aggregate contributors stop double-emitting singletons); add `config.ts` bucket; route dev-extras emitters (`accounts`, `dev-wallet`) to the `.devstack/.../generated-extras` location.
- `orchestrators/codegen/output-location.ts` + `paths.ts`: compute the `generated-extras` dir for the primary stack.
- `orchestrators/codegen/service.ts`: skip standalone file for aggregate-only decls; wire combined `config` bucket projection.
- `plugins/sui/codegen.ts`: project into `config.networks.local` (drop `sui/network.ts` + `services.ts`).
- `plugins/package/codegen.ts` + `plugins/package/index.ts`: project into `config.packages.<name>` with `byNetwork`+`objects`; add `networks?` option; surface `captured` into `objects.local`. Keep `PackageBindings` export for bindings emitter (`isPackageBindings` seam).
- `plugins/account/codegen.ts`: route to `generated-extras/accounts.ts` (dev surface), drop `accounts.ts` aggregate from `generated/`.
- `plugins/wallet/codegen.ts`: route to `generated-extras/dev-wallet.ts`, rename export `dappKitConfig`→`devWallet`, keep `sensitive:true`.
- `plugins/seal|deepbook/codegen.ts`: name-keyed sibling aggregate (`seal.ts`/`deepbook.ts`).
- `plugins/walrus/codegen.ts`: `walrus.ts` (path only).
- `build-integrations/vite/index.ts`: add `@devstack-dev` alias resolution (sibling of `@generated`), resolving `.devstack/stacks/<stack>/generated-extras`.
- `extras.ts`: only user `defineDevstack({extras})` feeds it. If no example uses it, drop the emitter; if used, relocate to `generated-extras/extras.ts`. (grep `extras:` in examples first.)

## Consumer migration pattern (Phase 2b — one agent per example)
- `import { config } from '@generated/config.js'` for packages/networks/objects.
- `config.packages.<name>.packageId` (was `packages.<name>.packageId`).
- `config.networks[config.network].rpc|chain|faucet|graphql` (was `suiNetwork.*` / `services.sui.*`).
- `import { seal } from '@generated/seal.js'` etc. (was `seal/seal.js` `sealBindings`).
- dev-wallet wiring (`dapp-kit.ts`): `import { devWallet } from '@devstack-dev/dev-wallet.js'`, `import { accounts } from '@devstack-dev/accounts.js'`. Add `@devstack-dev` to tsconfig `paths`.
- Example app UI that shows alice/bob labels (connect-four, token-studio): import `accounts` from `@devstack-dev` (examples are dev-only). The **template** must NOT use accounts at runtime.
- private-content `e2e/seal-flow.spec.ts` uses a RELATIVE generated import — handle separately.
