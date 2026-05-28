// Versioned cross-process document schema helper.
//
// Centralizes the `{ version: Literal<N>, ...payload }` discriminator
// shape that every cross-process document the substrate persists shares
// (roster, container claim, snapshot reservation, port reservation).
//
// Future v2 migration becomes mechanical: replace the call with
// `Schema.Union(versionedDocSchema(1, ...), versionedDocSchema(2, ...))`
// at exactly one site per document, rather than hand-rolling the
// discriminator field in each consumer.

import { Schema } from 'effect';

/** Construct a versioned cross-process document schema —
 *  `{ version: Literal<N>, ...payloadFields }` in one call.
 *
 *  The resulting schema is structurally identical to a hand-written
 *  `Schema.Struct({ version: Schema.Literal(N), ...payload })`; the
 *  `version` field becomes a literal-typed discriminator suitable for
 *  forward-compatible `Schema.Union`s. */
export const versionedDocSchema = <const V extends number, Fields extends Schema.Struct.Fields>(
	version: V,
	payload: Fields,
): Schema.Struct<{ readonly version: Schema.Literal<V> } & Fields> =>
	Schema.Struct({
		version: Schema.Literal(version),
		...payload,
	}) as unknown as Schema.Struct<{ readonly version: Schema.Literal<V> } & Fields>;
