// Interface contract for the Sui service.
//
// Phase 1 (this file) defines the canonical Sui tag + shape that every
// upstream factory (`suiLocalnet`, `suiTestnet`, `suiMainnet`, `suiCustom`
// in Phase 3) will produce a `Layer<Sui>` for. Consumers `yield* Sui`
// inside their Effect.gen body and receive `SuiShape` regardless of
// which factory wired the layer.
//
// Phase 1 intentionally does NOT touch `primitives/sui.ts`; the existing
// `Sui` class there shares the same Context key (`'@devstack/Sui'`) so
// the two are interchangeable at runtime (Context lookup is keyed on the
// string identifier, not class identity). Phase 3 will collapse them.

import { Context, Effect, Schema } from 'effect';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { SuiError } from '../primitives/errors.js';

/** Shape every Sui-producing factory must satisfy.
 *
 *  - `network` accepts the well-known names plus an open string so
 *    bespoke chains (e.g. a pinned devnet snapshot, a tenant-specific
 *    fork) typecheck without losing literal narrowing on the common
 *    case.
 *  - `faucetUrl` is optional because mainnet has no faucet and testnet's
 *    faucet may be unreachable in restricted networks; localnet always
 *    surfaces one.
 *  - `graphqlUrl` mirrors the field the current `primitives/sui.ts`
 *    primitive already populates — keeping it in the canonical shape
 *    means Phase 3's multi-impl factories don't lose coverage.
 *  - `chainId` is the checkpoint-0 digest; downstream primitives fold it
 *    into their `StateStore` cache keys so artifacts re-derive when the
 *    chain underneath them is wiped.
 *  - `waitForTransactionsReady` upgrades the socket-level "ready" the
 *    Sui primitive declares (RPC + faucet + GraphQL all listening) into
 *    a "the chain can actually transfer funds" guarantee. The default
 *    Sui-ready gate only proves the HTTP servers are bound — the
 *    underlying validator may still be mid-genesis and the faucet may
 *    still be returning body-level `{status: {Failure: ...}}`. Any
 *    primitive that immediately submits a funds-transferable tx after
 *    yielding `Sui` (faucet POSTs, signed transfers, package publishes)
 *    must call this method first or be prepared to absorb a cold-start
 *    `Failure` storm via its own retry budget. Resolves immediately on
 *    networks without a faucet (mainnet, suiCustom without `faucetUrl`)
 *    where the chain is presumed always-transferable by definition.
 */
export interface SuiShape {
	readonly rpcUrl: string;
	readonly chainId: string;
	readonly client: SuiJsonRpcClient;
	readonly network: 'localnet' | 'testnet' | 'mainnet' | 'devnet' | (string & {});
	readonly faucetUrl?: string;
	readonly graphqlUrl?: string;
	readonly waitForTransactionsReady: () => Effect.Effect<void, SuiError>;
}

/** Canonical Sui service tag. */
export class Sui extends Context.Service<Sui, SuiShape>()('@devstack/Sui') {}

/** Runtime-validation mirror of `SuiShape`. Use
 *  `Schema.decode(SuiShapeSchema)` to validate a hand-rolled
 *  `Layer.succeed(Sui, ...)`, or in tests where you want to assert the
 *  shape on yield. `client` is a live `SuiJsonRpcClient` — not
 *  Schema-validatable — so it's typed as `Unknown` here; decode the rest
 *  and accept `client` opaquely. `waitForTransactionsReady` is a method
 *  (also not Schema-validatable) so it lives outside the runtime mirror;
 *  hand-rolled `Layer.succeed(Sui, ...)` providers must still supply it. */
export const SuiShapeSchema = Schema.Struct({
	rpcUrl: Schema.String,
	chainId: Schema.String,
	client: Schema.Unknown,
	network: Schema.String,
	faucetUrl: Schema.optional(Schema.String),
	graphqlUrl: Schema.optional(Schema.String),
	waitForTransactionsReady: Schema.Unknown,
});
