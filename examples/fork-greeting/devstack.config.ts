// Fork-greeting app — minimal sui-fork harness.
//
// Stands up a `testnet-fork` (small upstream chunk + cheap restart vs.
// `mainnet-fork`), publishes a tiny `greeting::board` Move package, and
// surfaces the shared `Board` object's id through `package.captured` so
// the frontend (and the e2e spec) can write + read without scanning
// chain state.
//
// Account('publisher') auto-promotes to impersonation against the
// `Sui({fork:{seed:{addresses}}})` list — there's no faucet on a fork,
// so devstack pays for publish + module-init via the empty-signature
// branch of `executeImpersonated`. The first seeded address pays for
// the publish; remaining seeds back the per-user 'alice' / 'bob'
// accounts that the e2e spec drives.
//
// See `notes/sui-fork-integration.md` P2.T6 and
// `notes/sui-fork-phase-5.md` §1–§7 for the broader plan this harness
// gates: walrus-on-fork (P5.1), seal-on-fork (P5.3), auto-tick (P5.5),
// parallel stacks (P5.6), and dev-wallet fork controls (P5.8).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, Codegen, Dev, devstack, Sui, Wallet } from '@mysten-incubation/devstack';
import { PackageWithCapture } from '@mysten-incubation/devstack/advanced';

const HERE = dirname(fileURLToPath(import.meta.url));
const GREETING_DIR = resolve(HERE, 'move/greeting');

// Seed addresses for fork-mode impersonation. These need to be funded
// addresses on the upstream chain (testnet) so devstack's auto-promoted
// accounts can pay gas + fund downstream ephemerals.
//
// Configurable via env: pass a comma-separated list of `0x…` addresses
// in `FORK_SEED_ADDRESSES` to point the harness at your own seeded
// wallets. The fallback below targets a placeholder address — replace
// before `pnpm dev` or the publish will fail with insufficient gas.
//
// When you run `pnpm dev`, devstack records these in the fork's seed
// manifest on first boot — subsequent boots resume from the same seeds
// (changing them after the manifest exists is a hard error per the
// `seed_manifest.json` invariant).
const FORK_SEED_ADDRESSES: ReadonlyArray<string> = (
	process.env['FORK_SEED_ADDRESSES']?.split(',').map((s) => s.trim()) ?? [
		// Placeholder — override via `FORK_SEED_ADDRESSES` env var with a
		// real testnet address whose private key you control (so devstack's
		// fork impersonation can drain it for publish + downstream funding).
		'0x0000000000000000000000000000000000000000000000000000000000000001',
	]
).filter((s) => s.length > 0);

const sui = Sui({
	network: 'testnet-fork',
	fork: {
		seed: {
			addresses: FORK_SEED_ADDRESSES,
		},
	},
});

// `Account('publisher')` against a fork-mode `Sui` auto-promotes to
// `{kind: 'impersonate', sender: <first-seed>}` per the Phase-2
// auto-promotion rule in `services/account.ts`. The same applies to
// `alice` / `bob` — each is bound to a seed address from the fork's
// seed list so the e2e can drive distinct senders.
const publisher = Account('publisher');
const alice = Account('alice');
const bob = Account('bob');

// Publish the greeting package. The Move `init` function auto-shares a
// `Board`; we capture its id via `PackageWithCapture` so the frontend
// has a stable shared-object id to read + write against. The captured
// id surfaces both on the resolved tag (`pkg.captured.boardId`) and in
// the manifest's `packages.greeting.captured.boardId` slot.
const greeting = PackageWithCapture('greeting', GREETING_DIR, {
	signer: publisher,
	capture: { boardId: '::board::Board' },
});

const wallet = Wallet({
	accounts: [publisher, alice, bob],
	allowedOrigins: ['http://dev.fork-greeting.localhost:5175', 'http://localhost:5181'],
});

// Codegen emits typed move bindings + the dapp-kit config (with the
// fork-network translation per Phase 3 P3.T8 — the dapp-kit sees the
// upstream `'testnet'` literal even though the manifest carries
// `'testnet-fork'`).
const codegen = Codegen({ packages: [greeting] });

const dev = Dev({
	command: 'pnpm',
	args: ['exec', 'vite', '--host', '0.0.0.0', '--strictPort', '--port', '{port}'],
	port: 5181,
	needs: [greeting, wallet, codegen],
});

export default devstack(sui, publisher, alice, bob, greeting, wallet, codegen, dev, {
	// Disable hot-restart under playwright. The package's first publish
	// touches files inside `move/greeting/` (Move.lock + build/), which
	// trips the file watcher's restart — playwright's webServer then
	// races vite's brief death against the test's first navigation and
	// intermittently sees a 502. Mirrors arena's pattern.
	hotRestart: process.env['PLAYWRIGHT'] === '1' ? false : undefined,
});
