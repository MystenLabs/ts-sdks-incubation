// Move-package bindings emission.
//
// Distilled-doc § "Move-to-TS bindings: per-published-package typed
// client modules produced from each local Move package's summary."
// Drives `@mysten/codegen`'s `generateFromPackageSummary` against
// `MoveSummary` JSON contributed by a plugin-owned
// `MoveSummaryRunnerService`.
//
// sourcePath-known-vs-unknown discipline:
//   - `Package` plugin's `Codegenable` emits a `PackageBindings`
//     shape with `sourcePath: string | null`.
//   - The bindings emitter filters to `sourcePath !== null` (i.e.
//     LOCAL packages); `KnownPackage` entries (`sourcePath: null`)
//     are skipped — their bindings come from the SDK or MVR.
//
// Architecture seam:
//   - `MoveSummaryRunnerService` is contributed by a plugin (the
//     sui plugin ships `layerSuiMoveSummaryRunnerDocker` /
//     `layerSuiMoveSummaryRunnerHost`). The codegen orchestrator
//     consumes only the abstract service — it never names the Sui
//     CLI binary or container image (architecture: "Orchestrator
//     boundaries — never names a service").
//   - The call to `@mysten/codegen.generateFromPackageSummary` is
//     similarly behind a tagged service so unit tests can stub it
//     without pulling in the heavyweight `@mysten/codegen` graph.
//
// Distilled-doc § "Silent no-op from a downstream tool is a
// failure": after summary + render, we probe the output dir.
// If it's empty, that's a `CodegenBindingsFailed` with a hint about
// the common `Move.toml` `[addresses]` cause.

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { generateFromPackageSummary } from '@mysten/codegen';
import { Context, Effect, FileSystem, Layer } from 'effect';

import type { ImageRef } from '../../contracts/container-runtime.ts';

import { emitOne } from './emit.ts';
import { CodegenBindingsFailed } from './errors.ts';
import { NON_SENSITIVE_DIR_MODE, NON_SENSITIVE_FILE_MODE } from './permissions.ts';

// -----------------------------------------------------------------------------
// Service seam — Move summary + codegen invocation
// -----------------------------------------------------------------------------

/** Result of `sui move summary` — opaque JSON the codegen generator
 *  consumes. We don't decode it here; `@mysten/codegen` owns the
 *  schema. */
export interface MoveSummary {
	readonly packageName: string;
	readonly sourcePath: string;
	readonly summaryPath?: string;
	readonly cleanupPath?: string;
	readonly summaryJson: unknown;
}

export interface MoveSummaryInput {
	readonly packageName: string;
	readonly sourcePath: string;
	readonly buildImage?: ImageRef | null;
}

/** Shape of the Move summary runner. Implementations live in
 *  plugin packages (e.g. `plugins/sui/move-summary-runner.ts`
 *  exports `layerSuiMoveSummaryRunnerDocker` and
 *  `layerSuiMoveSummaryRunnerHost`); tests use `stubMoveSummaryRunner`
 *  below. */
export interface MoveSummaryRunner {
	readonly runSummary: (
		input: MoveSummaryInput,
	) => Effect.Effect<MoveSummary, CodegenBindingsFailed>;
}

export class MoveSummaryRunnerService extends Context.Service<
	MoveSummaryRunnerService,
	MoveSummaryRunner
>()('@devstack/orchestrator/MoveSummaryRunner') {}

/** Shape of the `@mysten/codegen` invocation. Returns the rendered
 *  TS files (path → content) for one package. */
export interface MoveCodegen {
	readonly generate: (input: {
		readonly packageName: string;
		readonly sourcePath: string;
		readonly summary: MoveSummary;
		readonly mvrPlaceholder: string;
		readonly importExtension: '.ts' | '.js' | '';
	}) => Effect.Effect<
		ReadonlyArray<{ readonly relPath: string; readonly content: string }>,
		CodegenBindingsFailed
	>;
}

export class MoveCodegenService extends Context.Service<MoveCodegenService, MoveCodegen>()(
	'@devstack/orchestrator/MoveCodegen',
) {}

// -----------------------------------------------------------------------------
// Public entry — emit bindings for the local packages in a set of
// PackageBindings contributions.
// -----------------------------------------------------------------------------

export interface PackageBindings {
	readonly name: string;
	readonly packageId: string;
	readonly mvrPlaceholder: string;
	readonly sourcePath: string | null;
	readonly excluded: boolean;
}

export interface EmitBindingsInput {
	readonly bindingsDir: string;
	readonly packages: ReadonlyArray<PackageBindings>;
	readonly importExtension?: '.ts' | '.js' | '';
}

export interface EmitBindingsResult {
	readonly packagesEmitted: ReadonlyArray<string>;
	readonly packagesSkipped: ReadonlyArray<string>;
	readonly filesWritten: ReadonlyArray<string>;
}

/**
 * Walk the `PackageBindings` set, filter to LOCAL packages
 * (`sourcePath !== null`), run `sui move summary` + `@mysten/codegen`
 * for each, and write the rendered files into `bindingsDir/<name>/`.
 *
 * Serial within a cycle (distilled-doc § "Serial within a cycle":
 * shared Move build cache races). Per-package parallelism is unsafe.
 */
export const emitBindings = (
	input: EmitBindingsInput,
): Effect.Effect<
	EmitBindingsResult,
	CodegenBindingsFailed,
	FileSystem.FileSystem | MoveSummaryRunnerService | MoveCodegenService
> =>
	Effect.gen(function* () {
		const runner = yield* MoveSummaryRunnerService;
		const generator = yield* MoveCodegenService;
		const importExtension = input.importExtension ?? '.ts';

		// Dedup by package name. First-wins; distilled-doc § "Duplicate
		// package names": warn + skip the duplicate to avoid the HMR
		// re-emit storm.
		const seen = new Set<string>();
		const targets: Array<PackageBindings> = [];
		const skipped: Array<string> = [];
		for (const pkg of input.packages) {
			if (pkg.sourcePath === null) {
				skipped.push(pkg.name);
				continue;
			}
			if (pkg.excluded) {
				skipped.push(pkg.name);
				continue;
			}
			if (seen.has(pkg.name)) {
				yield* Effect.logWarning(
					`codegen.bindings: duplicate package name '${pkg.name}' — keeping ` +
						`first and skipping duplicate to avoid HMR re-emit storm. ` +
						`Rename one of the packages.`,
				);
				skipped.push(pkg.name);
				continue;
			}
			seen.add(pkg.name);
			targets.push(pkg);
		}
		// Deterministic order: lexicographic by package name.
		targets.sort((a, b) => a.name.localeCompare(b.name));

		const emitted: Array<string> = [];
		const filesWritten: Array<string> = [];
		for (const pkg of targets) {
			// sourcePath is non-null per the filter above. Narrow.
			if (pkg.sourcePath === null) continue;
			const summary = yield* runner.runSummary({
				packageName: pkg.name,
				sourcePath: pkg.sourcePath,
			});
			const files = yield* generator.generate({
				packageName: pkg.name,
				sourcePath: pkg.sourcePath,
				summary,
				mvrPlaceholder: pkg.mvrPlaceholder,
				importExtension,
			});
			// Post-emit probe — silent no-op detection.
			if (files.length === 0) {
				return yield* Effect.fail(
					new CodegenBindingsFailed({
						package: pkg.name,
						sourcePath: pkg.sourcePath,
						reason: 'no-output',
						hint:
							'The Move codegen generator produced no files. This is ' +
							'usually caused by a missing `[addresses]` block in the ' +
							"package's Move.toml, or a non-published address mapping.",
					}),
				);
			}
			for (const f of files) {
				if (f.relPath.includes('..') || f.relPath.startsWith('/')) {
					return yield* Effect.fail(
						new CodegenBindingsFailed({
							package: pkg.name,
							sourcePath: pkg.sourcePath,
							reason: 'write-failed',
							cause: new Error(`generated binding path escapes output dir: ${f.relPath}`),
						}),
					);
				}
				const abs = joinPath(input.bindingsDir, f.relPath);
				const outcome = yield* emitOne({
					path: abs,
					content: stabilizeGeneratedBindingContent(f.content),
					mode: NON_SENSITIVE_FILE_MODE,
					parentMode: NON_SENSITIVE_DIR_MODE,
				}).pipe(
					Effect.mapError(
						(cause) =>
							new CodegenBindingsFailed({
								package: pkg.name,
								sourcePath: pkg.sourcePath!,
								reason: 'write-failed',
								cause,
							}),
					),
				);
				if (outcome.outcome !== 'unchanged') {
					filesWritten.push(abs);
				}
			}
			emitted.push(pkg.name);
		}

		return {
			packagesEmitted: emitted,
			packagesSkipped: skipped,
			filesWritten,
		};
	}).pipe(
		Effect.withSpan('codegen.emitBindings', {
			attributes: { 'codegen.bindingsDir': input.bindingsDir },
		}),
	);

// -----------------------------------------------------------------------------
// Stub implementations for tests
// -----------------------------------------------------------------------------

/** Stub runner — returns a synthetic summary. Used in unit tests
 *  to exercise the bindings pipeline without a real `sui` binary. */
export const stubMoveSummaryRunner = (
	summaryFor: (sourcePath: string) => MoveSummary,
): MoveSummaryRunner => ({
	runSummary: ({ sourcePath }) => Effect.succeed(summaryFor(sourcePath)),
});

/** Stub generator — returns a synthetic file set. Used in unit
 *  tests to exercise the bindings pipeline without pulling in the
 *  heavyweight `@mysten/codegen` graph. */
export const stubMoveCodegen = (
	files: (
		input: Parameters<MoveCodegen['generate']>[0],
	) => ReadonlyArray<{ readonly relPath: string; readonly content: string }>,
): MoveCodegen => ({
	generate: (input) => Effect.succeed(files(input)),
});

// -----------------------------------------------------------------------------
// Production implementations
// -----------------------------------------------------------------------------
//
// Layer factories for `MoveSummaryRunnerService` are plugin-owned —
// they live in `src/plugins/sui/move-summary-runner.ts`. The codegen
// orchestrator does not name the Sui CLI binary or container image;
// per "Orchestrator boundaries — never names a service", any plugin
// that can produce `MoveSummary` JSON may contribute a runner Layer.

export const layerMystenMoveCodegen: Layer.Layer<MoveCodegenService> = Layer.succeed(
	MoveCodegenService,
	MoveCodegenService.of({
		generate: (input) =>
			Effect.tryPromise({
				try: async () => {
					const tmp = await mkdtemp(join(tmpdir(), 'devstack-move-codegen-'));
					try {
						await generateFromPackageSummary({
							package: {
								path: input.summary.summaryPath ?? input.sourcePath,
								package: input.mvrPlaceholder,
								packageName: input.packageName,
							},
							prune: true,
							outputDir: tmp,
							importExtension: input.importExtension,
						});
						return await collectGeneratedFiles(tmp);
					} finally {
						await rm(tmp, { recursive: true, force: true });
						if (input.summary.cleanupPath !== undefined) {
							await rm(input.summary.cleanupPath, { recursive: true, force: true });
						}
					}
				},
				catch: (cause) =>
					new CodegenBindingsFailed({
						package: input.packageName,
						sourcePath: input.sourcePath,
						reason: 'render-failed',
						cause,
					}),
			}),
	}),
);

// -----------------------------------------------------------------------------
// Local helpers — keep the module dep-free of Path.Path so the
// caller can compose without an extra service yield.
// -----------------------------------------------------------------------------

const joinPath = (...parts: ReadonlyArray<string>): string =>
	parts.map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, ''))).join('/');

const generatedBcsFactoryPattern =
	/export function ([A-Za-z_$][\w$]*)<((?:[^<>]|<[^<>]*>)+)>\((\.\.\.typeParameters: \[[\s\S]*?\n\])\) \{\n(\s*)return new (MoveStruct|MoveEnum|MoveTuple)\(/g;

const bcsFactoryReturnType = (constructorName: string): string => {
	if (constructorName === 'MoveEnum') {
		return 'MoveEnum<any, string>';
	}
	if (constructorName === 'MoveTuple') {
		return 'MoveTuple<any, string>';
	}
	return 'MoveStruct<any, string>';
};

const stabilizeGeneratedBindingContent = (content: string): string =>
	content.replace(
		generatedBcsFactoryPattern,
		(_match, name, generics, parameters, indent, constructorName: string) =>
			`export function ${name}<${generics}>(${parameters}): ${bcsFactoryReturnType(
				constructorName,
			)} {\n${indent}return new ${constructorName}(`,
	);

const collectGeneratedFiles = async (
	root: string,
): Promise<ReadonlyArray<{ readonly relPath: string; readonly content: string }>> => {
	const out: Array<{ readonly relPath: string; readonly content: string }> = [];
	const walk = async (dir: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			const relPath = relative(root, abs).split(sep).join('/');
			out.push({ relPath, content: await readFile(abs, 'utf8') });
		}
	};
	await walk(root);
	out.sort((a, b) => a.relPath.localeCompare(b.relPath));
	return out;
};
