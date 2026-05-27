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
	readonly mode: 'local' | 'local-rpc' | 'live' | 'fork';
	readonly rpcUrl: string;
	readonly faucetUrl: string | null;
	readonly graphqlUrl: string | null;
	/** Fork-only — upstream identity for known-package lookups. */
	readonly forkUpstream: string | null;
}

/** Aggregate projection: fold the emitted `suiNetwork` shape into
 *  the cross-plugin `services.ts` aggregate at `services.sui`. The
 *  orchestrator stays plugin-name-blind; this projector owns the
 *  `{ rpc, faucet, graphql }` shape decision. */
const projectSuiNetworkServices = (
	exported: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null => {
	const network = exported['suiNetwork'];
	if (typeof network !== 'object' || network === null) return null;
	const record = network as Readonly<Record<string, unknown>>;
	const rpcUrl = stringField(record, 'rpcUrl');
	const faucetUrl = stringField(record, 'faucetUrl');
	const graphqlUrl = stringField(record, 'graphqlUrl');
	return {
		sui: {
			rpc: { url: rpcUrl ?? '' },
			faucet: faucetUrl === null ? null : { url: faucetUrl },
			graphql: graphqlUrl === null ? null : { url: graphqlUrl },
		},
	};
};

const stringField = (record: Readonly<Record<string, unknown>>, key: string): string | null => {
	const value = record[key];
	return typeof value === 'string' && value.length > 0 ? value : null;
};

/** Construct the Codegenable contribution. Emit is byte-deterministic
 *  on unchanged input (architecture: no mtime churn on no-op
 *  cycles). */
export const makeCodegenable = (resolved: ResolvedSuiNetwork): CodegenableDecl<'sui-network'> => ({
	kind: 'codegenable',
	emitterName: 'sui-network',
	outputPath: 'sui/network.ts',
	aggregate: {
		kind: 'sui-network',
		bucket: 'services.ts',
		project: projectSuiNetworkServices,
	},
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
