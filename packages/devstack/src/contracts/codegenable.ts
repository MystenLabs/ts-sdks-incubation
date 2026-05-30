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
 * Optional cross-decl aggregation. When present, the codegen
 * orchestrator additionally folds this decl's exported map into a
 * shared aggregate file alongside its own per-decl output.
 *
 * Architectural note: the orchestrator treats `bucket` as opaque and
 * delegates the projection to the plugin via `project`. Aggregate
 * special-casing (e.g. "the Sui `services.ts` row holds `{rpc,
 * faucet, graphql}`") belongs in the plugin's contributor, NOT in
 * the codegen orchestrator (architecture: "Orchestrator boundaries
 * — never names a service").
 */
export interface AggregateContribution {
	/** Which aggregate file this decl contributes to (e.g.
	 *  `'accounts.ts'`, `'coins.ts'`, `'packages.ts'`,
	 *  `'services.ts'`). The plugin chooses; the orchestrator treats
	 *  it as opaque. Distinct decls that target the same `bucket`
	 *  shallow-merge into one aggregate file. */
	readonly bucket: string;
	/** Project this decl's `exported` map into the value to merge
	 *  into the aggregate bucket. Returning `null` opts out of
	 *  contributing for this cycle (e.g. when the emitter produced
	 *  no usable shape). The returned record is shallow-merged onto
	 *  the bucket; for typed shapes the plugin owns the merge
	 *  semantics via the returned object's key set. */
	readonly project: (
		exported: Readonly<Record<string, unknown>>,
	) => Readonly<Record<string, unknown>> | null;
	/** Optional plugin-supplied kind tag for diagnostics / span
	 *  attributes (e.g. `'sui-network'`, `'account'`). The
	 *  orchestrator MUST NOT branch on this value — it is annotation-
	 *  only. */
	readonly kind?: string;
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
	/** When `true`, multiple decls may share this `emitterName`
	 *  (the orchestrator skips the emitter-name uniqueness check for
	 *  this decl). Use sparingly — only when the plugin legitimately
	 *  emits one decl per item (e.g. one `Package` per published
	 *  package). Output-path uniqueness is still enforced. */
	readonly allowEmitterNameRepetition?: boolean;
	/** Optional aggregation seam — when present, the orchestrator
	 *  folds the per-decl exported map into a shared aggregate file
	 *  via `aggregate.project(exported)`. Plugins own the projection
	 *  shape; the orchestrator is name-blind. */
	readonly aggregate?: AggregateContribution;
	/** Emit operation; writes generated file declarations through the
	 *  supplied context. */
	readonly emit: (ctx: CodegenEmitContext) => Effect.Effect<CodegenEmitDone>;
}
