// CompositePrimitive capability contract (architecture §8).
//
// Lets a plugin present as one supervisor row while internally
// composing N inner participants (lifted siblings + inner
// containers/one-shots). The substrate auto-wraps inner lifecycle
// into the composite row's narration.
//
// Phase-3 architecture decision (Tension 11): composite refusal
// lands at the TYPE level via mode-narrowed factory namespaces +
// cross-plugin witness checks at stack level.
//
// This file declares the composite-side contract. Mode-narrowing
// helpers live in `api/mode-narrowed-factory.ts`; witness helpers
// in `api/witness.ts`.

import type { Effect, Scope } from 'effect';

import type { PluginKey } from '../substrate/brand.ts';
import type { PhaseNarration } from '../substrate/lifecycle.ts';
import type { LiftedSiblingKey } from '../substrate/lifted-sibling.ts';
import type { AnyPlugin } from '../substrate/plugin.ts';

/**
 * Composite plugin authoring contract. The `acquire` procedure of
 * a composite member returns the composite's aggregate resolved
 * value PLUS a `CompositePrimitive` capability decl on its
 * `capabilities` tuple — the decl carries the inner-participants
 * shape and the per-child narration channel.
 */
export interface CompositePrimitiveDecl {
	readonly kind: 'composite-primitive';
	readonly compositeKey: PluginKey;
	readonly liftedSiblings: ReadonlyArray<LiftedSiblingKey>;
	/** Inner participants — declared at the type level as `AnyPlugin`
	 *  so the substrate can drive their lifecycle through the same
	 *  acquire pipeline. */
	readonly innerParticipants: ReadonlyArray<AnyPlugin>;
	/** Per-child phase narration. Substrate aggregates these under
	 *  the composite row's `narrationByContributor`. */
	readonly narrate?: (childKey: PluginKey) => Effect.Effect<PhaseNarration, never, Scope.Scope>;
}

/** Asymmetric tag fan-out hint. Architecture: "this composite
 *  resolves an admin tag in local mode but not in known-deployment
 *  mode." Expressible at the type level by the composite returning
 *  a different `Provides` tag per mode. The mode-narrowed factory
 *  namespace pattern handles this — see `api/mode-narrowed-factory.ts`.
 *
 *  This interface is just a documentation marker; no runtime data. */
export interface AsymmetricTagFanout {
	readonly _doc: 'See api/mode-narrowed-factory.ts for the typed pattern.';
}
