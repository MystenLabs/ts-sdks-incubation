// Warm boot-cache hooks — the hit/miss/stale decision, extracted.
//
// `--warm` captures a baseline snapshot after the first good cold boot and,
// on a later boot whose fingerprinted inputs are UNCHANGED, RESTORES that
// baseline in place of a cold boot. The two effects here are the entire
// decision surface:
//
//   - `runWarmRestore` — runs BEFORE the supervisor's initial acquire.
//     Recompute the input fingerprint; on a HIT (sidecar fingerprint matches
//     AND the artifact is in the catalog) restore the baseline and flag
//     `warmRestored` so the post-boot capture knows to skip. On a MISS
//     (absent/stale sidecar) drop any stale artifact + sidecar and fall
//     through to a cold boot.
//   - `runWarmCapture` — runs AFTER the stack is up. Unless THIS boot was
//     itself a restore, capture the baseline + write the sidecar.
//
// Both are DEPENDENCY-INJECTED: the snapshot ops, the filesystem, the stack
// root, the fingerprint effect, and the two shared Refs all come in via
// `deps`. That is what lets production (`cli/wirings/up.ts`) and the e2e boot
// harness drive the IDENTICAL warm path, and lets the hit/miss/stale logic be
// unit-tested with stubbed snapshot ops and no Docker.
//
// DEFENSIVENESS (load-bearing — preserved verbatim from the original inline
// `up.ts` bodies):
//   - the whole restore phase is wrapped in `catchCause → logWarning →
//     continue`, so a warm failure NEVER wedges boot; it degrades to cold.
//   - a fingerprint failure (unreadable config) is caught inside and degrades
//     to cold WITHOUT recording a fingerprint.
//   - restore is run with NO `resume` — the supervisor's initial acquire is
//     the converge (mirrors `recoverInterruptedRestore`).
//   - the capture phase swallows its own failure (`log + continue`): a warm
//     capture failure must not fail an otherwise-successful `up`.

import { Cause, Effect, Exit, FileSystem, Ref } from 'effect';

import type { SnapshotCatalogEntry, SnapshotMetadata } from '../snapshot/index.ts';
import { clearWarmBaseline, readWarmBaseline, writeWarmBaseline } from './baseline.ts';
import { WARM_BASELINE_SNAPSHOT_ID, type WarmFingerprintError } from './fingerprint.ts';

/** The narrow slice of the snapshot orchestrator the warm hooks drive.
 *  Narrowed (not the full `SnapshotOrchestrator`) so production passes the
 *  real service's methods and a unit test passes a trivial stub. Each op
 *  still carries `FileSystem.FileSystem` in its environment exactly like the
 *  orchestrator — `provideFileSystem`-style threading happens in the hook. */
export interface WarmSnapshotOps {
	readonly list: Effect.Effect<
		ReadonlyArray<SnapshotCatalogEntry>,
		unknown,
		FileSystem.FileSystem
	>;
	readonly restore: (args: {
		readonly id: string;
	}) => Effect.Effect<SnapshotMetadata, unknown, FileSystem.FileSystem>;
	readonly delete: (id: string) => Effect.Effect<void, unknown, FileSystem.FileSystem>;
	readonly capture: (args: {
		readonly id: string;
		readonly label?: string;
	}) => Effect.Effect<SnapshotMetadata, unknown, FileSystem.FileSystem>;
}

/** Everything the two warm hooks need, injected. `computeFingerprint` is the
 *  fully-bound fingerprint effect (production binds `computeWarmFingerprint`
 *  over `{ stack, appRoot, configPath, devstackVersion }`; a test stubs it),
 *  so the hooks carry no knowledge of the stack/config shape. The two Refs are
 *  the shared cells the restore phase writes and the capture phase reads —
 *  they live in the CALLER'S scope so the same two closures observe them. */
export interface WarmHookDeps {
	readonly snapshot: WarmSnapshotOps;
	readonly fs: FileSystem.FileSystem;
	readonly stackRoot: string;
	readonly computeFingerprint: Effect.Effect<string, WarmFingerprintError, FileSystem.FileSystem>;
	readonly warmRestoredRef: Ref.Ref<boolean>;
	readonly warmFingerprintRef: Ref.Ref<string | null>;
}

/** Provide the injected `FileSystem` into a snapshot/baseline effect, dropping
 *  it from the requirements. Local twin of `cli/wirings/provide-file-system.ts`
 *  so this orchestrator module carries no dependency on the CLI subtree. */
const withFs = <A, E, R>(
	fs: FileSystem.FileSystem,
	effect: Effect.Effect<A, E, R | FileSystem.FileSystem>,
): Effect.Effect<A, E, Exclude<R, FileSystem.FileSystem>> =>
	effect.pipe(Effect.provideService(FileSystem.FileSystem, fs)) as Effect.Effect<
		A,
		E,
		Exclude<R, FileSystem.FileSystem>
	>;

/**
 * WARM-RESTORE phase. Runs BEFORE the supervisor's initial acquire.
 *
 * Compute the fingerprint (a failure → degrade to cold, no fingerprint
 * recorded). On a HIT (sidecar fingerprint matches AND the artifact is in the
 * catalog) restore the baseline (NO `resume` — the initial acquire converges)
 * and set `warmRestored`. On a MISS drop any stale artifact + sidecar and fall
 * through to cold. The whole body is `catchCause → logWarning → continue`, so a
 * warm failure can never wedge boot.
 *
 * Returns `void` and never fails — every path either succeeds or is logged and
 * swallowed, so callers chain it without a `catch`.
 */
export const runWarmRestore = (deps: WarmHookDeps): Effect.Effect<void, never> =>
	Effect.gen(function* () {
		const fingerprintExit = yield* Effect.exit(withFs(deps.fs, deps.computeFingerprint));
		if (Exit.isFailure(fingerprintExit)) {
			// Only `WarmFingerprintError` is expected (unreadable config); any
			// cause degrades to cold boot WITHOUT recording a fingerprint.
			yield* Effect.logWarning(
				`warm: fingerprint failed → cold boot: ${Cause.pretty(fingerprintExit.cause)}`,
			);
			return;
		}
		const fingerprint = fingerprintExit.value;
		yield* Ref.set(deps.warmFingerprintRef, fingerprint);

		const sidecar = yield* withFs(deps.fs, readWarmBaseline(deps.stackRoot));
		const catalog = yield* withFs(deps.fs, deps.snapshot.list);
		const artifactExists = catalog.some((entry) => entry.id === WARM_BASELINE_SNAPSHOT_ID);
		const hit = sidecar !== null && sidecar.fingerprint === fingerprint && artifactExists;
		if (hit) {
			// Restore without `resume` — the initial acquire re-converges the
			// swapped-in tree (mirrors `recoverInterruptedRestore`).
			yield* withFs(deps.fs, deps.snapshot.restore({ id: WARM_BASELINE_SNAPSHOT_ID }));
			yield* Ref.set(deps.warmRestoredRef, true);
			yield* Effect.logInfo('warm: restored baseline (fingerprint match)');
			return;
		}
		// MISS — drop a stale/absent baseline so the post-boot capture
		// re-captures cleanly, then cold-boot.
		if (artifactExists) {
			yield* withFs(deps.fs, deps.snapshot.delete(WARM_BASELINE_SNAPSHOT_ID));
		}
		yield* withFs(deps.fs, clearWarmBaseline(deps.stackRoot));
		yield* Effect.logInfo('warm: no valid baseline → cold boot');
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.logWarning(`warm: restore phase failed → cold boot: ${Cause.pretty(cause)}`),
		),
	);

/**
 * BASELINE-CAPTURE phase. Runs AFTER the stack is up.
 *
 * Skip if this boot was itself a warm restore (no point re-capturing an
 * identical tree). Otherwise capture the baseline under
 * `WARM_BASELINE_SNAPSHOT_ID` and write the sidecar, reusing the fingerprint
 * the restore phase recorded (recomputing only if the restore phase never ran
 * / failed to record one). Any failure is swallowed (`log + continue`): a warm
 * capture failure must not fail an otherwise-successful `up`.
 *
 * Returns `void` and never fails.
 */
export const runWarmCapture = (deps: WarmHookDeps): Effect.Effect<void, never> =>
	Effect.gen(function* () {
		if (yield* Ref.get(deps.warmRestoredRef)) return;
		yield* Effect.gen(function* () {
			yield* withFs(
				deps.fs,
				deps.snapshot.capture({ id: WARM_BASELINE_SNAPSHOT_ID, label: 'warm-baseline' }),
			);
			// Reuse the fingerprint computed in the restore phase; recompute it
			// only if that phase never ran / failed to record one (e.g. a
			// restore-phase fingerprint failure degraded to cold without storing
			// one).
			const recorded = yield* Ref.get(deps.warmFingerprintRef);
			const fingerprint = recorded ?? (yield* withFs(deps.fs, deps.computeFingerprint));
			yield* withFs(
				deps.fs,
				writeWarmBaseline(deps.stackRoot, {
					version: 1,
					fingerprint,
					snapshotId: WARM_BASELINE_SNAPSHOT_ID,
					capturedAt: Date.now(),
				}),
			);
			yield* Effect.logInfo('warm: captured baseline');
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning(`warm: capture failed (continuing): ${Cause.pretty(cause)}`),
			),
		);
	});
