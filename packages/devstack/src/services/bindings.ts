// Bindings(opts) — TS-bindings convenience facade over the new
// `Codegen` / `BindingsEmitter` plug-in interface. The single-purpose
// shape (`{ packages, output, importExtension? }`) covers the common
// "I just want @mysten/codegen output" case without needing the user
// to declare a separate `Codegen({...})` ref.
//
// Under the hood this is exactly `Codegen({ output, packages,
// emitters: [BindingsEmitter({...})] })`. If you want multiple emitters
// or per-Package overrides, reach for `Codegen({...})` directly.

import type { Ref } from '../advanced/tag.js';
import { BindingsEmitter, type BindingsEmitterOptions } from '../codegen/emitters/bindings.js';
import { Codegen } from './codegen.js';

export interface BindingsRefOptions {
	/** Package refs to generate bindings for. `Package(...)` refs emit
	 *  fully; `KnownPackage(...)` refs are silently skipped at emit time
	 *  — bindings need the upstream Move source to feed `sui move
	 *  summary`. The type is loose (`Ref<any, any, any, any>`) because
	 *  TS treats the shape parameter as invariant on `Ref`, so requiring
	 *  a tighter shape would reject perfectly valid Package refs at
	 *  compose. The emitter validates package shape at runtime. */
	readonly packages: ReadonlyArray<Ref<any, any, any, any>>;
	/** Output directory. Bindings land under `<output>/bindings/`. */
	readonly output: string;
	/** Optional `.ts`/`.js`/`''` for the import-extension flavor in
	 *  generated code. Defaults to `.ts`. */
	readonly importExtension?: '.ts' | '.js' | '';
	/** Override tag name. Defaults to `'bindings'`. */
	readonly name?: string;
}

/** Bindings codegen factory. Returns a Ref. Equivalent to:
 *
 *     Codegen({
 *       output: opts.output,
 *       packages: opts.packages,
 *       emitters: [BindingsEmitter({ importExtension: opts.importExtension })],
 *     })
 */
export const Bindings = (opts: BindingsRefOptions) => {
	const emitterOpts: BindingsEmitterOptions =
		opts.importExtension !== undefined ? { importExtension: opts.importExtension } : {};
	return Codegen({
		output: opts.output,
		packages: opts.packages,
		emitters: [BindingsEmitter(emitterOpts)],
		...(opts.name !== undefined ? { name: opts.name } : { name: 'bindings' }),
	});
};
