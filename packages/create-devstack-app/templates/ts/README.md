# Headless Sui devstack app

TypeScript only — no frontend. `devstack.config.ts` declares a Sui localnet, the `alice` account,
the local `move/counter` package, and a dashboard; tests and scripts talk to the stack through
generated bindings.

## The loop

```bash
pnpm dev    # terminal 1: boots the localnet (+ any services), publishes move/counter,
            # regenerates src/generated/, and prints the dashboard URL
pnpm test   # terminal 2: runs src/**/*.test.ts against the running stack
```

Prefer a one-shot boot without the watch loop? `pnpm apply`. Day-2: `devstack status` (what's
running + endpoints), `devstack doctor` (diagnose), `devstack wipe` (reset state).

## Standalone scripts

Node 24 runs TypeScript natively — paste this into `src/main.ts` and run
`node src/main.ts <counterId>` (see `src/counter.test.ts` for the full create → increment → read
flow, including faucet funding):

```ts
import { SuiGrpcClient } from '@mysten/sui/grpc';

import { readCounter } from './counter.ts';
import { config } from './generated/config.ts';

const { rpc } = config.networks[config.network];
const client = new SuiGrpcClient({
	network: 'localnet',
	baseUrl: rpc,
	mvr: { overrides: { packages: config.mvrOverrides } },
});
console.log('counter value:', await readCounter(client, process.argv[2]!));
```

## Add a local service

Add a member to `devstack.config.ts`, list it in the stack, and install its SDK:

- Walrus — `const storage = walrus({ local: { nodeCount: 1 } });` and fund alice with
  `{ coin: walCoin(storage), amount: 500_000_000n }` · `pnpm add @mysten/walrus @mysten/walrus-wasm`
- Seal — `seal({ mode: 'local-keygen', signer: alice })` · `pnpm add @mysten/seal` (a real app
  publishes its own Move package with a `seal_approve` policy)
- DeepBook — not a one-liner: vendor the DeepBook + Pyth Move packages and configure pools
  explicitly; start from `examples/deepbook-trader` in the devstack repo.

## More

- A fuller example: `examples/token-studio` in the devstack repo.
- Want a React frontend? Re-scaffold with `--template app`, or see the devstack docs.
