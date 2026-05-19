// Pyth(opts) — canonical Pyth factory. Picks `pythLocalDeploy` on
// localnet (publishes vendored Pyth + creates PriceInfoObjects) and
// `pythKnownPackage` on testnet/mainnet (wraps canonical deployment).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { resolveNetwork } from '../engine/network.js';
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
	/** Override the canonical Pyth deployment for testnet/mainnet. */
	readonly override?: PythKnownPackageOptions;
	/** Override tag name. Defaults to `'pyth'`. */
	readonly name?: string;
}

/** Canonical Pyth factory. Picks local-deploy on localnet and the
 *  canonical remote deployment on testnet/mainnet — single source of
 *  truth is `DEVSTACK_NETWORK`. Returns a LayeredTag carrying
 *  `PythTag`. */
export const Pyth = (opts: PythOptions = {}) => {
	const network = resolveNetwork();
	if (network !== 'localnet') {
		// On a known network, `opts.override` is the source-of-truth.
		if (opts.override === undefined) {
			throw new Error(
				`Pyth: \`override\` is required on network='${network}'. ` +
					`Pass an explicit \`packageId\` + optional \`pythStateId\` / \`wormholeStateId\`.`,
			);
		}
		return Object.assign(pythKnownPackage(opts.override), { __kind: 'service' as const, __pluginName: 'pyth' });
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
	return Object.assign(pythLocalDeploy(localOpts), { __kind: 'service' as const, __pluginName: 'pyth' });
};
