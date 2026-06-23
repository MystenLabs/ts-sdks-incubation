# Examples

These are the curated devstack examples. Each one consumes
`@mysten-incubation/devstack` from the workspace and uses the final directory
name that a developer should reach for.

The generated bindings under `src/generated/` are committed: `devstack codegen`
writes id-free Move and config bindings that resolve live on-chain ids at app
build/dev time. Because the committed tree carries no stack-specific ids, the
same bindings serve every stack, and nothing dev-only lands in the committed
tree.

## Runnable apps

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

- `pnpm test` — fast unit tests (`vitest run`, `tests/unit/**`): pure domain logic
  (formatting, parsing, game rules, …), no devstack, no Docker.
- `pnpm test:browser` — full-stack Playwright run (`tests/browser/**`), backed by
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

## Adding an example

Scaffold a new app with [`create-devstack-app`](../packages/create-devstack-app):

```sh
pnpm create @mysten-incubation/devstack-app <your-app>
```

The scaffolder prompts for what you are building (**Web dapp** or **TypeScript
only**) and which optional services to include (walrus, seal, deepbook, pyth),
then copies the matching template (`templates/app/` or `templates/ts/`) and
renders `devstack.config.ts` from your selection. See the
[create-devstack-app README](../packages/create-devstack-app/README.md) for the
full prompt and option reference.

To grow the curated examples here, scaffold directly into `examples/<your-app>`
with `--target-dir ./examples`, and pick non-conflicting port hints — existing
examples occupy ports 5170, 5173, 5176, 5179, and 5182; the per-stack allocator
handles collisions at runtime.
