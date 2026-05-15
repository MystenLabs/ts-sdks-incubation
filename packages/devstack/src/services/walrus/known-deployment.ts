// `walrusKnownDeployment()` — pure-config handle pointing at a known
// testnet/mainnet deployment. Provides `WalrusNetwork`, `WalrusNodes`,
// and (when URLs are available) `WalrusProxy`. No `WalrusAdmin` — we
// never have admin power over a network we didn't boot.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Layer } from 'effect';
import type { StackMember } from '../../engine/supervisor.js';
import {
	WalrusNetwork,
	WalrusNodes,
	WalrusProxy,
	type WalrusNetworkShape,
	type WalrusNodeInfo,
	type WalrusNodesShape,
	type WalrusProxyShape,
} from '../walrus.js';
import { knownDeployments, type KnownNetwork } from '../../engine/known-deployments.js';

export interface WalrusKnownDeploymentOptions {
	readonly network?: KnownNetwork;
	readonly systemObjectId?: string;
	readonly stakingPoolId?: string;
	readonly subsidiesPackageId?: string;
	readonly exchangeIds?: ReadonlyArray<string>;
	readonly nodes?: ReadonlyArray<WalrusNodeInfo>;
	readonly aggregatorUrl?: string;
	readonly publisherUrl?: string;
	readonly proxyUrl?: string;
}

const KNOWN_DEPLOYMENT_KEY = 'walrusKnownDeployment';

export const walrusKnownDeployment = (options: WalrusKnownDeploymentOptions): StackMember => {
	// Look up the known-deployment record up-front so missing fields
	// trip a synchronous factory-time error rather than a deferred Layer
	// failure. When `network` isn't supplied, every required field must
	// be set explicitly — there's no record to fall back to.
	const known =
		options.network !== undefined ? knownDeployments.walrus[options.network] : undefined;

	const systemObjectId = options.systemObjectId ?? known?.systemObjectId;
	const stakingPoolId = options.stakingPoolId ?? known?.stakingPoolId;
	const subsidiesPackageId = options.subsidiesPackageId ?? known?.subsidiesPackageId;
	const exchangeIds = options.exchangeIds ?? known?.exchangeIds;
	const nodes = options.nodes ?? known?.nodes;
	const aggregatorUrl = options.aggregatorUrl ?? known?.aggregatorUrl;
	const publisherUrl = options.publisherUrl ?? known?.publisherUrl;
	const proxyUrl = options.proxyUrl ?? aggregatorUrl ?? publisherUrl;
	const network = options.network ?? 'custom';

	if (systemObjectId === undefined) {
		throw new Error(
			'walrusKnownDeployment: `systemObjectId` is required when `network` is not provided ' +
				'or when the known-deployment record lacks one.',
		);
	}
	if (stakingPoolId === undefined) {
		throw new Error(
			'walrusKnownDeployment: `stakingPoolId` is required when `network` is not provided ' +
				'or when the known-deployment record lacks one.',
		);
	}
	// The committee isn't statically registered — testnet has 100+ nodes
	// and the upstream `@mysten/walrus` SDK fetches them dynamically from
	// the staking pool. Surface the gap synchronously so consumers reach
	// for `walrusLocalCluster()` (local testing) or pass an explicit
	// committee list (production) instead of getting a confusing empty
	// `nodes` array at the first read.
	if (nodes === undefined) {
		throw new Error(
			`walrusKnownDeployment: Walrus ${network} committee has 100+ nodes and isn't ` +
				'statically registered. Pass ' +
				"`walrusKnownDeployment({ network, nodes: [...] })` with the explicit " +
				'committee list, OR use `walrusLocalCluster()` for local testing.',
		);
	}

	const networkShape: WalrusNetworkShape = {
		systemObjectId,
		stakingPoolId,
		subsidiesPackageId,
		exchangeIds,
		network,
		// SDK-ready view. Real testnet/mainnet values flow straight
		// from the registry to `new WalrusClient({ packageConfig })`.
		// `exchangeIds` is copied to a fresh mutable `string[]` here to
		// match `@mysten/walrus`'s `WalrusPackageConfig.exchangeIds: string[]`
		// — the source registry entry is `ReadonlyArray<string>`.
		packageConfig: {
			systemObjectId,
			stakingPoolId,
			...(exchangeIds !== undefined ? { exchangeIds: [...exchangeIds] } : {}),
		},
	};
	const nodesShape: WalrusNodesShape = { nodes };

	// Proxy is only provided when at least one of the URLs is reachable.
	// Without any URLs the consumer can't talk to walrus, so we'd rather
	// leave `WalrusProxy` unsatisfied (surfacing as ServiceNotFound) than
	// hand them back empty strings that would 404 at the first blob op.
	const hasProxy =
		proxyUrl !== undefined && aggregatorUrl !== undefined && publisherUrl !== undefined;

	const networkLayer = Layer.succeed(WalrusNetwork, networkShape);
	const nodesLayer = Layer.succeed(WalrusNodes, nodesShape);
	const proxyLayer = hasProxy
		? Layer.succeed(WalrusProxy, {
				proxyUrl: proxyUrl,
				aggregatorUrl: aggregatorUrl,
				publisherUrl: publisherUrl,
			} satisfies WalrusProxyShape)
		: undefined;

	const layers: Array<Layer.Layer<any, any, any>> = [networkLayer, nodesLayer];
	if (proxyLayer !== undefined) layers.push(proxyLayer);

	const combinedLayer = Layer.mergeAll(
		...(layers as [Layer.Layer<any, any, any>, ...Array<Layer.Layer<any, any, any>>]),
	);
	return {
		__layer: combinedLayer,
		__layers: layers,
		key: KNOWN_DEPLOYMENT_KEY,
		__kind: 'service' as const,
		__displayTitle: `walrus.${network}`,
	};
};
