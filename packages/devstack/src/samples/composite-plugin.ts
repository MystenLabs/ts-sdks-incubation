// Composite plugin sample.
//
// Shape: a multi-node cluster + on-chain registry + deploy one-shot.
// (Walrus-shaped conceptually, but uses generic naming so the substrate
// stays name-free — see architectural constraint.)
//
// Demonstrates:
//   - `definePlugin` returning a composite plugin resource
//   - `CompositePrimitive` capability decl with lifted siblings
//   - Four capability decls in one tuple (Snapshotable, Routable,
//     Codegenable, plus the CompositePrimitive itself surfaced via a
//     companion strategy contribution)
//   - Mode-narrowed factories via `defineModeNamespace`
//   - A phantom witness on the resolved value declaring an upstream
//     requirement satisfied by the trivial-leaf-plugin sample.

import { Effect } from 'effect';

import { definePlugin, resource } from '../api/define-plugin.ts';
import { defineModeNamespace } from '../api/mode-narrowed-factory.ts';
import { defineWitness, providesWitness, requiresWitness } from '../api/witness.ts';
import type { CodegenableDecl } from '../contracts/codegenable.ts';
import type { CompositePrimitiveDecl } from '../contracts/composite-primitive.ts';
import type { RoutableDecl } from '../contracts/routable.ts';
import type { SnapshotableDecl } from '../contracts/snapshotable.ts';
import { pluginKey } from '../substrate/brand.ts';
import { litSiblingKey } from '../substrate/lifted-sibling.ts';
import type { ProvidesWitness, RequiresWitness } from '../substrate/witness.ts';
import { KeyvalResource, type KeyvalClient } from './trivial-leaf-plugin.ts';

// --- Witness ------------------------------------------------------------

/** Witness this composite claims its underlying leaf has been chosen
 *  in the same network mode. The leaf-side provides a matching token. */
export const KeyvalLocalWitness = defineWitness('keyval-local');

// --- Resource + resolved value ------------------------------------------

/** A bindings shape the codegen output exports. The emitted module
 *  owns the app-facing type of this imported file. */
export interface ClusterBindings {
	readonly clusterUrl: string;
	readonly registryId: string;
	readonly deploy: () => Effect.Effect<void>;
}

/** Composite's resolved value. Carries a `RequiresWitness` phantom —
 *  the stack-level check refuses if no member provides the matching
 *  `ProvidesWitness` shape. */
export interface ClusterClient extends RequiresWitness<'keyval-local'> {
	readonly url: string;
	readonly registryObjectId: string;
}

/** Companion shape used by the local-mode factory: the underlying
 *  leaf plugin's resolved value flows in via `dependsOn`. */
export interface ClusterClientWithLeaf extends ClusterClient, ProvidesWitness<'keyval-local'> {
	readonly leaf: KeyvalClient;
}

export const ClusterResource = resource<'cluster', ClusterClient>('cluster');

// --- Inner-participant resource (private to the composite's local mode) --

interface ClusterNodeMember {
	readonly nodeId: number;
	readonly ip: string;
}

const ClusterNodeResource = resource<'cluster.node', ClusterNodeMember>('cluster.node');

// --- Lifted sibling key (literal-typed for compile-time dedup) ----------
//
// Two composites lifting siblings with the SAME (plugin, kind, scope)
// but DIFFERENT inputHash literals are refused at the type level.

export const SIBLING_PLUGIN = 'cluster' as const;
export const SIBLING_KIND = 'docker-image' as const;
export const SIBLING_SCOPE = 'per-app' as const;

export function clusterImageSibling<Hash extends string>(hash: Hash) {
	return litSiblingKey(SIBLING_PLUGIN, SIBLING_KIND, SIBLING_SCOPE, hash);
}

// --- Composite acquire procedure ----------------------------------------

function localCluster() {
	const compositeKey = pluginKey('cluster');

	const snap: SnapshotableDecl = {
		kind: 'snapshotable',
		subtrees: ['data/'],
		missingTolerance: 'fine',
	};

	const route: RoutableDecl = {
		kind: 'routable',
		endpointName: 'cluster-api',
		dispatchId: { compositeKey: 'cluster', role: 'api' },
		upstream: { type: 'container', containerName: 'cluster-leader', containerPort: 8080 },
		cors: true,
	};

	const codegen: CodegenableDecl<'cluster-bindings'> = {
		kind: 'codegenable',
		emitterName: 'cluster-bindings',
		outputPath: 'cluster/bindings.ts',
		emit: (_ctx) =>
			Effect.sync(() => {
				throw new Error('cluster.emit: not implemented yet (Phase 4)');
			}),
	};

	// Inner participant — a hidden leaf that represents one node.
	// Constructed inline because the composite owns its lifecycle.
	const nodeMember = definePlugin({
		id: ClusterNodeResource.id,
		kind: 'hidden-leaf',
		start: () =>
			Effect.sync<ClusterNodeMember>(() => {
				throw new Error('cluster.node.start: not implemented yet (Phase 4)');
			}),
	});

	const composite: CompositePrimitiveDecl = {
		kind: 'composite-primitive',
		compositeKey,
		liftedSiblings: [clusterImageSibling('cluster-image@v1.0.0')],
		innerParticipants: [nodeMember],
	};

	return definePlugin({
		id: ClusterResource.id,
		dependsOn: { leaf: KeyvalResource },
		kind: 'composite',
		rebootCost: 'heavy',
		start: (_ctx, { leaf }) =>
			Effect.gen(function* () {
				// Phantom helpers — runtime values are `{}`, but the
				// resolved-value's RequiresWitness/ProvidesWitness phantoms
				// drive the stack-level type check.
				void requiresWitness(KeyvalLocalWitness);
				void providesWitness(KeyvalLocalWitness);
				return yield* Effect.sync<ClusterClient>(() => {
					throw new Error(
						`cluster.start: not implemented yet (Phase 4) — leaf endpoint=${leaf.endpoint}`,
					);
				});
			}),
		capabilities: [snap, route, codegen, composite] as const,
	});
}

// --- Mode-narrowed factory namespace ------------------------------------
//
// `cluster.for(network).localCluster()` is allowed when `network.mode`
// is `'local'`. `cluster.for(forkNetwork).localCluster()` is a compile
// error — `localCluster` is `never` on the fork branch.

export const cluster = defineModeNamespace({
	local: {
		localCluster,
	},
	fork: {
		forkedCluster: () =>
			definePlugin({
				id: ClusterResource.id,
				kind: 'composite',
				start: () =>
					Effect.sync<ClusterClient>(() => {
						throw new Error('cluster.forkedCluster.start: not implemented yet (Phase 4)');
					}),
			}),
	},
	live: {
		// Live mode exposes neither localCluster nor forkedCluster — the
		// caller threads a known deployment manifest instead.
		known: (manifestUrl: string) =>
			definePlugin({
				id: ClusterResource.id,
				kind: 'composite',
				start: () =>
					Effect.sync<ClusterClient>(() => {
						throw new Error(`cluster.known.start(${manifestUrl}): not implemented yet (Phase 4)`);
					}),
			}),
	},
});

export type { ClusterClient as ClusterClientType };
