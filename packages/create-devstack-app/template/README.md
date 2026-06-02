# Devstack App

A minimal Sui app scaffolded with `@mysten-incubation/create-devstack-app`.

## Commands

```bash
pnpm dev       # start the devstack supervisor and Vite app
pnpm build     # apply the stack, typecheck, and build the app
pnpm test      # typecheck and run unit tests
pnpm test:e2e  # bring up the test stack and run the Playwright specs
```

## Project Shape

- `devstack.config.ts` defines the local Sui stack, accounts, Move package(s), and dev wallet.
- `move/counter/` contains the core example Move package.
- `src/dapp-kit.ts` wires dApp Kit to the generated devstack config.
- `src/App.tsx` registers the demo panels (counter, plus any plugins you chose at scaffold).

`devstack apply` writes runtime state under `.devstack/` and generated app bindings under
`src/generated/`; both are ignored because they are regenerated for each checkout.
