// Complex callback-form stack with mode-narrowed factories,
// tag/provide dependencies, and lifted siblings. The three
// `@ts-expect-error` directives demonstrate the type system catching:
//   1. removing a required dependency,
//   2. using a mode-incompatible factory,
//   3. two composites lifting siblings with conflicting `inputHash`
//      under the same `(plugin, kind, scope)` group.

import { defineDevstack, defineDevstackWith, defineNodePlugin } from '../src/index.ts';
import { defineTag } from '../src/index.ts';
import { Effect } from 'effect';
import { cluster, clusterImageSibling } from '../src/samples/composite-plugin.ts';
import { keyval } from '../src/samples/trivial-leaf-plugin.ts';
import type { NetworkConfig } from '../src/index.ts';
import { chainId } from '../src/substrate/brand.ts';

// --- Positive case ------------------------------------------------------
//
// Local-mode stack: keyval leaf + cluster composite (local factory).
// The composite consumes `KeyvalTag` — the leaf provides it.

const localNetwork: NetworkConfig<'local'> = { mode: 'local', chain: chainId('demo:local') };

export const localStack = defineDevstackWith(
	{ network: localNetwork, stackName: 'complex-local' },
	(ctx) => [keyval(), cluster.for(ctx.network).localCluster()] as const,
);

// --- Flat form, manual threading ---------------------------------------

export const flatLocalStack = defineDevstack(keyval(), cluster.for(localNetwork).localCluster(), {
	stackName: 'complex-flat',
});

// --- Negative case 1: removing the required leaf dependency ------------
//
// Cluster consumes KeyvalTag — without `keyval()` in the member set,
// MissingProviders<...> is `'keyval'` and the call site surfaces the
// branded `__MissingProvidersError` (architecture open-question #11).

export const missingDep = defineDevstack(
	// @ts-expect-error — MissingProviders: 'keyval' (no member provides it)
	cluster.for(localNetwork).localCluster(),
	{ stackName: 'missing-dep' },
);

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
export const _illegalModeFactory = cluster.for(forkNetwork).localCluster();

// Positive: forkedCluster IS available on the fork branch.
export const legalForkFactory = cluster.for(forkNetwork).forkedCluster();

// --- Negative case 3: lifted-sibling hash conflict ---------------------
//
// Two composites lifting siblings with the same (plugin, kind, scope)
// but DIFFERENT literal `inputHash` are refused by the type system at
// the stack composition site. We synthesize two composites that
// declare conflicting hashes by hand.

const SiblingATag = defineTag<'sibling-a', { readonly v: 'a' }>('sibling-a', 'cluster');
const SiblingBTag = defineTag<'sibling-b', { readonly v: 'b' }>('sibling-b', 'cluster');

const compositeWithHashA = defineNodePlugin({
	provides: SiblingATag,
	consumes: [] as const,
	kind: 'composite',
	acquire: () => Effect.succeed({ v: 'a' as const }),
	liftedSiblings: [clusterImageSibling('hash-A')] as const,
});

const compositeWithHashB = defineNodePlugin({
	provides: SiblingBTag,
	consumes: [] as const,
	kind: 'composite',
	acquire: () => Effect.succeed({ v: 'b' as const }),
	liftedSiblings: [clusterImageSibling('hash-B')] as const,
});

export const conflictingSiblings =
	// @ts-expect-error — sibling-hash conflict: 'cluster|docker-image|per-app' carries 'hash-A' and 'hash-B'
	defineDevstack(compositeWithHashA, compositeWithHashB, { stackName: 'conflict' });
