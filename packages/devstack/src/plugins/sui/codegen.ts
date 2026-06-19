// Sui plugin — Codegenable contribution, via the UNIFIED config-binding
// declaration.
//
// Architecture §6: plugins emit typed `CodegenableDecl`s; the codegen
// orchestrator stages files into the user's source tree WITHOUT naming the
// plugin. Sui's contribution is the active network: the active key
// (`network: "localnet"`) plus the `networks.localnet` entry (chainId, mode,
// rpc, faucet, graphql, forkUpstream).
//
// ONE declaration, TWO derivations. Sui declares its `config.ts`
// contributions ONCE as a `ConfigBindingSet`; the framework derives:
//   - the LIVE (boot) decl — bakes the resolved network entry into the
//     loadable deployment (so `assembleDeployment` reads it back), AND
//   - the STATIC (committed-tree) decl — emits `resolveNetwork()` /
//     `resolveNetworks()` raw expressions so the committed `config.ts`
//     carries NO network name and NO literal rpc URL (both are
//     environment/live data: a dynamic local rpc port; a real deployment
//     names a different network — resolved at app build/dev time via the
//     injected `__DEVSTACK_DEPLOYMENT__` global).
//
// The decl is `aggregateOnly` — it projects directly into the combined
// `generated/config.ts` (`config.network` + `config.networks.localnet`) and
// emits NO standalone `sui/network.ts`.

import { LOCAL_NETWORK_NAME } from '../../api/inference-network.ts';
import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import { configCodegenable, type ConfigBindingSet } from '../../contracts/config-bindings.ts';
import type { JsonValue } from '../../orchestrators/codegen/deployment.ts';
import type { ResolvedSuiNetwork } from './network-resolver.ts';

/** The typed shape one `networks.<key>` entry in `config.ts` exports. */
export interface SuiNetworkConfigEntry {
	/** Genesis-digest chain identifier of the running node (not the network
	 *  name, which is the `networks.<key>` key itself). */
	readonly chainId: string;
	readonly mode: 'local' | 'local-rpc' | 'live' | 'fork';
	readonly rpc: string;
	readonly faucet: string | null;
	readonly graphql: string | null;
	/** Fork-only — upstream identity for known-package lookups. */
	readonly forkUpstream: string | null;
}

/** The sui-plugin's config bindings, declared ONCE. Both the live boot decl
 *  and the static committed-tree decl are derived from this set:
 *   - `network`  — sugar `resolveNetwork()`  / live = `"localnet"`.
 *   - `networks` — sugar `resolveNetworks()` / live = `{ localnet: entry }`.
 *  The network NAME + connection map are environment/live data, so both are
 *  RESOLVED bindings (never literals). */
const suiConfigBindings = (): ConfigBindingSet<ResolvedSuiNetwork> => {
	const entryOf = (r: ResolvedSuiNetwork): JsonValue =>
		({
			chainId: r.chainId,
			mode: r.mode,
			rpc: r.rpc,
			faucet: r.faucet ?? null,
			graphql: r.graphql ?? null,
			forkUpstream: r.forkUpstream ?? null,
		}) satisfies SuiNetworkConfigEntry;

	return {
		bucket: 'config.ts',
		kind: 'sui-network',
		emitterName: 'sui-network',
		bindings: [
			{
				variant: 'resolved',
				configPath: ['network'],
				namespace: 'sui',
				key: 'network',
				sugar: { kind: 'network' },
				live: () => LOCAL_NETWORK_NAME,
			},
			{
				variant: 'resolved',
				configPath: ['networks'],
				namespace: 'sui',
				key: 'networks',
				sugar: { kind: 'networks' },
				live: (r) => ({ [LOCAL_NETWORK_NAME]: entryOf(r) }),
			},
		],
	} satisfies ConfigBindingSet<ResolvedSuiNetwork>;
};

/** The LIVE Codegenable contribution. Bakes the resolved network entry into
 *  the combined `config.ts` aggregate (chainId/rpc/faucet/graphql) — boot's
 *  `assembleDeployment` slices it back into the loadable deployment. */
export const makeCodegenable = (resolved: ResolvedSuiNetwork): CodegenableDecl =>
	configCodegenable(suiConfigBindings(), { mode: 'live', state: resolved });

/** The STATIC (stack-free) Codegenable contribution for the `codegen` verb.
 *  Emits `resolveNetwork()` / `resolveNetworks()` raw expressions — the
 *  committed `config.ts` carries no network name and no literal rpc URL. No
 *  id-resolver input needed (the values are injected, not config-derived). */
export const makeStaticCodegen = (): (() => ReadonlyArray<CodegenableDecl>) => () => [
	configCodegenable(suiConfigBindings(), 'static'),
];
