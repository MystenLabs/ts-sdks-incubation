# Examples

These examples are the final devstack example set. They all consume
`@mysten-incubation/devstack` from the workspace and use final directory names.

Most examples expose one of two workflows:

- Browser apps run the devstack lifecycle, generate local `src/generated/`
  output, then start Vite.
- Stack/config examples focus on API shape, plugin composition, or service boot
  behavior. They are useful references even when they are not full browser apps.

Generated files under `src/generated/` are local lifecycle output and should not
be committed.

## Runnable Apps

| App | What it shows | Command |
| --- | --- | --- |
| [`_template`](./_template) | Minimal starting point with one Move package, one publish action, one mint button, and one e2e spec. | `pnpm --filter @mysten-incubation/_template dev` |
| [`token-studio`](./token-studio) | Single managed coin with TreasuryCap-gated mint, burn, and transfer flows. | `pnpm --filter @mysten-incubation/token-studio dev` |
| [`wallet`](./wallet) | Wallet app shell over funded accounts and mock coins. | `pnpm --filter @mysten-incubation/wallet dev` |

The `dev` scripts build `@mysten-incubation/devstack`, invoke the built CLI's
`apply` command, then start Vite. The first lifecycle run may build or pull
local images; subsequent runs should reuse Docker cache.

Recursive example typechecks assume the orchestrator has already built
`@mysten-incubation/devstack`; standalone `apply` scripts still build it first.

## Stack And Config Examples

| Example | What it shows | Command |
| --- | --- | --- |
| [`hello-world`](./hello-world) | Smallest possible devstack config with localnet accounts and no Move package. | `pnpm --filter @mysten-incubation/example-hello-world apply` |
| [`effect-app`](./effect-app) | Programmable API shape from a Node/Effect app. | `pnpm --filter @mysten-incubation/example-effect-app start` |
| [`postgres-mini`](./postgres-mini) | Postgres plugin config and generated connection output. | `pnpm --filter @mysten-incubation/example-postgres-mini apply` |
| [`seal-mini`](./seal-mini) | Minimal Seal local-keygen boot shape. | `pnpm --filter @mysten-incubation/example-seal-mini apply` |
| [`walrus-mini`](./walrus-mini) | Minimal Walrus local-cluster boot shape. | `pnpm --filter @mysten-incubation/example-walrus-mini apply` |
| [`arena`](./arena) | Connect Four stack config target. | `pnpm --filter @mysten-incubation/arena apply` |
| [`fork-greeting`](./fork-greeting) | Forked-network stack config target. | `pnpm --filter @mysten-incubation/example-fork-greeting apply` |
| [`private-content`](./private-content) | Walrus plus Seal private-content stack config target. | `pnpm --filter @mysten-incubation/private-content apply` |
| [`plugin-author-redis`](./plugin-author-redis) | Plugin-author API shape with a real Redis container and optional TCP router endpoint. | `pnpm --filter @mysten-incubation/plugin-author-redis apply` |
| [`deepbook-full`](./deepbook-full) | DeepBook composite API target. | `pnpm --filter @mysten-incubation/deepbook-full typecheck` |

## Adding An Example

Use [`_template`](./_template) as the starting point for new browser examples.
It includes one `localPackage(...)` member publishing one Move package, one
`action(...)` member doing one post-publish transaction, a compact UI, and an
e2e spec exercising the connect-and-mint flow.

Manual path:

1. Copy `examples/_template` to `examples/<your-app>`.
2. Replace `_template` with your app name in `package.json` and
   `devstack.config.ts`.
3. Pick non-conflicting port hints. Existing examples occupy ports 5173-5181;
   the per-stack allocator handles collisions at runtime.
4. Rename `move/hello/` to your package name and update the address in
   `move/<pkg>/Move.toml`.
5. Run `pnpm install`, then `pnpm --filter <your-package> dev`.
