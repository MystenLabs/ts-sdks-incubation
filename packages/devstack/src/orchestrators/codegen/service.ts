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
//   - Decode the manifest envelope (plugins pass resolved blobs at
//     factory-build time; the orchestrator never re-reads the envelope).
//   - Watch files. Re-emit is driven by the supervisor cycle (and
//     on-demand by the CLI); the app's own toolchain (Vite/HMR)
//     watches the emitted output tree.
//   - Walk the user's Move-source mtimes (see `bindings.ts`).

import { Context, Effect, FileSystem, Layer, Order, Ref, Scope } from 'effect';
import { dirname } from 'node:path';

import {
	isRawExpr,
	type CodegenableDecl,
	type CodegenEmitDone,
	type CodegenEmitContext,
	type OutputLocation,
} from '../../contracts/codegenable.ts';
import { CONFIG_RUNTIME_OUTPUT_PATH, CONFIG_RUNTIME_SOURCE } from './config-runtime.ts';
import { acquireStackLock } from '../../substrate/runtime/cross-process/stack-lock.ts';
import { mintRandomSuffix } from '../../substrate/runtime/random-suffix.ts';
import { stageAndSwap, StageAndSwapError } from '../../substrate/runtime/stage-and-swap/index.ts';

import {
	emitBindings,
	type EmitBindingsResult,
	isPackageBindings,
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
import type {
	IdConfig,
	IdConfigNetwork,
	IdConfigPackage,
	IdConfigValues,
} from './id-config.ts';
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
	/** When `true`, this is the COMMITTED projection tree (`src/generated`,
	 *  written by the stack-free `codegen` verb): the `.gitignore` TRACKS
	 *  the stubs (bindings, config, config-runtime) so `tsc`/`vite build`
	 *  work on a fresh clone, ignoring only `sensitivePaths`. When
	 *  `false`/omitted, the ephemeral tree is blanket-ignored. */
	readonly trackTree?: boolean;
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
	location === 'generated-extras' ? paths.resolveExtras(outputPath) : paths.resolve(outputPath);

const declLocation = (decl: Pick<Codegenable, 'outputLocation'>): OutputLocation =>
	decl.outputLocation ?? 'generated';

/** A decl belongs to the `emitExtras` flush IFF it writes ONLY into the
 *  dev-only `generated-extras` tree. INVARIANT: `emitExtras` must NEVER
 *  touch the committed `src/generated` tree (it runs without stage-and-swap),
 *  so a decl that would emit any file into `generated` is excluded.
 *
 *  - `aggregateOnly` decls write only their aggregate file: include iff the
 *    aggregate's location is `generated-extras` (e.g. each account folding
 *    into the gitignored `accounts.ts`).
 *  - standalone decls write a per-decl file (and possibly an aggregate):
 *    include iff that standalone file lands in `generated-extras` (e.g. the
 *    wallet's `dev-wallet.ts`). A standalone-in-`generated` decl is excluded
 *    even if its aggregate targets `generated-extras`. */
const isExtrasDecl = (decl: Codegenable): boolean =>
	decl.aggregateOnly === true
		? (decl.aggregate?.outputLocation ?? 'generated') === 'generated-extras'
		: declLocation(decl) === 'generated-extras';

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
	// critical sections (roster mutations, the snapshot bounce). A
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
		yield* Effect.logInfo(
			`codegen: emitting projection (trackTree=${input.trackTree === true}).`,
		);
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
		const parentModeFor = yield* buildParentModeResolver(
			paths,
			fileEmitters
				.filter((d) => d.aggregateOnly !== true)
				.map((d) => ({
					outputPath: d.outputPath,
					location: declLocation(d),
					sensitive: d.sensitive === true,
				})),
		);
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
		// True once any aggregate references a `config-runtime.ts` resolver
		// (the committed `config.ts`): then we ALSO emit the fixed
		// `config-runtime.ts` resolver and import the referenced resolvers into
		// that file.
		let needsConfigRuntime = false;
		for (const aggregate of aggregateFiles) {
			const resolvers = resolversUsedBy(aggregate.exports);
			if (resolvers.length > 0) needsConfigRuntime = true;
			const rendered = renderFile({
				emitterName: aggregate.emitterName,
				outputPath: aggregate.outputPath,
				sensitive: aggregate.sensitive,
				exports: aggregate.exports,
				// The committed `config.ts` resolves ids/network at runtime —
				// import exactly the resolvers it references (no unused imports;
				// oxlint is pinned and flags them). `.js` specifier (ESM/TS-
				// resolved) mirrors the bindings' import style.
				...(resolvers.length > 0
					? { imports: [`import { ${resolvers.join(', ')} } from './config-runtime.js';`] }
					: {}),
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

		// Emit the FIXED `config-runtime.ts` resolver (a constant string, NOT
		// routed through the literal renderer) when `config.ts` resolves ids
		// at runtime. It reads the injected `__DEVSTACK_IDS__` global and
		// THROWS `DevstackConfigMissingError` on an unresolved id.
		if (needsConfigRuntime) {
			const abs = yield* paths.resolve(CONFIG_RUNTIME_OUTPUT_PATH);
			const outcome = yield* emitOne({
				path: abs,
				content: CONFIG_RUNTIME_SOURCE,
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
						d.sensitive === true && d.aggregateOnly !== true && declLocation(d) === 'generated',
				)
				.map((d) => d.outputPath),
			...aggregateFiles
				.filter((a) => a.sensitive && a.location === 'generated')
				.map((a) => a.outputPath),
		];
		// A committed projection (written by the stack-free `codegen` verb
		// into `src/generated`) is TRACKED: the stubs are committed so
		// `tsc`/`vite build` work on a fresh clone. Any ephemeral tree keeps
		// the blanket ignore.
		yield* writeGitignore({
			path: paths.gitignoreFile,
			sensitivePaths,
			parentMode: parentModeFor(paths.gitignoreFile),
			trackTree: input.trackTree === true,
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
				const pathKey = `${declLocation(d)} ${d.outputPath}`;
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
 * (`networks.localnet` from sui, `packages.<name>` / `objects.<name>`
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

/** The config-runtime resolver names a committed `config.ts` aggregate may
 *  reference as raw expressions. Each is imported from `./config-runtime.js`
 *  only when the aggregate actually calls it (oxlint flags unused imports). */
const CONFIG_RUNTIME_RESOLVERS = [
	'resolveId',
	'resolveNetwork',
	'resolveNetworks',
	'resolveValue',
] as const;
type ConfigRuntimeResolver = (typeof CONFIG_RUNTIME_RESOLVERS)[number];

/** Recursively collect which `config-runtime.ts` resolvers an exports map
 *  references via raw expressions — i.e. the committed `config.ts` needs each
 *  imported + the fixed `config-runtime.ts` emitted alongside it. */
const collectResolversInValue = (value: unknown, found: Set<ConfigRuntimeResolver>): void => {
	if (isRawExpr(value)) {
		for (const name of CONFIG_RUNTIME_RESOLVERS) {
			if (value.expr.includes(`${name}(`)) found.add(name);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) collectResolversInValue(v, found);
		return;
	}
	if (isPlainObject(value)) {
		for (const v of Object.values(value)) collectResolversInValue(v, found);
	}
};

/** The ordered set of config-runtime resolvers an aggregate's exports use
 *  (empty when none — the aggregate needs no resolver import). */
const resolversUsedBy = (
	exports: { readonly [key: string]: unknown },
): ReadonlyArray<ConfigRuntimeResolver> => {
	const found = new Set<ConfigRuntimeResolver>();
	for (const v of Object.values(exports)) collectResolversInValue(v, found);
	return CONFIG_RUNTIME_RESOLVERS.filter((name) => found.has(name));
};

// -----------------------------------------------------------------------------
// Service surface — registration API + emit-cycle trigger
// -----------------------------------------------------------------------------

/**
 * The codegen orchestrator's Context-bound service. The substrate's
 * supervisor calls `registerContribution(pluginKey, decl)` once per
 * `CodegenableDecl` on each plugin's `capabilities` tuple, scope-bound
 * to that plugin's acquire scope.
 *
 * Boot no longer runs codegen — the emit pipeline is the stack-free
 * `devstack codegen` verb (which calls `runEmitCycle` directly off the
 * config-derived `staticCodegen` decls). This service keeps the dispatcher
 * seam closed: every `codegenable` contribution still has a handler, so
 * plugins emit decls uniformly even though boot writes the id-config (not
 * the committed tree).
 */
export interface CodegenOrchestrator {
	/** Register a `CodegenableDecl` from a plugin. Scope-bound — when
	 *  the caller's scope (the plugin's acquire scope) closes, the
	 *  registration is reaped. */
	readonly registerContribution: (
		pluginKey: string,
		decl: Codegenable,
	) => Effect.Effect<void, never, Scope.Scope>;

	/** Assemble the id-config from the currently-registered (live-resolved)
	 *  contributions. Boot calls this in its post-acquire hook to WRITE the
	 *  id-config file (the same `networks` / `packages` / `mvrOverrides`
	 *  data that fed `config.ts`, but as loadable JSON the Vite plugin
	 *  injects). `network` is the active network name (`ctx.identity.network`).
	 *  Pure projection over the registered decls — no I/O, no chain. */
	readonly assembleIdConfig: (network: string) => Effect.Effect<IdConfig, CodegenEmitFailed>;

	/** Flush ONLY the `generated-extras` contributions (the dev wallet's
	 *  `dev-wallet.ts` + the account plugin's `accounts.ts`) to the
	 *  gitignored `.devstack/stacks/<stack>/generated-extras` tree. These
	 *  are acquire-resolved (can't be statically derived by the `codegen`
	 *  verb), so boot writes them — but ONLY when the resolved network's
	 *  `devWallet` flag is on. The committed `src/generated` tree is NEVER
	 *  touched (no `generated`-located decl is emitted). Reuses the emit
	 *  renderer + aggregate logic; skips the stage-and-swap of the runtime
	 *  tree (extras live outside it). No-op (empty result) when nothing is
	 *  routed to `generated-extras`. */
	readonly emitExtras: () => Effect.Effect<
		RunEmitCycleResult,
		CodegenError,
		FileSystem.FileSystem | CodegenPathsService | MoveSummaryRunnerService | MoveCodegenService
	>;
}

export class CodegenOrchestratorService extends Context.Service<
	CodegenOrchestratorService,
	CodegenOrchestrator
>()('@devstack/orchestrators/Codegen') {}

/**
 * Slice the deep-merged `config.ts` aggregate bucket into the loadable
 * `IdConfig` interchange shape. The bucket is the live codegen
 * accumulation (sui `networks`, per-package `packages`/`objects`/
 * `mvrOverrides`, account `accounts`); this picks the id-bearing fields
 * the Vite plugin injects. Reads are defensive — any missing slice
 * collapses to an empty record so a partial stack still writes a valid
 * (if sparse) id-config.
 */
const idConfigFromBucket = (
	bucket: Record<string, unknown>,
	network: string,
	values: IdConfigValues,
): IdConfig => {
	const asRecord = (v: unknown): Record<string, unknown> =>
		isPlainObject(v) ? v : {};
	const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

	const networks: Record<string, IdConfigNetwork> = {};
	for (const [name, raw] of Object.entries(asRecord(bucket['networks']))) {
		const entry = asRecord(raw);
		const rpc = asString(entry['rpc']);
		if (rpc === undefined) continue;
		networks[name] = {
			rpc,
			...(asString(entry['chainId']) !== undefined ? { chainId: asString(entry['chainId']) } : {}),
			...(entry['faucet'] !== undefined ? { faucet: asString(entry['faucet']) ?? null } : {}),
			...(entry['graphql'] !== undefined ? { graphql: asString(entry['graphql']) ?? null } : {}),
		};
	}

	const packages: Record<string, IdConfigPackage> = {};
	for (const [name, raw] of Object.entries(asRecord(bucket['packages']))) {
		const entry = asRecord(raw);
		// The active-network id is `packageId` (convenience field the package
		// projection sets = `byNetwork[activeNetwork]`).
		const id = asString(entry['packageId']) ?? '';
		const objectsRaw = asRecord(entry['objects']);
		const objects: Record<string, string> = {};
		for (const [k, v] of Object.entries(objectsRaw)) {
			const s = asString(v);
			if (s !== undefined) objects[k] = s;
		}
		packages[name] = {
			id,
			...(Object.keys(objects).length > 0 ? { objects } : {}),
		};
	}

	const accounts: Record<string, string> = {};
	for (const [name, v] of Object.entries(asRecord(bucket['accounts']))) {
		// Account bindings are an object keyed by name; the injectable id is
		// the `address`. Tolerate a bare string too (a pinned known-config).
		const address = asString(v) ?? asString(asRecord(v)['address']);
		if (address !== undefined) accounts[name] = address;
	}

	const mvrOverrides: Record<string, string> = {};
	for (const [mvr, v] of Object.entries(asRecord(bucket['mvrOverrides']))) {
		const s = asString(v);
		if (s !== undefined) mvrOverrides[mvr] = s;
	}

	return {
		network,
		networks,
		packages,
		accounts,
		mvrOverrides,
		...(Object.keys(values).length > 0 ? { values } : {}),
	};
};

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
			}) as Effect.Effect<void, never, Scope.Scope>;

		const assembleIdConfig: CodegenOrchestrator['assembleIdConfig'] = (network) =>
			Effect.gen(function* () {
				const registered = (yield* Ref.get(contributionsRef)).map((e) => e.decl);
				// Deep-merge every contribution's `config.ts` aggregate
				// projection into ONE bucket — the SAME accumulation the live
				// codegen cycle performed (sui's `networks.<net>` + each
				// package's `packages.<name>` / `objects` / `mvrOverrides`,
				// the account plugin's `accounts`). The merged bucket carries
				// real (live-`acquire`-resolved) ids; we then slice it into the
				// loadable `IdConfig` shape.
				const bucket: Record<string, unknown> = {};
				// `accounts.ts` is a SEPARATE aggregate bucket (the account
				// plugin routes it to `generated-extras`); fold its projection
				// under an `accounts` key so the id-config carries account
				// addresses alongside the `config.ts`-derived ids.
				const accounts: Record<string, unknown> = {};
				// The generic resolver channel — `values[namespace][key]` —
				// accumulated from any LIVE config-binding aggregate that
				// declared `idConfigValues` (the plugin live JSON the typed
				// fields can't carry). Deep-merged so sibling namespaces /
				// keys from distinct plugins coexist.
				const values: Record<string, unknown> = {};
				for (const decl of registered) {
					if (decl.aggregate === undefined) continue;
					// The generic `values` channel is BUCKET-BLIND: any LIVE
					// config-binding aggregate (config.ts, coins.ts, deepbook.ts,
					// walrus.ts, seal.ts, ...) may declare `idConfigValues`. Fold
					// every contributor's so the committed-tree `resolveValue` calls
					// those buckets emit resolve at app build/dev time -- not just the
					// `config.ts` plugins'. Slicing the TYPED id-config fields
					// (`networks` / `packages` / `mvrOverrides`) stays scoped to the
					// `config.ts` bucket below.
					if (decl.aggregate.idConfigValues !== undefined) {
						deepMerge(values, decl.aggregate.idConfigValues);
					}
					if (decl.aggregate.bucket === 'config.ts') {
						const emission = yield* runEmitter(decl);
						const projected = decl.aggregate.project(emission.exports);
						if (projected !== null) deepMerge(bucket, projected);
					} else if (decl.aggregate.bucket === 'accounts.ts') {
						const emission = yield* runEmitter(decl);
						const projected = decl.aggregate.project(emission.exports);
						if (projected !== null) deepMerge(accounts, projected);
					}
				}
				bucket['accounts'] = accounts;
				return idConfigFromBucket(bucket, network, values as IdConfigValues);
			});

		const emitExtras: CodegenOrchestrator['emitExtras'] = () =>
			Effect.gen(function* () {
				const registered = (yield* Ref.get(contributionsRef)).map((e) => e.decl);
				const extras = registered.filter(isExtrasDecl);
				if (extras.length === 0) {
					// Nothing routed to the dev tree (no wallet/accounts mounted).
					return { filesWritten: [], filesUnchanged: [], filesChmod: [], bindings: null };
				}
				// Validate the extras-only set up front (mirrors `runEmitCycle`'s
				// pre-flight), then emit DIRECTLY against the real paths — no
				// stage-and-swap, since the extras tree lives outside the runtime
				// `outputDir`. Every `generated-extras` decl routes through
				// `paths.resolveExtras`; no `generated`-located decl is present,
				// so the committed `src/generated` tree is untouched.
				yield* validateUniqueness(extras);
				yield* validateAggregatePathAvailability(extras);
				const paths = yield* CodegenPathsService;
				return yield* runEmitCycleInner({ contributions: extras, trackTree: false }, paths);
			});

		return CodegenOrchestratorService.of({
			registerContribution,
			assembleIdConfig,
			emitExtras,
		});
	}),
);
