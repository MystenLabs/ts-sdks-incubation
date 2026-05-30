// Vitest build-integration — typed errors.
//
// Architecture (distilled/23-build-integrations.md § Per-integration
// requirements → Vitest, § Edge cases): the vitest preset is a pure
// reader of files + env vars. The two failure modes it surfaces are
//   (a) manifest discovery failed when a test-setup hook asked for it,
//   (b) manifest exists but its shape doesn't match.
// Both errors carry a `recovery` string so the test-setup printout is
// actionable instead of a generic schema-decode trace.
//
// These tags mirror the engine's `ManifestDiscoveryError` /
// `ManifestShapeError` (substrate-side; see `runtime/` once it lands)
// but stay local to the vitest surface so consumers can `catchTag`
// without importing from substrate.

import { Data } from 'effect';

/** A test-setup hook asked for the manifest but no on-disk file was
 *  found by the walk-up or override path. The supervisor either hasn't
 *  run yet or the wrong stack/state-dir is configured. */
export class VitestManifestNotFoundError extends Data.TaggedError('VitestManifestNotFoundError')<{
	readonly message: string;
	readonly searchedFrom: string;
	readonly stack: string;
	readonly stateDir: string;
	readonly recovery: string;
}> {}

/** The manifest exists but doesn't decode against the L0 envelope schema
 *  — either malformed JSON (`parse`) or shape drift (`shape`).
 *
 *  Distinct from `VitestManifestVersionMismatchError`: this tag carries
 *  the "manifest looks like garbage / your envelope was wrong" recovery
 *  ("regenerate the manifest"); the version-mismatch tag carries the
 *  "build-integration and supervisor are at different versions"
 *  recovery (upgrade the consumer dependency). Splitting the two lets
 *  callers `catchTag` independently and surface a precise hint. */
export class VitestManifestShapeError extends Data.TaggedError('VitestManifestShapeError')<{
	readonly message: string;
	readonly path: string;
	readonly phase: 'parse' | 'shape';
	readonly recovery: string;
	readonly cause?: unknown;
}> {}

/** The manifest exists, decodes structurally, but its `manifestVersion`
 *  doesn't match what this consumer build was compiled for. Distinct
 *  from `VitestManifestShapeError` so callers can `catchTag` the two
 *  separately — the recovery action is "upgrade your devstack
 *  consumer dependency" rather than "regenerate the manifest". */
export class VitestManifestVersionMismatchError extends Data.TaggedError(
	'VitestManifestVersionMismatchError',
)<{
	readonly message: string;
	readonly path: string;
	readonly recovery: string;
	readonly cause?: unknown;
}> {}

/** A test-setup precondition was violated. Currently only one case:
 *  the caller asked for `requireDevstack: true` but the manifest wasn't
 *  discoverable. Distinct from the discovery error because the caller
 *  opted IN to the requirement. */
export class VitestSetupPreconditionError extends Data.TaggedError('VitestSetupPreconditionError')<{
	readonly message: string;
	readonly hint?: string;
}> {}

export type VitestIntegrationError =
	| VitestManifestNotFoundError
	| VitestManifestShapeError
	| VitestManifestVersionMismatchError
	| VitestSetupPreconditionError;
