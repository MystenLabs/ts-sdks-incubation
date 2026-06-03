// Sui plugin — Codegenable contribution.
//
// Architecture §6: plugins emit typed `CodegenableDecl`s; the
// codegen orchestrator stages files into the user's source tree
// WITHOUT naming the plugin. Sui's contribution is the active
// network: the active key (`network: "local"`) plus the
// `networks.local` entry (chain, mode, rpc, faucet, graphql,
// forkUpstream).
//
// The sui contribution is `aggregateOnly` — it projects directly into
// the combined `generated/config.ts` (`config.network` + `config.networks.local`)
// and emits NO standalone `sui/network.ts` (nothing imports a
// per-decl sui file anymore; consumers read `config.networks[config.network]`).

import { Effect } from 'effect';

import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { ResolvedSuiNetwork } from './network-resolver.ts';

/** The typed shape one `networks.<key>` entry in `config.ts` exports. */
export interface SuiNetworkConfigEntry {
	readonly chain: string;
	readonly mode: 'local' | 'local-rpc' | 'live' | 'fork';
	readonly rpc: string;
	readonly faucet: string | null;
	readonly graphql: string | null;
	/** Fork-only — upstream identity for known-package lookups. */
	readonly forkUpstream: string | null;
}

/** Aggregate projection: fold the resolved sui network into the
 *  combined `config.ts` aggregate as `network: "local"` plus
 *  `networks.local: {chain,mode,rpc,faucet,graphql,forkUpstream}`. The
 *  orchestrator stays plugin-name-blind and deep-merges this with each
 *  package's `packages.<name>` / `objects.<name>` contribution. */
const projectSuiConfig = (
	exported: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null => {
	const entry = exported['__suiNetworkEntry'];
	if (typeof entry !== 'object' || entry === null) return null;
	return {
		network: 'local',
		networks: { local: entry },
	};
};

/** Construct the Codegenable contribution. Emit is byte-deterministic
 *  on unchanged input (architecture: no mtime churn on no-op
 *  cycles). */
export const makeCodegenable = (resolved: ResolvedSuiNetwork): CodegenableDecl<'sui-network'> => {
	const entry: SuiNetworkConfigEntry = {
		chain: resolved.chain,
		mode: resolved.mode,
		rpc: resolved.rpc,
		faucet: resolved.faucet ?? null,
		graphql: resolved.graphql ?? null,
		forkUpstream: resolved.forkUpstream ?? null,
	};
	return {
		kind: 'codegenable',
		emitterName: 'sui-network',
		// Dead output path: `aggregateOnly` skips the standalone file.
		// Kept non-empty so path-resolution never sees a bare ''.
		outputPath: 'config.ts',
		aggregateOnly: true,
		aggregate: {
			kind: 'sui-network',
			bucket: 'config.ts',
			project: projectSuiConfig,
		},
		emit: (ctx) =>
			Effect.sync(() => {
				// The projector reads this off the exported map; the
				// standalone file is never written (aggregateOnly).
				ctx.exportConst('__suiNetworkEntry', entry);
				return ctx.done();
			}),
	};
};
