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
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
	ForNetworkBucket,
	isForNetworkBucket,
	isRawExpr,
	rawExpr,
	type CodegenableDecl,
	type CodegenEmitDone,
	type CodegenEmitContext,
} from '../../contracts/codegenable.ts';
import { CONFIG_RUNTIME_OUTPUT_PATH, CONFIG_RUNTIME_SOURCE } from './config-runtime.ts';
import { DEPLOYMENT_STRICT_OUTPUT_PATH, renderDeploymentStrict } from './deployment-strict.ts';
import { LOCAL_NETWORK_NAME } from '../../api/inference-network.ts';
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
import { UNRESOLVED_ID } from './deployment.ts';
import type {
	DevstackDeployment,
	NetworkDeployment,
	DeploymentPackage,
	DeploymentValues,
} from './deployment.ts';
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
	/** The LIVE network names — the app's `deployments/*.ts` filenames (sans
	 *  `.ts`, local excluded) — used to render the strict `deployment.ts`
	 *  type's `ProvidedNetwork` union + `NETWORK_NAMES` tuple. Omitted ⇒ the
	 *  outer {@link runEmitCycle} discovers them by globbing
	 *  `<projectRoot>/deployments/*.ts` (the canonical, non-staging output
	 *  dir's grandparent). Empty / no dir ⇒ `ProvidedNetwork = never`. */
	readonly providedNetworks?: ReadonlyArray<string>;
}

export interface RunEmitCycleResult {
	readonly filesWritten: ReadonlyArray<string>;
	readonly filesUnchanged: ReadonlyArray<string>;
	readonly filesChmod: ReadonlyArray<string>;
	readonly bindings: EmitBindingsResult | null;
}

/** Discover the app's LIVE network names by globbing `<projectRoot>/deployments/*.ts`
 *  (D7 — the network set is the `deployments/` directory, by FILENAME; the
 *  file CONTENTS are never read — ids load at app build via Vite). The
 *  project root is the grandparent of the canonical (non-staging) codegen
 *  `outputDir` (`<projectRoot>/src/generated`). Returns the filenames sans
 *  `.ts`, sorted; empty when there is no `deployments/` dir (a clean clone /
 *  template — `ProvidedNetwork = never`, `NETWORK_NAMES = [<local>]`). Never
 *  throws — a read failure degrades to empty (no live networks). */
const discoverProvidedNetworks = (canonicalOutputDir: string): ReadonlyArray<string> => {
	try {
		// `<projectRoot>/src/generated` → `<projectRoot>`. `deployments/` is a
		// sibling of `src/`.
		const projectRoot = dirname(dirname(canonicalOutputDir));
		const deploymentsDir = join(projectRoot, 'deployments');
		if (!existsSync(deploymentsDir)) return [];
		return readdirSync(deploymentsDir)
			.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
			.map((f) => f.slice(0, -'.ts'.length))
			.filter((n) => n.length > 0)
			.sort();
	} catch {
		return [];
	}
};

const buildParentModeResolver = (
	paths: CodegenPaths,
	entries: ReadonlyArray<{
		readonly outputPath: string;
		readonly sensitive: boolean;
	}>,
): Effect.Effect<(absolutePath: string) => number, CodegenPathConflict> =>
	Effect.gen(function* () {
		const byParent = new Map<string, Array<{ readonly sensitive?: boolean }>>();
		for (const entry of entries) {
			const parent = dirname(yield* paths.resolve(entry.outputPath));
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
	// invocations, future watcher hooks) can call `runEmitCycle`
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

		// Discover the app's LIVE network set ONCE from the canonical (non-
		// staging) `outputDir` — globbing `<projectRoot>/deployments/*.ts` by
		// FILENAME (D7). Done here (not inside the staging build, whose
		// `outputDir` is the throwaway `.staging.<id>` dir) so the project root
		// resolves against the real tree. The caller may override (e.g. a test
		// pinning a fixed set). Empty when no `deployments/` dir.
		const providedNetworks = input.providedNetworks ?? discoverProvidedNetworks(paths.outputDir);
		const innerInput: RunEmitCycleInput = { ...input, providedNetworks };

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
				const inner = yield* runEmitCycleInner(innerInput, stagingPaths).pipe(
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
		yield* Effect.logInfo(`codegen: emitting projection (trackTree=${input.trackTree === true}).`);
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
					// First-contributor-wins for sensitivity, but a LATER
					// contributor that disagrees is a hard error — the
					// `AggregateContribution` contract requires all
					// contributors to a bucket to agree, and a silent
					// mismatch could misroute a sensitive aggregate's
					// permissions (secret leak).
					const declSensitive = decl.aggregate.sensitive === true;
					const established = aggregateMeta.get(decl.aggregate.bucket);
					if (established === undefined) {
						aggregateMeta.set(decl.aggregate.bucket, {
							sensitive: declSensitive,
							establishedBy: decl.emitterName,
						});
					} else {
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

		// Inject the static-only DEPLOYMENT envelope accessors into the
		// committed `config.ts` aggregate and wrap each SERVICE bucket
		// (coins/deepbook/seal/walrus) in its per-network `forNetwork(network)`
		// accessor — BEFORE usage scanning, so the resulting `__deployment` /
		// `dep` references drive the import + preamble below. The MVR `types`
		// overrides are NOT folded here: they are OPT-IN and come from the
		// package's own config bindings (each declared `mvrOverrides.types.<tag>`
		// already projected into the `config.ts` aggregate), so no bindings-derived
		// post-transform — and no dependency on the bindings having run first.
		const aggregateFiles = buildAggregateFiles(aggregates, aggregateMeta)
			.map(withConfigEnvelopeAccessors)
			.map(withForNetworkAccessor);
		// True once any aggregate references a `config-runtime.ts` deployment
		// symbol (the committed `config.ts` + service buckets): then we ALSO emit
		// the fixed `config-runtime.ts` and import + preamble exactly what each
		// file references.
		let needsConfigRuntime = false;
		for (const aggregate of aggregateFiles) {
			const usage = deploymentUsageOf(aggregate.exports);
			if (!deploymentUsageEmpty(usage)) needsConfigRuntime = true;
			const imports = deploymentImportsFor(usage);
			// A SERVICE bucket carries its `dep` inside the `forNetwork(network)`
			// accessor (a per-call `loadDeployment().forNetwork(network)` local),
			// so it imports `loadDeployment` but emits NO module-level `dep` /
			// `__deployment` preamble. Non-service buckets (config.ts) keep the
			// module-level preamble.
			const preamble = SERVICE_BUCKETS.has(aggregate.outputPath)
				? []
				: deploymentPreambleFor(usage);
			// `config.ts` references the app-specific `NETWORK_NAMES` tuple (D2)
			// for `defaultNetwork`/`networkNames`; import it from the strict
			// `deployment.ts` we emit alongside `config-runtime.ts`. Scan for the
			// identifier so only files that use it carry the import (oxlint flags
			// unused). `import type` is wrong — `NETWORK_NAMES` is a runtime value
			// (used both as a value AND in the `typeof` cast).
			const usesNetworkNames = referencesNetworkNames(aggregate.exports);
			const importLines: Array<string> = [];
			if (imports.length > 0) {
				importLines.push(`import { ${imports.join(', ')} } from './config-runtime.js';`);
			}
			if (usesNetworkNames) {
				importLines.push(`import { NETWORK_NAMES } from './deployment.js';`);
			}
			const rendered = renderFile({
				emitterName: aggregate.emitterName,
				outputPath: aggregate.outputPath,
				sensitive: aggregate.sensitive,
				exports: aggregate.exports,
				// The committed `config.ts` + service buckets read off the injected
				// deployment at runtime — import exactly the symbols referenced (no
				// unused imports; oxlint is pinned and flags them) and emit the
				// `loadDeployment()` / `dep` preamble. `.js` specifier (ESM/TS-
				// resolved) mirrors the bindings' import style.
				...(importLines.length > 0 ? { imports: importLines } : {}),
				...(preamble.length > 0 ? { preamble } : {}),
			});
			if (!rendered.ok) {
				return yield* Effect.fail(rendered.error);
			}
			const abs = yield* paths.resolve(aggregate.outputPath);
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
		// at runtime. It reads the injected `__DEVSTACK_DEPLOYMENT__` global and
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

			// Emit the APP-SPECIFIC strict `deployment.ts` type alongside the
			// fixed `config-runtime.ts` (it imports `NetworkDeployment` from
			// it). RENDERED FROM DATA: `AppPackages` is exhaustive over the
			// declared package names, `AppNetworkDeployment.mvrOverrides`
			// requires the declared `@local/*` placeholders, and
			// `ProvidedNetwork` / `NETWORK_NAMES` enumerate the live networks
			// from the `deployments/*.ts` filenames (D7, passed in
			// `providedNetworks`). Types-only + zero runtime (bar the
			// `NETWORK_NAMES` tuple) so a clean clone (no `deployments/` dir →
			// empty `providedNetworks`) stays `tsc`-green.
			const strictInput = strictTypeInputFrom(aggregateFiles);
			const deploymentStrict = renderDeploymentStrict({
				localNetworkName: LOCAL_NETWORK_NAME,
				packageNames: strictInput.packageNames,
				mvrPlaceholders: strictInput.mvrPlaceholders,
				mvrTypeTags: strictInput.mvrTypeTags,
				providedNetworks: input.providedNetworks ?? [],
				serviceValues: serviceValuesFrom(input.contributions),
			});
			const strictAbs = yield* paths.resolve(DEPLOYMENT_STRICT_OUTPUT_PATH);
			const strictOutcome = yield* emitOne({
				path: strictAbs,
				content: deploymentStrict,
				mode: 0o644,
				parentMode: parentModeFor(strictAbs),
			});
			switch (strictOutcome.outcome) {
				case 'wrote':
					filesWritten.push(strictAbs);
					break;
				case 'unchanged':
					filesUnchanged.push(strictAbs);
					break;
				case 'chmod-only':
					filesChmod.push(strictAbs);
					break;
			}
		}

		// Run the Move-to-TS bindings step — render each local package's typed
		// client modules into `generated/bindings/`. Order-independent of the
		// aggregate emission above: the MVR `types` overrides are opt-in and come
		// from the package's config bindings, not from the rendered bindings, so
		// nothing downstream of this step depends on its result beyond the emitted
		// files + the returned summary.
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

		// `.gitignore` covers the runtime `generated/` tree only.
		// Aggregate-only decls never write a standalone file, so they are
		// excluded here — the managed `.gitignore` only lists real sensitive
		// files in `outputDir`.
		//
		// Synthesized aggregate files are a SEPARATE source of sensitive
		// runtime paths: a sensitive aggregate bucket writes a real
		// secret-bearing file in `outputDir` that the standalone-decl scan
		// above never sees (its contributors may all be `aggregateOnly`).
		// Without an explicit ignore line such a file would rely solely on
		// the blanket `*` rule — and a user `!<file>` override in the
		// preserved user block would then start tracking the secret. Include
		// them so each gets an explicit re-ignore line. The managed
		// `.gitignore` belongs to the committed/live `generated` tree at
		// `<outputDir>/.gitignore`. Write it ONLY when this emit actually
		// produces output: a metadata-only cycle (no standalone files, no
		// aggregate files — e.g. boot's values-only deployment assembly,
		// which writes no committed file) must NOT clobber the committed
		// tree's TRACKED policy with the blanket ignore-all, which would
		// break `tsc`/`vite build` on a fresh clone.
		const hasGeneratedOutput =
			fileEmitters.some((d) => d.aggregateOnly !== true) || aggregateFiles.length > 0;
		if (hasGeneratedOutput) {
			const sensitivePaths = [
				...fileEmitters
					.filter((d) => d.sensitive === true && d.aggregateOnly !== true)
					.map((d) => d.outputPath),
				...aggregateFiles.filter((a) => a.sensitive).map((a) => a.outputPath),
			];
			yield* writeGitignore({
				path: paths.gitignoreFile,
				sensitivePaths,
				parentMode: parentModeFor(paths.gitignoreFile),
				trackTree: input.trackTree === true,
			});
		}

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
		// Annotate the emit span with the contributor's plugin-supplied
		// `kind` tag (declared on the decl's `aggregate`). The orchestrator
		// stays name-blind — it never reads the tag's VALUE or branches on it
		// (per the `AggregateContribution` contract); wiring it here makes the
		// otherwise-dead field observable so a trace attributes each emit to
		// the plugin family that produced it. `annotateCurrentSpan` only lands
		// inside an enclosing `withSpan` — the `codegen.emit` span this body is
		// wrapped in below.
		const kind = decl.aggregate?.kind;
		if (kind !== undefined) {
			yield* Effect.annotateCurrentSpan('codegen.kind', kind);
		}
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
	}).pipe(Effect.withSpan('codegen.emit', { attributes: { 'codegen.emitter': decl.emitterName } }));

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
				const ps = byPath.get(d.outputPath) ?? [];
				ps.push(d.emitterName);
				byPath.set(d.outputPath, ps);
			}
			if (d.allowEmitterNameRepetition === true) continue;
			const ns = byName.get(d.emitterName) ?? [];
			ns.push(d.outputPath);
			byName.set(d.emitterName, ns);
		}
		for (const [outputPath, emitters] of byPath) {
			if (emitters.length > 1) {
				return yield* Effect.fail(
					new CodegenPathConflict({
						kind: 'duplicate',
						outputPath,
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
		// A standalone decl that writes a synthesized aggregate bucket's
		// path would clash with the aggregate; an aggregate-only decl
		// (which writes no standalone file) does not.
		const aggregateBuckets = new Set<string>();
		for (const decl of decls) {
			if (decl.aggregate !== undefined) {
				aggregateBuckets.add(decl.aggregate.bucket);
			}
		}
		for (const bucket of aggregateBuckets) {
			const colliding = decls.filter(
				(decl) => decl.aggregateOnly !== true && decl.outputPath === bucket,
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

/** Per-bucket sensitivity, captured from the first decl the
 *  orchestrator sees contributing to a bucket. The orchestrator stays
 *  name-blind; the plugin owns this on its `AggregateContribution`.
 *  `establishedBy` records the emitter name of that first contributor so
 *  a later disagreement can quote both sides in
 *  `CodegenAggregateConflict`. */
interface AggregateMeta {
	readonly sensitive: boolean;
	readonly establishedBy: string;
}

interface AggregateFile {
	readonly emitterName: string;
	readonly outputPath: string;
	readonly exports: { readonly [key: string]: unknown };
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
			// `value` may be a decl-owned cached projection object (or array).
			// Storing it by reference would let a sibling decl that later
			// recurses into the same nested key mutate this decl's cache in
			// place, leaking state across emit cycles. Deep-clone any plain
			// object / array so the shared bucket never aliases decl state.
			target[key] = isPlainObject(value) || Array.isArray(value) ? structuredClone(value) : value;
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
 * `sensitive` flag (from the first contributing decl) drives its mode.
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
			sensitive: false,
			establishedBy: `aggregate/${stem}`,
		};
		files.push({
			emitterName: `aggregate/${stem}`,
			outputPath: bucket,
			exports: { [stem]: contents },
			sensitive: bucketMeta.sensitive,
		});
	}
	return files;
};

const bucketStem = (bucket: string): string => bucket.replace(/\.ts$/, '').replace(/^.*\//, '');

/** The committed `config.ts` bucket. The orchestrator already encodes
 *  `config.ts` semantics by name elsewhere (the live `assembleDeployment`
 *  slices it by this exact bucket); the static envelope-accessor injection
 *  below is the matching static-render-only branch. */
const CONFIG_BUCKET = 'config.ts';

/**
 * Inject the DEPLOYMENT envelope-accessor fields into the committed
 * `config.ts` aggregate's `config` object literal as raw expressions:
 *   - `defaultNetwork: __deployment.defaultNetwork`
 *   - `networkNames:   __deployment.networkNames`
 *   - `forNetwork:     __deployment.forNetwork`
 *
 * There is deliberately NO `activeNetwork` field: the genuinely active network
 * is whatever dapp-kit currently has selected (it can `switchNetwork` at
 * runtime), so a statically-resolved "active" entry would lie the moment the
 * user switches. Apps resolve per-network data through
 * `config.forNetwork(<dapp-kit-selected network>)` — e.g.
 * `createClient(network) => config.forNetwork(network)` — so nothing drifts out
 * of sync with the selected network.
 *
 * STATIC-render-only: these are wired into the emitted committed tree so apps
 * can enumerate / look up networks off `config`, but they are NOT part of the
 * live deployment path (`assembleDeployment` / `deploymentFromBucket` slice the raw
 * `network`/`networks`/`packages`/`mvrOverrides` fields, never these). The
 * aggregate file's `exports` is `{ config: {...} }`; mutate the inner object.
 */
const withConfigEnvelopeAccessors = (file: AggregateFile): AggregateFile => {
	if (file.outputPath !== CONFIG_BUCKET) return file;
	const stem = bucketStem(file.outputPath); // 'config'
	const inner = file.exports[stem];
	if (!isPlainObject(inner)) return file;
	const augmented: Record<string, unknown> = {
		...inner,
		// Typed against the app-specific `NETWORK_NAMES` tuple (D2) so dapp-kit's
		// `switchNetwork(name)` is literal-checked: `defaultNetwork` narrows to
		// the tuple's element union, and `networkNames` IS the literal tuple
		// (the app's declared network set: local + committed `deployments/*.ts`).
		defaultNetwork: rawExpr('__deployment.defaultNetwork as (typeof NETWORK_NAMES)[number]'),
		networkNames: rawExpr('NETWORK_NAMES'),
		forNetwork: rawExpr('__deployment.forNetwork'),
	};
	return { ...file, exports: { ...file.exports, [stem]: augmented } };
};

/** The own-bucket SERVICE buckets (coin → `coins.ts`, deepbook →
 *  `deepbook.ts`, seal → `seal.ts`, walrus → `walrus.ts`). Each is wrapped in
 *  a per-network `forNetwork(network)` accessor so its ids resolve for the
 *  dapp-kit-selected network (not the default network baked at module load).
 *  `config.ts` / `accounts.ts` are NOT service buckets (config carries its own
 *  per-network `forNetwork` field; accounts are network-agnostic). */
const SERVICE_BUCKETS: ReadonlySet<string> = new Set([
	'coins.ts',
	'deepbook.ts',
	'seal.ts',
	'walrus.ts',
]);

/**
 * Wrap a SERVICE bucket's inner object in a `forNetwork(network)` accessor.
 *
 * The aggregate file's `exports` is `{ <stem>: <merged bucket object> }`. We
 * replace the merged object with a {@link ForNetworkBucket} marker the renderer
 * emits as `{ forNetwork(network) { const dep = …; return <object> as const; } }`.
 * `needsDep` is true when the merged object actually references `dep` (a
 * pure-literal bucket — known/live seal, builtin-only coin — does not, so the
 * accessor omits the `const dep` line and ignores its `network` param).
 *
 * Non-service buckets pass through unchanged.
 */
const withForNetworkAccessor = (file: AggregateFile): AggregateFile => {
	if (!SERVICE_BUCKETS.has(file.outputPath)) return file;
	const stem = bucketStem(file.outputPath);
	const inner = file.exports[stem];
	if (!isPlainObject(inner)) return file;
	const usage = { ...EMPTY_DEPLOYMENT_USAGE };
	scanDeploymentUsage(inner, usage);
	const marker = new ForNetworkBucket(inner, usage.usesDep);
	return { ...file, exports: { ...file.exports, [stem]: marker } };
};

/** Pull the app's declared package names + MVR placeholders out of the
 *  committed `config.ts` aggregate's inner `config` object — the SAME data
 *  the strict `deployment.ts` type narrows over. `config.packages.<name>`
 *  gives the package names; `config.mvrOverrides.<mvr>` gives the placeholder
 *  keys. Both come from the deep-merged bucket (no chain / no live data), so
 *  this stays a pure projection over already-collected exports. Returns empty
 *  arrays when there is no `config.ts` aggregate. */
const strictTypeInputFrom = (
	aggregateFiles: ReadonlyArray<AggregateFile>,
): {
	packageNames: ReadonlyArray<string>;
	mvrPlaceholders: ReadonlyArray<string>;
	mvrTypeTags: ReadonlyArray<string>;
} => {
	const empty = { packageNames: [], mvrPlaceholders: [], mvrTypeTags: [] };
	const configFile = aggregateFiles.find((f) => f.outputPath === CONFIG_BUCKET);
	if (configFile === undefined) return empty;
	const inner = configFile.exports[bucketStem(CONFIG_BUCKET)];
	if (!isPlainObject(inner)) return empty;
	const packagesNode = inner['packages'];
	// `mvrOverrides` is now the @mysten override shape `{ packages, types }`
	// (the package plugin's `mvrOverrides.packages.<mvr>` + the orchestrator-
	// folded `mvrOverrides.types.<tag>`). Read each sub-map's keys.
	const mvrNode = isPlainObject(inner['mvrOverrides']) ? inner['mvrOverrides'] : {};
	const mvrPackagesNode = mvrNode['packages'];
	const mvrTypesNode = mvrNode['types'];
	const packageNames = isPlainObject(packagesNode) ? Object.keys(packagesNode).sort() : [];
	const mvrPlaceholders = isPlainObject(mvrPackagesNode) ? Object.keys(mvrPackagesNode).sort() : [];
	const mvrTypeTags = isPlainObject(mvrTypesNode) ? Object.keys(mvrTypesNode).sort() : [];
	return { packageNames, mvrPlaceholders, mvrTypeTags };
};

/**
 * Derive the structured SERVICE-VALUE channel `values[namespace][key] = <tsType>`
 * for the strict `deployment.ts` — every generic (non-sugar) RESOLVED
 * config-binding the contributions declare. Computed from the SAME contribution
 * decls the cycle emits: a binding lands here exactly when it would land in the
 * live deployment's generic `values` channel (a `resolved` binding with NO
 * `sugar`), so the required `AppNetworkDeployment.values` shape matches what a
 * resolved deployment actually carries. The tsType is read off each contribution's
 * `aggregate.valueTypes` (added in config-bindings); a binding with no declared
 * tsType contributes `'unknown'`. Empty for a service-less app.
 */
const serviceValuesFrom = (
	contributions: ReadonlyArray<Codegenable>,
): Record<string, Record<string, string>> => {
	const out: Record<string, Record<string, string>> = {};
	for (const decl of contributions) {
		const valueTypes = decl.aggregate?.valueTypes;
		if (valueTypes === undefined) continue;
		for (const [ns, keys] of Object.entries(valueTypes)) {
			const nsOut = (out[ns] ??= {});
			for (const [key, tsType] of Object.entries(keys)) {
				nsOut[key] = tsType;
			}
		}
	}
	return out;
};

/** Which `config-runtime.ts` deployment symbols an aggregate's emitted raw
 *  expressions reference. Drives BOTH the `./config-runtime.js` import line
 *  (oxlint is pinned and flags unused imports — emit only what's used) AND the
 *  module-level preamble the emitted file needs:
 *    `const __deployment = loadDeployment();`
 *    `const dep = __deployment.forNetwork(__deployment.defaultNetwork);`
 *
 *  - `usesDep`: any expr references the `dep` identifier
 *    (`requireId(dep, …)`, `requireValue(dep, …)`, `dep.network`, …) — needs
 *    the `dep` preamble line (and therefore `__deployment` + `loadDeployment`).
 *  - `usesDeployment`: any expr references `__deployment` (the `networks`
 *    sugar's `Object.fromEntries(__deployment.networkNames.map(...))`) — needs
 *    the `__deployment` preamble line (and `loadDeployment`).
 *  - `requireId` / `requireValue` / `optionalValue`: the named helper appears
 *    in some expr — import it. */
interface DeploymentUsage {
	readonly usesDep: boolean;
	readonly usesDeployment: boolean;
	readonly requireId: boolean;
	readonly requireValue: boolean;
	readonly optionalValue: boolean;
}

const EMPTY_DEPLOYMENT_USAGE: DeploymentUsage = {
	usesDep: false,
	usesDeployment: false,
	requireId: false,
	requireValue: false,
	optionalValue: false,
};

const deploymentUsageEmpty = (u: DeploymentUsage): boolean =>
	!u.usesDep && !u.usesDeployment && !u.requireId && !u.requireValue && !u.optionalValue;

/** Recursively scan an exports value's raw expressions, OR-ing in the
 *  deployment symbols each references. */
const scanDeploymentUsage = (
	value: unknown,
	acc: { -readonly [K in keyof DeploymentUsage]: boolean },
): void => {
	if (isRawExpr(value)) {
		const e = value.expr;
		// `dep` as a standalone identifier (not a substring of e.g. `__deployment`).
		if (/\bdep\b/.test(e)) acc.usesDep = true;
		if (e.includes('__deployment')) acc.usesDeployment = true;
		if (e.includes('requireId(')) acc.requireId = true;
		if (e.includes('requireValue')) acc.requireValue = true;
		if (e.includes('optionalValue(')) acc.optionalValue = true;
		return;
	}
	// A per-network service bucket carries its `dep` references inside the
	// `forNetwork` accessor's `inner` object — recurse so the import scan sees
	// the `requireValue` / `loadDeployment` symbols (the accessor's body calls
	// `loadDeployment().forNetwork(network)`, so a bucket with resolved fields
	// always needs `loadDeployment`).
	if (isForNetworkBucket(value)) {
		scanDeploymentUsage(value.inner, acc);
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) scanDeploymentUsage(v, acc);
		return;
	}
	if (isPlainObject(value)) {
		for (const v of Object.values(value)) scanDeploymentUsage(v, acc);
	}
};

/** True when any raw expression in the exports references the `NETWORK_NAMES`
 *  identifier (the strict `deployment.ts` tuple `config.ts` types against).
 *  Drives the `./deployment.js` import injection. */
const referencesNetworkNames = (value: unknown): boolean => {
	if (isRawExpr(value)) return /\bNETWORK_NAMES\b/.test(value.expr);
	if (Array.isArray(value)) return value.some(referencesNetworkNames);
	if (isPlainObject(value)) return Object.values(value).some(referencesNetworkNames);
	return false;
};

/** The deployment symbols an aggregate's exports use (all-false when the
 *  aggregate carries no deployment expressions — pure literals). */
const deploymentUsageOf = (exports: { readonly [key: string]: unknown }): DeploymentUsage => {
	const acc = { ...EMPTY_DEPLOYMENT_USAGE };
	for (const v of Object.values(exports)) scanDeploymentUsage(v, acc);
	return acc;
};

/** The `./config-runtime.js` named imports the usage requires, in a stable
 *  order. Only symbols actually used are imported (oxlint flags unused). */
const deploymentImportsFor = (u: DeploymentUsage): ReadonlyArray<string> => {
	const names: Array<string> = [];
	if (u.usesDep || u.usesDeployment) names.push('loadDeployment');
	if (u.requireId) names.push('requireId');
	if (u.requireValue) names.push('requireValue');
	if (u.optionalValue) names.push('optionalValue');
	return names;
};

/** The module-level preamble lines the usage requires (`loadDeployment()`
 *  once, then the active-network `dep`). */
const deploymentPreambleFor = (u: DeploymentUsage): ReadonlyArray<string> => {
	const lines: Array<string> = [];
	if (u.usesDep || u.usesDeployment) lines.push('const __deployment = loadDeployment();');
	if (u.usesDep) lines.push('const dep = __deployment.forNetwork(__deployment.defaultNetwork);');
	return lines;
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
 * plugins emit decls uniformly even though boot writes the deployment (not
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

	/** Assemble the deployment ENVELOPE from the currently-registered
	 *  (live-resolved) contributions. Boot calls this in its post-acquire hook
	 *  to WRITE the deployment file (the same `networks` / `packages` /
	 *  `mvrOverrides` data that fed `config.ts`, but as loadable JSON the Vite
	 *  plugin injects). A single-network dev stack yields a one-entry envelope
	 *  `{ defaultNetwork: <net>, networks: { <net>: <NetworkDeployment, local:true> } }`
	 *  — the live LOCAL network the Vite plugin overlays in dev. `network` is the
	 *  active network name (`ctx.identity.network`). Pure projection over the
	 *  registered decls — no I/O, no chain. */
	readonly assembleDeployment: (
		network: string,
	) => Effect.Effect<DevstackDeployment, CodegenEmitFailed>;

	/** Emit the COMMITTED `src/generated` tree (config.ts + Move bindings +
	 *  coins/deepbook/… ) from the caller-supplied STATIC contributions — the
	 *  SAME id-free decls the stack-free `codegen` verb derives via each
	 *  member's `staticCodegen()` hook, NOT the live registered ones. This is
	 *  load-bearing: the live decls bake the resolved on-chain ids into
	 *  `config.ts`, but the committed tree MUST stay id-free (ids resolve at
	 *  app build time via `__DEVSTACK_DEPLOYMENT__`) — baking a live id breaks a fresh
	 *  clone and any OTHER stack reading the tree. Runs the canonical
	 *  {@link runEmitCycle} (per-process lock + content-addressed
	 *  stage-and-swap), so config.ts re-emits to its unchanged id-free form
	 *  (no-touch) while an edited package's Move bindings refresh. Dev-`up`
	 *  only: the post-acquire hook calls this when a Move-source edit
	 *  (re)acquires the package. `apply` / `runStack` never call it (the
	 *  committed tree is the build's input there, not its output). */
	readonly emitBindings: (
		contributions: ReadonlyArray<CodegenableDecl>,
	) => Effect.Effect<
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
 * Slice the deep-merged `config.ts` aggregate bucket into a single
 * loadable `NetworkDeployment` (the LIVE LOCAL network unit). The bucket is
 * the live codegen accumulation (sui `networks`, per-package `packages`/
 * `objects`/`mvrOverrides`); this picks the id-bearing
 * fields the Vite plugin injects and FLATTENS the chosen network's
 * connection coordinates (rpc/chainId/faucet/graphql) inline. Reads are
 * defensive — any missing slice collapses to an empty record so a partial
 * stack still writes a valid (if sparse) network deployment. Single-network
 * only here: `assembleDeployment` keys the envelope under this unit's network.
 * Per-network package ids for live networks come from the committed
 * `deployments/<net>.ts` files merged into the envelope at app build/dev time.
 */
const deploymentFromBucket = (
	bucket: Record<string, unknown>,
	network: string,
	values: DeploymentValues,
): NetworkDeployment => {
	const asRecord = (v: unknown): Record<string, unknown> => (isPlainObject(v) ? v : {});
	const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

	// The bucket's `networks` map is keyed by what the sui binding emitted
	// (`"localnet"` for every local mode); each entry carries the connection
	// coordinates. We flatten ONE entry's coordinates into the per-network
	// unit. Collect them first so we can pick the active network.
	interface Conn {
		readonly rpc: string;
		readonly chainId?: string;
		readonly faucet?: string | null;
		readonly graphql?: string | null;
	}
	const conns: Record<string, Conn> = {};
	for (const [name, raw] of Object.entries(asRecord(bucket['networks']))) {
		const entry = asRecord(raw);
		const rpc = asString(entry['rpc']);
		if (rpc === undefined) continue;
		conns[name] = {
			rpc,
			...(asString(entry['chainId']) !== undefined ? { chainId: asString(entry['chainId']) } : {}),
			...(entry['faucet'] !== undefined ? { faucet: asString(entry['faucet']) ?? null } : {}),
			...(entry['graphql'] !== undefined ? { graphql: asString(entry['graphql']) ?? null } : {}),
		};
	}

	const packages: Record<string, DeploymentPackage> = {};
	for (const [name, raw] of Object.entries(asRecord(bucket['packages']))) {
		const entry = asRecord(raw);
		// The local network's id is `packageId` (the convenience field the
		// package projection sets). An empty/missing packageId maps to the
		// UNRESOLVED_ID sentinel — an empty string would slip past
		// `isUnresolvedId` and ship as a real, resolved id.
		const rawId = asString(entry['packageId']);
		const id = rawId === undefined || rawId === '' ? UNRESOLVED_ID : rawId;
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

	// `mvrOverrides` is the @mysten override shape `{ packages, types }`. The
	// live bucket carries `mvrOverrides.packages.<mvr>` (each package plugin's
	// resolved active-network id). `types` is OPT-IN and lives ONLY in the
	// COMMITTED `config.ts` (each developer-declared `mvrTypes` entry projects a
	// `requireId(dep, "<mvr>")`-resolved tag there); the live deployment slice
	// ships `types: {}`, since the generated `config.ts` rebuilds the full
	// `{ packages, types }` override at runtime over `mvrOverrides.packages`.
	const mvrPackages: Record<string, string> = {};
	const mvrNode = asRecord(bucket['mvrOverrides']);
	for (const [mvr, v] of Object.entries(asRecord(mvrNode['packages']))) {
		const s = asString(v);
		if (s !== undefined) mvrPackages[mvr] = s;
	}
	const mvrOverrides = { packages: mvrPackages, types: {} as Record<string, string> };

	// The unit's `network` field MUST be a key present in the bucket's
	// connection map — the Vite dev-wallet injection reads
	// `networks[network].rpc` off the envelope. The `network` PARAM is the
	// identity's network name (e.g. `"testnet-fork"`), but the sui binding
	// keys the connection map by what it emitted (`"localnet"` for every
	// mode). A single-network local stack contributes exactly ONE connection,
	// so PREFER the network the binding stamped into the bucket
	// (`bucket['network']`, which matches the connection key); fall back to
	// that sole connection key, then the param. This keeps `network` in
	// agreement with the connection map so resolution never dereferences
	// `undefined`.
	const connKeys = Object.keys(conns);
	const bucketNetwork = asString(bucket['network']);
	const activeNetwork =
		bucketNetwork !== undefined && connKeys.includes(bucketNetwork)
			? bucketNetwork
			: connKeys.length === 1
				? connKeys[0]!
				: (bucketNetwork ?? network);

	// Flatten the active network's connection coordinates inline. A bucket
	// with no connection at all (network-only / partial stack) still yields a
	// well-formed unit with an empty `rpc` — the resolvers throw their
	// actionable error rather than a raw TypeError.
	const conn = conns[activeNetwork] ?? { rpc: '' };

	return {
		network: activeNetwork,
		rpc: conn.rpc,
		...(conn.chainId !== undefined ? { chainId: conn.chainId } : {}),
		...(conn.faucet !== undefined ? { faucet: conn.faucet } : {}),
		...(conn.graphql !== undefined ? { graphql: conn.graphql } : {}),
		// Live LOCAL network — the deploy filter (`command === 'build'`)
		// drops it; dev overlays it as the default network.
		local: true,
		packages,
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

		const assembleDeployment: CodegenOrchestrator['assembleDeployment'] = (network) =>
			Effect.gen(function* () {
				const registered = (yield* Ref.get(contributionsRef)).map((e) => e.decl);
				// Deep-merge every contribution's `config.ts` aggregate
				// projection into ONE bucket — the SAME accumulation the live
				// codegen cycle performed (sui's `networks.<net>` + each
				// package's `packages.<name>` / `objects` / `mvrOverrides`,
				// the account plugin's `accounts`). The merged bucket carries
				// real (live-`acquire`-resolved) ids; we then slice it into the
				// loadable `Deployment` shape.
				const bucket: Record<string, unknown> = {};
				// `accounts.ts` is a SEPARATE aggregate bucket (the values-only
				// account decl); fold its projection into the ENVELOPE-level
				// `accounts` map. Accounts are a network-AGNOSTIC dev concept, so
				// they ride the envelope, NOT any per-network unit (the
				// per-network shape a prod author writes has no accounts at all).
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
					// `config.ts` plugins'. Slicing the TYPED deployment fields
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
				// Normalize the account-bucket projection (`{ <name>:
				// { address } }`, tolerating a bare string) into the
				// envelope-level name → address map.
				const envelopeAccounts: Record<string, string> = {};
				for (const [name, v] of Object.entries(accounts)) {
					const address =
						typeof v === 'string'
							? v
							: isPlainObject(v) && typeof v['address'] === 'string'
								? v['address']
								: undefined;
					if (address !== undefined) envelopeAccounts[name] = address;
				}
				// The single-network slice — the live LOCAL network unit.
				const unit = deploymentFromBucket(bucket, network, values as DeploymentValues);
				// Wrap it in the multi-network envelope keyed by the unit's own
				// (bucket-derived) network, so the on-disk shape is uniform with a
				// multi-network deployment. A single-network dev stack ⇒ one entry.
				// `accounts` ride the ENVELOPE (network-agnostic dev identities).
				const unitNetwork = unit.network ?? network;
				return {
					defaultNetwork: unitNetwork,
					networks: { [unitNetwork]: unit },
					accounts: envelopeAccounts,
				} satisfies DevstackDeployment;
			});

		const emitBindings: CodegenOrchestrator['emitBindings'] = (contributions) =>
			Effect.gen(function* () {
				// Emit from the caller's STATIC (id-free) contributions, NOT the
				// live registered ones — the latter bake real on-chain ids into
				// `config.ts`, breaking the committed tree's id-free invariant.
				// `runEmitCycle` owns the lock + content-addressed stage-and-swap,
				// so config.ts re-emits to its unchanged id-free form (no-touch)
				// while an edited package's Move bindings refresh (HMR stays quiet).
				if (contributions.length === 0) {
					return { filesWritten: [], filesUnchanged: [], filesChmod: [], bindings: null };
				}
				return yield* runEmitCycle({ contributions, trackTree: true });
			});

		return CodegenOrchestratorService.of({
			registerContribution,
			assembleDeployment,
			emitBindings,
		});
	}),
);
