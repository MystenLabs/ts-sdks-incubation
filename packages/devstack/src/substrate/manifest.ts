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
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Effect.Effect<ManifestExtras, Error, never> =>
	Effect.gen(function* () {
		if (input === undefined) return {};
		const resolvedEffect = Effect.isEffect(input)
			? input
			: typeof input === 'function'
				? Effect.sync(() => input(ctx)).pipe(
						Effect.flatMap((value) => (Effect.isEffect(value) ? value : Effect.succeed(value))),
					)
				: Effect.succeed(input);
		const resolved = yield* resolvedEffect;
		if (!isRecord(resolved)) {
			return yield* Effect.fail(new Error('manifest extras must resolve to a plain record'));
		}
		return resolved;
	});

/** Flat endpoint entry — the manifest's load-bearing surface for
 *  build integrations. */
export interface EndpointEntry {
	readonly name: string;
	readonly url: string;
	readonly displayUrl: string | null;
	readonly wireProtocol: 'http' | 'h2c' | string;
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
			wireProtocol: Schema.String,
			pluginKey: Schema.String,
			endpointKey: Schema.String,
		}),
	),
	extras: Schema.Record(Schema.String, Schema.Unknown),
});
