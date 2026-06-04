// Atomic write primitive — ONE canonical implementation.
//
// Architecture § "What's collapsed" — three tempfile+rename impls
// (atomic-write, cache, global registry) collapse to one. This
// is that one.
//
// Contract:
//   1. Ensure parent directory exists.
//   2. Open `<final>.tmp.<pid>.<rand>` with `wx` (O_EXCL) — refuse
//      to clobber a half-written sibling from a crashed earlier
//      writer in the same pid.
//   3. Write bytes.
//   4. `fsync` the file.
//   5. Rename tempfile → final. Rename on POSIX is atomic w.r.t.
//      `open` of the final path.
//   6. On any failure mid-flight, unlink the tempfile. Best-effort:
//      a tempfile-cleanup failure does NOT mask the original error.
//
// Two surfaces:
//   - `atomicWriteFile` / `atomicWriteJson` — Effect/FileSystem-based,
//     used by every async write site (manifest, cache).
//   - `atomicWriteFileSync` / `atomicWriteJsonSync` — node:fs-sync,
//     used by the cross-process modules (roster, stack-lock) that hold
//     `stack.lock` and must keep their critical
//     section non-yielding. Substrate-fix-plan #11 tracks unifying
//     these onto Effect FS once we lift the cross-process modules off
//     `node:fs`; until then both surfaces share THIS file (and only
//     this file) so the tempfile dance has ONE owner.
//
// What we do NOT do here:
//   - fsync the parent directory. Linux's man fsync(2) suggests it
//     for full durability after rename(); the Effect platform layer
//     does not expose dir-fsync. Documented limitation — recoverable
//     on crash because every on-disk artifact rewrites on change and
//     cache misses re-produce.

import {
	closeSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

import { Effect, FileSystem, Schema } from 'effect';

import { selfPid } from './cross-process/self-pid.ts';
import { AtomicWriteFailed } from './errors.ts';

/** 8-hex tempfile suffix. `crypto.randomUUID()` is collision-safe under
 *  parallel callers within the same pid. */
const tempSuffix = (): string => randomUUID().replace(/-/g, '').slice(0, 8);

const failStage =
	(
		path: string,
		stage: AtomicWriteFailed['stage'],
	): ((cause: unknown) => Effect.Effect<never, AtomicWriteFailed>) =>
	(cause) =>
		Effect.fail(new AtomicWriteFailed({ path, stage, cause }));

/**
 * Atomically write `bytes` to `path`. The helper ensures
 * `dirname(path)` exists (recursive mkdir, idempotent).
 *
 * `mode` is the final file mode bits (default 0o600 — secret-safe
 * default; cache callers may bump to 0o644 if they want world-read).
 */
export const atomicWriteFile = (
	path: string,
	bytes: Uint8Array,
	options: { readonly mode?: number; readonly parentMode?: number } = {},
): Effect.Effect<void, AtomicWriteFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const mode = options.mode ?? 0o600;
		const parentMode = options.parentMode ?? 0o700;
		const tmp = `${path}.tmp.${selfPid()}.${tempSuffix()}`;
		// 1. Ensure parent. recursive: true is idempotent under
		//    concurrent callers — `mkdir -p` semantics.
		yield* fs
			.makeDirectory(dirname(path), { recursive: true, mode: parentMode })
			.pipe(Effect.catch(failStage(path, 'mkdir-parent')));
		// 2-5. Write + rename, with unconditional tempfile cleanup on
		//      ANY failure path (open-temp / write / fsync / rename).
		//      `force: true` makes the unlink a no-op if the file
		//      doesn't exist (open-temp failed early, or rename moved
		//      it to its final home).
		yield* Effect.gen(function* () {
			yield* Effect.scoped(
				Effect.gen(function* () {
					const file = yield* fs
						.open(tmp, { flag: 'wx', mode })
						.pipe(Effect.catch(failStage(path, 'open-temp')));
					yield* file.writeAll(bytes).pipe(Effect.catch(failStage(path, 'write')));
					// fsync — durability boundary. Without this the
					// rename can land but bytes can stay in the page
					// cache through a power loss.
					yield* file.sync.pipe(Effect.catch(failStage(path, 'fsync')));
				}),
			);
			yield* fs.rename(tmp, path).pipe(Effect.catch(failStage(path, 'rename')));
		}).pipe(Effect.onError(() => fs.remove(tmp, { force: true }).pipe(Effect.ignore)));
	});

/**
 * Atomically write a JSON value. Encodes via Schema (so the on-disk
 * shape is the schema's `Encoded` form, not the rich `Type`). Caller
 * supplies a schema whose `Type` matches `value`.
 */
export const atomicWriteJson = <A, I>(
	path: string,
	schema: Schema.Codec<A, I>,
	value: A,
	options?: { readonly mode?: number; readonly parentMode?: number },
): Effect.Effect<void, AtomicWriteFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const encoded = yield* Schema.encodeUnknownEffect(schema)(value).pipe(
			Effect.catch(failStage(path, 'encode')),
		);
		const json = JSON.stringify(encoded, null, 2);
		const bytes = new TextEncoder().encode(json);
		yield* atomicWriteFile(path, bytes, options);
	});

// -----------------------------------------------------------------------------
// Sync surface — for the cross-process modules that hold `stack.lock`
// and must keep their critical section non-yielding. Same contract as
// the Effect surface above.
// -----------------------------------------------------------------------------

/**
 * Internal: mkdir-parent → O_EXCL temp → write → fsync. Returns the
 * tempfile path on success; throws on any failure (and unlinks the
 * tempfile if it managed to land). The temp exists after return —
 * the caller is responsible for moving it to its final home (rename
 * for clobber semantics, link for exclusive-create semantics) AND
 * for unlinking the temp afterwards.
 *
 * Centralizes the durability boundary so both `atomicWriteFileSync`
 * (rename) and `atomicWriteFileExclusiveSync` (link+unlink) share
 * one tempfile/fsync implementation.
 */
const writeAndFsyncTempSync = (
	finalPath: string,
	bytes: Uint8Array | string,
	mode: number,
	parentMode: number,
): string => {
	const tmp = `${finalPath}.tmp.${selfPid()}.${tempSuffix()}`;
	mkdirSync(dirname(finalPath), { recursive: true, mode: parentMode });
	// O_EXCL via `flag: 'wx'`. writeFileSync handles open + write +
	// close in one call but does NOT fsync; do it manually so we
	// preserve the durability boundary the Effect surface has.
	writeFileSync(tmp, bytes, { flag: 'wx', mode });
	// Tempfile exists from here — fsync failure must unlink before
	// rethrowing so a crashed-mid-flight writer doesn't leak a
	// half-written sibling.
	try {
		let fd: number | null = null;
		try {
			fd = openSync(tmp, 'r');
			fsyncSync(fd);
		} finally {
			if (fd !== null) closeSync(fd);
		}
	} catch (cause) {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore — best-effort
		}
		throw cause;
	}
	return tmp;
};

/** Best-effort unlink. Swallows errors — used in cleanup paths where
 *  a failure to remove the temp should NOT mask the original error. */
const unlinkBestEffort = (path: string): void => {
	try {
		unlinkSync(path);
	} catch {
		// ignore
	}
};

/**
 * Synchronous atomic write. Same disk-side contract as
 * `atomicWriteFile` (mkdir-parent → O_EXCL temp → write → fsync →
 * rename). Returns `void` on success; throws on any failure with
 * `cause` set to the underlying `NodeJS.ErrnoException`.
 *
 * Rename CLOBBERS a pre-existing file at the final path. Callers
 * that need exclusive-create semantics ("fail if the final path
 * already exists, atomically") want `atomicWriteFileExclusiveSync`
 * instead — that surface uses `linkSync` which is POSIX-atomic and
 * fails with `EEXIST` rather than overwriting.
 *
 * Used inside `Effect.try` by the cross-process modules; the caller
 * maps the thrown error to a typed plugin/runtime error
 * (`RosterIoError` / `StackLockIoError` / etc.).
 */
export const atomicWriteFileSync = (
	path: string,
	bytes: Uint8Array | string,
	options: { readonly mode?: number; readonly parentMode?: number } = {},
): void => {
	const mode = options.mode ?? 0o600;
	const parentMode = options.parentMode ?? 0o700;
	const tmp = writeAndFsyncTempSync(path, bytes, mode, parentMode);
	let renamed = false;
	try {
		renameSync(tmp, path);
		renamed = true;
	} finally {
		if (!renamed) unlinkBestEffort(tmp);
	}
};

/**
 * Synchronous atomic EXCLUSIVE-CREATE write. Same disk-side contract
 * as `atomicWriteFileSync` (mkdir-parent → O_EXCL temp → write →
 * fsync) but uses `linkSync(tmp, final)` instead of `renameSync` for
 * the final installation step. `link` is POSIX-atomic and FAILS with
 * `EEXIST` if the target already exists — closing the rename-clobber
 * race that `existsSync` + `renameSync` cannot.
 *
 * On success: the tempfile is unlinked (the hard link satisfies the
 * final path).
 *
 * On `EEXIST`: the tempfile is unlinked and the underlying
 * `NodeJS.ErrnoException` (with `code === 'EEXIST'`) is rethrown so
 * the caller can read the winning final-path and decide what to do.
 *
 * On any other failure: the tempfile is unlinked and the error is
 * rethrown unchanged.
 *
 * POSIX `link(2)` is available on Linux + macOS + WSL. Devstack is
 * POSIX-only at runtime.
 */
export const atomicWriteFileExclusiveSync = (
	path: string,
	bytes: Uint8Array | string,
	options: { readonly mode?: number; readonly parentMode?: number } = {},
): void => {
	const mode = options.mode ?? 0o600;
	const parentMode = options.parentMode ?? 0o700;
	const tmp = writeAndFsyncTempSync(path, bytes, mode, parentMode);
	try {
		// Atomic exclusive-create. On EEXIST the tempfile remains and
		// the finally below unlinks it; the EEXIST error propagates.
		linkSync(tmp, path);
	} finally {
		// Always unlink the tempfile: on success the hard link IS the
		// final file; on failure (EEXIST or otherwise) the tempfile
		// should not leak.
		unlinkBestEffort(tmp);
	}
};

/**
 * Synchronous atomic JSON write. Stringifies `value` and routes
 * through `atomicWriteFileSync`. No Schema encoding here — the
 * cross-process modules round-trip plain JSON (their schemas are
 * Schema.Struct of primitives; `JSON.stringify` is sufficient and
 * keeps the sync path dependency-free of Effect's Schema effects).
 */
export const atomicWriteJsonSync = (
	path: string,
	value: unknown,
	options?: { readonly mode?: number; readonly parentMode?: number },
): void => {
	const json = JSON.stringify(value);
	atomicWriteFileSync(path, json, options);
};

// Local dirname — we don't yield Path service here because
// atomic-write may be called outside of a path-service-having
// context (tests, recovery scripts). Posix-only; devstack is
// posix-only in practice.
const dirname = (p: string): string => {
	const i = p.lastIndexOf('/');
	return i <= 0 ? '/' : p.slice(0, i);
};
