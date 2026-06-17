# Headless Sui devstack app

TypeScript only — no frontend. `devstack.config.ts` declares a Sui localnet, the `alice` account,
the local `move/counter` package, and a dashboard; tests and scripts talk to the stack through
generated bindings.

## The loop

```bash
pnpm dev       # boots the `dev` localnet (+ any services), publishes move/counter,
               # injects the live stack's ids, and prints the dashboard URL
               # (run `pnpm codegen` to regenerate the committed src/generated/ tree)
pnpm test      # unit tests (src/**/*.test.ts) — fast, boots nothing
pnpm test:e2e  # full-stack tests (src/**/*.e2e.test.ts) — boots a throwaway `test`
               # stack, runs them against it, then tears it down
```

`pnpm test:e2e` is self-contained: it does **not** need `pnpm dev` running, and because it
boots a separate `test` stack — with its own per-stack ids file and runtime state — it runs in
parallel with `pnpm dev` without contending. The committed `src/generated` tree is shared and
stack-invariant, so neither stack rewrites it. To run the e2e suite against an already-running
stack instead of booting a fresh one, set `DEVSTACK_TEST_REUSE=1` (and point `DEVSTACK_STACK` at
that stack).

Prefer a one-shot boot without the watch loop? `pnpm apply` (re-emits the live ids file + dev
extras; it does not rewrite the committed `src/generated`). To regenerate the committed tree after
a Move source change, run `devstack codegen`. Day-2: `devstack status` (what's running +
endpoints), `devstack doctor` (diagnose), `devstack wipe` (reset state).

## Standalone scripts

Node 24 runs TypeScript natively — paste this into `src/main.ts` and run
`node src/main.ts <counterId>` (see `src/counter.e2e.test.ts` for the full create → increment →
read flow, including faucet funding):

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
