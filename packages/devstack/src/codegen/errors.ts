import { Data } from 'effect';

/** Tagged error surfaced by every Codegen emitter. The `emitter` field
 *  carries the name of the emitter that failed so a multi-emitter run's
 *  error message points at exactly the right code path. */
export class CodegenError extends Data.TaggedError('CodegenError')<{
	readonly emitter: string;
	readonly phase: 'read' | 'generate' | 'write';
	readonly message: string;
	readonly cause?: unknown;
}> {}
