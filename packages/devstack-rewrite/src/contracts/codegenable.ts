// Codegenable capability contract (architecture §6).
//
// Lets a plugin contribute files to the user's source tree without
// the codegen surface (L4) knowing the plugin exists. The
// `CodegenableDecl` is literal-typed on its emit shape so a
// downstream consumer of the emitted file is typed correctly.
//
// The explicit `CodegenableDecl<Shape, Emitter>` annotation is what
// flows codegen emit types through to consumers. Without it (e.g.
// erased to `CodegenableDecl<unknown, string>` only), the consumer's
// `EmittedFor<member, 'sui-bindings'>` resolves to `never`.

import type { Effect } from 'effect';

/**
 * Codegen contribution. `EmittedShape` is the typed handle the
 * emitted file exports; `Emitter` is a literal emitter name used
 * for downstream type extraction by literal name.
 */
export interface CodegenableDecl<EmittedShape = unknown, Emitter extends string = string> {
	readonly kind: 'codegenable';
	readonly emitterName: Emitter;
	/** Relative path under the codegen staging dir. */
	readonly outputPath: string;
	/** Optional sensitivity flag — drives file permissions and
	 *  `.gitignore` inclusion. */
	readonly sensitive?: boolean;
	/** Emit operation; receives the resolved-once user extras and
	 *  returns the file's exports as a typed record. */
	readonly emit: () => Effect.Effect<{ readonly [key: string]: unknown }>;
	/** Optional phantom — covariant (return-position) per the
	 *  phantom-variance rule. Drives downstream
	 *  `EmittedFor<Member, Emitter>` extraction; declarations normally
	 *  carry this through their explicit generic annotation instead of a
	 *  concrete runtime property. */
	readonly _emitted?: () => EmittedShape;
}

/** Extract the union of `{ emitter, shape }` from a member's
 *  capabilities tuple. */
export type CodegenEntries<Caps extends ReadonlyArray<unknown>> = {
	[K in keyof Caps]: Caps[K] extends CodegenableDecl<infer Shape, infer Emitter>
		? { readonly emitter: Emitter; readonly shape: Shape }
		: never;
}[number];

/** Pluck a single emitted shape by literal emitter name. */
export type EmittedFor<Caps extends ReadonlyArray<unknown>, Emitter extends string> = Extract<
	CodegenEntries<Caps>,
	{ readonly emitter: Emitter }
>['shape'];
