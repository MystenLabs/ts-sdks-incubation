# Devstack app

A Sui dapp wired to a local devstack. One command boots everything this app needs.

```bash
pnpm install
pnpm dev
```

`pnpm dev` boots a Sui localnet (plus any services in `devstack.config.ts`) in Docker, funds the dev
account, publishes `move/counter`, generates typed bindings + runtime config into `src/generated/`,
serves the app with a browser dev wallet injected, and prints the dashboard URL.

## Day-2 commands

| Command           | What it does                                                            |
| ----------------- | ----------------------------------------------------------------------- |
| `pnpm dev`        | Boot (or reuse) the stack and serve the app with the dev wallet.        |
| `pnpm apply`      | Bring the stack up to date (publish + codegen) without serving the app. |
| `pnpm typecheck`  | `devstack apply`, then `tsc -b --noEmit`.                               |
| `pnpm test`       | Run `src/counter.test.ts` against the running stack.                    |
| `pnpm build`      | Apply, typecheck, and produce a production bundle in `dist/`.           |
| `devstack doctor` | Diagnose Docker / stack health.                                         |
| `devstack wipe`   | Tear down the stack's containers and reset its on-disk state.           |

## Add a local service

Each service is a few lines in `devstack.config.ts` plus its SDK. Add the new member to the host
service's `after` list so the app waits for it.

**Walrus** (blob storage) — `pnpm add @mysten/walrus @mysten/walrus-wasm`

```ts
import { walCoin, walrus } from '@mysten-incubation/devstack';

const storage = walrus({ local: { nodeCount: 1 } });
// fund alice with WAL:  funding: [..., { coin: walCoin(storage), amount: 500_000_000n }]
// gate the app on it:   after: [..., storage]
```

**Seal** (decentralized secrets) — `pnpm add @mysten/seal`

```ts
import { seal } from '@mysten-incubation/devstack';

const sealSigner = account('seal_signer', {
	kind: 'ephemeral',
	funding: [{ coin: 'sui', amount: 1_000_000_000n }],
});
const sealKeyServer = seal({ mode: 'local-keygen', signer: sealSigner });
// accounts: [alice, sealSigner]   (wallet)
// after: [..., sealKeyServer]     (host service)
// A real app also publishes its own Move package with a `seal_approve`
// policy and checks it through the key server.
```

**DeepBook** (on-chain CLOB) is not a one-liner: devstack doesn't synthesize a local DeepBook, so
you vendor the DeepBook + Pyth Move packages and configure publisher, pools, and price feeds
explicitly. Start from `examples/deepbook-trader` in the devstack repo.

For a richer app built the same way, see `examples/token-studio` in the
[ts-sdks-incubation](https://github.com/MystenLabs/ts-sdks-incubation) repo.
