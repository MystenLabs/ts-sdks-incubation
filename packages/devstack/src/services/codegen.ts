// Codegen(opts) — the centralized codegen Ref. Runs a list of emitter
// plug-ins against the resolved Package set at acquire time.
//
// Architecture:
//   - User declares `Codegen({ output, emitters: [...] })` once at the
//     top of the stack.
//   - Each Package(...) the stack contains feeds into Codegen's context
//     (unless it sets `{ codegen: false }`).
//   - Each emitter sees the same `{ packages, outputDir }` context and
//     writes to its own subdirectory under `outputDir`.
//
// Built-in emitters: `BindingsEmitter` (Move → TS bindings) and
// (Phase 3g) `DappKitEmitter`. User emitters drop in alongside via
// `defineEmitter({ name, emit })`.
//
// `Codegen` itself doesn't auto-include any emitter — explicit is the
// rule. Most users will write `Codegen({ output: 'src/sui', emitters:
// [BindingsEmitter()] })`.

import * as path from 'node:path';
import { Effect } from 'effect';
import { tag, setPhase, type Ref } from '../advanced/tag.js';
import type { Emitter, CodegenContext, CodegenPackage } from '../codegen/define-emitter.js';
import { CodegenError } from '../codegen/errors.js';
import type { PackageShape, LocalPackageShape } from './package.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CodegenOptions {
	/** Output directory. Resolved relative to `process.cwd()` if not
	 *  absolute. Each emitter writes under a subdirectory of this path
	 *  (`<output>/bindings/`, `<output>/dapp-kit/`, …) so multiple
	 *  emitters coexist without collision. */
	readonly output: string;
	/** Emitter plug-ins to run. Run in declaration order; one emitter's
	 *  output isn't visible to another (each emitter is independent). */
	readonly emitters: ReadonlyArray<Emitter>;
	/** Package refs to emit for. When omitted, defaults to the empty
	 *  list — pass `packages: [pkg1, pkg2]` explicitly. The Phase 6
	 *  default-provider step will auto-include every `Package(...)` in
	 *  the stack that doesn't opt out via `{ codegen: false }`. */
	readonly packages?: ReadonlyArray<Ref<any, any, any, any>>;
	/** Override tag name. Defaults to `'codegen'`. */
	readonly name?: string;
}

/** Resolve a Package Ref's value into the `CodegenPackage` shape every
 *  emitter consumes. Local packages carry `sourcePath`; remote/known
 *  packages don't (emitters that need source filter to entries where
 *  it's defined). */
const toCodegenPackage = (pkg: PackageShape | LocalPackageShape): CodegenPackage => {
	const base: { name: string; packageId: string; mvrPlaceholder: string } = {
		name: pkg.name,
		packageId: pkg.packageId,
		mvrPlaceholder:
			'mvrPlaceholder' in pkg && pkg.mvrPlaceholder !== undefined
				? pkg.mvrPlaceholder
				: pkg.name,
	};
	const local = 'sourcePath' in pkg ? (pkg as LocalPackageShape) : undefined;
	if (local !== undefined) {
		const withSource: CodegenPackage = {
			...base,
			sourcePath: local.sourcePath,
			...(local.captured !== undefined ? { captured: local.captured } : {}),
		};
		return withSource;
	}
	return base;
};

/** The Codegen Ref. Returns a tag whose value is the resolved
 *  `CodegenContext` (after every emitter has run). */
export const Codegen = (opts: CodegenOptions) => {
	const name = opts.name ?? 'codegen';
	const packageRefs = opts.packages ?? [];
	return tag(
		`codegen/${name}` as const,
		Effect.gen(function* () {
			const outputDir = path.isAbsolute(opts.output)
				? opts.output
				: path.resolve(process.cwd(), opts.output);

			yield* setPhase('resolving packages');
			const resolved: Array<CodegenPackage> = [];
			const seen = new Set<string>();
			for (const ref of packageRefs) {
				// Skip refs that opted out of codegen at construction time
				// via `Package(..., { codegen: false })`. The flag is stamped
				// onto the Ref itself so we can read it without acquiring.
				if ((ref as { __codegenExclude?: boolean }).__codegenExclude === true) continue;
				const pkg = yield* ref;
				if (seen.has(pkg.name)) continue;
				seen.add(pkg.name);
				resolved.push(toCodegenPackage(pkg));
			}

			const ctx: CodegenContext = { packages: resolved, outputDir };
			yield* Effect.annotateCurrentSpan({
				'codegen.output': outputDir,
				'codegen.packages': resolved.map((p) => p.name).join(','),
				'codegen.emitters': opts.emitters.map((e) => e.name).join(','),
			});

			for (const emitter of opts.emitters) {
				yield* setPhase(`emit: ${emitter.name}`);
				yield* emitter.emit(ctx).pipe(
					Effect.mapError((cause) => {
						if (cause instanceof CodegenError) return cause;
						return new CodegenError({
							emitter: emitter.name,
							phase: 'generate',
							message: `emitter '${emitter.name}' failed`,
							cause,
						});
					}),
				);
			}

			return { outputDir, emitters: opts.emitters.map((e) => e.name) };
		}).pipe(Effect.withSpan(`codegen(${name})`)),
		{
			kind: 'app',
			displayTitle: `codegen.${name}`,
			display: (s: { readonly outputDir: string; readonly emitters: ReadonlyArray<string> }) => ({
				title: `codegen.${name}`,
				primary: s.outputDir,
				extras: [`${s.emitters.length} emitter${s.emitters.length === 1 ? '' : 's'}`],
			}),
		},
	);
};
