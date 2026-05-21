# Examples

The rewrite set currently has two kinds of examples:

- Runnable browser apps, which use the public devstack lifecycle to generate
  local `src/generated/` output before starting Vite.
- Stack/config smoke examples, which are useful API-shape references but are
  not presented as browser apps until their product flows are complete.

The repo currently carries paired example sets during the devstack rewrite
transition:

- `<name>/` — consumes the original `@mysten-incubation/devstack` package.
- `<name>-rewrite/` — consumes `@mysten-incubation/devstack-rewrite` and
  reflects the current API shape.

New work targets the `-rewrite/` set; the older `<name>/` examples will be
removed once cutover (PR7) lands.

## Curated tour (rewrite set)

Start here for runnable apps:

| App                                              | What it shows                                                                         | Command                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`_template-rewrite`](./_template-rewrite)       | Minimal starting point: one Move package, one publish, one mint button, one e2e spec. | `pnpm --filter @mysten-incubation/_template-rewrite dev`            |
| [`token-studio-rewrite`](./token-studio-rewrite) | Single managed coin with TreasuryCap-gated mint / burn / transfer.                    | `pnpm --filter @mysten-incubation/example-token-studio-rewrite dev` |
| [`wallet-rewrite`](./wallet-rewrite)             | Wallet app shell over funded accounts and mock coins.                                 | `pnpm --filter @mysten-incubation/example-wallet-rewrite dev`       |

The `dev` scripts above build `@mysten-incubation/devstack-rewrite`, run
`devstack apply` to publish/generate local artifacts, then start Vite.
Generated files under `src/generated/` are local lifecycle output and should
not be committed.

Stack/config smoke examples:

| Example                                                        | What it shows                                                                                         | Command                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`hello-world-rewrite`](./hello-world-rewrite)                 | Smallest possible devstack config — single localnet, no Move, nothing extra.                          | `pnpm --filter @mysten-incubation/example-hello-world-rewrite apply`     |
| [`effect-app-rewrite`](./effect-app-rewrite)                   | Programmable API shape from a Node/Effect app.                                                        | `pnpm --filter @mysten-incubation/example-effect-app-rewrite start`      |
| [`postgres-mini-rewrite`](./postgres-mini-rewrite)             | Postgres plugin config and generated connection output.                                               | `pnpm --filter @mysten-incubation/example-postgres-mini-rewrite apply`   |
| [`seal-mini-rewrite`](./seal-mini-rewrite)                     | Minimal Seal local-keygen boot shape.                                                                 | `pnpm --filter @mysten-incubation/example-seal-mini-rewrite apply`       |
| [`walrus-mini-rewrite`](./walrus-mini-rewrite)                 | Minimal Walrus local-cluster boot shape.                                                              | `pnpm --filter @mysten-incubation/example-walrus-mini-rewrite apply`     |
| [`arena-rewrite`](./arena-rewrite)                             | Connect Four config migration target; browser app migration is not complete.                          | `pnpm --filter @mysten-incubation/example-arena-rewrite apply`           |
| [`fork-greeting-rewrite`](./fork-greeting-rewrite)             | Forked-network config migration target; browser app migration is not complete.                        | `pnpm --filter @mysten-incubation/example-fork-greeting-rewrite apply`   |
| [`private-content-rewrite`](./private-content-rewrite)         | Walrus + Seal config target; full encrypt/store/decrypt product roundtrip is not complete.            | `pnpm --filter @mysten-incubation/example-private-content-rewrite apply` |
| [`plugin-author-redis-rewrite`](./plugin-author-redis-rewrite) | Plugin-author API shape with a real Redis container and optional TCP router endpoint.                 | `pnpm --filter @mysten-incubation/plugin-author-redis-rewrite apply`     |
| [`deepbook-full-rewrite`](./deepbook-full-rewrite)             | DeepBook composite API target; real publish/Pyth/indexer/product flow is outside the release app set. | Typecheck only                                                           |

For runnable apps:

```bash
pnpm --filter <app> dev
```

The first lifecycle run may build or pull heavy local images. Subsequent runs
hit Docker layer cache and complete faster.

## Adding a new example

The [`_template-rewrite/`](./_template-rewrite) directory carries the
canonical boilerplate every new rewrite example needs — one `Package(...)`
member publishing one Move package, one `Action(...)` member doing one
post-publish transaction, a single-Card UI with a mint button, and an e2e
spec exercising the connect-and-mint flow.

Manual path (during the transition, the create-devstack-app scaffolder still
points at the original `_template/`; regenerate it from `_template-rewrite/`
after cutover):

1. `cp -r examples/_template-rewrite examples/<your-app>-rewrite` (read
   `examples/_template-rewrite/devstack.config.ts` for the canonical config
   shape).
2. Replace `_template` with your app name in `package.json` and
   `devstack.config.ts`.
3. Pick non-conflicting port hints — other examples occupy ports
   9000-9999 and 5173-5180. The per-stack allocator handles collisions
   at runtime, but explicit ranges are kinder to operators.
4. Rename `move/hello/` to your package name and update the address in
   `move/<pkg>/Move.toml`.
5. `pnpm install` then `pnpm dev`.
