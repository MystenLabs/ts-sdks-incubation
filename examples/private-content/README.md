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

Publish the Move packages to the target network, then scaffold a typed, committed
`deployments/<network>.ts` (`devstack dump-deployment --network <net>`). The bare
`devstackVitePlugin()` in `vite.config.ts` auto-discovers `deployments/*.ts`; a production
`pnpm build` ships only the committed networks. There is no `ids` Vite option and no
`config/<net>.ids.json` file. See the canonical
[Going to production](https://ts-sdks-incubation.vercel.app/devstack/going-to-production) guide
for the full flow.
