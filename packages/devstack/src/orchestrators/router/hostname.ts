// Hostname + dispatch-id minting helpers.
//
// Architecture distilled-doc §"Outputs / capabilities provided":
//
//   - default ("main") stack: `<service>.<app>.localhost`
//   - every other stack:      `<service>.<stack>.<app>.localhost`
//
// "service" here is the dispatch-id's `role` segment — NOT the
// plugin's name. Plugins emit a `(serviceKey, role)` DispatchId; we
// fold the role into the hostname, since the role is the
// user-meaningful side ("api", "key-server", "indexer-metrics") and
// the service key already encodes plugin + app + stack on the
// dispatch-file side.
//
// Architecture invariants:
//   #7 — Distinct `(app, stack, service)` triples MUST produce
//         distinct hostnames AND distinct dispatch ids. The default-
//         stack omission is intentional UX; every other stack
//         includes the stack segment so parallel stacks of the same
//         app never collide.
//   #8 — Hostname service labels fold dots to a label-safe separator.
//         Dispatch ids are minted from a canonical source tuple plus a
//         SHA-256 digest, so lossy readable folding cannot collide.
//   #13 — User-influenceable strings are validated against a
//         conservative character set before render.
//
// As of B1 (boundary-repair): pure URL composition + hostname minting
// live in `substrate/runtime/routed-url.ts` so L2 plugins can call
// them without reaching across the L2→L3 boundary. This module re-
// exports the substrate primitives, owns dispatch-file id minting
// (router-orchestrator-specific), and provides a `routerHostname`
// adapter that projects substrate's `HostnameValidationError` into the
// router's `RouterValidationError` union for intra-L3 callers
// (file-provider, resolveRoute).

import { createHash } from 'node:crypto';

import { Effect } from 'effect';
import type { DispatchId } from '../../contracts/routable.ts';
import type { Identity } from '../../substrate/identity.ts';
import {
	DEFAULT_STACK,
	HostnameValidationError,
	normalizeServiceSegment,
	renderUrl,
	routedHostname,
} from '../../substrate/runtime/routed-url.ts';
import { RouterValidationError } from './errors.ts';

// Re-export substrate-blind primitives for intra-L3 callers that
// continue to import from this module path.
export { DEFAULT_STACK, normalizeServiceSegment, renderUrl };

// The readable prefix is capped, and the SHA-256 suffix is fixed size.
const MAX_DISPATCH_ID_LEN = 140;
const MAX_DISPATCH_ID_READABLE_LEN = 48;

/** Build the human-readable prefix of a dispatch id. This is not the
 *  identity key; uniqueness comes from the hash over the canonical
 *  tuple in `dispatchFileId`. */
export const normalizeDispatchSegment = (raw: string): string =>
	raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '') || 'route';

// ---------------------------------------------------------------------------
// Hostname minting — orchestrator-internal adapter
// ---------------------------------------------------------------------------

/** Project the substrate-blind hostname error into the router error
 *  union. The shape is identical (tagged class with field/value/detail);
 *  this exists so intra-L3 composers (file-provider, resolveRoute) can
 *  keep returning the existing `RouterError` union without a per-call
 *  `mapError` at every call site. */
const liftHostnameError = (cause: HostnameValidationError): RouterValidationError =>
	new RouterValidationError({
		field: cause.field,
		value: cause.value,
		detail: cause.detail,
	});

/** Intra-L3 alias for substrate's `routedHostname` that maps the
 *  substrate error onto the router orchestrator's `RouterError` union.
 *
 *  L2 plugins MUST NOT import this — they import `routedHostname` from
 *  `substrate/runtime/routed-url.ts` directly. This adapter exists only
 *  for the orchestrator's own composers. */
export const routerHostname = (
	identity: Identity,
	role: string,
): Effect.Effect<string, RouterValidationError> =>
	routedHostname(identity, role).pipe(Effect.mapError(liftHostnameError));

// ---------------------------------------------------------------------------
// Dispatch-file id minting
// ---------------------------------------------------------------------------

export interface DispatchFileIdInputs {
	readonly identity: Identity;
	readonly dispatch: DispatchId;
}

const canonicalDispatchTuple = (inputs: DispatchFileIdInputs): string =>
	JSON.stringify([
		'devstack-router-dispatch-v1',
		inputs.identity.app,
		inputs.identity.stack,
		inputs.dispatch.serviceKey,
		inputs.dispatch.role,
	]);

const truncateReadable = (value: string): string =>
	(value.length <= MAX_DISPATCH_ID_READABLE_LEN
		? value
		: value.slice(0, MAX_DISPATCH_ID_READABLE_LEN).replace(/-+$/g, '')) || 'route';

/** Mint a dispatch-file id from the full route identity tuple. The id
 *  is used as the file name in the global file-provider directory
 *  (one file per backend), and as the Traefik router/service name
 *  inside the file.
 *
 *  Format: `r1-<readable-prefix>-<sha256>`.
 *
 *  The readable prefix is intentionally lossy; it exists only to make
 *  directory listings diagnosable. The SHA-256 suffix is over the
 *  canonical `(version, app, stack, serviceKey, role)` tuple, so
 *  raw underscores, separator strings, case, and dot/hyphen folding do
 *  not affect identity. */
export const dispatchFileId = (
	inputs: DispatchFileIdInputs,
): Effect.Effect<string, RouterValidationError> =>
	Effect.gen(function* () {
		const readable = truncateReadable(
			normalizeDispatchSegment(
				[
					inputs.identity.app,
					inputs.identity.stack,
					inputs.dispatch.serviceKey,
					inputs.dispatch.role,
				].join('-'),
			),
		);
		const hash = createHash('sha256').update(canonicalDispatchTuple(inputs)).digest('hex');
		const id = `r1-${readable}-${hash}`;
		if (id.length > MAX_DISPATCH_ID_LEN) {
			return yield* Effect.fail(
				new RouterValidationError({
					field: 'dispatchId',
					value: id,
					detail: `exceeds ${MAX_DISPATCH_ID_LEN}-char limit`,
				}),
			);
		}
		if (!/^r1-[a-z0-9][a-z0-9-]*-[a-f0-9]{64}$/.test(id)) {
			return yield* Effect.fail(
				new RouterValidationError({
					field: 'dispatchId',
					value: id,
					detail: 'expected r1-<lower-case-slug>-<sha256-hex>',
				}),
			);
		}
		return id;
	});
