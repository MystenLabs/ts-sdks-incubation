# Private content

Seal-encrypted file vault on top of sui-localnet, a local Walrus
storage cluster, and a single Open-mode Seal key server. Access control
runs entirely client-side via `SessionKey` + the
`vault::vault::seal_approve` dry-run policy fn.

```
private-content/
├── devstack.config.ts       # sui-localnet + walrus cluster + seal keygen + vault publish + wallet-app + vite
├── move/vault/              # Move package: Vault + Cap with seal_approve policy
├── e2e/seal-flow.spec.ts    # alice encrypts+uploads, grants Cap to bob, bob decrypts
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
pnpm test         # typecheck plus Vitest unit coverage
pnpm test:e2e     # full Playwright run; expect a long first cycle
```

The `e2e/seal-flow.spec.ts` spec drives the full
`SealClient.encrypt → upload → grant → SessionKey → seal_approve →
fetchKeys → decrypt` round trip with no mocks.
