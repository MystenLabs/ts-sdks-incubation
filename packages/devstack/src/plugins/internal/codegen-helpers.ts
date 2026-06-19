// Internal plugin helpers — codegen shape factories.
//
// `defineSimpleConstExport` collapses the duplicated `CodegenableDecl`
// boilerplate shared by the per-plugin `codegen.ts` modules. Each of
// those plugins emits one file containing exactly one `export const`
// from a resolved value record, optionally joining a cross-decl
// aggregate bucket and optionally running a pre-emit Effect (e.g. span
// annotation) before writing.
//
// Internal to this package — not re-exported from the root barrel.

import { Effect } from 'effect';

import type { AggregateContribution, CodegenableDecl } from '../../contracts/codegenable.ts';

/** Spec for a `CodegenableDecl` that emits a single `export const`.
 *
 *  `Emitter` is preserved as a generic so plugins that template the
 *  emitter name (e.g. `coin/${symbol}`, `account/${name}`) keep their
 *  literal-typed emission identity. */
export interface SimpleConstExportSpec<Emitter extends string, Value> {
	readonly emitterName: Emitter;
	readonly outputPath: string;
	readonly exportName: string;
	readonly value: Value;
	readonly sensitive?: boolean;
	/** Contribute only to the `aggregate` bucket — skip the standalone
	 *  file. Default `false`. */
	readonly aggregateOnly?: boolean;
	readonly aggregate?: AggregateContribution;
	/** Optional Effect run before the `exportConst` write — used by the
	 *  wallet plugin to annotate the current span with a redacted form
	 *  of the emitted value. Runs inside the emit Effect so the
	 *  annotation lands on the codegen span. */
	readonly preEmit?: Effect.Effect<void>;
}

export const defineSimpleConstExport = <Emitter extends string, Value>(
	spec: SimpleConstExportSpec<Emitter, Value>,
): CodegenableDecl<Emitter> => ({
	kind: 'codegenable',
	emitterName: spec.emitterName,
	outputPath: spec.outputPath,
	sensitive: spec.sensitive ?? false,
	...(spec.aggregateOnly ? { aggregateOnly: spec.aggregateOnly } : {}),
	...(spec.aggregate ? { aggregate: spec.aggregate } : {}),
	emit: (ctx) =>
		Effect.gen(function* () {
			if (spec.preEmit) {
				yield* spec.preEmit;
			}
			ctx.exportConst(spec.exportName, spec.value);
			return ctx.done();
		}),
});
