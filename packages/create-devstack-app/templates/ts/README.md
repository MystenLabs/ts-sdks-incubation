# Headless Sui devstack app

TypeScript only — no frontend. `devstack.config.ts` declares a Sui localnet, the `alice` account,
the local `move/counter` package, and a dashboard; tests and scripts talk to the stack through
generated bindings.

## The loop

```bash
pnpm dev       # boots the `dev` localnet (+ any services), publishes move/counter,
               # injects the live stack's ids, and prints the dashboard URL
               # (run `pnpm codegen` to regenerate the committed src/generated/ tree)
pnpm test      # unit tests (tests/unit/**) — fast, boots nothing
pnpm test:e2e  # full-stack tests (tests/e2e/**) — boots a throwaway `test`
               # stack, runs them against it, then tears it down
```

`pnpm test:e2e` is self-contained: it does **not** need `pnpm dev` running, and because it boots a
separate `test` stack — with its own per-stack ids file and runtime state — it runs in parallel with
`pnpm dev` without contending. The committed `src/generated` tree is shared and stack-invariant, so
neither stack rewrites it. To run the e2e suite against an already-running stack instead of booting
a fresh one, set `DEVSTACK_TEST_REUSE=1` (and point `DEVSTACK_STACK` at that stack).

The scaffolder runs `pnpm codegen` for you after install when a host `sui` CLI is on your PATH, so
the committed `src/generated/` tree already covers the services you selected. If `sui` wasn't found
(or you scaffolded with `--no-codegen` / `--no-install`), run `pnpm codegen` once — it needs the
`sui` CLI. Git-sourced services (deepbook/pyth) clone their Move tree at stack boot, so their local
bindings finish materializing on first `pnpm dev`.

Prefer a one-shot boot without the watch loop? `pnpm apply` (re-emits the live ids file + dev
extras; it does not rewrite the committed `src/generated`). To regenerate the committed tree after a
Move source change, run `devstack codegen`. Day-2: `devstack status` (what's running + endpoints),
`devstack doctor` (diagnose), `devstack wipe` (reset state).

## Standalone scripts

Node 24 runs TypeScript natively — paste this into `src/main.ts` and run
`node src/main.ts <counterId>` (see `tests/e2e/counter.test.ts` for the full create → increment →
read flow, including faucet funding):

```ts
import { SuiGrpcClient } from '@mysten/sui/grpc';

import { readCounter } from './counter.ts';
import { config } from './generated/config.ts';

// `config.forNetwork(name)` returns that network's deployment (`.rpc`, `.network`,
// `.packages`, `.mvrOverrides`, …). `config.defaultNetwork` is the dev default;
// `config.networkNames` lists every network this build knows about.
const deployment = config.forNetwork(config.defaultNetwork);
const client = new SuiGrpcClient({
	network: 'localnet',
	baseUrl: deployment.rpc,
	mvr: { overrides: { packages: deployment.mvrOverrides } },
});
console.log('counter value:', await readCounter(client, process.argv[2]!));
```

## Add a local service

Add a member to `devstack.config.ts`, list it in the stack, and install its SDK:

- Walrus — `const storage = walrus({ local: { nodeCount: 1 } });` and fund alice with
  `{ coin: walCoin(storage), amount: 500_000_000n }` · `pnpm add @mysten/walrus @mysten/walrus-wasm`
- Seal — `seal({ mode: 'local-keygen', signer: alice })` · `pnpm add @mysten/seal` (a real app
  publishes its own Move package with a `seal_approve` policy)
- DeepBook — scaffold with `--services deepbook`: devstack publishes the DeepBook Move package from
  upstream git and synthesizes a default DEEP/SUI pool. Add `--services pyth` (implies deepbook) for
  local mock-Pyth feeds on that pool. For the hand-configured multi-pool + multi-feed setup, start
  from `examples/deepbook-trader` in the devstack repo.

## More

- A fuller example: `examples/token-studio` in the devstack repo.
- Want a React frontend? Re-scaffold with `--template app`, or see the devstack docs.
