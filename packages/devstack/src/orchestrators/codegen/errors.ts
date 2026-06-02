// Typed errors for the Codegen orchestrator.
//
// Architecture §6 (Codegenable) failure-mode taxonomy + distilled-doc
// §"Refine the `CodegenError` phase taxonomy". Today's v3 collapsed
// "emitter-collision at acquire", "binary shell-out failure", and
// "pure render failure" into a single tag; the rewrite keeps them
// separate so callers can `catchTag` on each.
//
// Phase tags inside each error name the lifecycle step that failed
// (resolve → emit → render → write → bindings → finalize) so error
// attribution stays accurate.

import { Schema } from 'effect';

/** Path-layer rejection from the codegen orchestrator.
 *  - `kind: 'duplicate'` — two `Codegenable` contributions claim the
 *    same `outputPath`. Hard failure detected BEFORE write so the
 *    user-visible output dir never sees an ambiguous overwrite.
 *  - `kind: 'non-relative'` — a plugin-authored `outputPath` escapes
 *    the codegen root (contains `..` or is absolute). Defense-in-depth
 *    for the file-layout invariants. */
export class CodegenPathConflict extends Schema.TaggedErrorClass<CodegenPathConflict>()(
	'CodegenPathConflict',
	{
		kind: Schema.Literals(['duplicate', 'non-relative']),
		outputPath: Schema.String,
		emitters: Schema.Array(Schema.String),
	},
) {}

/** Two `Codegenable` contributions share the SAME `emitterName`
 *  literal but resolve to different `outputPath`s — programming
 *  bug in plugin code (emitter name should be unique). Distinct
 *  from `CodegenPathConflict` so attribution stays clean. */
export class CodegenEmitterCollision extends Schema.TaggedErrorClass<CodegenEmitterCollision>()(
	'CodegenEmitterCollision',
	{
		emitterName: Schema.String,
		outputPaths: Schema.Array(Schema.String),
	},
) {}

/** Two `Codegenable` contributions target the SAME aggregate
 *  `bucket` but disagree on its routing/sensitivity metadata
 *  (`outputLocation` or `sensitive`). The `AggregateContribution`
 *  contract requires all contributors to a bucket to agree; the
 *  orchestrator routes the synthesized aggregate from the FIRST
 *  contributor it sees, so a silent disagreement could misroute a
 *  sensitive aggregate into the committed `generated` tree. Detected
 *  while folding contributions so the cycle fails fast rather than
 *  emitting a secret with non-sensitive handling. */
export class CodegenAggregateConflict extends Schema.TaggedErrorClass<CodegenAggregateConflict>()(
	'CodegenAggregateConflict',
	{
		bucket: Schema.String,
		field: Schema.Literals(['outputLocation', 'sensitive']),
		/** The value the first contributor established for the bucket. */
		established: Schema.String,
		/** The conflicting value a later contributor declared. */
		conflicting: Schema.String,
		/** Emitter names: the contributor that established the value and
		 *  the one that disagreed. */
		emitters: Schema.Array(Schema.String),
	},
) {}

/** A `Codegenable.emit()` wrote a value that the renderer cannot
 *  serialise (a function, a symbol, a circular reference, etc.). */
export class CodegenRenderError extends Schema.TaggedErrorClass<CodegenRenderError>()(
	'CodegenRenderError',
	{
		emitterName: Schema.String,
		outputPath: Schema.String,
		detail: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

/** `Codegenable.emit()` raised. Wraps the inner Effect failure
 *  rather than propagating it raw so the orchestrator's error
 *  channel stays closed. */
export class CodegenEmitFailed extends Schema.TaggedErrorClass<CodegenEmitFailed>()(
	'CodegenEmitFailed',
	{
		emitterName: Schema.String,
		outputPath: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

/** Disk write (atomic-write or permission-tighten) failed. */
export class CodegenWriteFailed extends Schema.TaggedErrorClass<CodegenWriteFailed>()(
	'CodegenWriteFailed',
	{
		outputPath: Schema.String,
		stage: Schema.Literals(['mkdir-parent', 'write', 'rename', 'chmod', 'gitignore']),
		cause: Schema.optional(Schema.Defect),
	},
) {}

/** `@mysten/codegen` shell-out (Move-to-TS bindings) failed or
 *  silently no-op'd. Distilled-doc § "Silent no-op from a
 *  downstream tool is a failure" — we surface a hint about the
 *  common `Move.toml` cause. */
export class CodegenBindingsFailed extends Schema.TaggedErrorClass<CodegenBindingsFailed>()(
	'CodegenBindingsFailed',
	{
		package: Schema.String,
		sourcePath: Schema.String,
		reason: Schema.Literals(['summary-failed', 'no-output', 'render-failed', 'write-failed']),
		hint: Schema.optional(Schema.String),
		cause: Schema.optional(Schema.Defect),
	},
) {}

/** The reader of the manifest envelope detected drift between
 *  what plugins contributed and what's on disk — e.g. a stale
 *  envelope from a previous stack lifecycle. */
export class CodegenManifestDrift extends Schema.TaggedErrorClass<CodegenManifestDrift>()(
	'CodegenManifestDrift',
	{
		detail: Schema.String,
	},
) {}

export type CodegenError =
	| CodegenPathConflict
	| CodegenEmitterCollision
	| CodegenAggregateConflict
	| CodegenRenderError
	| CodegenEmitFailed
	| CodegenWriteFailed
	| CodegenBindingsFailed
	| CodegenManifestDrift;
