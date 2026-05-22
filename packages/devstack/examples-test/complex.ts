// Complex callback-form stack with mode-narrowed factories,
// resource dependencies, and lifted siblings. The three
// `@ts-expect-error` directives demonstrate the type system catching:
//   1. removing a required dependency,
//   2. using a mode-incompatible factory,
//   3. two composites lifting siblings with conflicting `inputHash`
//      under the same `(plugin, kind, scope)` group.

import {
	chainId,
	defineDevstack,
	defineDevstackWith,
	defineModeNamespace,
	definePlugin,
	litSiblingKey,
	resource,
	sui,
} from '../src/index.ts';
import { Effect } from 'effect';
import type { NetworkConfig } from '../src/index.ts';

const keyvalResource = resource<'keyval', { readonly url: string }>('keyval');

const keyval = () =>
	definePlugin({
		id: keyvalResource.id,
		kind: 'leaf-long-running',
		start: () => Effect.succeed({ url: 'http://127.0.0.1:6379' } as const),
	});

const clusterImageSibling = <const Hash extends string>(hash: Hash) =>
	litSiblingKey('cluster', 'docker-image', 'per-app', hash);

const cluster = defineModeNamespace({
	local: {
		localCluster: () =>
			definePlugin({
				id: 'cluster',
				dependsOn: { leaf: keyvalResource },
				kind: 'composite',
				composite: { key: 'cluster' },
				liftedSiblings: [clusterImageSibling('cluster-image-v1')] as const,
				start: ({ leaf }) => Effect.succeed({ endpoint: leaf.url } as const),
			}),
	},
	fork: {
		forkedCluster: () =>
			definePlugin({
				id: 'cluster-fork',
				kind: 'leaf-one-shot',
				start: () => Effect.succeed({ endpoint: 'https://example.invalid' } as const),
			}),
	},
});

// --- Positive case ------------------------------------------------------
//
// Local-mode stack: keyval leaf + cluster composite (local factory).
// The composite depends on the `keyval` resource — the leaf provides it.

const localNetwork: NetworkConfig<'local'> = { mode: 'local', chain: chainId('demo:local') };

export const localStack = defineDevstackWith(
	{ network: localNetwork, stackName: 'complex-local' },
	(ctx) => [keyval(), cluster(ctx.network).localCluster()] as const,
);

// --- Flat form, manual threading ---------------------------------------

export const flatLocalStack = defineDevstack({
	members: [keyval(), cluster(localNetwork).localCluster()],
	stackName: 'complex-flat',
});

const suiExternal = sui({ mode: 'external', rpcUrl: 'http://127.0.0.1:9000' });
const resourceRefConsumer = definePlugin({
	id: 'resource-ref-consumer',
	dependsOn: { sui: suiExternal },
	kind: 'leaf-long-running',
	start: ({ sui }) => Effect.succeed({ chain: sui.chain } as const),
});

export const recursiveSuiDependencyStack = defineDevstack({
	members: [resourceRefConsumer],
	stackName: 'recursive-sui-dependency',
});

// --- Negative case 1: removing the required leaf dependency ------------
//
// Cluster depends on the keyval resource — without `keyval()` in the member set,
// MissingProviders<...> is `'keyval'` and the call site surfaces the
// branded `__MissingProvidersError` (architecture open-question #11).

// @ts-expect-error missing provider: keyval
export const missingDep = defineDevstack({
	members: [cluster(localNetwork).localCluster()],
	stackName: 'missing-dep',
});

// --- Negative case 2: mode-incompatible factory access -----------------
//
// `localCluster` exists only in the `'local'` branch of the cluster
// factory namespace; on a fork-typed network, the property is `never`.
// (Asserted as a standalone expression — wrapping it in a
// `defineDevstackWith` call poisons the outer member-tuple type with
// `any` and obscures whether the mode-narrowing check fired.)

const forkNetwork: NetworkConfig<'fork'> = {
	mode: 'fork',
	chain: chainId('demo:fork@1'),
	checkpoint: '1',
};

// @ts-expect-error — localCluster does not exist on the fork branch
export const _illegalModeFactory = cluster(forkNetwork).localCluster();

// Positive: forkedCluster IS available on the fork branch.
export const legalForkFactory = cluster(forkNetwork).forkedCluster();

// --- Negative case 3: lifted-sibling hash conflict ---------------------
//
// Two composites lifting siblings with the same (plugin, kind, scope)
// but DIFFERENT literal `inputHash` are refused by the type system at
// the stack composition site. We synthesize two composites that
// declare conflicting hashes by hand.

const compositeWithHashA = definePlugin({
	id: 'sibling-a',
	kind: 'composite',
	start: () => Effect.succeed({ v: 'a' as const }),
	liftedSiblings: [clusterImageSibling('hash-A')] as const,
});

const compositeWithHashB = definePlugin({
	id: 'sibling-b',
	kind: 'composite',
	start: () => Effect.succeed({ v: 'b' as const }),
	liftedSiblings: [clusterImageSibling('hash-B')] as const,
});

export const conflictingSiblings =
	// @ts-expect-error — sibling-hash conflict: 'cluster|docker-image|per-app' carries 'hash-A' and 'hash-B'
	defineDevstack({ members: [compositeWithHashA, compositeWithHashB], stackName: 'conflict' });
