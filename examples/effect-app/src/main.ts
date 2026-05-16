// Minimal Effect program consuming Devstack services via the Ref API.
//
// The same `program` runs against a freshly-spun localnet in dev and a
// remote testnet RPC in prod. Network is selected via the
// `DEVSTACK_NETWORK` env var (or the `devstack --network <kind>` CLI
// flag) — `Sui()` reads it at construction time, so the same
// `Sui()` call resolves to whichever network is active. Only the
// `from:` parameter on `Account(...)` flips on env, because account
// sources are intrinsically environment-shaped (ephemeral keypair vs
// env-supplied key).

import { Effect } from 'effect';
import { runMain } from '@effect/platform-node/NodeRuntime';
import { Account, devstack, Sui } from '@mysten-incubation/devstack';

const isProduction = process.env.NODE_ENV === 'production';

export const alice = isProduction
	? Account('alice', { from: 'env', key: 'ALICE_PRIVATE_KEY' })
	: Account('alice', { from: 'ephemeral-funded' });

export const sui = Sui();

/**
 * Pure connect-and-print program. Depends on the local `sui` + `alice`
 * Refs — a unit test can stub both via `Effect.provide` without spinning
 * up a real localnet.
 */
export const program = Effect.gen(function* () {
	const s = yield* sui;
	const a = yield* alice;
	yield* Effect.log(`connected to sui ${s.network} at ${s.rpc.host}`);
	yield* Effect.log(`chain id: ${s.chainId}`);
	yield* Effect.log(`alice: ${a.address}`);
});

const stack = devstack(sui, alice);

// Only run when invoked as a script (e.g. `tsx src/main.ts`). Without
// this guard, importing the module from a vitest test would also boot
// a real sui-localnet inside the test process.
if (import.meta.url === `file://${process.argv[1]}`) {
	// `Effect.provide(stack.layer)` removes all requirements from the
	// program; the resulting `R = never` is what `runMain` accepts. The
	// cast is required because v3 program types widen R to `any` (via the
	// v3-style `PluginTag<any, ...>` cross-refs in the Account factory)
	// and `any - unknown` resolves to `any` rather than `never` in TS.
	// Functionally identical to v3's `runMain(...pipe(Effect.provide(...)))`.
	runMain(program.pipe(Effect.provide(stack.layer)) as Effect.Effect<void, never, never>);
}
