# Devstack App

A minimal Sui app scaffolded with `@mysten-incubation/create-devstack-app`.

## Commands

```bash
pnpm dev       # apply the stack, generate app bindings, and start Vite
pnpm build     # apply the stack, typecheck, and build the app
pnpm test      # typecheck and run unit tests
pnpm test:e2e  # run the Playwright mint flow
```

## Project Shape

- `devstack.config.ts` defines the local Sui stack, accounts, Move package, and dev wallet.
- `move/hello/` contains the example Move package.
- `src/dapp-kit.ts` wires dApp Kit to the generated devstack config.
- `src/App.tsx` connects the wallet and calls `hello::mint`.

`devstack apply` writes runtime state under `.devstack/` and generated app bindings under
`src/generated/`; both are ignored because they are regenerated for each checkout.
