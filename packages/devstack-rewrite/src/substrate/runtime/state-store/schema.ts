// On-disk schema for the per-stack state.json.
//
// One file per stack. Plugin-keyed top-level subtrees so two
// plugins never see each other's keys. Tombstones distinguish
// "deleted" from "missing" — see header of `state-store.ts`.

import { Schema } from 'effect';

/** Stored value envelope. The phantom-typed `StateKey<V>` reads /
 *  writes against the `value` slot opaquely (the substrate doesn't
 *  introspect plugin values — it stores the JSON value as `unknown`
 *  and re-encodes the document on every set). */
export const StateEntry = Schema.Struct({
	/** Discriminator. `present` carries a value; `tombstone` records
	 *  that the key was deleted (so reads can distinguish "user
	 *  removed this" from "user never wrote it"). */
	state: Schema.Literals(['present', 'tombstone']),
	/** Encoded value. For `tombstone` entries this is `null`; the
	 *  substrate refuses to deliver it on `get`. */
	value: Schema.Unknown,
	/** Timestamp of the last mutation. Renderers may surface it;
	 *  the substrate uses it only for diagnostics. */
	updatedAt: Schema.Number,
});
export type StateEntry = typeof StateEntry.Type;

/** Document — one file per stack. Keys are the `StateKey<V>` string
 *  form (`<pluginKey>/<suffix>`), values are entries. */
export const StateDocument = Schema.Struct({
	/** Schema version; bump on incompatible changes. v1 is the
	 *  initial release; bumps are the only way to introduce
	 *  backward-incompatible shape changes. Schema-decode failure on
	 *  read with an unknown version surfaces as `corruption`. */
	version: Schema.Literal(1),
	/** Per-plugin namespaces. Key is the plugin-key prefix; nested
	 *  record is the plugin's own keys (suffix → entry). Two-level
	 *  structure (vs. flat `pluginKey/suffix → entry`) so `listUnder`
	 *  is an O(1) lookup and per-plugin wipes are O(1) field deletes. */
	plugins: Schema.Record(Schema.String, Schema.Record(Schema.String, StateEntry)),
});
export type StateDocument = typeof StateDocument.Type;

/** Initial empty document. */
export const emptyDocument: StateDocument = { version: 1, plugins: {} };
