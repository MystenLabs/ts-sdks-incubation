# effect-app

> **Effect-native alternative pattern.** This example composes devstack
> from an Effect Layer composition directly inside an Effect program —
> no `devstack.config.ts`, no codegen. **Most apps should use the
> canonical shape** — see `examples/_template/` for the
> `devstack.config.ts` + generated-code path. Reach for this pattern
> when you already have an Effect program and want to embed
> devstack-managed services in its Layer composition.

Minimal Effect program consuming Devstack via the Ref API. The same
program runs against a freshly-spun localnet in dev and a remote
testnet RPC in prod — the network is picked up from
`DEVSTACK_NETWORK` (or `devstack --network <kind>`), so `Sui()` and
every other factory in the stack resolve to the same target without
any config change.

## Pattern

```ts
import { Effect } from 'effect';
import { runMain } from '@effect/platform-node/NodeRuntime';
import { Account, devstack, Sui } from '@mysten-incubation/devstack';

const isProduction = process.env.NODE_ENV === 'production';

const alice = isProduction
	? Account('alice', { from: 'env', key: 'ALICE_PRIVATE_KEY' })
	: Account('alice', { from: 'ephemeral-funded' });

const sui = Sui();

const program = Effect.gen(function* () {
	const s = yield* sui;
	const a = yield* alice;
	yield* Effect.log(`sui ${s.network} @ ${s.rpc.host}`);
	yield* Effect.log(`alice ${a.address}`);
});

const stack = devstack(sui, alice);
runMain(program.pipe(Effect.provide(stack.layer)) as Effect.Effect<void, never, never>);
```

The two axes that vary by env are orthogonal:

- **Sui network.** Picked from `DEVSTACK_NETWORK` at module-load time.
  No code changes — `pnpm start` runs against localnet,
  `DEVSTACK_NETWORK=testnet pnpm start` runs against testnet. The
  same `Sui()` call returns the right handle.
- **Account source.** `Account(name, { from: ... })`'s discriminator
  binds the same `alice` Ref to different signer sources by env:
  `ephemeral-funded` (fresh keypair, faucet-funded, persisted under
  `.devstack/`) for dev, `env` (load `ALICE_PRIVATE_KEY` from the
  environment, no funding, no persistence) for prod. Other variants:
  `keystore` (path on disk) and `inline` (literal key string — for
  tests).

## Why `devstack(...).layer` instead of `.run()`

The `devstack(...)` handle exposes:

- `.run()` / `.runMain()` — a _runner_. Composes the stack, attaches
  a TUI / plain renderer, file watcher, signal handlers, restart loop.
  That's the shape `devstack up` uses, and the shape
  `examples/wallet` / `examples/arena` use in their
  `devstack.config.ts`.
- `.layer` — the same composed Layer without the runner. Use this
  when you have an Effect program already and just want Devstack
  services available in Context — scripts, tests, or production apps
  that embed Devstack-managed resources alongside their own services.

## Run

```sh
pnpm start                                            # localnet (needs `docker` running)
DEVSTACK_NETWORK=testnet NODE_ENV=production pnpm start   # testnet (no docker; remote RPC)
pnpm typecheck
```
