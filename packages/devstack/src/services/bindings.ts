// Bindings(opts) — TS codegen for one or more Package refs. Thin facade
// over `bindings(...)`. Phase 2 keeps explicit invocation; Phase 6's
// default-provider step will auto-emit bindings when any `Package` is
// declared without an explicit `Bindings(...)` in the stack.

import { bindings, type BindingsOptions } from '../primitives/bindings.js';
import type { LocalPackageShape } from './package.js';
import type { Ref } from '../advanced/tag.js';

export interface BindingsRefOptions {
	/** Package refs to generate bindings for. Must satisfy
	 *  `LocalPackageShape` (i.e. produced by `Package(...)`). */
	readonly packages: ReadonlyArray<Ref<any, LocalPackageShape, any, any>>;
	/** Output directory. Each package emits under `<output>/<name>/`. */
	readonly output: string;
	/** Optional `.ts`/`.js`/`''` for the import-extension flavor in
	 *  generated code. Defaults to `.ts`. */
	readonly importExtension?: '.ts' | '.js' | '';
	/** Override tag name. Defaults to `'bindings'`. */
	readonly name?: string;
}

/** Bindings codegen factory. Returns a Ref. */
export const Bindings = (opts: BindingsRefOptions) => {
	const bopts: BindingsOptions = {
		packages: opts.packages,
		output: opts.output,
		...(opts.importExtension !== undefined ? { importExtension: opts.importExtension } : {}),
		...(opts.name !== undefined ? { name: opts.name } : {}),
	};
	return Object.assign(bindings(bopts), { __kind: 'app' as const });
};
