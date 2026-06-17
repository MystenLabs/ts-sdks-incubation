# Devstack app

A Sui dapp wired to a local devstack. One command boots everything this app needs.

```bash
pnpm install
pnpm dev
```

`pnpm dev` boots a Sui localnet (plus any services in `devstack.config.ts`) in Docker, funds the dev
account, publishes `move/counter`, serves the app with a browser dev wallet injected, and prints the
dashboard URL. It injects the live stack's ids into the build automatically; it does not rewrite the
committed `src/generated/` tree (run `pnpm codegen` for that).

## Day-2 commands

| Command           | What it does                                                                  |
| ----------------- | ---------------------------------------------------------------------------- |
| `pnpm dev`        | Boot (or reuse) the `dev` stack and serve the app with the dev wallet; injects live ids automatically. |
| `pnpm codegen`    | Regenerate `src/generated` bindings after a Move source change — deterministic, stack-free. |
| `pnpm apply`      | Bring the stack up to date and re-emit the live ids file + dev extras, without serving the app. Does not rewrite the committed `src/generated`. |
| `pnpm typecheck`  | `tsc -b --noEmit` — stack-free.                                             |
| `pnpm test`       | Unit tests (`src/**/*.test.ts`) — fast, boots nothing.                       |
| `pnpm test:e2e`   | Full-stack tests (`src/**/*.e2e.test.ts`) — auto-boots a throwaway `test` stack (parallel-safe with `pnpm dev`), then tears it down. |
| `pnpm build`      | `tsc -b && vite build` — stack-free, no Docker; produces `dist/`. Works on a clean clone. |
| `devstack doctor` | Diagnose Docker / stack health.                                             |
| `devstack wipe`   | Tear down the stack's containers and reset its on-disk state.               |

The committed `src/generated/config.ts` carries no on-chain ids — it resolves them at runtime
from values injected at build time. `pnpm dev` injects the live stack's ids automatically.
`pnpm build` is deterministic and stack-free: a build with no injected ids throws
`DevstackConfigMissingError` at runtime rather than silently shipping zeros.

## Deploy to a real network

A production build needs a known deployment's id-config file — the same `devstack-ids.json`
schema the local stack writes. The supported way to obtain one is `devstack dump-ids`, or
hand-author one:

```bash
# Option A: boot against the target network, then dump its ids to a committed file
devstack up --network testnet
devstack dump-ids --network testnet --out config/testnet.ids.json
```

For the full id-config schema (Option B, hand-authoring) see the canonical
[Deploy to a real network](https://ts-sdks-incubation.vercel.app/devstack/features/codegen#deploy-to-a-real-network)
section in the devstack docs. Commit the file, then point the build at it via the Vite plugin
option or env:

```ts title="vite.config.ts"
devstackVitePlugin({ ids: './config/testnet.ids.json' });
```

```bash
DEVSTACK_IDS_FILE=./config/testnet.ids.json pnpm build
```

Then deploy the static `dist/` bundle. A build with no ids throws `DevstackConfigMissingError`
at runtime — loud, not a silent zero.

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
