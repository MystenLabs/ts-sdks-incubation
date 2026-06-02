// Thin app-level projection of the generated runtime config.
//
// Re-exports the generated `config` (networks + packages + objects) and
// exposes `activeNet()` — the resolved endpoint block for the currently
// selected network (`config.networks[config.network]`). Keeping this in
// one place means panels never reindex `config.networks[...]` by hand.

import { config } from '@generated/config.js';

export { config };

/** Shape of the generated runtime config. The codegen emits only the
 *  `config` value (a `const` literal), so the type is derived from it
 *  here rather than imported. */
export type GeneratedConfig = typeof config;

/** The resolved network block (chain/mode/rpc/faucet/graphql) for the
 *  active network selected by `config.network`. */
export function activeNet() {
	return config.networks[config.network];
}
