// Hostname + dispatch-id minting helpers.
//
// Architecture distilled-doc §"Outputs / capabilities provided":
//
//   - default ("main") stack: `<service>.<app>.localhost`
//   - every other stack:      `<stack>.<service>.<app>.localhost`
//
// "service" here is the dispatch-id's `role` segment — NOT the
// plugin's name. Plugins emit a `(compositeKey, role)` DispatchId; we
// fold the role into the hostname, since the role is the
// user-meaningful side ("api", "key-server", "indexer-metrics") and
// the composite-key already encodes plugin + app + stack on the
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

import { createHash } from 'node:crypto';

import { Effect } from 'effect';
import type { DispatchId } from '../../contracts/routable.ts';
import type { Identity } from '../../substrate/identity.ts';
import { RouterValidationError } from './errors.ts';

/** The conventional "default" stack name. Hostnames for this stack
 *  omit the stack segment per the architecture's UX rule. */
export const DEFAULT_STACK = 'main';

// RFC-1035 single-label regex: starts/ends with alphanumeric, allows
// internal hyphens, length 1-63. We use the same shape for app, role,
// and (post-fold) the stack segment.
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// The readable prefix is capped, and the SHA-256 suffix is fixed size.
const MAX_DISPATCH_ID_LEN = 140;
const MAX_DISPATCH_ID_READABLE_LEN = 48;
// 253 chars is the RFC-1035 full-name max. We stay well below.
const MAX_HOSTNAME_LEN = 200;

/** Validate a single label-shaped string. Returns the input or fails
 *  with a typed `RouterValidationError`. */
const validateLabel = (
	field: RouterValidationError['field'],
	value: string,
): Effect.Effect<string, RouterValidationError> => {
	if (!LABEL.test(value)) {
		return Effect.fail(
			new RouterValidationError({
				field,
				value,
				detail: 'expected lower-case RFC-1035 label (alphanumeric + internal hyphens, 1-63 chars)',
			}),
		);
	}
	return Effect.succeed(value);
};

/** Fold dots → hyphens (architecture invariant #8) and lower-case.
 *  Pure, no validation. The output is fed to `validateLabel`. */
export const normalizeServiceSegment = (raw: string): string =>
	raw.toLowerCase().replace(/\./g, '-');

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
// Hostname minting
// ---------------------------------------------------------------------------

/** Mint the per-Routable hostname from `(identity, role)`.
 *
 *  Default stack: `<role>.<app>.localhost`
 *  Other stacks:  `<stack>.<role>.<app>.localhost`
 *
 *  The `role` segment is folded + validated; the `app` and `stack`
 *  segments are also validated (they come from `Identity`, which the
 *  substrate has already validated once at boot, but defense-in-depth
 *  is cheap and the failure mode is a programming error).
 *
 *  Architecture invariant #7: this MUST embed the stack dimension for
 *  non-default stacks. Distinct identities → distinct hostnames. */
export const routerHostname = (
	identity: Identity,
	role: string,
): Effect.Effect<string, RouterValidationError> =>
	Effect.gen(function* () {
		const app = yield* validateLabel('hostname', identity.app);
		const folded = normalizeServiceSegment(role);
		const roleSafe = yield* validateLabel('hostname', folded);
		const host = (() => {
			if (identity.stack === DEFAULT_STACK) {
				return `${roleSafe}.${app}.localhost`;
			}
			const stackSafe = identity.stack.toLowerCase();
			// `validateLabel` runs *after* lower-casing so the stack name
			// (Identity brand) is held to the same character set as the
			// role and the app. Boot validation should already enforce
			// this; we re-check defensively.
			return `${stackSafe}.${roleSafe}.${app}.localhost`;
		})();
		if (host.length > MAX_HOSTNAME_LEN) {
			return yield* Effect.fail(
				new RouterValidationError({
					field: 'hostname',
					value: host,
					detail: `exceeds ${MAX_HOSTNAME_LEN}-char limit`,
				}),
			);
		}
		// Re-validate the stack segment for non-default stacks now that
		// it's part of a composed hostname.
		if (identity.stack !== DEFAULT_STACK) {
			yield* validateLabel('hostname', identity.stack.toLowerCase());
		}
		return host;
	});

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
		inputs.dispatch.compositeKey,
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
 *  canonical `(version, app, stack, compositeKey, role)` tuple, so
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
					inputs.dispatch.compositeKey,
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

/** URL-construction helper: `<scheme>://<hostname>:<port>`.
 *
 *  - `http` / `h2c` → `http://…` (h2c is HTTP/2 cleartext; Traefik
 *    handles upstream selection internally, the URL scheme is still
 *    `http`).
 *  - `tcp` → `tcp://…` — used by the file-provider renderer to
 *    distinguish from HTTP at YAML-emit time. Consumers of the
 *    resolved URL (manifest, codegen) translate back to whatever
 *    scheme their protocol expects (e.g. `postgres://`, `redis://`). */
export const renderUrl = (parts: {
	readonly protocol: 'http' | 'h2c' | 'tcp';
	readonly hostname: string;
	readonly port: number;
}): string => {
	if (parts.protocol === 'tcp') return `tcp://${parts.hostname}:${parts.port}`;
	return `http://${parts.hostname}:${parts.port}`;
};
