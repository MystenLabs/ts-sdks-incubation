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
- Sui CLI (`sui` on `PATH`) for Move compilation
- Node >= 24, pnpm

First `pnpm dev` builds two heavy local images: walrus (~10 min cold)
and seal (~5–8 min). Subsequent runs hit the docker layer cache. The
Playwright config bumps the test timeout to 900s for this reason.

## Run

```
pnpm dev          # devstack up: localnet + walrus + seal + publish + wallet-app + vite (port 5175)
pnpm test:e2e     # full Playwright run; expect a long first cycle
pnpm test:watch   # vitest in watch mode
```

The `e2e/seal-flow.spec.ts` spec drives the full
`SealClient.encrypt → upload → grant → SessionKey → seal_approve →
fetchKeys → decrypt` round trip with no mocks.
