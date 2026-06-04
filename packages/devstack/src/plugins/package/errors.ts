// Package plugin — typed errors.
//
// Distilled doc §"Edge cases and known failure modes": the publish
// error is a SINGLE tagged error with a CLOSED step set. Per
// architecture §Effect, errors are plain interfaces with a `_tag`
// discriminator; `Effect.catchTag` / `catchTags` match on the literal.

/** Closed step set for `PublishError`.
 *
 *   - `hash`        — source-tree walk / digest failed (FS read perms,
 *                     symlink loop, disk error).
 *   - `scrub`       — vendored Move.lock scrub failed.
 *   - `build`       — `sui move build` exit / parse failure / container
 *                     unreachable. Cause-chain carries verbatim
 *                     stdout/stderr.
 *   - `publish-tx`  — sign-and-execute failed (gas, bytecode
 *                     verification, RPC).
 *   - `parse`       — no `published` change in receipt OR the
 *                     post-publish ready-probe timed out.
 *   - `verify`      — KnownPackage verify probe authoritatively says
 *                     "object not present" (transient is masked by
 *                     lenient probe — does NOT raise this).
 */
export type PublishPhase = 'hash' | 'scrub' | 'build' | 'publish-tx' | 'parse' | 'verify';

/** Single tagged publish error. */
export interface PublishError {
	readonly _tag: 'PublishError';
	readonly phase: PublishPhase;
	/** Source path of the package being published. Populated at every
	 *  throw site that has it in scope — `KnownPackage` paths set this
	 *  to the symbolic id; post-publish probe phases (e.g. the
	 *  `postPublishReadyHint` step that only sees the on-chain `packageId`)
	 *  pass `undefined`. The `mode-local` re-stamp pass back-fills
	 *  from the outer `inputs.sourcePath` whenever it can. */
	readonly sourcePath?: string | undefined;
	/** Symbolic package name (the user-declared `pkg.name`). Optional
	 *  because some throw sites (e.g. `postPublishReadyHint` in
	 *  `publish-executor.ts`) only have the resolved on-chain
	 *  `packageId` in scope; the `mode-local` re-stamp pass back-fills
	 *  the symbolic name from `inputs.packageName` whenever it can.
	 *  Throw sites MUST NOT overload this slot with the on-chain
	 *  `packageId` — the symbolic name is what user-facing error
	 *  displays expect. */
	readonly packageName?: string | undefined;
	readonly message: string;
	readonly cause?: unknown;
}

export const publishError = (
	phase: PublishPhase,
	parts: Omit<PublishError, '_tag' | 'phase'>,
): PublishError => ({ _tag: 'PublishError', phase, ...parts });

/** The catchable error tags this plugin exposes. Pinned against the
 *  user-facing error catalog by the error-catalog-parity test. */
export const PACKAGE_ERROR_TAGS = ['PublishError'] as const;

export type PackageError = PublishError;
