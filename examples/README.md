# Examples

Each example is a self-contained Sui app that consumes
`@mysten-incubation/devstack` for localnet bring-up + Move
publish + codegen + dev-wallet wiring.

## Apps

| App                                  | What it shows                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [\_template](./_template)            | Minimal-but-real starting point. One Move package, one publish, one mint button, one e2e spec.  |
| [arena](./arena)                     | On-chain Connect Four. Matchmaking via shared Lobby; gameplay via shared Game.                  |
| [effect-app](./effect-app)           | Pure-DI consumer mode. Same `Effect.gen` program runs against localnet in dev, testnet in prod. |
| [private-content](./private-content) | Seal-encrypted file vault on top of walrus + a single Open-mode seal key server.                |
| [token-studio](./token-studio)       | Single managed coin with TreasuryCap-gated minting.                                             |
| [wallet](./wallet)                   | Multi-coin wallet UI + DeepBook v3 swap. Imports deepbook from upstream.                        |

Run any one:

```bash
pnpm --filter <app> dev
```

The first `pnpm dev` builds heavy local images (sui-localnet always;
walrus + seal for `private-content`) — 5-10 minutes on a cold cache.
Subsequent runs hit Docker layer cache and complete in seconds.

## Adding a new example

The [`_template/`](./_template) directory carries the canonical
boilerplate every new example needs — one `Package(...)` Ref publishing
one Move package, one `Action(...)` Ref doing one post-publish
transaction, a single-Card UI with a mint button, and an e2e spec
exercising the connect-and-mint flow.

The fastest path:

```bash
pnpm create @mysten-incubation/devstack-app my-app
```

That scaffolder (under `packages/create-devstack-app/`) clones
`_template/` into `examples/my-app/`, substitutes the app name into
`package.json` / `devstack.config.ts` / `Move.toml`, and runs
`pnpm install`.

Manual path:

1. `cp -r examples/_template examples/<your-app>` (read
   `examples/_template/README.md` for the full file tree).
2. Replace `_template` with your app name in `package.json` and
   `devstack.config.ts`.
3. Pick non-conflicting port hints — other examples occupy ports
   9000-9999 and 5173-5180. The per-stack allocator handles collisions
   at runtime, but explicit ranges are kinder to operators.
4. Rename `move/hello/` to your package name and update the address in
   `move/<pkg>/Move.toml`.
5. `pnpm install` then `pnpm dev`.
