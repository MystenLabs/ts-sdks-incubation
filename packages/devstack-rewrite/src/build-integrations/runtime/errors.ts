// Build-integrations / runtime errors.
//
// The read-side surface for consumer code (apps, build tools). Two
// failure shapes that callers care about distinguishing:
//
//   - `ManifestDiscoveryError`: no manifest could be located. Includes
//     a recovery hint ("run `devstack up`") and the candidate path the
//     resolver expected.
//   - `ManifestShapeError`: a manifest was found but failed to parse
//     or decode. The two phases (`parse` vs `shape`) drive distinct
//     recovery recipes the caller can print.
//
// These are PLAIN classes (no Effect tags) because the read surface is
// sync-blocking — apps load the manifest at startup and rely on plain
// `try` / `catch`. The Effect-flavored read path (CLI / codegen) wraps
// these into structured failure channels.

/** Phase of a `ManifestDiscoveryError`. `walk-up` means the resolver
 *  walked from cwd to root without finding a stack-scoped manifest;
 *  `env-missing` means `DEVSTACK_MANIFEST_PATH` (top-precedence
 *  override) pointed at a file that doesn't exist; `override-missing`
 *  means a caller-supplied `manifestPath` / `override` doesn't exist;
 *  `required-missing` is the catch-all for the `required: true`
 *  branches. */
export type ManifestDiscoveryPhase =
	| 'walk-up'
	| 'env-missing'
	| 'override-missing'
	| 'required-missing';

/** Thrown when the manifest cannot be located on disk. The message
 *  embeds the candidate path and the canonical recovery recipe
 *  (`run devstack up`); the field shape is stable so structured-log
 *  consumers can pattern-match without parsing strings. */
export class ManifestDiscoveryError extends Error {
	override readonly name = 'ManifestDiscoveryError';
	readonly phase: ManifestDiscoveryPhase;
	readonly path: string | undefined;
	override readonly cause?: unknown;
	constructor(args: {
		readonly phase: ManifestDiscoveryPhase;
		readonly message: string;
		readonly path?: string;
		readonly cause?: unknown;
	}) {
		super(args.message);
		this.phase = args.phase;
		this.path = args.path;
		if (args.cause !== undefined) this.cause = args.cause;
	}
}

/** Phase of a `ManifestShapeError`. `parse` means `JSON.parse` rejected
 *  the bytes (truncation mid-write, hand-edit); `shape` means the bytes
 *  parsed but the decoded value failed schema validation (wrong / stale
 *  envelope shape); `version` means the manifest's `manifestVersion`
 *  doesn't match the version this consumer was built against. */
export type ManifestShapePhase = 'parse' | 'shape' | 'version';

/** Thrown when a discovered manifest exists but fails to parse / decode
 *  / version-match. Carries the offending path so the recovery recipe
 *  (`rm <path> && devstack up`) is actionable. */
export class ManifestShapeError extends Error {
	override readonly name = 'ManifestShapeError';
	readonly phase: ManifestShapePhase;
	readonly path: string;
	override readonly cause?: unknown;
	constructor(args: {
		readonly phase: ManifestShapePhase;
		readonly message: string;
		readonly path: string;
		readonly cause?: unknown;
	}) {
		super(args.message);
		this.phase = args.phase;
		this.path = args.path;
		if (args.cause !== undefined) this.cause = args.cause;
	}
}

/** Thrown by `coldStartUrl(endpoint)` when the endpoint name is not
 *  registered in the conventional-routes table and no manifest is
 *  available either. The message lists the supported endpoint names
 *  (derived from the registry, not hard-coded) so typos surface
 *  obviously. */
export class NoConventionalRouteError extends Error {
	override readonly name = 'NoConventionalRouteError';
	readonly endpoint: string;
	readonly supported: ReadonlyArray<string>;
	constructor(args: {
		readonly endpoint: string;
		readonly supported: ReadonlyArray<string>;
		readonly message: string;
	}) {
		super(args.message);
		this.endpoint = args.endpoint;
		this.supported = args.supported;
	}
}
