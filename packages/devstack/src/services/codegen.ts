// Codegen(opts) — the canonical codegen Ref. Runs a list of emitter
// plug-ins against the resolved Package set at acquire time.
//
// Architecture:
//   - User declares `Codegen({ output, packages })` once at the
//     top of the stack. With no `emitters` field, `BindingsEmitter()`
//     (Move → TS bindings via `@mysten/codegen`) is used by default,
//     which is what 90% of stacks want.
//   - For multiple emitters or per-emitter options, pass them
//     explicitly: `Codegen({ ..., emitters: [BindingsEmitter(),
//     DappKitEmitter({ flavor: 'react' })] })`.
//   - Each Package(...) the stack contains feeds into Codegen's context
//     (unless it sets `{ codegen: false }`).
//   - Each emitter sees the same `{ packages, outputDir }` context and
//     writes to its own subdirectory under `outputDir`.
//
// Built-in emitters: `BindingsEmitter` (Move → TS bindings) and
// `DappKitEmitter` (React/Vue hooks). User emitters drop in alongside
// via `defineEmitter({ name, emit })`.

import * as path from 'node:path';
import { Effect } from 'effect';
import { tag, setPhase, type Ref } from '../advanced/tag.js';
import type { Emitter, CodegenContext, CodegenPackage } from '../codegen/define-emitter.js';
import { BindingsEmitter } from '../codegen/emitters/bindings.js';
import { CodegenError } from '../codegen/errors.js';
import type { Package, LocalPackage } from './package.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Canonical default output directory for `Codegen({})`. Imported by
 *  app code (`import ... from './generated/bindings/...'`) so it lives in
 *  a normal `src/`-typed source dir, NOT under the `.devstack/` dot-dir
 *  (which is reserved for non-importable runtime state — see the
 *  invariant comment in `engine/service-paths.ts`). The relative form
 *  resolves against the example app's `process.cwd()` at codegen time. */
export const DEFAULT_CODEGEN_OUTPUT = './src/generated';

export interface CodegenOptions {
	/** Output directory. Resolved relative to `process.cwd()` if not
	 *  absolute. Each emitter writes under a subdirectory of this path
	 *  (`<output>/bindings/`, `<output>/dapp-kit/`, …) so multiple
	 *  emitters coexist without collision.
	 *
	 *  Defaults to `./src/generated` — a normal source dir picked up by
	 *  TypeScript's `include` patterns and Vite's resolve graph, so app
	 *  code can `import { useFoo } from './generated/dapp-kit/foo.js'`
	 *  without extra wiring. The `.devstack/` dot-dir is intentionally
	 *  NOT used here: that path is reserved for non-importable runtime
	 *  state (account keys, wallet tokens, walrus deploy outputs, etc.). */
	readonly output?: string;
	/** Package refs to emit for. `Package(...)` refs emit fully;
	 *  `KnownPackage(...)` refs are silently skipped at emit time by
	 *  emitters that need Move source (e.g. `BindingsEmitter`). The
	 *  type is loose because TS treats the shape parameter as invariant
	 *  on `Ref`; the emitter validates package shape at runtime.
	 *
	 *  Defaults to `[]` — Phase-6 default-provider auto-includes every
	 *  `Package(...)` in the stack that doesn't opt out via
	 *  `{ codegen: false }`, so most users omit this. */
	readonly packages?: ReadonlyArray<Ref<any, any, any, any>>;
	/** Emitter plug-ins to run. Run in declaration order; one emitter's
	 *  output isn't visible to another (each emitter is independent).
	 *  Defaults to `[BindingsEmitter()]` — Move → TS bindings via
	 *  `@mysten/codegen`, which is what most stacks want. Override to
	 *  add DappKitEmitter, swap in user emitters, or change emitter
	 *  options. */
	readonly emitters?: ReadonlyArray<Emitter>;
	/** Override tag name. Defaults to `'codegen'`. */
	readonly name?: string;
}

/** Resolve a Package Ref's value into the `CodegenPackage` shape every
 *  emitter consumes. Local packages carry `sourcePath`; remote/known
 *  packages don't (emitters that need source filter to entries where
 *  it's defined). */
const toCodegenPackage = (pkg: Package | LocalPackage): CodegenPackage => {
	const base: { name: string; packageId: string; mvrPlaceholder: string } = {
		name: pkg.name,
		packageId: pkg.packageId,
		mvrPlaceholder:
			'mvrPlaceholder' in pkg && pkg.mvrPlaceholder !== undefined
				? pkg.mvrPlaceholder
				: pkg.name,
	};
	const local = 'sourcePath' in pkg ? (pkg as LocalPackage) : undefined;
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
 *  `CodegenContext` (after every emitter has run).
 *
 *  Zero-config: `Codegen({})` (or just `Codegen()`) uses every default —
 *  `output: './src/generated'`, `packages: []` (auto-fill TBD), and
 *  `emitters: [BindingsEmitter()]`. Most stacks should call it that
 *  way and let the defaults do their job. */
export const Codegen = (opts: CodegenOptions = {}) => {
	const name = opts.name ?? 'codegen';
	const packageRefs = opts.packages ?? [];
	const emitters = opts.emitters ?? [BindingsEmitter()];
	const output = opts.output ?? DEFAULT_CODEGEN_OUTPUT;
	return tag(
		`codegen/${name}` as const,
		Effect.gen(function* () {
			const outputDir = path.isAbsolute(output)
				? output
				: path.resolve(process.cwd(), output);

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

			// Collision detection: each emitter conventionally writes
			// under `<outputDir>/<emitter.name>/`. Two emitters with the
			// same `name` would clobber each other's output (and which
			// one wins depends on iteration order, which is fragile).
			// Fail loudly at acquire time so the conflict surfaces with
			// the user's `Codegen({ emitters: [...] })` site in the
			// stack trace, not as a mysterious missing-file error
			// during a downstream consumer's TS build.
			const emitterNamesSeen = new Set<string>();
			for (const emitter of emitters) {
				if (emitterNamesSeen.has(emitter.name)) {
					return yield* Effect.fail(
						new CodegenError({
							emitter: emitter.name,
							phase: 'generate',
							message:
								`Codegen('${name}'): duplicate emitter name '${emitter.name}'. ` +
								`Each emitter writes under <outputDir>/<emitter.name>/; two ` +
								`emitters with the same name would clobber each other.`,
						}),
					);
				}
				emitterNamesSeen.add(emitter.name);
			}

			const ctx: CodegenContext = { packages: resolved, outputDir };
			yield* Effect.annotateCurrentSpan({
				'codegen.output': outputDir,
				'codegen.packages': resolved.map((p) => p.name).join(','),
				'codegen.emitters': emitters.map((e) => e.name).join(','),
			});

			// Serial emit (concurrency: 1). Per-emitter locking is on the
			// long-tail wishlist; until then, serial avoids the
			// `~/.move` and bind-mount races between concurrent
			// `sui move {build,summary}` invocations.
			for (const emitter of emitters) {
				yield* setPhase(`emit: ${emitter.name}`);
				yield* emitter.emit(ctx).pipe(
					Effect.mapError((cause) => {
						if (cause instanceof CodegenError) {
							// Preserve the emitter's `phase` rather than
							// re-wrapping into 'generate' — the original
							// classification (e.g. 'write' for atomic
							// dir-swap failures) is more diagnostic.
							return cause;
						}
						return new CodegenError({
							emitter: emitter.name,
							phase: 'generate',
							message: `emitter '${emitter.name}' failed`,
							cause,
						});
					}),
				);
			}

			return { outputDir, emitters: emitters.map((e) => e.name) };
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
