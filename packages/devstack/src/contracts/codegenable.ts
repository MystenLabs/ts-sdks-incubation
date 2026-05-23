// Codegenable capability contract (architecture §6).
//
// Lets a plugin contribute files to the user's source tree without
// the codegen surface (L4) knowing the plugin exists. The runtime
// contract only needs the literal emitter name, output path,
// sensitivity, and an emit operation that writes through an opaque
// context. Generated files own their app-facing export types directly.

import type { Effect } from 'effect';

/**
 * Opaque per-file emission context.
 *
 * Plugin authors declare named generated exports by calling
 * `exportConst(...)`. The orchestrator owns how those declarations are
 * collected, rendered, grouped, permissioned, and written. Emitters do
 * not return a raw `{ [exportName]: value }` record, which keeps the
 * codegen contract focused on the public generated file shape instead
 * of an internal renderer payload.
 */
export interface CodegenEmitContext {
	/** Add one `export const <name> = <value> as const;` to the file. */
	readonly exportConst: (name: string, value: unknown) => void;
	/** Add a raw import statement before the generated exports. */
	readonly importStatement: (statement: string) => void;
	/** Finish emission after all exports/imports have been written. */
	readonly done: () => CodegenEmitDone;
}

export interface CodegenEmitDone {
	readonly _tag: 'CodegenEmitDone';
}

/**
 * Codegen contribution. `Emitter` is a literal emitter name used
 * by the codegen orchestrator for attribution and grouping.
 */
export interface CodegenableDecl<Emitter extends string = string> {
	readonly kind: 'codegenable';
	readonly emitterName: Emitter;
	/** Relative path under the codegen staging dir. */
	readonly outputPath: string;
	/** Optional sensitivity flag — drives file permissions and
	 *  `.gitignore` inclusion. */
	readonly sensitive?: boolean;
	/** Emit operation; writes generated file declarations through the
	 *  supplied context. */
	readonly emit: (ctx: CodegenEmitContext) => Effect.Effect<CodegenEmitDone>;
}
