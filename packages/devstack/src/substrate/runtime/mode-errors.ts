// Cross-cutting mode-refusal errors.
//
// Reviews finding (cross-cutting.md §"Error model"): the
// `ForkIncompatibleError` tag is defined twice today — once in
// `plugins/walrus/errors.ts`, once in `plugins/seal/errors.ts` — with
// conflicting field shapes. Two `_tag` literals with the same name
// but different shapes violate STYLE_GUIDE §2 ("One `_tag` literal
// per logical error type across the whole package").
//
// Lift the canonical shape here. Both plugins import from substrate
// in PR3; this PR does NOT modify the plugin-side error files (per
// PR1 scope).
//
// Shape decision:
//   - `variant` carries the refusing factory name (e.g.
//     `'walrusLocalCluster'`, `'sealLocalKeygen'`). Lets walrus and
//     seal share the shape without losing the call-site distinction.
//   - `network` carries the resolved `*-fork` network string the
//     user passed.
//   - `message` is the imperative one-liner suitable for stderr.
//   - `hint` is the actionable next step (the known-deployment
//     alternative).
//
// Substrate is name-blind on the plugin level — these fields are
// generic ("which factory variant refused" + "which network it
// refused under") and do NOT name walrus / seal.

import { Schema } from 'effect';

/**
 * Synchronous factory-time refusal raised by a plugin factory
 * variant when composed against a network the variant cannot serve
 * (canonically: a `*-fork` chain that doesn't expose the fullnode
 * surface the variant requires).
 *
 * Architecture (Tension 11): primary refusal is TYPE-LEVEL via
 * mode-narrowed factory namespaces — `walrusFor(forkNet).<mode>` only
 * exposes `.known`. This runtime shape is defense-in-depth for
 * callers that bypass the type-level narrowing (env-driven factories,
 * plugin composition through resolved values).
 *
 * Used by walrus (`local-cluster` variant) and seal (`local-keygen`
 * variant) today; future plugin factories refusing on a network
 * predicate share this single shape.
 */
export class ForkIncompatibleError extends Schema.TaggedErrorClass<ForkIncompatibleError>()(
	'ForkIncompatibleError',
	{
		/** Refusing factory variant — e.g. `'walrusLocalCluster'`,
		 *  `'sealLocalKeygen'`. Lets multiple plugin factories share
		 *  this shape without losing the call-site distinction. */
		variant: Schema.String,
		/** Resolved network the composition refused under. */
		network: Schema.String,
		/** Imperative one-liner suitable for stderr. */
		message: Schema.String,
		/** Actionable next step (the known-deployment alternative). */
		hint: Schema.optional(Schema.String),
		/** Optional original cause when the refusal wraps an underlying
		 *  fault (rare — typical use is a pure factory-time refusal). */
		cause: Schema.optional(Schema.Defect),
	},
) {}
