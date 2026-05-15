// Minimal devstack config in the v4 Ref-based API.
//
// Each user concept (account, package, action, wallet, dev server) is a
// typed Ref returned by a single-call factory. Cross-references are
// values (`signer: alice`), not strings. `devstack(...)` auto-fills the
// sui localnet provider and emits the manifest sidecar.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { devstack } from '@mysten-incubation/devstack';
import {
	Account,
	Action,
	Dev,
	Package,
	Wallet,
} from '@mysten-incubation/devstack/services';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELLO_DIR = resolve(HERE, 'move/hello');

const alice = Account('alice');
const bob = Account('bob');

const hello = Package('hello', HELLO_DIR, { signer: alice });

const mintGreeting = Action('mint-greeting', {
	signer: alice,
	needs: [hello],
	build: (t) =>
		Effect.gen(function* () {
			const pkg = yield* hello;
			t.moveCall({
				target: `${pkg.packageId}::hello::mint`,
				arguments: [t.pure.vector('u8', Array.from(new TextEncoder().encode('hello, sui')))],
			});
		}),
});

const wallet = Wallet({
	accounts: [alice, bob],
	allowedOrigins: ['http://localhost:5179'],
});

// User app dev server — pinned to the port Playwright's webServer config
// uses. Sits in the APP section of the TUI and shows up under
// `Devstack.app.dev` in the runtime accessor.
const dev = Dev({
	command: 'pnpm',
	args: ['exec', 'vite', '--port', '5179'],
	ready: { kind: 'http', url: 'http://localhost:5179', timeoutMs: 60_000 },
	needs: [hello, wallet],
});

export default devstack(alice, bob, hello, mintGreeting, wallet, dev);
