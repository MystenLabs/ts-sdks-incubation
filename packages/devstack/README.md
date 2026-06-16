# @mysten-incubation/devstack

Devstack composes a local Sui development environment from one TypeScript config. It can boot Sui,
fund accounts, publish Move packages, run the dev wallet, start app servers, wire services such as
Walrus, Seal, and DeepBook, and generate typed files for app and test code.

The current docs live at <https://ts-sdks-incubation.vercel.app/devstack>.

## Quick Start

Scaffold a new app from the canonical template:

```bash
pnpm create @mysten-incubation/devstack-app@latest my-app
cd my-app
pnpm dev
```

Or add devstack to an existing app:

```bash
pnpm add @mysten-incubation/devstack @mysten-incubation/dev-wallet @mysten/signers
pnpm add -D @mysten-incubation/tsconfig
```

Then create a `devstack.config.ts` in your app:

```ts
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	defineDevstack,
	HOST_SERVICE_PORT_TOKEN,
	hostService,
	localPackage,
	sui,
	wallet,
} from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = 5173;

const localnet = sui();
const publisher = account('publisher');
const alice = account('alice');

const hello = localPackage('hello', {
	sourcePath: resolve(HERE, 'move/hello'),
	publisher,
});

const devWallet = wallet({
	accounts: [publisher, alice],
});

const app = hostService({
	name: 'app',
	script: `pnpm exec vite --host 127.0.0.1 --strictPort --port ${HOST_SERVICE_PORT_TOKEN}`,
	cwd: HERE,
	port: DEV_PORT,
	ready: { kind: 'http' },
	after: [hello, devWallet] as const,
});

export default defineDevstack({
	members: [localnet, app],
	stackName: 'main',
	codegen: { outputDir: 'src/generated' },
});
```

Listed `members` are entrypoints. Transitive plugin dependencies expand automatically via
`runPluginExpanders`, so dependencies referenced through `dependsOn` (and the `wallet` /
`hostService` resource refs above) are pulled into the stack without being listed explicitly.

Run the stack during development:

```bash
pnpm devstack up
```

Reconcile from another shell, CI, or before typechecking, building, or tests:

```bash
pnpm devstack apply
```

If `pnpm devstack up` is already live for this stack, `apply` asks that supervisor to reconcile and
waits for completion. Without a live supervisor, it runs one-shot setup and exits.

Generated files are written under `src/generated` by default. Runtime state, manifests, snapshots,
and logs stay under `.devstack/`.

## Package Surface

- Root API: stack composition, built-in factories, plugin-author helpers, and public types.
- CLI: `devstack up`, `apply`, `status`, `doctor`, `config`, `schema`, `snapshot`, `prune`, and
  `wipe`. `--json` is a global flag that switches any verb to JSON output.
- Build integrations: `@mysten-incubation/devstack/vitest`, `/playwright`, `/vite`, `/runtime`, and
  `/dapp-kit`.

App code should consume generated files and the runtime manifest. It should not import devstack
engine internals directly.

## Docs

- [Quickstart](https://ts-sdks-incubation.vercel.app/devstack/quickstart)
- [Local development](https://ts-sdks-incubation.vercel.app/devstack/features/local-dev)
- [Vitest integration](https://ts-sdks-incubation.vercel.app/devstack/features/testing-vitest)
- [Playwright integration](https://ts-sdks-incubation.vercel.app/devstack/features/testing-playwright)
- [Services](https://ts-sdks-incubation.vercel.app/devstack/features/services)
