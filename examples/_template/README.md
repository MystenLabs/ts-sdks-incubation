# Template

Minimal devstack starter: one Move package (`hello::mint`), two
managed accounts, one post-publish action, and one e2e spec exercising
the connect-and-mint flow.

```
_template/
├── devstack.config.ts    # sui-localnet + hello package + greet action + dev-wallet + vite
├── move/hello/           # Move package: emits a Greeting event on mint
├── e2e/                  # Playwright: connect wallet, mint, assert digest
└── src/                  # React UI: connect, mint, render digest
```

## Run

```
pnpm dev          # devstack up: localnet + publish + greet + wallet + vite (port 5179)
pnpm test         # typecheck + Vitest unit coverage
pnpm test:e2e     # Playwright connect-and-mint flow
```

## See also

- [examples/README.md](../README.md) — overview of every runnable app.
- [Quickstart](https://ts-sdks-incubation.vercel.app/devstack/quickstart) — full tour
  of the same shape you see here.

Use this folder as the starting point for new browser examples — see
`examples/README.md > Adding An Example`.
