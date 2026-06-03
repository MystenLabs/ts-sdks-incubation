// Manifest envelope schema.
//
// Architecture § Manifest data model: envelope shape is fixed at L0,
// per-service projection is each plugin's responsibility (lives in
// the Codegenable contribution). Build integrations read the
// envelope; codegen output carries the typed per-service slice.
//
// L0 owns:
//   - the envelope (identity tuple, manifestVersion, services slot,
//     endpoints lookup, opaque extras),
//   - the endpoint-declaration shape (decl emitted by Routable; the
//     manifest writer at L3 walks them).

import { Effect, Schema } from 'effect';

/** Tagged failure when a plugin's manifest-extras contribution does
 *  not resolve to a plain record. STYLE_GUIDE §2.2 — substrate (L0)
 *  errors use `Schema.TaggedErrorClass`; downstream classifiers
 *  `catchTag('ManifestExtrasInvalid', ...)` instead of sniffing the
 *  message. */
export class ManifestExtrasInvalid extends Schema.TaggedErrorClass<ManifestExtrasInvalid>()(
	'ManifestExtrasInvalid',
	{
		detail: Schema.String,
	},
) {}

/** Tagged failure when a plugin's `extras` factory references a
 *  resource the host cannot resolve — either the resource id is not
 *  registered with the supervisor, or it has not produced a value
 *  yet at the point the factory ran. Thrown synchronously from the
 *  user-supplied `ctx.value(...)` closure; `resolveManifestExtras`
 *  catches the throw and surfaces it as a typed failure so callers
 *  classify via `catchTag('ManifestExtrasLookupError', ...)` rather
 *  than die-cause inspection. */
export class ManifestExtrasLookupError extends Schema.TaggedErrorClass<ManifestExtrasLookupError>()(
	'ManifestExtrasLookupError',
	{
		kind: Schema.Literals(['unknown-resource', 'unresolved-resource']),
		resourceId: Schema.String,
	},
) {}

/** Codegen metadata recorded per stack. The supervisor writes the
 *  resolved absolute output dir here at manifest-flush time so the
 *  read-side build integrations (the Vite plugin) point an `@generated`
 *  alias at the EXACT dir codegen emitted into for THIS stack — read
 *  and write share one decision (see
 *  `orchestrators/codegen/output-location.ts`). Optional + additive:
 *  manifests written before this field existed (and stacks that somehow
 *  flush without it) still decode; consumers fall back to
 *  `src/generated/`. */
export interface ManifestCodegen {
	/** Absolute path to the directory codegen emitted into for this
	 *  stack (primary → `<appRoot>/src/generated`; secondary →
	 *  `<appRoot>/.devstack/stacks/<stack>/generated`). */
	readonly generatedDir: string;
	/** Absolute path to the dev-only + secret `generated-extras` tree
	 *  for this stack (`<appRoot>/.devstack/stacks/<stack>/generated-extras`).
	 *  The `@devstack-dev` Vite alias resolves here. Optional +
	 *  additive — older manifests omit it; the reader falls back to
	 *  `.devstack/stacks/<stack>/generated-extras`. */
	readonly extrasDir?: string;
}

/** Manifest envelope. The `services` slot is open (`unknown`) at
 *  the envelope level; each plugin's Codegenable contribution
 *  emits a typed file the consumer imports for the typed shape.
 */
export interface ManifestEnvelope {
	readonly identity: {
		readonly app: string;
		readonly stack: string;
		readonly chain: string;
	};
	readonly manifestVersion: number;
	readonly services: Readonly<Record<string, unknown>>;
	readonly endpoints: Readonly<Record<string, EndpointEntry>>;
	readonly extras: Readonly<Record<string, unknown>>;
	/** Per-stack codegen metadata. Optional — absent in older
	 *  manifests; the reader falls back to `src/generated/`. */
	readonly codegen?: ManifestCodegen;
}

export type ManifestExtras = Readonly<Record<string, unknown>>;

export interface ManifestExtrasContext {
	readonly value: (resource: { readonly id: string }) => unknown;
}

export type ManifestExtrasInput =
	| ManifestExtras
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	| Effect.Effect<ManifestExtras, any, never>
	| ((
			ctx: ManifestExtrasContext,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
	  ) => ManifestExtras | Effect.Effect<ManifestExtras, any, never>);

const isRecord = (value: unknown): value is ManifestExtras =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export const resolveManifestExtras = (
	input: ManifestExtrasInput | undefined,
	ctx: ManifestExtrasContext,
): Effect.Effect<ManifestExtras, ManifestExtrasInvalid | ManifestExtrasLookupError, never> =>
	Effect.gen(function* () {
		if (input === undefined) return {};
		// The user-supplied `extras` factory invokes `ctx.value(...)`
		// synchronously; a missing/unresolved resource throws a
		// `ManifestExtrasLookupError`. `Effect.try` with a typed
		// `catch` mapper promotes that throw into the typed failure
		// channel so callers `catchTag` it instead of having to inspect
		// the die-cause. Any non-tagged throw is rethrown to preserve
		// the existing defect semantics for genuine programmer errors
		// inside the factory body.
		const resolvedEffect = Effect.isEffect(input)
			? input
			: typeof input === 'function'
				? Effect.try({
						try: () => input(ctx),
						catch: (cause) => {
							if (cause instanceof ManifestExtrasLookupError) return cause;
							throw cause;
						},
					}).pipe(
						Effect.flatMap((value) => (Effect.isEffect(value) ? value : Effect.succeed(value))),
					)
				: Effect.succeed(input);
		const resolved = yield* resolvedEffect;
		if (!isRecord(resolved)) {
			return yield* Effect.fail(
				new ManifestExtrasInvalid({
					detail: 'manifest extras must resolve to a plain record',
				}),
			);
		}
		return resolved;
	});

/** Flat endpoint entry — the manifest's load-bearing surface for
 *  build integrations. */
export interface EndpointEntry {
	readonly name: string;
	readonly url: string;
	readonly displayUrl: string | null;
	readonly wireProtocol: 'http' | 'h2c' | 'tcp';
	readonly pluginKey: string;
	readonly endpointKey: string;
}

/** Schema for runtime validation of an on-disk manifest. Build
 *  integrations decode through this on read. */
export const ManifestEnvelopeSchema = Schema.Struct({
	identity: Schema.Struct({
		app: Schema.String,
		stack: Schema.String,
		chain: Schema.String,
	}),
	manifestVersion: Schema.Number,
	services: Schema.Record(Schema.String, Schema.Unknown),
	endpoints: Schema.Record(
		Schema.String,
		Schema.Struct({
			name: Schema.String,
			url: Schema.String,
			displayUrl: Schema.NullOr(Schema.String),
			wireProtocol: Schema.Literals(['http', 'h2c', 'tcp']),
			pluginKey: Schema.String,
			endpointKey: Schema.String,
		}),
	),
	extras: Schema.Record(Schema.String, Schema.Unknown),
	// Optional + additive — a manifest written before this field
	// existed still decodes (the key is simply absent). The Vite plugin
	// reads `codegen.generatedDir` to point its `@generated` alias; on a
	// miss it falls back to `src/generated/`.
	codegen: Schema.optional(
		Schema.Struct({
			generatedDir: Schema.String,
			extrasDir: Schema.optional(Schema.String),
		}),
	),
});
