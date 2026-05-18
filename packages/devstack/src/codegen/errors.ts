import { Schema } from 'effect';

import { CodegenPhases } from '../engine/phases.js';

/** Tagged error surfaced by every Codegen emitter. The `emitter` field
 *  carries the name of the emitter that failed so a multi-emitter run's
 *  error message points at exactly the right code path. The `phase` set
 *  is closed in `engine/phases.ts` (`CodegenPhases`). */
export class CodegenError extends Schema.TaggedErrorClass<CodegenError>()('CodegenError', {
	emitter: Schema.String,
	phase: Schema.Literals(CodegenPhases),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}
