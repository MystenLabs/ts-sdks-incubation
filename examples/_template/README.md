# Template

Devstack starter with one core panel and two optional plugin panels:

- **Counter** (core) — create + increment a shared Move `Counter`.
- **Seal** (optional) — encrypt a secret, register its policy on chain,
  and decrypt it back.
- **Walrus** (optional) — store a text blob and read it back.

Optional plugins are wrapped in `// devstack:begin <plugin>` /
`// devstack:end <plugin>` fences in the shared files (`App.tsx`,
`devstack.config.ts`) so the scaffolder can strip the ones you opt out
of. Plugin-specific files (`panels/`, `lib/`, `move/`, `e2e/`) are
removed wholesale.

```
_template/
├── devstack.config.ts    # sui-localnet + counter pkg (+ fenced seal/walrus) + dev-wallet + vite
├── move/counter/         # core Move package: shared Counter
├── move/vault/           # <seal> Move package: policy object for seal_approve
├── e2e/                  # Playwright: counter / seal / walrus flows
└── src/
    ├── dapp-kit.ts       # prod-safe wallet wiring (dev wallet dynamically imported, DEV-gated)
    ├── dapp-kit.dev.ts   # dev-only: accounts + connectAs slot
    ├── panels/           # CounterPanel (core), SealPanel/WalrusPanel (optional)
    ├── lib/              # counter / seal / walrus integrations + shared sign hook
    └── ui/               # Panel + Card chrome
```

## Run

```
pnpm dev          # devstack up: localnet + publish + plugins + wallet + vite
pnpm test         # typecheck + Vitest unit coverage (counter tx builders)
pnpm test:e2e     # Playwright counter/seal/walrus flows on the `test` stack
```

## See also

- [examples/README.md](../README.md) — overview of every runnable app.
- [Quickstart](https://ts-sdks-incubation.vercel.app/devstack/quickstart) — full tour.

Use this folder as the starting point for new browser examples — see
`examples/README.md > Adding An Example`.
