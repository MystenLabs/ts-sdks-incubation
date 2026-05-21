// Playwright build-integration errors.
//
// Architecture (distilled/23-build-integrations.md § Playwright):
// every failure surface for the preset is a tagged error so the
// config-load (synchronous, runs before any supervisor exists) can
// raise a structured signal with an embedded recovery recipe rather
// than an opaque downstream NPE.
//
// Scope discipline: this surface owns FOUR error tags. Anything that
// would be a fifth tag is either upstream (manifest schema error from
// the L0 substrate, which we re-raise unchanged) or a programmer
// defect (Effect.die / throw — not part of this contract).
//
// The Playwright config-load is synchronous (Playwright's
// `defineConfig` is sync), so these errors are constructed and
// thrown rather than `Effect.fail`-ed. The surface mirrors the
// `Data.TaggedError` shape so the tags are uniform across the
// codebase, but the catch sites are `try` / `instanceof` in
// Playwright host code.

import { Data } from 'effect';

// -----------------------------------------------------------------------------
// Discovery — manifest could not be located and no conventional URL
// fallback exists for the requested endpoint.
// -----------------------------------------------------------------------------

/**
 * The manifest could not be located on disk (no stack-scoped file
 * along the walk-up path) AND the requested endpoint has no
 * conventional URL fallback in the endpoint declaration registry.
 *
 * Recovery: run `devstack up` once to materialize the manifest, OR
 * pass an explicit `baseURL` to `defineDevstackPlaywrightConfig` to
 * bypass the discovery path.
 */
export class PlaywrightManifestDiscoveryError extends Data.TaggedError(
	'PlaywrightManifestDiscoveryError',
)<{
	readonly message: string;
	readonly searchedPaths: ReadonlyArray<string>;
	readonly endpointKey?: string;
	readonly recoveryHint: string;
}> {}

// -----------------------------------------------------------------------------
// Shape — manifest exists but failed to decode against the L0
// envelope schema.
// -----------------------------------------------------------------------------

/**
 * The manifest file was located but failed to decode against
 * `ManifestEnvelopeSchema`. Wraps the substrate's `ManifestError`
 * (reason = `decode-failed` | `version-mismatch`) with a recovery
 * recipe targeted at the Playwright user (delete + re-run `devstack
 * up` rather than the engine-side recovery).
 */
export class PlaywrightManifestShapeError extends Data.TaggedError('PlaywrightManifestShapeError')<{
	readonly message: string;
	readonly manifestPath: string;
	readonly phase: 'shape' | 'parse' | 'version-mismatch';
	readonly recoveryHint: string;
	readonly cause?: unknown;
}> {}

// -----------------------------------------------------------------------------
// Endpoint lookup — manifest decoded fine but the requested endpoint
// is absent from the flat lookup.
// -----------------------------------------------------------------------------

/**
 * The manifest decoded but `endpoints[endpointKey]` is not present.
 * Typically caused by a typo in user config or by referencing an
 * endpoint owned by a plugin not present in the resolved stack.
 */
export class PlaywrightEndpointNotFoundError extends Data.TaggedError(
	'PlaywrightEndpointNotFoundError',
)<{
	readonly message: string;
	readonly endpointKey: string;
	readonly available: ReadonlyArray<string>;
	readonly recoveryHint: string;
}> {}

// -----------------------------------------------------------------------------
// Wallet adapter — the in-spec wallet helper could not talk to the
// dev wallet's HTTP API.
// -----------------------------------------------------------------------------

/**
 * The wallet-context test helper failed to reach the dev wallet's
 * HTTP API (the supervisor's wallet plugin exposes an endpoint that
 * tests POST to for sign-tx flows). Typical causes: supervisor not
 * up, wallet endpoint not yet registered in the manifest, network
 * partition between test runner and supervisor.
 *
 * This tag is throwable from in-spec helpers AND constructible by
 * `wallet-context.ts` callers; it carries enough detail to format a
 * Playwright-friendly assertion failure.
 */
export class PlaywrightWalletAdapterError extends Data.TaggedError('PlaywrightWalletAdapterError')<{
	readonly message: string;
	readonly operation: 'sign-tx' | 'list-accounts' | 'switch-account' | 'fetch';
	readonly url?: string;
	readonly status?: number;
	readonly cause?: unknown;
}> {}

// -----------------------------------------------------------------------------
// Union for catch sites that want to handle every surface tag.
// -----------------------------------------------------------------------------

/** Discriminated union of every error the Playwright preset emits. */
export type PlaywrightIntegrationError =
	| PlaywrightManifestDiscoveryError
	| PlaywrightManifestShapeError
	| PlaywrightEndpointNotFoundError
	| PlaywrightWalletAdapterError;
