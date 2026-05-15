// Deepbook(opts) — canonical Deepbook factory. Picks local-deploy or
// known-package based on `mode`. Returns a single Ref carrying the
// resolved deepbook deployment (package id, pools).
//
// Market-making is a separate factory (`DeepbookMarketMaker`) so the
// caller can compose order: it typically `needs:` the deploy ref + a
// seed-tokens action so balances are present before the first tick.

import {
	deepbookKnownPackage,
	deepbookLocalDeploy,
	deepbookMarketMaker,
	type DeepbookKnownPackageOptions,
} from '../primitives/deepbook/index.js';
import { withSection } from './ref.js';

export interface DeepbookOptions {
	/** Which Deepbook source. `'auto'` picks `'local'` by default. */
	readonly mode?: 'auto' | 'local' | 'known';
	/** Pass-through extras for the local-deploy path. See
	 *  `DeepbookLocalDeployOptions` for the full surface. */
	readonly local?: Record<string, unknown>;
	/** Pass-through extras for the known-package path. */
	readonly known?: DeepbookKnownPackageOptions;
	/** Override tag name. Defaults to `'deepbook'`. */
	readonly name?: string;
}

const resolveMode = (opts: DeepbookOptions): 'local' | 'known' => {
	if (opts.mode === 'local' || opts.mode === 'known') return opts.mode;
	return 'local';
};

/** Deepbook factory. Returns a single Ref that resolves to the deployed
 *  package id + pool map. Pair with {@link DeepbookMarketMaker} when
 *  continuous liquidity is needed. */
export const Deepbook = (opts: DeepbookOptions = {}) => {
	const mode = resolveMode(opts);
	if (mode === 'known') {
		return withSection(deepbookKnownPackage(opts.known ?? {}), 'service');
	}
	const localOpts = {
		...(opts.name !== undefined ? { name: opts.name } : {}),
		...(opts.local ?? {}),
	} as Parameters<typeof deepbookLocalDeploy>[0];
	return withSection(deepbookLocalDeploy(localOpts), 'service');
};

/** Market-maker factory. Spawns a fiber that posts POST_ONLY orders on
 *  each named pool. Typically `needs:` the {@link Deepbook} deploy ref
 *  + whatever seeds the maker's balance manager with inventory. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DeepbookMarketMaker = (opts: any) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	withSection((deepbookMarketMaker as any)(opts), 'action');
