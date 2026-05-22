// Typed errors emitted by the router orchestrator.
//
// One tagged class per discriminated failure surface; the router is
// the only producer so the shapes are tight. Effect v4 `Schema.TaggedErrorClass`
// pattern matches the rest of the substrate (see
// `substrate/runtime/errors.ts`).

import { Schema } from 'effect';

/** Caller registered (or referenced) an entrypoint that isn't in the
 *  process-global registry. Architecture invariant #6:
 *  registrations are read once at router launch; this surface is the
 *  programming-error path for callers that splice an unregistered
 *  name into a Routable. */
export class UnknownEntrypoint extends Schema.TaggedErrorClass<UnknownEntrypoint>()(
	'UnknownEntrypoint',
	{
		name: Schema.String,
		known: Schema.Array(Schema.String),
	},
) {}

/** Two callers tried to register the same entrypoint *name* with
 *  conflicting `(port, protocol)`. Architecture invariant #6:
 *  re-registering identically is idempotent; re-registering with a
 *  conflict throws synchronously. */
export class EntrypointConflict extends Schema.TaggedErrorClass<EntrypointConflict>()(
	'EntrypointConflict',
	{
		name: Schema.String,
		existing: Schema.Struct({
			port: Schema.Number,
			protocol: Schema.String,
		}),
		attempted: Schema.Struct({
			port: Schema.Number,
			protocol: Schema.String,
		}),
	},
) {}

/** A user-influenceable string (dispatch id / hostname / upstream URL
 *  / entrypoint name) didn't pass the validator. Architecture
 *  invariant #13. Always a programming error in the caller, NOT a
 *  transient. */
export class RouterValidationError extends Schema.TaggedErrorClass<RouterValidationError>()(
	'RouterValidationError',
	{
		field: Schema.Literals(['hostname', 'dispatchId', 'entrypointName', 'upstreamUrl']),
		value: Schema.String,
		detail: Schema.String,
	},
) {}

/** Two `Routable` contributions minted the same `(hostname, entrypoint)`
 *  pair — i.e. the dispatch-id contract is violated upstream. Hard
 *  failure: routing would be ambiguous. */
export class RouteCollision extends Schema.TaggedErrorClass<RouteCollision>()('RouteCollision', {
	message: Schema.String,
	hostname: Schema.String,
	entrypoint: Schema.String,
	dispatchIds: Schema.Array(Schema.String),
}) {}

/** The router upstream URL could not be resolved within the bounded
 *  retry budget — for container backends the network-connect's
 *  async IP-allocation never settled. Architecture invariant #3. */
export class UpstreamResolveTimeout extends Schema.TaggedErrorClass<UpstreamResolveTimeout>()(
	'UpstreamResolveTimeout',
	{
		dispatchId: Schema.String,
		upstreamKind: Schema.Literals(['container', 'host-loopback']),
		waitedMillis: Schema.Number,
	},
) {}

/** The router boot failed (image-pull, network-create, container-run
 *  all roll up here). Distinct tag from `UnknownEntrypoint` so callers
 *  can `Effect.catchTag('RouterBootFailed', …)` and report proxy
 *  infrastructure failures separately from route validation. */
export class RouterBootFailed extends Schema.TaggedErrorClass<RouterBootFailed>()(
	'RouterBootFailed',
	{
		stage: Schema.Literals([
			'ensure-network',
			'ensure-container',
			'write-shared-config',
			'inspect',
		]),
		detail: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

/** Router opt-out only supports endpoints that are already reachable
 *  from the host without Traefik. Container upstreams require the
 *  router's Docker network + proxy entrypoint, so disabled mode must
 *  fail explicitly instead of fabricating a localhost URL. */
export class RouterDisabledRouteUnsupported extends Schema.TaggedErrorClass<RouterDisabledRouteUnsupported>()(
	'RouterDisabledRouteUnsupported',
	{
		endpointName: Schema.String,
		upstreamKind: Schema.Literals(['container', 'host-loopback']),
		detail: Schema.String,
	},
) {}

/** Writing a per-backend dispatch file failed. Distinct from
 *  `RouterBootFailed` so callers can log/skip an individual route
 *  without failing boot, per distilled-doc:
 *  "the per-primitive route is silently absent; the route's hostname
 *  returns Traefik's default 404. Warning is logged…". */
export class DispatchWriteFailed extends Schema.TaggedErrorClass<DispatchWriteFailed>()(
	'DispatchWriteFailed',
	{
		dispatchFileId: Schema.String,
		path: Schema.String,
		detail: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

/** The per-backend dispatch file was written, but the public router
 *  entrypoint did not start serving that route within the readiness
 *  budget. This catches Traefik file-provider reload races before the
 *  endpoint is surfaced to users. */
export class RouteReadinessProbeFailed extends Schema.TaggedErrorClass<RouteReadinessProbeFailed>()(
	'RouteReadinessProbeFailed',
	{
		dispatchFileId: Schema.String,
		url: Schema.String,
		timeoutMs: Schema.Number,
		detail: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

export type RouterError =
	| UnknownEntrypoint
	| EntrypointConflict
	| RouterValidationError
	| RouteCollision
	| UpstreamResolveTimeout
	| RouterBootFailed
	| RouterDisabledRouteUnsupported
	| DispatchWriteFailed
	| RouteReadinessProbeFailed;
