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
| [`deepbook-full`](./deepbook-full)     | DeepBook/Pyth market console over generated known-deployment bindings and live testnet market reads. | `pnpm --filter @mysten-incubation/deepbook-full dev`   |
| [`private-content`](./private-content) | Primary Sui + Walrus + Seal app: encrypted content grants, Walrus storage, and Seal decryption.      | `pnpm --filter @mysten-incubation/private-content dev` |
| [`token-studio`](./token-studio)       | Single managed coin with TreasuryCap-gated mint, burn, and transfer flows.                           | `pnpm --filter @mysten-incubation/token-studio dev`    |
| [`wallet`](./wallet)                   | Wallet app shell over funded accounts and mock coins.                                                | `pnpm --filter @mysten-incubation/wallet dev`          |

The `dev` scripts run `devstack up` directly. Turbo builds workspace
dependencies when needed, and devstack supervises the local services plus each
browser app's Vite process. The first lifecycle run may build or pull local
images; subsequent runs should reuse Docker cache.

## Stack And Config Examples

| Example                            | What it shows                       | Command                                                        |
| ---------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| [`arena`](./arena)                 | Connect Four stack config target.   | `pnpm --filter @mysten-incubation/arena apply`                 |
| [`fork-greeting`](./fork-greeting) | Forked-network stack config target. | `pnpm --filter @mysten-incubation/example-fork-greeting apply` |

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
