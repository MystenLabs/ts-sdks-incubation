// Pyth(opts) — canonical Pyth factory. Picks `pythLocalDeploy` on
// localnet (publishes vendored Pyth + creates PriceInfoObjects) and
// `pythKnownPackage` on testnet/mainnet (wraps canonical deployment).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { resolveNetwork } from '../engine/network.js';
import { resolveDeploymentNetwork } from '../engine/known-deployments.js';
import { makeService } from '../advanced/make-service.js';
import {
	pythKnownPackage,
	pythLocalDeploy,
	type PythKnownPackageOptions,
	type PythLocalDeployOptions,
} from './pyth/index.js';

export {
	PythTag,
	pythMid,
	PythPusher,
	SUI_PRICE_FEED_ID,
	DEEP_PRICE_FEED_ID,
	USDC_PRICE_FEED_ID,
} from './pyth/index.js';
export type {
	Pyth as PythShape,
	PythPriceInfo,
	PythMid,
	PythMidOptions,
	PythMidScale,
	PythPusherHandle,
	PythPusherOptions,
	PythPusherSource,
	PythPriceFeedId,
	PythPriceInfoSpec,
	PythPriceUpdate,
	PythLocalDeployOptions,
	PythLocalDeployFeedSpec,
	PythKnownPackageOptions,
} from './pyth/index.js';

export interface PythOptions {
	/** Pass-through extras for the local-deploy path
	 *  (signer, movePackagePath, feeds, etc.). */
	readonly local?: Omit<PythLocalDeployOptions<string>, 'name'>;
	/** Override tag name. Defaults to `'pyth'`. */
	readonly name?: string;
}

// Plugin authors who need to pin a private Pyth deployment (custom
// packageId, non-canonical state ids, or explicit price-info-object
// pinning) reach for `pythKnownPackage({...})` directly from
// `/advanced` — the canonical-only `Pyth()` factory intentionally
// exposes no `override:` surface (Wave 3 / §10.3): zero examples or
// tests ever set an override.

/** Canonical Pyth factory. Picks local-deploy on localnet and the
 *  canonical remote deployment on testnet/mainnet — single source of
 *  truth is `DEVSTACK_NETWORK`. Returns a LayeredTag carrying
 *  `PythTag`. */
export const Pyth = (opts: PythOptions = {}) => {
	const network = resolveNetwork();
	if (network !== 'localnet') {
		// On a known network, wire to the canonical Pyth deployment for
		// that network. `pythKnownPackage` derives PriceInfoObjects from
		// `knownDeployments.deepbook.<network>.coins`. Fork variants
		// resolve to their upstream's `KnownNetwork` via
		// `resolveDeploymentNetwork`. Plugin authors who need custom
		// packageId / state ids / explicit feeds reach for
		// `pythKnownPackage({...})` on `/advanced` directly.
		const knownNetwork = resolveDeploymentNetwork(network);
		if (knownNetwork === undefined) {
			throw new Error(
				`Pyth: no canonical deployment for network='${network}'. ` +
					`Use \`pythKnownPackage({...})\` on /advanced with explicit \`packageId\`/\`pythStateId\`/\`wormholeStateId\`.`,
			);
		}
		const knownOpts: PythKnownPackageOptions = { network: knownNetwork };
		return makeService('pyth', 'service', pythKnownPackage(knownOpts));
	}
	if (opts.local === undefined) {
		throw new Error(
			`Pyth: \`local\` config is required on localnet (signer + movePackagePath + feeds).`,
		);
	}
	const localOpts = {
		...(opts.name !== undefined ? { name: opts.name } : {}),
		...opts.local,
	} as Parameters<typeof pythLocalDeploy>[0];
	return makeService('pyth', 'service', pythLocalDeploy(localOpts));
};
