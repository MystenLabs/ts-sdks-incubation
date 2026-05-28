// Sui plugin — resolved network identity.
//
// Plugin-internal projection of the resolved mode's identity. Populated
// by the mode-specific builder (`mode/{local,external,live,fork}.ts`)
// and consumed by `codegen.ts` (Codegenable bindings) and the per-mode
// boot results that feed `service.ts` / `index.ts`.
//
// Mode → substrate `NetworkMode` mapping (informational, applied at
// `Codegenable` construction):
//
//   - `local`     → `mode: 'local'`
//   - `local-rpc` → `mode: 'local'` (the chain itself is still local
//                    in semantics — caller wrapped their own localnet;
//                    downstream plugins shouldn't branch on
//                    container-vs-local-rpc below this layer).
//   - `live`     → `mode: 'live'`
//   - `fork`     → `mode: 'fork'` — and the resolver SHALL emit the
//                   upstream's REAL chain id, not a fork-local digest,
//                   so wallet-standard / MVR / known-package lookups
//                   work.

import type { ChainId } from '../../substrate/brand.ts';
import type { SuiPluginMode } from './mode/spec.ts';

/** Plugin-internal shape — the resolved mode's identity, populated
 *  by the mode-specific builder. */
export interface ResolvedSuiNetwork {
	readonly mode: SuiPluginMode;
	/** Branded chain identity — assembled by the mode builders so
	 *  downstream lookups (chain-probe / faucet capability keys) and
	 *  the substrate's `NetworkConfig` projection both accept it without
	 *  a re-wrap. */
	readonly chain: ChainId;
	readonly rpc: string;
	readonly faucet?: string;
	readonly graphql?: string;
	readonly source: 'cli' | 'env' | 'config' | 'default';
	/** Fork-only: upstream + checkpoint pin. */
	readonly checkpoint?: string;
	readonly forkUpstream?: 'mainnet' | 'testnet' | 'devnet';
}
