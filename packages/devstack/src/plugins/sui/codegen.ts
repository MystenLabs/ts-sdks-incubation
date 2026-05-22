// Sui plugin — Codegenable contribution.
//
// Architecture §6: plugins emit typed `CodegenableDecl`s; the
// codegen orchestrator stages files into the user's source tree
// WITHOUT naming the plugin. Sui's contribution is network
// metadata: the active RPC endpoint, the chain id, and (when
// applicable) the resolved known-package ids.
//
// Downstream consumers — chain-aware code (e.g. SDK boots, wallet
// pickers, frontend RPC selectors) — `import { suiNetwork } from
// '<staging>/sui/network'`; the generated module owns that exported
// value's type.

import { Effect } from 'effect';

import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { ResolvedSuiNetwork } from './network-resolver.ts';

/** The typed shape the emitted file exports. */
export interface SuiNetworkBindings {
	readonly chain: string;
	readonly mode: 'local' | 'external' | 'live' | 'fork';
	readonly rpcUrl: string;
	readonly faucetUrl: string | null;
	readonly graphqlUrl: string | null;
	/** Fork-only — upstream identity for known-package lookups. */
	readonly forkUpstream: string | null;
}

/** Construct the Codegenable contribution. Emit is byte-deterministic
 *  on unchanged input (architecture: no mtime churn on no-op
 *  cycles). */
export const makeCodegenable = (
	resolved: ResolvedSuiNetwork,
): CodegenableDecl<'sui-network'> => ({
	kind: 'codegenable',
	emitterName: 'sui-network',
	outputPath: 'sui/network.ts',
	emit: (ctx) =>
		Effect.sync(() => {
			const bindings: SuiNetworkBindings = {
				chain: resolved.chain,
				mode: resolved.mode,
				rpcUrl: resolved.rpc,
				faucetUrl: resolved.faucet ?? null,
				graphqlUrl: resolved.graphql ?? null,
				forkUpstream: resolved.forkUpstream ?? null,
			};
			ctx.exportConst('suiNetwork', bindings);
			return ctx.done();
		}),
});
