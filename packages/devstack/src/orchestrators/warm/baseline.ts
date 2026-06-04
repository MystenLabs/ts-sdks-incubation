// Warm-baseline sidecar IO.
//
// The warm baseline is an ordinary snapshot captured under
// `WARM_BASELINE_SNAPSHOT_ID`; the sidecar is the small JSON record that
// remembers WHICH inputs that baseline was captured for. On a later
// boot, the boot path recomputes the fingerprint (see `fingerprint.ts`)
// and compares it to `sidecar.fingerprint`:
//
//   - equal      → restore `sidecar.snapshotId`
//   - differ     → re-capture and rewrite the sidecar
//   - absent     → first warm boot: capture and write the sidecar
//
// The sidecar lives directly under the stack root (a sibling of
// `stack.lock` / `roster.json`), so it is wiped with the stack and never
// leaks across stacks.
//
// Resilience: a present-but-unparseable sidecar is treated as ABSENT
// (warn + null), never a hard failure — a corrupt sidecar must not wedge
// boot, it should just fall back to a fresh capture.

import { join } from 'node:path';

import { Effect, FileSystem, PlatformError, Schema } from 'effect';

import { decodeJsonText } from '../../substrate/runtime/runtime-decode.ts';
import { versionedDocSchema } from '../../substrate/versioned-doc-schema.ts';

/** Sidecar filename, written under the stack root. */
export const WARM_BASELINE_SIDECAR_FILE = 'warm-baseline.json';

/** Absolute path of the warm-baseline sidecar for a stack root. */
export const warmBaselineSidecarPath = (stackRoot: string): string =>
	join(stackRoot, WARM_BASELINE_SIDECAR_FILE);

/** Sidecar schema version. Bump on incompatible shape changes; a
 *  failed decode (including a version mismatch) is treated as
 *  no-baseline, so an old sidecar simply triggers a re-capture. */
export const WARM_BASELINE_SIDECAR_VERSION = 1 as const;

/** Versioned sidecar record: the fingerprint the baseline was captured
 *  for, the snapshot id it was captured under, and when. */
export const WarmBaselineSidecarSchema = versionedDocSchema(WARM_BASELINE_SIDECAR_VERSION, {
	/** Hex sha256 from `computeWarmFingerprint`. */
	fingerprint: Schema.String,
	/** Snapshot id the baseline was captured under
	 *  (`WARM_BASELINE_SNAPSHOT_ID`). */
	snapshotId: Schema.String,
	/** Epoch millis of capture. */
	capturedAt: Schema.Number,
});
export type WarmBaselineSidecar = Schema.Schema.Type<typeof WarmBaselineSidecarSchema>;

/**
 * Read the warm-baseline sidecar for a stack root.
 *
 *   - absent                 → `null`
 *   - present + unparseable  → warn, then `null` (treat as no baseline;
 *                              a corrupt sidecar must never wedge boot)
 *   - present + valid        → the decoded record
 */
export const readWarmBaseline = (
	stackRoot: string,
): Effect.Effect<WarmBaselineSidecar | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = warmBaselineSidecarPath(stackRoot);
		const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
		if (!exists) return null;

		const text = yield* fs.readFileString(path).pipe(Effect.option);
		if (text._tag === 'None') {
			yield* Effect.logWarning(`warm baseline sidecar unreadable at ${path}; ignoring`);
			return null;
		}

		const decoded = yield* decodeJsonText(WarmBaselineSidecarSchema, text.value, {
			source: path,
			mkError: (issue) => issue,
		}).pipe(Effect.option);
		if (decoded._tag === 'None') {
			yield* Effect.logWarning(
				`warm baseline sidecar at ${path} is corrupt; treating as no baseline`,
			);
			return null;
		}
		return decoded.value;
	});

/**
 * Write the warm-baseline sidecar (canonical JSON) under the stack
 * root. Surfaces the filesystem error on failure — a write that cannot
 * land is a real problem the caller decides on. The record is a flat
 * primitive struct so it is `JSON.stringify`-able verbatim (no encode
 * step that could widen the error channel beyond `PlatformError`).
 */
export const writeWarmBaseline = (
	stackRoot: string,
	sidecar: WarmBaselineSidecar,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = warmBaselineSidecarPath(stackRoot);
		yield* fs.writeFileString(path, `${JSON.stringify(sidecar, null, 2)}\n`);
	});

/**
 * Remove the warm-baseline sidecar. Idempotent — a missing file is not
 * an error (`{ force: true }`), so `clear` is safe to call
 * unconditionally before a re-capture.
 */
export const clearWarmBaseline = (
	stackRoot: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = warmBaselineSidecarPath(stackRoot);
		yield* fs.remove(path, { force: true }).pipe(Effect.ignore);
	});
