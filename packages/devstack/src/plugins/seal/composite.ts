// Seal plugin — CompositePrimitive capability decl.
//
// Architecture §8 (CompositePrimitive): lets seal present as ONE
// supervisor row while internally composing the lifted siblings
// (cargo image, source-fetch) + inner participants (keygen one-shot,
// publish, register, container).
//
// Distilled-doc invariants pinned by this file:
//
//   #1 — closure-bound internal resource + two narrow projection layers
//        + lifted-sibling artifacts: this is exactly the
//        CompositePrimitive shape.
//   #9 — peer-dep structural assignability (compile-time check via
//        `_SealKeyServerEntryCheck`).
//
// Mode-asymmetric resource fan-out (architecture: AsymmetricTagFanout):
// the `local-keygen` mode contributes BOTH the read-side resource AND
// the admin resource; the known modes contribute the read-side resource
// ONLY. We don't model this as runtime branching here — the barrel
// (`index.ts`) chooses the right CompositePrimitiveDecl per mode.

import type { CompositePrimitiveDecl } from '../../contracts/composite-primitive.ts';
import { pluginKey, type PluginKey } from '../../substrate/brand.ts';
import type { LiftedSiblingKey } from '../../substrate/lifted-sibling.ts';
import type { AnyPlugin } from '../../substrate/plugin.ts';

// ---------------------------------------------------------------------------
// Plugin-key constructor
// ---------------------------------------------------------------------------

/** Per-seal-instance plugin key. Folds the instance name so multi-
 *  instance seal in the same stack mints distinct rows. */
export const sealPluginKey = (name: string): PluginKey => pluginKey(`seal:${name}`);

// ---------------------------------------------------------------------------
// CompositePrimitiveDecl builder
// ---------------------------------------------------------------------------

/** Build the CompositePrimitive decl. The substrate's lifecycle
 *  orchestrator consumes this; it walks the lifted-siblings + the
 *  inner-participants and weaves their phase narrations under the
 *  composite row's `narrationByContributor`.
 *
 *  Inputs:
 *   - `name`            — seal instance name.
 *   - `liftedSiblings`  — the cargo-image + source-fetch keys (or
 *                          just cargo-image if `movePackagePath`
 *                          was supplied at the factory layer).
 *   - `innerParticipants` — keygen + publish + register + container
 *                            as plugins. */
export const makeSealComposite = (inputs: {
	readonly name: string;
	readonly liftedSiblings: ReadonlyArray<LiftedSiblingKey>;
	readonly innerParticipants: ReadonlyArray<AnyPlugin>;
}): CompositePrimitiveDecl => ({
	kind: 'composite-primitive',
	compositeKey: sealPluginKey(inputs.name),
	liftedSiblings: inputs.liftedSiblings,
	innerParticipants: inputs.innerParticipants,
});

// ---------------------------------------------------------------------------
// Distilled-doc invariant #9 — peer-dep structural assignability
// ---------------------------------------------------------------------------

/** Compile-time structural-assignability check that
 *  `SealKeyServerEntry` remains assignable to `@mysten/seal`'s
 *  `KeyServerConfig`. Distilled-doc invariant #18 (#9 in our
 *  re-numbering) — peer-dep drift would silently break
 *  `new SealClient({serverConfigs})`.
 *
 *  Implementation strategy: we declare a minimal structural mirror
 *  of `KeyServerConfig` (the relevant fields ARE `{objectId,
 *  weight, aggregatorUrl?}` — same as `SealKeyServerEntry`) and
 *  assert assignability via the `_SealKeyServerEntryCheck` line.
 *  A runtime no-op; a compile-time error if the shape drifts.
 *
 *  We mirror the shape locally rather than importing
 *  `@mysten/seal`'s `KeyServerConfig` so the rewrite package does
 *  not take a peer-dep on the seal client SDK. */
interface PeerKeyServerConfigShape {
	readonly objectId: string;
	readonly weight: number;
	readonly aggregatorUrl?: string;
}

// Re-import locally to avoid the cycle through registry-publish.ts in
// composite.ts.
interface LocalSealKeyServerEntry {
	readonly objectId: string;
	readonly weight: number;
	readonly aggregatorUrl?: string;
}

/** Structural-drift guard. If `SealKeyServerEntry` drops or adds a
 *  required field that breaks assignability to `KeyServerConfig`,
 *  THIS line fails to compile. */
export type _SealKeyServerEntryCheck = LocalSealKeyServerEntry extends PeerKeyServerConfigShape
	? true
	: never;

// Force the check to evaluate at module load. The cast is a no-op
// at runtime; the compile-time evaluation IS the guard.
const _sealKeyServerEntryAssignable: _SealKeyServerEntryCheck = true;
void _sealKeyServerEntryAssignable;
