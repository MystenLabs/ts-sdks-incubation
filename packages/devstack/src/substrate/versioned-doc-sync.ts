// Versioned cross-process document — read / write envelope helpers.
//
// The cross-process modules (`runtime/cross-process/{roster,
// stack-lock}.ts`) share one `Effect.try(readFileSync) → decodeJsonText →
// mkIoError|mkCorruptError` read envelope and one
// `Effect.try(atomicWriteJsonSync) → mkIoError` write envelope, each
// parameterised by a typed-error pair. This file centralizes both
// envelopes around the versioned-doc schemas constructed via
// `versionedDocSchema` (the sibling file). The caller supplies the error
// constructors so its typed error channel is preserved end-to-end;
// crash-atomicity, fsync ordering, and version-stamp handling all live
// in the underlying primitives.
//
// Lives at substrate L0+ — depends on `effect`, `node:fs`, the
// runtime-decode helpers, and the canonical atomic-write primitive.
// Kept as a sibling of `versioned-doc-schema.ts` rather than absorbed
// into it so the schema constructor remains pure-Schema (callable from
// any L0 declaration site such as `substrate/cross-process.ts`); only
// callers that actually round-trip a versioned doc to disk pay the
// fs/runtime-decode import cost.

import { existsSync, readFileSync } from 'node:fs';

import { Effect, Schema } from 'effect';

import { atomicWriteJsonSync } from './runtime/atomic-write.ts';
import { decodeJsonText, decodeJsonTextSync } from './runtime/runtime-decode.ts';

/** Constructor pair the caller supplies so its typed error channel is
 *  preserved through the envelope. `mkIo` wraps any node:fs / disk
 *  failure (read OR write); `mkCorrupt` wraps any JSON-parse / Schema-
 *  decode failure (read only). Both helpers thread the on-disk `path`
 *  and — for `mkCorrupt` — the raw bytes that failed to decode so
 *  diagnostics can echo what was actually on disk. */
export interface VersionedDocErrors<IoErr, CorruptErr> {
	readonly mkIo: (input: { readonly path: string; readonly cause: unknown }) => IoErr;
	readonly mkCorrupt: (input: {
		readonly path: string;
		readonly raw: string;
		readonly cause: unknown;
	}) => CorruptErr;
}

/** Constructor for the IO-only case (write path — no decode failure
 *  mode). Split into its own interface so `writeVersionedDocumentSync`
 *  callers don't have to supply a `mkCorrupt` they would never invoke. */
export interface VersionedDocIoError<IoErr> {
	readonly mkIo: (input: { readonly path: string; readonly cause: unknown }) => IoErr;
}

/**
 * Read + decode a versioned cross-process document from disk.
 *
 *  - Missing file (`!existsSync`) → returns the caller-supplied
 *    `whenAbsent` default. This is the "no peer has ever written yet"
 *    path; the caller decides whether that's an empty document or a
 *    failure.
 *  - Read failure (any `node:fs` error other than ENOENT) → `mkIo`.
 *  - JSON-parse OR Schema-decode failure → `mkCorrupt` with the raw
 *    bytes echoed so callers can log the offending content.
 *
 *  The decode runs through `decodeJsonText`, so the on-disk JSON is
 *  parsed and Schema-validated in one envelope. No atomicity, fsync, or
 *  lock-ordering concerns at the read site — this is pure read-and-
 *  validate.
 */
export const readVersionedDocumentSync = <
	S extends Schema.Decoder<unknown>,
	IoErr,
	CorruptErr,
>(
	path: string,
	schema: S,
	errors: VersionedDocErrors<IoErr, CorruptErr>,
	whenAbsent: S['Type'],
): Effect.Effect<S['Type'], IoErr | CorruptErr> =>
	Effect.gen(function* () {
		if (!existsSync(path)) return whenAbsent;
		const raw = yield* Effect.try({
			try: () => readFileSync(path, 'utf8'),
			catch: (cause) => errors.mkIo({ path, cause }),
		});
		return yield* decodeJsonText(schema, raw, {
			source: path,
			mkError: (issue) => errors.mkCorrupt({ path, raw, cause: issue.cause ?? issue }),
		});
	});

/**
 * Sync parse-or-null variant of `readVersionedDocumentSync`. Decodes a
 * raw JSON body against `schema`; returns `null` on parse or decode
 * failure. Use this when a malformed body should be treated the same as
 * a missing body (e.g. a half-written roster entry by a crashed creator,
 * stack-lock body interrupted mid-write) — the call site swaps a
 * try/catch around `decodeJsonTextSync` for one helper call.
 *
 * `source` is purely a diagnostic label for the synthesized error
 * inside `decodeJsonTextSync`'s throw; it is consumed by the catch and
 * discarded along with the error. The caller does not need to thread a
 * typed error constructor — the contract here is "null means
 * unreadable/malformed; the caller decides what to do next".
 */
export const parseVersionedDocumentBodyOrNull = <S extends Schema.Decoder<unknown>>(
	raw: string,
	schema: S,
	source: string,
): S['Type'] | null => {
	try {
		return decodeJsonTextSync(schema, raw, {
			source,
			mkError: (issue) => issue,
		});
	} catch {
		return null;
	}
};

/**
 * Write a versioned cross-process document atomically.
 *
 * Routes through the canonical `atomicWriteJsonSync` primitive — the
 * crash-atomic mkdir-parent → O_EXCL temp → write → fsync → rename
 * dance with one owner of the tempfile cleanup. The version stamp lives in
 * the caller-supplied `value` (every versioned-doc schema carries a
 * literal `version` field via `versionedDocSchema`); this helper does
 * NOT inject a version — it just ensures the typed write envelope
 * (Effect.try → mkIo) is consistent across cross-process sites.
 *
 * No Schema-encode step here: matching `atomicWriteJsonSync`'s contract,
 * cross-process docs are `Schema.Struct` of primitives that round-trip
 * cleanly through plain `JSON.stringify`. The `value` is typed as a
 * generic `D` so the caller's document interface (`RosterDocument`,
 * ...) is what gets serialized.
 *
 * This is the SYNC surface — used by callers that hold `stack.lock`
 * and must keep their critical section non-yielding.
 */
export const writeVersionedDocumentSync = <D, IoErr>(
	path: string,
	value: D,
	errors: VersionedDocIoError<IoErr>,
): Effect.Effect<void, IoErr> =>
	Effect.try({
		try: () => atomicWriteJsonSync(path, value),
		catch: (cause) => errors.mkIo({ path, cause }),
	});
