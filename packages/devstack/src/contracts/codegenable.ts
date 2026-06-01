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
	 *  `'accounts.ts'`, `'coins.ts'`, `'config.ts'`). The plugin
	 *  chooses; the orchestrator treats it as opaque. Distinct decls
	 *  that target the same `bucket` deep-merge into one aggregate
	 *  file (so e.g. sui's `networks.local` and every package's
	 *  `packages.<name>` coexist in one `config.ts`). */
	readonly bucket: string;
	/** Project this decl's `exported` map into the value to merge
	 *  into the aggregate bucket. Returning `null` opts out of
	 *  contributing for this cycle (e.g. when the emitter produced
	 *  no usable shape). The returned record is deep-merged onto
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
	/** Where the synthesized aggregate file lands. `'generated'` is
	 *  the canonical runtime tree (`src/generated/`); `'generated-extras'`
	 *  routes the aggregate to the gitignored
	 *  `.devstack/stacks/<stack>/generated-extras/` tree (dev-only +
	 *  secret artifacts). All decls contributing to one bucket MUST
	 *  agree on this; the orchestrator reads it from the first
	 *  contributor it sees for the bucket. Defaults to `'generated'`. */
	readonly outputLocation?: OutputLocation;
	/** When `true`, the synthesized aggregate file is written with
	 *  tightened `0o600` perms and injected into `.gitignore`. Mirrors
	 *  `CodegenableDecl.sensitive` for aggregate files. Defaults to
	 *  `false`. */
	readonly sensitive?: boolean;
}

/** Which codegen output tree a decl (or aggregate) emits into.
 *  `'generated'` is the runtime-imported `src/generated/` tree;
 *  `'generated-extras'` is the gitignored
 *  `.devstack/stacks/<stack>/generated-extras/` dev-only tree reached
 *  via the `@devstack-dev` alias. */
export type OutputLocation = 'generated' | 'generated-extras';

/**
 * Codegen contribution. `Emitter` is a literal emitter name used
 * by the codegen orchestrator for attribution and grouping.
 */
export interface CodegenableDecl<Emitter extends string = string> {
	readonly kind: 'codegenable';
	readonly emitterName: Emitter;
	/** Relative path under the codegen staging dir. */
	readonly outputPath: string;
	/** Which codegen tree this decl's standalone file emits into.
	 *  `'generated'` (default) → `src/generated/`; `'generated-extras'`
	 *  → the gitignored `.devstack/stacks/<stack>/generated-extras/`
	 *  dev-only tree (reached via the `@devstack-dev` alias). */
	readonly outputLocation?: OutputLocation;
	/** When `true`, this decl contributes ONLY to its `aggregate`
	 *  bucket — the orchestrator skips emitting the standalone
	 *  per-decl file. Use when the per-decl singleton has no consumer
	 *  (the combined aggregate is the only app-facing surface). */
	readonly aggregateOnly?: boolean;
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
