// Substrate-blind URL composer + routed-hostname accessor.
//
// Consumed by L2 plugins (wallet, sui modes, future authors) so plugin
// code does not reach across the L2→L3 boundary into
// `orchestrators/router/hostname.ts`. The pure URL composition and
// hostname-minting logic depends only on `substrate/identity.ts` and is
// genuinely substrate-level; lifting it here removes a long-standing
// boundary violation flagged in ARCHITECTURE.md (L2 row: "NEVER imports
// from … L3 orchestrators").
//
// Architecture invariants honoured (mirrored from the original
// orchestrators/router/hostname.ts authoritative comment):
//
//   #7  — Distinct `(app, stack, role)` triples MUST produce distinct
//          hostnames. Default stack ('main') omits the stack segment;
//          every other stack includes it.
//   #8  — Hostname service labels fold dots to a label-safe separator
//          before validation.
//   #13 — User-influenceable strings are validated against a
//          conservative character set before render.
//
// The L3 router orchestrator imports from here and adapts the
// substrate-blind `HostnameValidationError` into its richer
// `RouterError` union for orchestrator-internal callers (file-provider,
// resolveRoute) that compose with `UnknownEntrypoint`, `RouteCollision`,
// etc. Substrate stays name-blind: this module mentions no plugin or
// orchestrator identifiers.

import { Effect, Schema } from 'effect';

import type { Identity } from '../identity.ts';

/** The conventional "default" stack name. Hostnames for this stack omit
 *  the stack segment per the architecture's UX rule. */
export const DEFAULT_STACK = 'main';

// RFC-1035 single-label regex: starts/ends with alphanumeric, allows
// internal hyphens, length 1-63. Used for app, role, and (post-fold)
// stack labels.
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// 253 chars is the RFC-1035 full-name max. We stay well below.
const MAX_HOSTNAME_LEN = 200;

/** A user-influenceable hostname-segment string did not pass
 *  validation. Substrate-blind shape mirroring the orchestrator's
 *  `RouterValidationError`; L3 orchestrators wrap this into their
 *  richer error union for internal composition. */
export class HostnameValidationError extends Schema.TaggedErrorClass<HostnameValidationError>()(
	'HostnameValidationError',
	{
		field: Schema.Literals(['hostname', 'dispatchId', 'entrypointName', 'upstreamUrl']),
		value: Schema.String,
		detail: Schema.String,
	},
) {}

/** Validate a single label-shaped string. */
const validateLabel = (
	field: HostnameValidationError['field'],
	value: string,
): Effect.Effect<string, HostnameValidationError> => {
	if (!LABEL.test(value)) {
		return Effect.fail(
			new HostnameValidationError({
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

/** Mint the per-Routable hostname from `(identity, role)`.
 *
 *  Default stack: `<role>.<app>.localhost`
 *  Other stacks:  `<role>.<stack>.<app>.localhost`
 *
 *  Substrate-blind: the substrate knows about identities (app, stack)
 *  and arbitrary role strings — it does not know about specific plugins
 *  or services. L2 plugins call this directly; L3 orchestrators wrap
 *  the failure case into their richer error union. */
export const routedHostname = (
	identity: Identity,
	role: string,
): Effect.Effect<string, HostnameValidationError> =>
	Effect.gen(function* () {
		const app = yield* validateLabel('hostname', identity.app);
		const folded = normalizeServiceSegment(role);
		const roleSafe = yield* validateLabel('hostname', folded);
		const assembled = (() => {
			if (identity.stack === DEFAULT_STACK) {
				return `${roleSafe}.${app}.localhost`;
			}
			const stackSafe = identity.stack.toLowerCase();
			// The stack name comes from the Identity brand, which boot
			// validation already constrains to the same RFC-1035 label
			// shape as `app` and `role`. We do not re-validate here —
			// `validateLabel(folded)` above already proved any label
			// failure would have surfaced upstream, and earlier revisions
			// of this code added a defensive re-check that was unreachable
			// in practice.
			return `${roleSafe}.${stackSafe}.${app}.localhost`;
		})();
		if (assembled.length > MAX_HOSTNAME_LEN) {
			return yield* Effect.fail(
				new HostnameValidationError({
					field: 'hostname',
					value: assembled,
					detail: `exceeds ${MAX_HOSTNAME_LEN}-char limit`,
				}),
			);
		}
		return assembled;
	});

/** Pure URL composer.
 *
 *  - `http` / `h2c` → `http://…` (h2c is HTTP/2 cleartext; Traefik
 *    handles upstream selection internally, the URL scheme stays
 *    `http`).
 *  - `https`        → `https://…`.
 *  - `tcp`          → `tcp://…` — used by the file-provider renderer
 *    to distinguish from HTTP at YAML-emit time. Consumers of the
 *    resolved URL (manifest, codegen) translate back to whatever
 *    scheme their protocol expects (e.g. `postgres://`, `redis://`).
 *
 *  The port is always included in the rendered URL (no well-known-port
 *  omission); the file-provider renderer parses the URL back into
 *  `(assembled, port)` for the TCP `address:` field and would reject a
 *  port-less form. `path` is appended verbatim when supplied (it MUST
 *  include the leading slash). */
export const renderUrl = (parts: {
	readonly protocol: 'http' | 'https' | 'h2c' | 'tcp';
	readonly hostname: string;
	readonly port: number;
	readonly path?: string;
}): string => {
	const scheme = parts.protocol === 'https' ? 'https' : parts.protocol === 'tcp' ? 'tcp' : 'http';
	const path = parts.path ?? '';
	return `${scheme}://${parts.hostname}:${parts.port}${path}`;
};
