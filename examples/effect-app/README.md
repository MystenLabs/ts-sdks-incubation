# effect-app

Minimal example of consuming Devstack services from inside an Effect
program via `provideDevstack`.

## Pattern

```ts
import { Effect } from 'effect';
import { runMain } from '@effect/platform-node/NodeRuntime';
import {
    accounts,
    provideDevstack,
    Sui,
    suiLocalnet,
    suiTestnet,
} from '@mysten-incubation/devstack-effect';

const a =
    process.env.NODE_ENV === 'production'
        ? accounts({ alice: { from: 'env', key: 'ALICE_PRIVATE_KEY' } })
        : accounts({ alice: { from: 'ephemeral-funded' } });

const program = Effect.gen(function* () {
    const sui = yield* Sui;
    const alice = yield* a.alice;
    yield* Effect.log(`sui ${sui.network} @ ${sui.rpcUrl}`);
    yield* Effect.log(`alice ${alice.address}`);
});

const layer =
    process.env.NODE_ENV === 'production'
        ? provideDevstack([suiTestnet(), a.alice])
        : provideDevstack([suiLocalnet(), a.alice]);

runMain(program.pipe(Effect.provide(layer)));
```

Two axes vary by env, both orthogonal to `program`:

- The Sui `Layer`. `program` depends on the `Sui` *interface tag*, not on
  a specific factory. Swap `suiLocalnet()` for `suiTestnet()` /
  `suiMainnet()` / `suiCustom({...})` in one line — `program` is
  untouched.
- The account source. `accounts({...})`'s `from:` discriminator binds
  the same `a.alice` tag to different signer sources by env:
  `ephemeral-funded` (fresh Ed25519 keypair, faucet-funded, persisted
  under `.devstack/`) for dev, `env` (load `ALICE_PRIVATE_KEY` from the
  environment, no funding, no persistence) for prod. Other variants:
  `keystore` (path on disk) and `inline` (literal key string — for
  tests).

## When to reach for `provideDevstack` vs `defineDevstack`

- `defineDevstack` is a *runner*. It composes the stack into a Layer,
  attaches a TUI / plain renderer, file watcher, signal handlers, and a
  restart loop, then exposes `.run()` / `.runMain()`. That's the shape
  the `devstack up` CLI uses, and the shape `examples/wallet` /
  `examples/arena` / etc. use in their `devstack.config.ts`.

- `provideDevstack` is *pure DI*. It returns the same composed Layer
  without the launch loop. Use this when you have an Effect program
  already and just want Devstack services available in Context — e.g.
  scripts, tests, or production apps that embed Devstack-managed
  resources alongside their own services.

## Run

```sh
pnpm start                        # localnet (needs `docker` running)
NODE_ENV=production pnpm start    # testnet (no docker; remote RPC)
pnpm typecheck
```
