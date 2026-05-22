# Examples

These are the curated devstack examples. Each one consumes
`@mysten-incubation/devstack` from the workspace and uses the final directory
name that a developer should reach for.

Generated files under `src/generated/` are local lifecycle output and should not
be committed.

## Runnable Apps

| App                                    | What it shows                                                                                        | Command                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [`_template`](./_template)             | Minimal starting point with one Move package, one publish action, one mint button, and one e2e spec. | `pnpm --filter @mysten-incubation/_template dev`       |
| [`connect-four`](./connect-four)       | On-chain Connect Four lobby, join, and move flow using managed accounts and dev wallet signing.      | `pnpm --filter @mysten-incubation/connect-four dev`    |
| [`deepbook-trader`](./deepbook-trader) | Localnet DeepBook trader shell with dev-wallet connection, local SUI/DEEP funding, and disabled swaps until local DeepBook/Pyth are first-class. | `pnpm --filter @mysten-incubation/deepbook-trader dev` |
| [`private-content`](./private-content) | Primary Sui + Walrus + Seal app: encrypted content grants, Walrus storage, and Seal decryption.      | `pnpm --filter @mysten-incubation/private-content dev` |
| [`token-studio`](./token-studio)       | Single managed coin with TreasuryCap-gated mint, burn, and transfer flows.                           | `pnpm --filter @mysten-incubation/token-studio dev`    |

The `dev` scripts run the built workspace devstack CLI directly. Turbo builds workspace
dependencies when needed, and devstack supervises the local services plus each
browser app's Vite process. The first lifecycle run may build or pull local
images; subsequent runs should reuse Docker cache.
Each runnable app also has a `test:e2e` script backed by
`@mysten-incubation/devstack/playwright`, so Playwright starts the app's stack
through `pnpm dev` rather than requiring a separate `devstack up` session.

## Coming Soon

| Example                            | Planned coverage                           |
| ---------------------------------- | ------------------------------------------ |
| [`fork-greeting`](./fork-greeting) | Forked-network package capture and replay. |

## Adding An Example

Use [`_template`](./_template) as the starting point for new browser examples.
It includes one `localPackage(...)` member publishing one Move package, one
`action(...)` member doing one post-publish transaction, a compact UI, and an
e2e spec exercising the connect-and-mint flow.

Manual path:

1. Copy `examples/_template` to `examples/<your-app>`.
2. Replace the package name and `DEVSTACK_APP=template` runtime identity
   with your app name in `package.json` and `devstack.config.ts`.
3. Pick non-conflicting port hints. Existing examples occupy ports 5170, 5173,
   5176, 5179, 5181, and 5182; the per-stack allocator handles collisions at
   runtime.
4. Rename `move/hello/` to your package name and update the address in
   `move/<pkg>/Move.toml`.
5. Run `pnpm install`, then `pnpm --filter <your-package> dev`.
