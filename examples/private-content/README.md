# Private content

Seal-encrypted file vault on top of sui-localnet, a local Walrus
storage cluster, and a single Open-mode Seal key server. Access control
runs entirely client-side via `SessionKey` + the
`vault::vault::seal_approve` dry-run policy fn.

```
private-content/
├── devstack.config.ts       # sui-localnet + walrus cluster + seal keygen + vault publish + wallet-app + vite
├── move/vault/              # Move package: Vault + Cap with seal_approve policy
├── tests/browser/seal-flow.spec.ts  # alice encrypts+uploads, grants Cap to bob, bob decrypts
└── src/                     # React UI: upload, grant, fetch+decrypt
```

## Prerequisites

- Docker (for sui-localnet, Walrus nodes, Seal key server)
- Node >= 24, pnpm

First `pnpm dev` builds local service images and downloads upstream
release binaries. Walrus uses upstream release tarballs only and builds
for Docker's native target platform. Subsequent runs should reuse the
Docker layer cache. The Playwright config bumps the test timeout to
900s for the cold path.

## Run

```
pnpm dev          # devstack up: localnet + walrus + seal + publish + wallet-app + vite (port 5170)
pnpm codegen      # regenerate src/generated bindings after a Move source change (stack-free)
pnpm build        # tsc -b && vite build — stack-free, no Docker; works on a clean clone
pnpm test         # Vitest unit tests only — fast, boots nothing (no devstack, no Docker)
pnpm test:browser # full Playwright Seal flow on an isolated `e2e` stack
                  # (parallel-safe with `pnpm dev`; expect a long first cycle)
```

`pnpm dev` injects live on-chain ids; the committed `src/generated/config.ts` (plus the
`seal.ts` / `walrus.ts` buckets) resolves them at runtime — vault package id, Seal key-server
url + object id, and the local Walrus node/package config all resolve at runtime and are never
baked in. `pnpm build` is deterministic and stack-free (no Docker) — a build with no injected
ids throws `DevstackConfigMissingError` at runtime rather than silently shipping zeros.

The `tests/browser/seal-flow.spec.ts` spec drives the full
`SealClient.encrypt → upload → grant → SessionKey → seal_approve →
fetchKeys → decrypt` round trip with no mocks.

## Deploy to a real network

The build needs a known deployment's deployment file (the same `deployment.json` schema the
local stack writes). Either point the stack at the target network once and copy the file it
emits, or hand-author one:

```bash
# Option A: boot against the target network, then copy the emitted deployment
devstack up --network testnet
cp .devstack/stacks/main/deployment.json config/testnet.ids.json
```

For the full deployment schema (Option B, hand-authoring) see the canonical
[Deploy to a real network](https://ts-sdks-incubation.vercel.app/devstack/features/codegen#deploy-to-a-real-network)
section in the devstack docs. For this example the `values` channel carries the Seal key-server
url/object id and the Walrus endpoints + package config. Commit the file, then point the build
at it:

```bash
# via the Vite plugin option (vite.config.ts):
#   devstackVitePlugin({ ids: './config/testnet.ids.json' })
# or via env:
DEVSTACK_DEPLOYMENT_FILE=./config/testnet.ids.json pnpm build
```

Then deploy the static `dist/` bundle. A build with no ids throws `DevstackConfigMissingError`
at runtime — loud, not a silent zero.
