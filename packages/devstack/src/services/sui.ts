// Sui(opts?) — the canonical sui factory. Collapses the four v3 sui
// factories (suiLocalnet / suiTestnet / suiMainnet / suiCustom) behind
// a single `network` option. Default network is `'localnet'`.
//
// Phase 2 delegates to the existing v3 factories; Phase 6 will inline
// the bodies once the old factories are deleted from the public surface.

import { Context, Effect, Schema } from 'effect';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { Endpoint } from '../engine/endpoint.js';
import { SuiError } from '../primitives/errors.js';
import {
	suiCustom,
	suiLocalnet,
	suiMainnet,
	suiTestnet,
	type SuiCustomOptions,
	type SuiLocalnetOptions,
	type SuiMainnetOptions,
	type SuiTestnetOptions,
} from '../primitives/sui.js';

// -----------------------------------------------------------------------------
// Contract
// -----------------------------------------------------------------------------

/** Shape every Sui-producing factory must satisfy.
 *
 *  - `network` accepts the well-known names plus an open string so
 *    bespoke chains (e.g. a pinned devnet snapshot, a tenant-specific
 *    fork) typecheck without losing literal narrowing on the common
 *    case.
 *  - `rpc` / `faucet` / `graphql` are `Endpoint`s carrying BOTH a
 *    host-reachable URL and (when meaningful) a docker-DNS URL plus
 *    the per-stack networks on which the docker-DNS form resolves.
 *    Host-side callers (browser, supervisor, host-CLI invocations)
 *    read `.host`; container-side callers (one-shot scripts, key-
 *    server config files, walrus storage-node env) read `.container`
 *    and attach to one of `.containerNetworks`. See
 *    `src/engine/endpoint.ts` for the full rationale (glibc's
 *    `.localhost` hardcode bypasses traefik for in-container DNS).
 *  - `faucet` is optional because mainnet has no faucet and testnet's
 *    faucet may be unreachable in restricted networks; localnet always
 *    surfaces one.
 *  - `graphql` mirrors the field the current `primitives/sui.ts`
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
 *    networks without a faucet (mainnet, suiCustom without `faucet`)
 *    where the chain is presumed always-transferable by definition.
 */
export interface SuiShape {
	readonly network: 'localnet' | 'testnet' | 'mainnet' | 'devnet' | (string & {});
	readonly rpc: Endpoint;
	readonly faucet?: Endpoint;
	readonly graphql?: Endpoint;
	readonly client: SuiJsonRpcClient;
	readonly chainId: string;
	readonly waitForTransactionsReady: () => Effect.Effect<void, SuiError>;
}

/** Canonical Sui service tag. Named `SuiTag` (not `Sui`) so the factory
 *  `Sui(opts?)` in this file can take the public-surface name. The
 *  Context key (`'@devstack/Sui'`) is unchanged, so any layer keyed
 *  against the legacy `Sui` class identity continues to resolve. */
export class SuiTag extends Context.Service<SuiTag, SuiShape>()('@devstack/Sui') {}

/** Runtime-validation mirror of `Endpoint`. Use inside
 *  `SuiShapeSchema` (and any future shape that carries an `Endpoint`)
 *  so a hand-rolled `Layer.succeed(SuiTag, ...)` shape can be validated
 *  end-to-end via `Schema.decode(SuiShapeSchema)`. */
export const EndpointSchema = Schema.Struct({
	host: Schema.String,
	container: Schema.optional(Schema.String),
	containerNetworks: Schema.optional(Schema.Array(Schema.String)),
});

/** Runtime-validation mirror of `SuiShape`. Use
 *  `Schema.decode(SuiShapeSchema)` to validate a hand-rolled
 *  `Layer.succeed(SuiTag, ...)`, or in tests where you want to assert
 *  the shape on yield. `client` is a live `SuiJsonRpcClient` — not
 *  Schema-validatable — so it's typed as `Unknown` here; decode the rest
 *  and accept `client` opaquely. `waitForTransactionsReady` is a method
 *  (also not Schema-validatable) so it lives outside the runtime mirror;
 *  hand-rolled `Layer.succeed(SuiTag, ...)` providers must still supply it. */
export const SuiShapeSchema = Schema.Struct({
	network: Schema.String,
	rpc: EndpointSchema,
	faucet: Schema.optional(EndpointSchema),
	graphql: Schema.optional(EndpointSchema),
	chainId: Schema.String,
	client: Schema.Unknown,
	waitForTransactionsReady: Schema.Unknown,
});

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

export interface SuiOptions {
	/** Which sui network to provide. Defaults to `'localnet'`, which
	 *  spins up a local sui-test-validator container with embedded
	 *  faucet + GraphQL. `'testnet'`/`'mainnet'` produce RPC-only
	 *  handles pointing at the public fullnodes. Pass an object form
	 *  (`{ rpc, faucet? }`) for custom RPC endpoints (corporate fullnodes,
	 *  pinned forks, air-gapped mirrors). */
	readonly network?:
		| 'localnet'
		| 'testnet'
		| 'mainnet'
		| { readonly rpc: string; readonly faucet?: string };

	/** Pass-through extras for the localnet variant. Ignored on testnet /
	 *  mainnet / custom. */
	readonly localnet?: Omit<SuiLocalnetOptions, never>;
	/** Pass-through extras for testnet. */
	readonly testnet?: Omit<SuiTestnetOptions, never>;
	/** Pass-through extras for mainnet. */
	readonly mainnet?: Omit<SuiMainnetOptions, never>;
}

/** The canonical sui factory. Returns a Ref that's both an Effect Layer
 *  and an Effect tag (`yield* Sui` gives the `SuiShape`).
 *
 *  Defaults to localnet. Pass `{ network: 'testnet' }` to switch nets, or
 *  `{ network: { rpc, faucet } }` for a custom RPC. */
export const Sui = (opts: SuiOptions = {}) => {
	const net = opts.network ?? 'localnet';
	if (typeof net === 'object') {
		const customOpts: SuiCustomOptions = {
			rpcUrl: net.rpc,
			...(net.faucet !== undefined ? { faucetUrl: net.faucet } : {}),
		};
		return Object.assign(suiCustom(customOpts), { __kind: 'service' as const });
	}
	if (net === 'testnet')
		return Object.assign(suiTestnet(opts.testnet ?? {}), { __kind: 'service' as const });
	if (net === 'mainnet')
		return Object.assign(suiMainnet(opts.mainnet ?? {}), { __kind: 'service' as const });
	return Object.assign(suiLocalnet(opts.localnet ?? {}), { __kind: 'service' as const });
};
