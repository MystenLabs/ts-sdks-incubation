// Codegen orchestrator — main service.
//
// Architecture §6 (Codegenable):
//   "Codegen is a surface (L4) that walks the plugin-emitted
//    `Codegenable` capability decls."
//
// Hard boundary (distilled-doc §"Hard boundary"):
//   "Apps consume codegen output, NOT devstack." Every runtime value
//   the app needs flows through codegen-emitted TS files. The
//   orchestrator owns the only legitimate channel from stack state
//   to app code.
//
// Lifecycle (distilled-doc §"Lifecycle states"):
//   - at-up:       per supervisor cycle, run all emitters serially,
//                  with per-file atomic/idempotent writes.
//   - on-change:   re-run as part of the new cycle when the
//                  supervisor restarts.
//   - on-demand:   same emit pipeline for snapshot resume.
//   - idempotency: per-file no-touch on unchanged content.
//
// Pipeline (one cycle):
//   1. Collect `Codegenable` contributions from the active stack
//      members (the supervisor walks `member.capabilities`).
//   2. Validate uniqueness: emitter name (literal) is globally
//      unique; output path is globally unique.
//   3. Run each emitter serially (distilled-doc § "Serial within a
//      cycle"). Each emit writes exports through a per-file context.
//   4. Render each collected file emission to a TS source string.
//   5. Emit each file with an atomic write + per-file no-touch
//      idempotency.
//   6. Run the Move-bindings emitter against the collected
//      `package`-emitted contributions.
//   7. Write the `.gitignore`.
//
// What this module does NOT do:
//   - Construct plugin-level resolved blobs (plugins pass them at
//     factory-build time).
//   - Decode the manifest envelope (see `manifest-bridge.ts`).
//   - Watch files (see `watcher.ts`).
//   - Walk the user's Move-source mtimes (see `bindings.ts`).

import { Context, Effect, FileSystem, Layer, Order, Ref, Scope } from 'effect';
import { dirname } from 'node:path';

import type {
	CodegenableDecl,
	CodegenEmitDone,
	CodegenEmitContext,
} from '../../contracts/codegenable.ts';

import {
	emitBindings,
	type EmitBindingsResult,
	MoveCodegenService,
	MoveSummaryRunnerService,
	type PackageBindings,
} from './bindings.ts';
import { emitOne } from './emit.ts';
import {
	CodegenEmitFailed,
	CodegenEmitterCollision,
	CodegenPathConflict,
	type CodegenError,
} from './errors.ts';
import { renderFile } from './format.ts';
import { writeGitignore } from './gitignore.ts';
import { CodegenPathsService } from './paths.ts';
import { dirModeFor, modeFor, NON_SENSITIVE_DIR_MODE } from './permissions.ts';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/** A type alias the orchestrator uses internally to avoid restating
 *  the wide-erased `CodegenableDecl` generic in every signature. */
export type Codegenable = CodegenableDecl<string>;

export interface RunEmitCycleInput {
	/** All Codegenable contributions, as collected from the active
	 *  stack members' `capabilities` tuples. The orchestrator does
	 *  not look at plugins — only at the decl set. */
	readonly contributions: ReadonlyArray<Codegenable>;
	/** Optional: import-extension for bindings emission. Default `.ts`. */
	readonly bindingsImportExtension?: '.ts' | '.js' | '';
}

export interface RunEmitCycleResult {
	readonly filesWritten: ReadonlyArray<string>;
	readonly filesUnchanged: ReadonlyArray<string>;
	readonly filesChmod: ReadonlyArray<string>;
	readonly bindings: EmitBindingsResult | null;
}

const buildParentModeResolver = (
	paths: { readonly resolve: (outputPath: string) => string },
	decls: ReadonlyArray<Codegenable>,
): ((absolutePath: string) => number) => {
	const byParent = new Map<string, Array<Pick<Codegenable, 'sensitive'>>>();
	for (const decl of decls) {
		const parent = dirname(paths.resolve(decl.outputPath));
		const current = byParent.get(parent);
		if (current === undefined) {
			byParent.set(parent, [decl]);
		} else {
			current.push(decl);
		}
	}
	const modes = new Map<string, number>();
	for (const [parent, parentDecls] of byParent) {
		modes.set(parent, dirModeFor(parentDecls));
	}
	return (absolutePath) => modes.get(dirname(absolutePath)) ?? NON_SENSITIVE_DIR_MODE;
};

// -----------------------------------------------------------------------------
// Main entry — one cycle of the codegen pipeline
// -----------------------------------------------------------------------------

export const runEmitCycle = (
	input: RunEmitCycleInput,
): Effect.Effect<
	RunEmitCycleResult,
	CodegenError,
	FileSystem.FileSystem | CodegenPathsService | MoveSummaryRunnerService | MoveCodegenService
> =>
	Effect.gen(function* () {
		const paths = yield* CodegenPathsService;

		// 1. All contributions go through the generic file emit path.
		//    Package outputs are collected for the bindings emitter
		//    from the same single evaluated result used to render the
		//    package pointer file.
		const fileEmitters: Array<Codegenable> = [];
		for (const decl of input.contributions) {
			fileEmitters.push(decl);
		}

		// 2. Validate uniqueness — both `emitterName` and `outputPath`.
		//    Detected BEFORE write so the user-visible tree is
		//    never half-written. `package` is the one exception:
		//    multiple instances (one per Package) share the same
		//    `emitterName` literal by design.
		yield* validateUniqueness(fileEmitters);
		yield* validateAggregatePathAvailability(fileEmitters);

		// 3-5. Run + render + emit each non-bindings contribution.
		const filesWritten: Array<string> = [];
		const filesUnchanged: Array<string> = [];
		const filesChmod: Array<string> = [];
		const aggregates = emptyAggregateBuckets();
		const packageContribs: Array<PackageBindings> = [];
		const sortedDecls = [...fileEmitters].sort(
			Order.mapInput(Order.String, (d: Codegenable) => d.outputPath),
		);
		const parentModeFor = buildParentModeResolver(paths, fileEmitters);
		for (const decl of sortedDecls) {
			const emission = yield* runEmitter(decl);
			const exported = emission.exports;
			collectAggregateExport(aggregates, decl, exported);
			if (decl.emitterName === 'package') {
				const bindings = exported['packageBindings'];
				if (isPackageBindings(bindings)) {
					packageContribs.push(bindings);
				}
			}
			const rendered = renderFile({
				emitterName: decl.emitterName,
				outputPath: decl.outputPath,
				sensitive: decl.sensitive === true,
				exports: exported,
				imports: emission.imports,
			});
			if (rendered instanceof Error) {
				// `renderFile` returns either a string or a
				// `CodegenRenderError` (extends Error). Yield the
				// tagged form.
				return yield* Effect.fail(rendered as CodegenError);
			}
			const abs = paths.resolve(decl.outputPath);
			const outcome = yield* emitOne({
				path: abs,
				content: rendered,
				mode: modeFor(decl),
				parentMode: parentModeFor(abs),
			});
			switch (outcome.outcome) {
				case 'wrote':
					filesWritten.push(abs);
					break;
				case 'unchanged':
					filesUnchanged.push(abs);
					break;
				case 'chmod-only':
					filesChmod.push(abs);
					break;
			}
		}

		for (const aggregate of buildAggregateFiles(aggregates)) {
			const rendered = renderFile({
				emitterName: aggregate.emitterName,
				outputPath: aggregate.outputPath,
				sensitive: false,
				exports: aggregate.exports,
			});
			if (rendered instanceof Error) {
				return yield* Effect.fail(rendered as CodegenError);
			}
			const abs = paths.resolve(aggregate.outputPath);
			const outcome = yield* emitOne({
				path: abs,
				content: rendered,
				mode: 0o644,
				parentMode: parentModeFor(abs),
			});
			switch (outcome.outcome) {
				case 'wrote':
					filesWritten.push(abs);
					break;
				case 'unchanged':
					filesUnchanged.push(abs);
					break;
				case 'chmod-only':
					filesChmod.push(abs);
					break;
			}
		}

		// 6. Bindings emitter. Skipped when there are no local
		//    packages (distilled-doc § "Skip-emit is explicit and
		//    logged").
		let bindings: EmitBindingsResult | null = null;
		if (packageContribs.length > 0) {
			bindings = yield* emitBindings({
				bindingsDir: paths.bindingsDir,
				packages: packageContribs,
				importExtension: input.bindingsImportExtension,
			});
		} else {
			yield* Effect.logInfo(
				'codegen: no package contributions; skipping Move-to-TS bindings step.',
			);
		}

		// 7. Gitignore. Sensitive paths get an explicit mention.
		const sensitivePaths = fileEmitters
			.filter((d) => d.sensitive === true)
			.map((d) => d.outputPath);
		yield* writeGitignore({
			path: paths.gitignoreFile,
			sensitivePaths,
			parentMode: parentModeFor(paths.gitignoreFile),
		});

		return {
			filesWritten,
			filesUnchanged,
			filesChmod,
			bindings,
		};
	}).pipe(
		Effect.withSpan('codegen.runEmitCycle', {
			attributes: {
				'codegen.contributions': input.contributions.length,
			},
		}),
	);

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

interface CodegenEmission {
	readonly exports: { readonly [key: string]: unknown };
	readonly imports: ReadonlyArray<string>;
}

const runEmitter = (decl: Codegenable): Effect.Effect<CodegenEmission, CodegenEmitFailed> =>
	Effect.gen(function* () {
		const exports: Record<string, unknown> = {};
		const imports: Array<string> = [];
		const done: CodegenEmitDone = { _tag: 'CodegenEmitDone' };
		const ctx: CodegenEmitContext = {
			exportConst: (name, value) => {
				exports[name] = value;
			},
			importStatement: (statement) => {
				imports.push(statement);
			},
			done: () => done,
		};
		yield* decl.emit(ctx).pipe(
			Effect.mapError(
				(cause) =>
					new CodegenEmitFailed({
						emitterName: decl.emitterName,
						outputPath: decl.outputPath,
						cause,
					}),
			),
		);
		return { exports, imports };
	});

/**
 * Uniqueness check: emitter name (literal) must be unique EXCEPT
 * for the `package` emitter, which legitimately appears once per
 * Package contribution. Output paths must be unique across ALL
 * emitters (including each `package`-emitted pointer file).
 */
const validateUniqueness = (
	decls: ReadonlyArray<Codegenable>,
): Effect.Effect<void, CodegenPathConflict | CodegenEmitterCollision> =>
	Effect.gen(function* () {
		const byPath = new Map<string, Array<string>>();
		const byName = new Map<string, Array<string>>();
		for (const d of decls) {
			const ps = byPath.get(d.outputPath) ?? [];
			ps.push(d.emitterName);
			byPath.set(d.outputPath, ps);
			// `package` is allowed to repeat — it's per-Package by design.
			if (d.emitterName === 'package') continue;
			const ns = byName.get(d.emitterName) ?? [];
			ns.push(d.outputPath);
			byName.set(d.emitterName, ns);
		}
		for (const [path, emitters] of byPath) {
			if (emitters.length > 1) {
				return yield* Effect.fail(
					new CodegenPathConflict({
						outputPath: path,
						emitters,
					}),
				);
			}
		}
		for (const [name, outputPaths] of byName) {
			if (outputPaths.length > 1) {
				return yield* Effect.fail(
					new CodegenEmitterCollision({
						emitterName: name,
						outputPaths,
					}),
				);
			}
		}
	});

const AGGREGATE_OUTPUTS = {
	accounts: 'accounts.ts',
	coins: 'coins.ts',
	packages: 'packages.ts',
	services: 'services.ts',
} as const;

const aggregatePathFor = (decl: Codegenable): string | null => {
	if (decl.emitterName.startsWith('account/')) return AGGREGATE_OUTPUTS.accounts;
	if (decl.emitterName.startsWith('coin/')) return AGGREGATE_OUTPUTS.coins;
	if (decl.emitterName === 'package') return AGGREGATE_OUTPUTS.packages;
	if (decl.emitterName === 'sui-network') return AGGREGATE_OUTPUTS.services;
	return null;
};

const validateAggregatePathAvailability = (
	decls: ReadonlyArray<Codegenable>,
): Effect.Effect<void, CodegenPathConflict> =>
	Effect.gen(function* () {
		const aggregatePaths = new Set<string>();
		for (const decl of decls) {
			const path = aggregatePathFor(decl);
			if (path !== null) aggregatePaths.add(path);
		}
		for (const path of aggregatePaths) {
			const colliding = decls.filter((decl) => decl.outputPath === path);
			if (colliding.length > 0) {
				return yield* Effect.fail(
					new CodegenPathConflict({
						outputPath: path,
						emitters: [...colliding.map((decl) => decl.emitterName), `aggregate/${path}`],
					}),
				);
			}
		}
	});

interface AggregateBuckets {
	readonly accounts: Record<string, unknown>;
	readonly coins: Record<string, unknown>;
	readonly packages: Record<string, unknown>;
	readonly services: Record<string, unknown>;
}

const emptyAggregateBuckets = (): AggregateBuckets => ({
	accounts: {},
	coins: {},
	packages: {},
	services: {},
});

const collectAggregateExport = (
	buckets: AggregateBuckets,
	decl: Codegenable,
	exported: { readonly [key: string]: unknown },
): void => {
	if (decl.emitterName.startsWith('account/')) {
		Object.assign(buckets.accounts, exported);
		return;
	}
	if (decl.emitterName.startsWith('coin/')) {
		Object.assign(buckets.coins, exported);
		return;
	}
	if (decl.emitterName === 'package') {
		const bindings = exported['packageBindings'];
		if (isPackageBindings(bindings)) {
			buckets.packages[bindings.name] = bindings;
		}
		return;
	}
	if (decl.emitterName === 'sui-network') {
		const network = exported['suiNetwork'];
		if (isRecord(network)) {
			const rpcUrl = stringField(network, 'rpcUrl');
			const faucetUrl = stringField(network, 'faucetUrl');
			const graphqlUrl = stringField(network, 'graphqlUrl');
			buckets.services['sui'] = {
				rpc: { url: rpcUrl ?? '' },
				faucet: faucetUrl === null ? null : { url: faucetUrl },
				graphql: graphqlUrl === null ? null : { url: graphqlUrl },
			};
		}
	}
};

interface AggregateFile {
	readonly emitterName: string;
	readonly outputPath: string;
	readonly exports: { readonly [key: string]: unknown };
}

const buildAggregateFiles = (buckets: AggregateBuckets): ReadonlyArray<AggregateFile> => {
	const files: Array<AggregateFile> = [];
	if (Object.keys(buckets.accounts).length > 0) {
		files.push({
			emitterName: 'aggregate/accounts',
			outputPath: AGGREGATE_OUTPUTS.accounts,
			exports: { accounts: buckets.accounts },
		});
	}
	if (Object.keys(buckets.coins).length > 0) {
		files.push({
			emitterName: 'aggregate/coins',
			outputPath: AGGREGATE_OUTPUTS.coins,
			exports: { coins: buckets.coins },
		});
	}
	if (Object.keys(buckets.packages).length > 0) {
		files.push({
			emitterName: 'aggregate/packages',
			outputPath: AGGREGATE_OUTPUTS.packages,
			exports: { packages: buckets.packages },
		});
	}
	if (Object.keys(buckets.services).length > 0) {
		files.push({
			emitterName: 'aggregate/services',
			outputPath: AGGREGATE_OUTPUTS.services,
			exports: { services: buckets.services },
		});
	}
	return files;
};

const isPackageBindings = (v: unknown): v is PackageBindings =>
	typeof v === 'object' &&
	v !== null &&
	'name' in v &&
	'packageId' in v &&
	'mvrPlaceholder' in v &&
	'sourcePath' in v;

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
	typeof v === 'object' && v !== null;

const stringField = (record: Readonly<Record<string, unknown>>, key: string): string | null => {
	const value = record[key];
	return typeof value === 'string' && value.length > 0 ? value : null;
};

// -----------------------------------------------------------------------------
// Service surface — registration API + emit-cycle trigger
// -----------------------------------------------------------------------------

/**
 * The codegen orchestrator's Context-bound service. The substrate's
 * supervisor calls `registerContribution(pluginKey, decl)` once per
 * `CodegenableDecl` on each plugin's `capabilities` tuple, scope-bound
 * to that plugin's acquire scope. `runCycle()` walks the registered
 * set and runs one full emit pipeline.
 */
export interface CodegenOrchestrator {
	/** Register a `CodegenableDecl` from a plugin. Scope-bound — when
	 *  the caller's scope (the plugin's acquire scope) closes, the
	 *  registration is reaped. */
	readonly registerContribution: (
		pluginKey: string,
		decl: Codegenable,
	) => Effect.Effect<void, never, Scope.Scope>;

	/** Run one emit cycle against the currently-registered set.
	 *  `extraContributions` are merged into the active set (callers
	 *  that have a one-off decl not tied to a plugin scope).
	 *  `bindingsImportExtension` mirrors `runEmitCycle`. */
	readonly runCycle: (args?: {
		readonly extraContributions?: ReadonlyArray<Codegenable>;
		readonly bindingsImportExtension?: '.ts' | '.js' | '';
	}) => Effect.Effect<
		RunEmitCycleResult,
		CodegenError,
		FileSystem.FileSystem | CodegenPathsService | MoveSummaryRunnerService | MoveCodegenService
	>;
}

export class CodegenOrchestratorService extends Context.Service<
	CodegenOrchestratorService,
	CodegenOrchestrator
>()('@devstack-rewrite/orchestrators/Codegen') {}

interface RegisteredCodegenEntry {
	readonly pluginKey: string;
	readonly decl: Codegenable;
	readonly seq: number;
}

/** Layer-wired codegen orchestrator. No upstream requirements at boot
 *  time — the per-cycle effect carries the `FileSystem` + Move-codegen
 *  service requirements through to the caller. */
export const layerCodegenOrchestrator: Layer.Layer<CodegenOrchestratorService> = Layer.effect(
	CodegenOrchestratorService,
	Effect.gen(function* () {
		const contributionsRef = yield* Ref.make<ReadonlyArray<RegisteredCodegenEntry>>([]);
		const seqRef = yield* Ref.make(0);

		const registerContribution: CodegenOrchestrator['registerContribution'] = (pluginKey, decl) =>
			Effect.gen(function* () {
				const seq = yield* Ref.updateAndGet(seqRef, (n) => n + 1);
				const entry: RegisteredCodegenEntry = { pluginKey, decl, seq };
				yield* Ref.update(contributionsRef, (xs) => [...xs, entry]);
				yield* Effect.addFinalizer(() =>
					Ref.update(contributionsRef, (xs) => xs.filter((e) => e.seq !== seq)),
				);
				yield* Effect.annotateCurrentSpan({
					'codegen.contribution.plugin': pluginKey,
					'codegen.contribution.emitter': decl.emitterName,
					'codegen.contribution.outputPath': decl.outputPath,
				});
			}).pipe(Effect.withSpan('orchestrator.codegen.registerContribution')) as Effect.Effect<
				void,
				never,
				Scope.Scope
			>;

		const runCycle: CodegenOrchestrator['runCycle'] = (args) =>
			Effect.gen(function* () {
				const registered = (yield* Ref.get(contributionsRef)).map((e) => e.decl);
				const merged: ReadonlyArray<Codegenable> = args?.extraContributions
					? [...registered, ...args.extraContributions]
					: registered;
				return yield* runEmitCycle({
					contributions: merged,
					bindingsImportExtension: args?.bindingsImportExtension,
				});
			}).pipe(Effect.withSpan('orchestrator.codegen.runCycle'));

		return CodegenOrchestratorService.of({
			registerContribution,
			runCycle,
		});
	}),
);
