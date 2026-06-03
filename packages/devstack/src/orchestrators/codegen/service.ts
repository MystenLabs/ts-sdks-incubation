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
//   - Watch files. Re-emit is driven by the supervisor cycle (and
//     on-demand by the CLI); the app's own toolchain (Vite/HMR)
//     watches the emitted output tree.
//   - Walk the user's Move-source mtimes (see `bindings.ts`).

import { Context, Effect, FileSystem, Layer, Order, Ref, Scope } from 'effect';
import { dirname } from 'node:path';

import type {
	CodegenableDecl,
	CodegenEmitDone,
	CodegenEmitContext,
	OutputLocation,
} from '../../contracts/codegenable.ts';
import { acquireStackLock } from '../../substrate/runtime/cross-process/stack-lock.ts';
import { mintRandomSuffix } from '../../substrate/runtime/random-suffix.ts';
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
	CodegenAggregateConflict,
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

/** Resolve a decl/aggregate's absolute output path against the tree
 *  selected by its `outputLocation`. `'generated-extras'` routes
 *  through `paths.resolveExtras` (the gitignored dev tree); everything
 *  else through `paths.resolve` (the staging-and-swapped runtime tree). */
const resolveAt = (
	paths: CodegenPaths,
	location: OutputLocation,
	outputPath: string,
): Effect.Effect<string, CodegenPathConflict> =>
	location === 'generated-extras'
		? paths.resolveExtras(outputPath)
		: paths.resolve(outputPath);

const declLocation = (decl: Pick<Codegenable, 'outputLocation'>): OutputLocation =>
	decl.outputLocation ?? 'generated';

const buildParentModeResolver = (
	paths: CodegenPaths,
	entries: ReadonlyArray<{
		readonly outputPath: string;
		readonly location: OutputLocation;
		readonly sensitive: boolean;
	}>,
): Effect.Effect<(absolutePath: string) => number, CodegenPathConflict> =>
	Effect.gen(function* () {
		const byParent = new Map<string, Array<{ readonly sensitive?: boolean }>>();
		for (const entry of entries) {
			const parent = dirname(yield* resolveAt(paths, entry.location, entry.outputPath));
			const current = byParent.get(parent);
			if (current === undefined) {
				byParent.set(parent, [{ sensitive: entry.sensitive }]);
			} else {
				current.push({ sensitive: entry.sensitive });
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
		const cycleId = mintRandomSuffix(16);
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
		// Per-bucket location + sensitivity, read from the first decl
		// the orchestrator sees contributing to the bucket. Drives where
		// the synthesized aggregate file lands and its file mode. Every
		// later contributor to the same bucket MUST agree (enforced
		// below) — a silent disagreement could misroute a sensitive
		// aggregate into the committed `generated` tree.
		const aggregateMeta = new Map<string, AggregateMeta>();
		const packageContribs: Array<PackageBindings> = [];
		const sortedDecls = [...fileEmitters].sort(
			Order.mapInput(Order.String, (d: Codegenable) => d.outputPath),
		);
		// Parent-mode resolver must see every path that will be written —
		// standalone decls AND synthesized aggregates — across BOTH trees.
		// Aggregate-only decls do not write a standalone file, so they are
		// excluded from the standalone-path set here.
		const parentModeFor = yield* buildParentModeResolver(paths, [
			...fileEmitters
				.filter((d) => d.aggregateOnly !== true)
				.map((d) => ({
					outputPath: d.outputPath,
					location: declLocation(d),
					sensitive: d.sensitive === true,
				})),
		]);
		for (const decl of sortedDecls) {
			const emission = yield* runEmitter(decl);
			const exported = emission.exports;
			if (decl.aggregate !== undefined) {
				const projected = decl.aggregate.project(exported);
				if (projected !== null) {
					const bucket = aggregates.get(decl.aggregate.bucket) ?? {};
					deepMerge(bucket, projected);
					aggregates.set(decl.aggregate.bucket, bucket);
					// First-contributor-wins for routing/sensitivity, but a
					// LATER contributor that disagrees is a hard error — the
					// `AggregateContribution` contract requires all
					// contributors to a bucket to agree, and a silent
					// mismatch could misroute a sensitive aggregate into the
					// committed `generated` tree (secret leak).
					const declLoc = decl.aggregate.outputLocation ?? 'generated';
					const declSensitive = decl.aggregate.sensitive === true;
					const established = aggregateMeta.get(decl.aggregate.bucket);
					if (established === undefined) {
						aggregateMeta.set(decl.aggregate.bucket, {
							location: declLoc,
							sensitive: declSensitive,
							establishedBy: decl.emitterName,
						});
					} else {
						if (established.location !== declLoc) {
							return yield* Effect.fail(
								new CodegenAggregateConflict({
									bucket: decl.aggregate.bucket,
									field: 'outputLocation',
									established: established.location,
									conflicting: declLoc,
									emitters: [established.establishedBy, decl.emitterName],
								}),
							);
						}
						if (established.sensitive !== declSensitive) {
							return yield* Effect.fail(
								new CodegenAggregateConflict({
									bucket: decl.aggregate.bucket,
									field: 'sensitive',
									established: String(established.sensitive),
									conflicting: String(declSensitive),
									emitters: [established.establishedBy, decl.emitterName],
								}),
							);
						}
					}
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
			// Aggregate-only decls contribute solely to their bucket; the
			// standalone per-decl file is skipped (the combined aggregate
			// is the only app-facing surface).
			if (decl.aggregateOnly === true) continue;
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
			const abs = yield* resolveAt(paths, declLocation(decl), decl.outputPath);
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

		const aggregateFiles = buildAggregateFiles(aggregates, aggregateMeta);
		for (const aggregate of aggregateFiles) {
			const rendered = renderFile({
				emitterName: aggregate.emitterName,
				outputPath: aggregate.outputPath,
				sensitive: aggregate.sensitive,
				exports: aggregate.exports,
			});
			if (!rendered.ok) {
				return yield* Effect.fail(rendered.error);
			}
			const abs = yield* resolveAt(paths, aggregate.location, aggregate.outputPath);
			const outcome = yield* emitOne({
				path: abs,
				content: rendered.text,
				mode: aggregate.sensitive ? 0o600 : 0o644,
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

		// `.gitignore` covers the runtime `generated/` tree only. Decls
		// routed to `generated-extras` live outside `outputDir` (that
		// whole tree is gitignored at the `.devstack/` level), and
		// aggregate-only decls never write a standalone file — both are
		// excluded here so the managed `.gitignore` only lists real
		// sensitive files in `outputDir`.
		//
		// Synthesized aggregate files are a SEPARATE source of sensitive
		// runtime paths: a sensitive bucket routed to `generated` writes a
		// real secret-bearing file in `outputDir` that the standalone-decl
		// scan above never sees (its contributors may all be
		// `aggregateOnly`). Without an explicit ignore line such a file
		// would rely solely on the blanket `*` rule — and a user `!<file>`
		// override in the preserved user block would then start tracking
		// the secret. Include them so each gets an explicit re-ignore line.
		const sensitivePaths = [
			...fileEmitters
				.filter(
					(d) =>
						d.sensitive === true &&
						d.aggregateOnly !== true &&
						declLocation(d) === 'generated',
				)
				.map((d) => d.outputPath),
			...aggregateFiles
				.filter((a) => a.sensitive && a.location === 'generated')
				.map((a) => a.outputPath),
		];
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
			// Aggregate-only decls write no standalone file, so their
			// `outputPath` is a dead value — exclude them from the
			// path-uniqueness check (many `package` decls legitimately
			// share `config.ts`'s bucket but carry distinct dead
			// `package/<name>.ts` outputPaths that never hit disk).
			if (d.aggregateOnly !== true) {
				// Key by (location, path): the same relative path in the
				// `generated` vs `generated-extras` trees is two distinct
				// files, so `accounts.ts` may exist in both without a
				// false collision.
				const pathKey = `${declLocation(d)} ${d.outputPath}`;
				const ps = byPath.get(pathKey) ?? [];
				ps.push(d.emitterName);
				byPath.set(pathKey, ps);
			}
			if (d.allowEmitterNameRepetition === true) continue;
			const ns = byName.get(d.emitterName) ?? [];
			ns.push(d.outputPath);
			byName.set(d.emitterName, ns);
		}
		for (const [pathKey, emitters] of byPath) {
			if (emitters.length > 1) {
				return yield* Effect.fail(
					new CodegenPathConflict({
						kind: 'duplicate',
						// Strip the `<location> ` prefix from the dedup key so
						// the error names the relative path the plugin declared.
						outputPath: pathKey.slice(pathKey.indexOf(' ') + 1),
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
		// Aggregate buckets keyed by (location, bucket). A standalone
		// decl in the SAME tree that writes the bucket path would clash
		// with the synthesized aggregate; a decl in the OTHER tree (or
		// an aggregate-only decl, which writes no standalone file) does
		// not.
		const aggregatePaths = new Map<string, string>();
		for (const decl of decls) {
			if (decl.aggregate !== undefined) {
				const location = decl.aggregate.outputLocation ?? 'generated';
				aggregatePaths.set(`${location} ${decl.aggregate.bucket}`, decl.aggregate.bucket);
			}
		}
		for (const [key, bucket] of aggregatePaths) {
			const location = key.slice(0, key.indexOf(' '));
			const colliding = decls.filter(
				(decl) =>
					decl.aggregateOnly !== true &&
					declLocation(decl) === location &&
					decl.outputPath === bucket,
			);
			if (colliding.length > 0) {
				return yield* Effect.fail(
					new CodegenPathConflict({
						kind: 'duplicate',
						outputPath: bucket,
						emitters: [...colliding.map((decl) => decl.emitterName), `aggregate/${bucket}`],
					}),
				);
			}
		}
	});

/** Per-bucket location + sensitivity, captured from the first decl
 *  the orchestrator sees contributing to a bucket. The orchestrator
 *  stays name-blind; the plugin owns these on its
 *  `AggregateContribution`. `establishedBy` records the emitter name
 *  of that first contributor so a later disagreement can quote both
 *  sides in `CodegenAggregateConflict`. */
interface AggregateMeta {
	readonly location: OutputLocation;
	readonly sensitive: boolean;
	readonly establishedBy: string;
}

interface AggregateFile {
	readonly emitterName: string;
	readonly outputPath: string;
	readonly exports: { readonly [key: string]: unknown };
	readonly location: OutputLocation;
	readonly sensitive: boolean;
}

/**
 * Recursively merge `source` into `target`. Distinct buckets are
 * shallow records keyed by name, but a single bucket (e.g. `config.ts`)
 * accumulates contributions from MANY plugins into nested sub-records
 * (`networks.local` from sui, `packages.<name>` / `objects.<name>`
 * from each package). A shallow `Object.assign` would have the last
 * package's `{packages:{...}}` clobber the prior ones. Deep-merge so
 * sibling keys at every level coexist.
 *
 * Arrays and non-plain values overwrite (no element-wise merge — a
 * plugin that re-emits a bucket key owns its full value). Only plain
 * objects recurse.
 */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const deepMerge = (
	target: Record<string, unknown>,
	source: Readonly<Record<string, unknown>>,
): void => {
	for (const [key, value] of Object.entries(source)) {
		const existing = target[key];
		if (isPlainObject(existing) && isPlainObject(value)) {
			deepMerge(existing, value);
		} else {
			target[key] = value;
		}
	}
};

/**
 * Synthesize one `AggregateFile` per non-empty bucket. The exports
 * map is keyed by the bucket's stem (e.g. `accounts.ts` → `accounts`)
 * so the rendered file exports `export const <stem> = { ... }`. The
 * orchestrator picks the export key from the bucket filename; the
 * stem itself is not a plugin identifier — it is the filename
 * without the `.ts` extension, derived mechanically. The bucket's
 * `location`/`sensitive` (from the first contributing decl) drive
 * which tree the file lands in and its mode.
 */
const buildAggregateFiles = (
	buckets: ReadonlyMap<string, Record<string, unknown>>,
	meta: ReadonlyMap<string, AggregateMeta>,
): ReadonlyArray<AggregateFile> => {
	const files: Array<AggregateFile> = [];
	const sortedEntries = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
	for (const [bucket, contents] of sortedEntries) {
		if (Object.keys(contents).length === 0) continue;
		const stem = bucketStem(bucket);
		const bucketMeta = meta.get(bucket) ?? {
			location: 'generated' as const,
			sensitive: false,
			establishedBy: `aggregate/${stem}`,
		};
		files.push({
			emitterName: `aggregate/${stem}`,
			outputPath: bucket,
			exports: { [stem]: contents },
			location: bucketMeta.location,
			sensitive: bucketMeta.sensitive,
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
