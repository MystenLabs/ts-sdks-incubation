# Examples

These are the curated devstack examples. Each one consumes
`@mysten-incubation/devstack` from the workspace and uses the final directory
name that a developer should reach for.

Generated files under `src/generated/` are local lifecycle output and should not
be committed.

## Runnable Apps

| App                                    | What it shows                                                                                                                   | Command                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`connect-four`](./connect-four)       | On-chain Connect Four lobby, join, and move flow using managed accounts and dev wallet signing.                                 | `pnpm --filter @mysten-incubation/connect-four dev`          |
| [`deepbook-trader`](./deepbook-trader) | Localnet DeepBook trader with dev-wallet connection, local DeepBook publish, DEEP/SUI pool seeding, and live SUI-to-DEEP swaps. | `pnpm --filter @mysten-incubation/deepbook-trader dev`       |
| [`fork-greeting`](./fork-greeting)     | Testnet fork replay with fork-faucet funding, local package publish, and managed dev-wallet accounts.                           | `pnpm --filter @mysten-incubation/example-fork-greeting dev` |
| [`private-content`](./private-content) | Primary Sui + Walrus + Seal app: encrypted content grants, Walrus storage, and Seal decryption.                                 | `pnpm --filter @mysten-incubation/private-content dev`       |
| [`token-studio`](./token-studio)       | Single managed coin with TreasuryCap-gated mint and transfer flows.                                                             | `pnpm --filter @mysten-incubation/token-studio dev`          |

The `dev` scripts run the built workspace devstack CLI directly. Turbo builds workspace
dependencies when needed, and devstack supervises the local services plus each
browser app's Vite process. The first lifecycle run may build or pull local
images; subsequent runs should reuse Docker cache.

### Testing

Each app exposes two test commands:

- `pnpm test` — fast unit tests (`vitest run`): pure domain logic (formatting,
  parsing, game rules, …), no devstack, no Docker.
- `pnpm test:e2e` — full-stack Playwright run, backed by
  `@mysten-incubation/devstack/playwright`, for the apps with a browser UI
  (`connect-four`, `deepbook-trader`, `private-content`, `token-studio`). It boots a
  dedicated, isolated `e2e` stack (`DEVSTACK_STACK=e2e`, which overrides the config's
  `stackName`) and drives the app against it — so it runs **in parallel** with a
  developer's `pnpm dev` stack without contending or clobbering `src/generated` (the
  `e2e` stack is secondary, so its codegen lands in `.devstack/stacks/e2e/generated`).
  The router is a shared singleton, so both stacks coexist behind distinct
  `<endpoint>.<stack>.<app>.localhost` hostnames.

`fork-greeting` and `dashboard-demo` ship no browser e2e; their `pnpm test` runs the
relevant checks only (`dashboard-demo` asserts its stack config composes).

## Adding An Example

Scaffold a new browser app from the canonical template with
[`create-devstack-app`](../packages/create-devstack-app):

```sh
pnpm create @mysten-incubation/devstack-app <your-app>
```

The scaffolder copies the authored template
([`packages/create-devstack-app/template/`](../packages/create-devstack-app/template)),
which includes a Move package, a compact UI with core/walrus/seal/deepbook
panels (pick which plugins to keep at scaffold time), and an e2e spec. It
rewrites the `DEVSTACK_APP` runtime identity, tsconfig paths, and Playwright
host tokens to your app name automatically.

To grow the curated examples here, scaffold into `examples/<your-app>` and pick
non-conflicting port hints — existing examples occupy ports 5170, 5173, 5176,
5179, and 5182; the per-stack allocator handles collisions at runtime.
