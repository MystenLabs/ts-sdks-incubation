// Walrus composite-primitive contribution.
//
// Distilled-doc reference (06-walrus.md §"Lifecycle" + §"TUI rows"):
// Walrus is the canonical composite primitive — one engine row,
// many children. The composite presents as ONE supervisor row
// (`walrus.cluster`) while internally composing N storage-node
// containers + 1 deploy one-shot + 2 lifted siblings (cargo image,
// move source).
//
// Architecture (composite-primitive contract):
//
//   - `compositeKey`        — the substrate-level plugin key. One
//                              row in the engine row table.
//   - `liftedSiblings`      — the cargo-image + move-source sibling
//                              keys. Level-0 leaves in the topo
//                              graph; first-wins dedup across
//                              composites.
//   - `innerParticipants`   — the per-child member shape. The
//                              substrate drives their lifecycle
//                              through the same acquire pipeline,
//                              and routes all their narration onto
//                              this composite's row.
//   - `narrate(childKey)`   — per-child phase narration. The
//                              composite aggregates these under
//                              `narrationByContributor`.
//
// Phase narration vocabulary used here:
//   - 'image-build'      — wrapper image build (upstream is a
//                           sibling, already-ready at this point).
//   - 'cluster-network'  — docker network create.
//   - 'deploy'           — `walrus-deploy` one-shot.
//   - 'storage-node-<i>' — per-node startup narration.
//   - 'proxy-pick'       — picking nodes[0].rpcUrl as the proxy URL.
//   - 'seed-wal'         — SUI → WAL swap for seed accounts.
//   - 'register'         — registry publish.
//
// Distilled-doc opportunity #2: the v3 codebase has two parallel
// vocabularies (human phase strings vs WalrusError phase tags). We
// unify here on the closed-set WalrusPhase enum from `errors.ts`
// so the narration string IS the failure tag.

import { Effect, type Scope } from 'effect';

import type { CompositePrimitiveDecl } from '../../contracts/composite-primitive.ts';
import type { LiftedSiblingKey } from '../../substrate/lifted-sibling.ts';
import type { PhaseNarration } from '../../substrate/lifecycle.ts';
import type { PluginKey } from '../../substrate/brand.ts';
import { pluginKey } from '../../substrate/brand.ts';
import type { AnyPlugin } from '../../substrate/plugin.ts';

/** Build the CompositePrimitive contribution.
 *
 *  `innerParticipants` is the substrate-side view of the children:
 *  for the local-cluster path, this is N storage-node plugins + 1
 *  deploy-one-shot member; for known-deployment, this is empty
 *  (the resolved value is a pure projection — no inner children to
 *  drive a lifecycle for).
 *
 *  The `narrate(childKey)` mapping routes inner-participant phase
 *  events onto the composite's row. */
export const makeWalrusComposite = (args: {
	readonly compositeKey: string;
	readonly liftedSiblings: ReadonlyArray<LiftedSiblingKey>;
	readonly innerParticipants: ReadonlyArray<AnyPlugin>;
}): CompositePrimitiveDecl => ({
	kind: 'composite-primitive',
	compositeKey: pluginKey(args.compositeKey),
	liftedSiblings: args.liftedSiblings,
	innerParticipants: args.innerParticipants,
	narrate: makeNarrator(),
});

/** Build the per-child narration callback. The substrate calls this
 *  with a child key and gets back an Effect that emits a phase
 *  narration. The body returns a static phase string projected from
 *  the child key; the supervisor's lifecycle dispatch handles the
 *  per-child fiber narration. */
const makeNarrator =
	() =>
	(childKey: PluginKey): Effect.Effect<PhaseNarration, never, Scope.Scope> =>
		Effect.succeed(narrationForChild(childKey));

/** Project a child key onto the composite's phase vocabulary. The
 *  closed phase set is anchored by `WalrusPhase` from `errors.ts` —
 *  one parallel vocabulary instead of v3's two. */
const narrationForChild = (childKey: PluginKey): PhaseNarration => {
	const key = childKey as unknown as string;
	if (key.startsWith('walrus:storage-node-')) {
		const idx = key.slice('walrus:storage-node-'.length);
		return `storage-node-${idx}`;
	}
	if (key === 'walrus:deploy-one-shot') return 'deploy';
	if (key === 'walrus:cargo-image') return 'image-build';
	if (key === 'walrus:move-source') return 'move-source';
	return key;
};
