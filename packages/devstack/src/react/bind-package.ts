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
// The end-to-end MVR-resolution path is the eventual home for this
// substitution (the SDK's `namedPackagesPlugin` resolves placeholders
// at tx-build time), but `@mysten/codegen` 0.10.4 emits package names
// in snake_case (Move convention: `@local-pkg/connect_four`) and
// `@mysten/sui` 2.16.0's MVR validation rejects underscores in app
// names. Until those align, `bindPackage` stays as the runtime
// substitution mechanism.
//
// Pure data; doesn't import React. Apps wrap it in a small per-app
// `usePackage(module, name)` helper that reads `packageId` from the
// manifest — see `notes/react-api-investigation.md`.

export type CodegenModule = Record<string, unknown>;

interface BuilderOptions {
	package?: string;
	arguments?: unknown;
	[key: string]: unknown;
}

type Builder = (options?: BuilderOptions) => unknown;

export function bindPackage<M extends CodegenModule>(module: M, packageId: string): M {
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
	return out as M;
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
