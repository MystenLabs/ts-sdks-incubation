// `bindPackage(module, packageId)` — walks a codegen module's exports
// and wraps every typed call builder so the `package` option is
// auto-injected from the live `packageId`. Non-builder exports
// (`MoveStruct` instances, `bcs` re-exports, helpers) pass through.
//
// `@mysten/codegen` 0.10.x emits builders shaped roughly like:
//
//   export function createLobby(options: CreateLobbyOptions = {}) {
//     const packageAddress = options.package ?? '@local-pkg/<name>';
//     return (tx) => tx.moveCall({...});
//   }
//
// The default `'@local-pkg/<name>'` placeholder is what the app would
// otherwise have to override. `bindPackage` replaces the default at the
// hook layer, so call sites become `pkg.createLobby({ arguments: [...] })`
// — no `package: deployment.connectFourPackageId` boilerplate.

import type { CodegenModule } from './types.js';

interface BuilderOptions {
	package?: string;
	arguments?: unknown;
	[key: string]: unknown;
}

type Builder = (options?: BuilderOptions) => unknown;

export function bindPackage(module: CodegenModule, packageId: string): CodegenModule {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(module)) {
		if (isBuilder(value)) {
			out[key] = (options?: BuilderOptions) => {
				const opts: BuilderOptions = { ...(options ?? {}) };
				if (opts.package === undefined) opts.package = packageId;
				return (value as Builder)(opts);
			};
		} else {
			out[key] = value;
		}
	}
	return out;
}

function isBuilder(value: unknown): value is Builder {
	// Heuristic: codegen-emitted builders are plain functions taking
	// 0–1 args. Classes (e.g. `MoveStruct` instances) appear here as
	// objects with their own prototype — skip those. Arrow vs function
	// declaration both pass `typeof === 'function'`.
	if (typeof value !== 'function') return false;
	// Builders have arity 0 or 1 (the options bag). Constructor-shaped
	// exports usually have higher arity or are bound differently.
	return value.length <= 1;
}
