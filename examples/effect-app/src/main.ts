// Minimal Effect program consuming Devstack services via `provideDevstack`.
//
// The same `program` runs against a freshly-spun localnet in dev and a
// remote testnet RPC in prod — the only thing that changes is the layer
// passed to `Effect.provide`. That's the orthogonal-mixing pattern the
// `Sui` interface tag plus `suiLocalnet` / `suiTestnet` factories enable:
// the program depends on the tag, not on a specific factory.
//
// `accounts({...})`'s `from:` discriminator (Phase 8) lets the SAME
// program also bind its signer to different sources by env:
//
//   - dev:  `from: 'ephemeral-funded'` — fresh Ed25519 keypair, funded
//           by the localnet faucet, persisted under `.devstack/`.
//   - prod: `from: 'env', key: 'ALICE_PRIVATE_KEY'` — the secret comes
//           from the process environment; no funding, no persistence.

import { Effect } from 'effect';
import { runMain } from '@effect/platform-node/NodeRuntime';
import { accounts, provideDevstack, Sui, suiLocalnet, suiTestnet } from '@mysten-incubation/devstack-effect';

export const a =
	process.env.NODE_ENV === 'production'
		? accounts({ alice: { from: 'env', key: 'ALICE_PRIVATE_KEY' } })
		: accounts({ alice: { from: 'ephemeral-funded' } });

/**
 * Pure connect-and-print program — `Sui` interface tag + `a.alice` are
 * the only services it reaches for, so a unit test can verify the
 * happy-path by providing a stub `Sui` layer + a fake `alice` layer
 * instead of spinning up a real localnet.
 */
export const program = Effect.gen(function* () {
	const sui = yield* Sui;
	const alice = yield* a.alice;
	yield* Effect.log(`connected to sui ${sui.network} at ${sui.rpcUrl}`);
	yield* Effect.log(`chain id: ${sui.chainId}`);
	yield* Effect.log(`alice: ${alice.address}`);
});

const layer =
	process.env.NODE_ENV === 'production'
		? provideDevstack([suiTestnet(), a.alice])
		: provideDevstack([suiLocalnet(), a.alice]);

// Only run when invoked as a script (e.g. `tsx src/main.ts`). Without
// this guard, importing the module from a vitest test would also boot
// a real sui-localnet inside the test process.
if (import.meta.url === `file://${process.argv[1]}`) {
	runMain(program.pipe(Effect.provide(layer)));
}
