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
//                  with per-file atomic/idempotent writes inside a
//                  cycle-level stage-and-swap (rollback on any
//                  per-file failure leaves the user-visible tree
//                  unchanged).
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
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import type {
	CodegenableDecl,
	CodegenEmitDone,
	CodegenEmitContext,
} from '../../contracts/codegenable.ts';
import { acquireStackLock } from '../../substrate/runtime/cross-process/stack-lock.ts';
import { stageAndSwap, StageAndSwapError } from '../../substrate/runtime/stage-and-swap/index.ts';

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
	CodegenWriteFailed,
	type CodegenError,
} from './errors.ts';
import { renderFile } from './format.ts';
import { writeGitignore } from './gitignore.ts';
import { CodegenPathsService, type CodegenPaths } from './paths.ts';
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
	paths: CodegenPaths,
	decls: ReadonlyArray<Codegenable>,
): Effect.Effect<(absolutePath: string) => number, CodegenPathConflict> =>
	Effect.gen(function* () {
		const byParent = new Map<string, Array<Pick<Codegenable, 'sensitive'>>>();
		for (const decl of decls) {
			const parent = dirname(yield* paths.resolve(decl.outputPath));
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
		return (absolutePath: string) => modes.get(dirname(absolutePath)) ?? NON_SENSITIVE_DIR_MODE;
	});

// -----------------------------------------------------------------------------
// Main entry — one cycle of the codegen pipeline
// -----------------------------------------------------------------------------

/**
 * Per-cycle lock acquire timeout. Codegen cycles can be file-system
 * heavy (multi-emitter, Move-bindings compilation), so we allow more
 * than the substrate's default 5s for `stack.lock` — a custom CLI
 * caller that hits a supervisor mid-cycle should wait, not error.
 * Mirrors `MOVE_BUILD_LOCK_TIMEOUT_MS` (5 minutes).
 */
const CODEGEN_CYCLE_LOCK_TIMEOUT_MS = 5 * 60_000;

export const runEmitCycle = (
	input: RunEmitCycleInput,
): Effect.Effect<
	RunEmitCycleResult,
	CodegenError,
	FileSystem.FileSystem | CodegenPathsService | MoveSummaryRunnerService | MoveCodegenService
> =>
	// Per-process lock. The supervisor's serialized post-acquire path
	// is fine for the normal lifecycle, but custom callers (CLI direct
	// invocations, future watcher hooks) can call `runCycle`
	// concurrently. With `stageAndSwap` writing under shared
	// `<outputDir>.staging.<cycleId>` and `<outputDir>.bak.<cycleId>`
	// siblings — and with the pre-seed `fs.copy` reading from the
	// shared `outputDir` — two overlapping cycles can stage from a
	// half-published tree of the other. The lock serializes them.
	//
	// Dedicated `codegenLockFile` (NOT the substrate `stack.lock`):
	// codegen cycles can run for many seconds when Move bindings
	// compile, and the substrate's `stack.lock` is reserved for short
	// critical sections (roster mutations, snapshot reservation). A
	// dedicated lock isolates codegen contention from those subsystems.
	Effect.scoped(
		Effect.gen(function* () {
			const paths = yield* CodegenPathsService;
			yield* acquireStackLock(paths.codegenLockFile, CODEGEN_CYCLE_LOCK_TIMEOUT_MS).pipe(
				Effect.mapError(
					(cause) =>
						new CodegenWriteFailed({
							outputPath: paths.codegenLockFile,
							stage: 'write',
							cause,
						}),
				),
			);
			return yield* runEmitCycleLocked(input);
		}),
	);

const runEmitCycleLocked = (
	input: RunEmitCycleInput,
): Effect.Effect<
	RunEmitCycleResult,
	CodegenError,
	FileSystem.FileSystem | CodegenPathsService | MoveSummaryRunnerService | MoveCodegenService
> =>
	Effect.gen(function* () {
		const paths = yield* CodegenPathsService;
		// Yield the Move-codegen services here (outside the
		// stage-and-swap build) so the build's R-channel collapses to
		// just `FileSystem.FileSystem` — the substrate `stageAndSwap`
		// primitive constrains `build`'s requirements to
		// `FileSystem.FileSystem`.
		const moveRunner = yield* MoveSummaryRunnerService;
		const moveCodegen = yield* MoveCodegenService;

		// Pre-flight contribution-set validation. Detected BEFORE the
		// stage-and-swap so a programming-bug rejection (duplicate
		// emitterName / outputPath collision) never opens an empty
		// staging dir on disk. `package` is the one exception:
		// multiple instances (one per Package) legitimately share the
		// `emitterName` literal by design.
		yield* validateUniqueness(input.contributions);
		yield* validateAggregatePathAvailability(input.contributions);

		// Cycle-level atomicity: substrate stage-and-swap. The build
		// populates `<outputDir>.staging.<cycleId>/`; on success the
		// substrate renames it into place; on any failure the previous
		// tree (if any) is restored byte-for-byte. Without this wrapper
		// a mid-cycle emit failure would leave `src/generated/`
		// half-rewritten — see STYLE_GUIDE §19.
		//
		// `preserveOnPreseed: true` — substrate clones the current
		// target into staging before `build` runs so the per-file
		// no-touch idempotency (and gitignore user-block preservation)
		// sees the right baseline. Files this cycle rewrites are
		// overwritten in staging; files this cycle does NOT touch
		// survive into the next target verbatim with their original
		// mtimes (HMR watchers stay quiet for unchanged outputs).
		//
		// Cycle id is a random suffix. STYLE_GUIDE §17 mandates 8
		// hex chars for external-facing identifiers; this is a
		// deliberate 16-char carve-out because the value only
		// appears in transient staging-directory names
		// (`.staging.<id>` / `.bak.<id>`) that the substrate rm's
		// after publish. The extra entropy is defense-in-depth for
		// the race-window where two concurrent emit cycles under a
		// custom-CLI caller could mint overlapping staging dirs
		// against the same shared `outputDir`; a collision there
		// would corrupt a half-built tree, not just clash an
		// operator-visible name.
		const cycleId = randomUUID().replaceAll('-', '').slice(0, 16);
		const stagingPaths = paths.withRoot(`${paths.outputDir}.staging.${cycleId}`);

		return yield* stageAndSwap({
			targetPath: paths.outputDir,
			idSuffix: cycleId,
			preserveOnPreseed: true,
			build: Effect.gen(function* () {
				const inner = yield* runEmitCycleInner(input, stagingPaths).pipe(
					Effect.provideService(MoveSummaryRunnerService, moveRunner),
					Effect.provideService(MoveCodegenService, moveCodegen),
				);
				// Rewrite paths so callers see the final user-visible
				// `outputDir` location, not the staging directory that
				// only exists for the duration of the build.
				return rewriteResultPaths(inner, stagingPaths.outputDir, paths.outputDir);
			}),
		}).pipe(
			Effect.mapError((e): CodegenError => {
				if (e instanceof StageAndSwapError) {
					return new CodegenWriteFailed({
						outputPath: paths.outputDir,
						stage: 'rename',
						cause: e,
					});
				}
				return e;
			}),
			Effect.withSpan('codegen.runEmitCycle', {
				attributes: {
					'codegen.contributions': input.contributions.length,
					'codegen.cycleId': cycleId,
					'codegen.stagingDir': stagingPaths.outputDir,
				},
			}),
		);
	});

/**
 * Project a staging-rooted `RunEmitCycleResult` back into the user-
 * visible `outputDir` namespace. The build effect writes through
 * `stagingDir` paths; callers (and tests) expect to see the final
 * post-rename locations.
 */
const rewriteResultPaths = (
	result: RunEmitCycleResult,
	stagingDir: string,
	outputDir: string,
): RunEmitCycleResult => {
	const stripped = stagingDir.replace(/\/+$/, '');
	const target = outputDir.replace(/\/+$/, '');
	const rewrite = (p: string): string =>
		p.startsWith(stripped) ? `${target}${p.slice(stripped.length)}` : p;
	return {
		filesWritten: result.filesWritten.map(rewrite),
		filesUnchanged: result.filesUnchanged.map(rewrite),
		filesChmod: result.filesChmod.map(rewrite),
		bindings:
			result.bindings === null
				? null
				: {
						...result.bindings,
						filesWritten: result.bindings.filesWritten.map(rewrite),
					},
	};
};

/**
 * The body of one emit cycle. Pulled out of `runEmitCycle` so the
 * stage-and-swap wrapper can drive it against a redirected
 * `CodegenPathsService` (the staging tree). Validation runs BEFORE
 * this function so callers know the contribution set is well-formed.
 */
const runEmitCycleInner = (
	input: RunEmitCycleInput,
	paths: CodegenPaths,
): Effect.Effect<
	RunEmitCycleResult,
	CodegenError,
	FileSystem.FileSystem | MoveSummaryRunnerService | MoveCodegenService
> =>
	Effect.gen(function* () {
		const fileEmitters: Array<Codegenable> = [...input.contributions];

		const filesWritten: Array<string> = [];
		const filesUnchanged: Array<string> = [];
		const filesChmod: Array<string> = [];
		// Aggregate buckets keyed by plugin-supplied bucket name. The
		// orchestrator treats bucket names as opaque tags chosen by
		// the contributor; it never branches on plugin identity. See
		// `CodegenableDecl.aggregate` (contracts/codegenable.ts).
		const aggregates = new Map<string, Record<string, unknown>>();
		const packageContribs: Array<PackageBindings> = [];
		const sortedDecls = [...fileEmitters].sort(
			Order.mapInput(Order.String, (d: Codegenable) => d.outputPath),
		);
		const parentModeFor = yield* buildParentModeResolver(paths, fileEmitters);
		for (const decl of sortedDecls) {
			const emission = yield* runEmitter(decl);
			const exported = emission.exports;
			if (decl.aggregate !== undefined) {
				const projected = decl.aggregate.project(exported);
				if (projected !== null) {
					const bucket = aggregates.get(decl.aggregate.bucket) ?? {};
					Object.assign(bucket, projected);
					aggregates.set(decl.aggregate.bucket, bucket);
				}
			}
			// Move-bindings collection: any export whose shape matches
			// the orchestrator's `PackageBindings` consumer contract is
			// forwarded to `emitBindings`. Runs against the raw `exported`
			// map (not via `aggregate.project`) so direct `codegenable(...)`
			// contributions — which carry no `aggregate` — are picked up
			// too. The orchestrator validates the shape it consumes; it
			// does NOT name the plugin that produced it.
			for (const value of Object.values(exported)) {
				if (isPackageBindings(value)) {
					packageContribs.push(value);
				}
			}
			const rendered = renderFile({
				emitterName: decl.emitterName,
				outputPath: decl.outputPath,
				sensitive: decl.sensitive === true,
				exports: exported,
				imports: emission.imports,
			});
			if (!rendered.ok) {
				return yield* Effect.fail(rendered.error);
			}
			const abs = yield* paths.resolve(decl.outputPath);
			const outcome = yield* emitOne({
				path: abs,
				content: rendered.text,
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
			if (!rendered.ok) {
				return yield* Effect.fail(rendered.error);
			}
			const abs = yield* paths.resolve(aggregate.outputPath);
			const outcome = yield* emitOne({
				path: abs,
				content: rendered.text,
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
	});

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
 * Uniqueness check: emitter name (literal) must be unique unless
 * the decl opts into repetition via `allowEmitterNameRepetition`
 * (used by per-item plugins like Package, which emit one decl per
 * published package under a shared emitter name). Output paths
 * must be unique across ALL emitters.
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
			if (d.allowEmitterNameRepetition === true) continue;
			const ns = byName.get(d.emitterName) ?? [];
			ns.push(d.outputPath);
			byName.set(d.emitterName, ns);
		}
		for (const [path, emitters] of byPath) {
			if (emitters.length > 1) {
				return yield* Effect.fail(
					new CodegenPathConflict({
						kind: 'duplicate',
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

/**
 * Reject contribution sets that would have an aggregate bucket
 * collide with a per-decl `outputPath`. The orchestrator only knows
 * bucket names because plugins declared them via `aggregate.bucket`;
 * it does not enumerate or recognize plugin identities here.
 */
const validateAggregatePathAvailability = (
	decls: ReadonlyArray<Codegenable>,
): Effect.Effect<void, CodegenPathConflict> =>
	Effect.gen(function* () {
		const aggregatePaths = new Set<string>();
		for (const decl of decls) {
			if (decl.aggregate !== undefined) aggregatePaths.add(decl.aggregate.bucket);
		}
		for (const path of aggregatePaths) {
			const colliding = decls.filter((decl) => decl.outputPath === path);
			if (colliding.length > 0) {
				return yield* Effect.fail(
					new CodegenPathConflict({
						kind: 'duplicate',
						outputPath: path,
						emitters: [...colliding.map((decl) => decl.emitterName), `aggregate/${path}`],
					}),
				);
			}
		}
	});

interface AggregateFile {
	readonly emitterName: string;
	readonly outputPath: string;
	readonly exports: { readonly [key: string]: unknown };
}

/**
 * Synthesize one `AggregateFile` per non-empty bucket. The exports
 * map is keyed by the bucket's stem (e.g. `accounts.ts` → `accounts`)
 * so the rendered file exports `export const <stem> = { ... }`. The
 * orchestrator picks the export key from the bucket filename; the
 * stem itself is not a plugin identifier — it is the filename
 * without the `.ts` extension, derived mechanically.
 */
const buildAggregateFiles = (
	buckets: ReadonlyMap<string, Record<string, unknown>>,
): ReadonlyArray<AggregateFile> => {
	const files: Array<AggregateFile> = [];
	const sortedEntries = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
	for (const [bucket, contents] of sortedEntries) {
		if (Object.keys(contents).length === 0) continue;
		const stem = bucketStem(bucket);
		files.push({
			emitterName: `aggregate/${stem}`,
			outputPath: bucket,
			exports: { [stem]: contents },
		});
	}
	return files;
};

const bucketStem = (bucket: string): string => bucket.replace(/\.ts$/, '').replace(/^.*\//, '');

/**
 * Consumer-side shape guard: does this aggregated value look like a
 * Move-bindings contribution that `emitBindings` knows how to
 * consume? This is structural validation of the orchestrator's own
 * input contract, NOT a plugin-name match. Any plugin whose
 * `aggregate.project` returns objects with this shape will be
 * forwarded to the Move bindings emitter.
 */
const isPackageBindings = (v: unknown): v is PackageBindings =>
	typeof v === 'object' &&
	v !== null &&
	'name' in v &&
	'packageId' in v &&
	'mvrPlaceholder' in v &&
	'sourcePath' in v;

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
>()('@devstack/orchestrators/Codegen') {}

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
