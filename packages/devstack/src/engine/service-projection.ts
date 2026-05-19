// `defineServiceProjection` — table-driven primitive for the "read
// service state registry, project the last record into a view"
// boilerplate that every per-service grouper inside `gatherManifest`
// used to hand-roll.
//
// Each service primitive (Sui, Seal, Walrus, Pyth, Postgres, ...)
// publishes a single `StateRecord` into a dedicated `RegistryShape<T>`
// at acquire time. The manifest emitter, the codegen emitters, and the
// in-process consumers all want the same projection: take the LAST
// record (last-write-wins per name), run a pure mapping into a typed
// view, surface `undefined` when nothing has been published yet.
//
// Before this helper, that pattern lived as a per-service `groupX`
// closure plus an inline `lastXState = rawX[rawX.length - 1]` line.
// Adding a new service required edits in four places. The helper lifts
// the registry-yield + last-record + optional-map dance; each row of
// the projection table carries only the pure mapping.

import { Context, Effect } from 'effect';
import type { RegistryShape } from './define-registry.js';

/** A service projection declaration — registry tag + pure mapping.
 *
 *  `project` receives the LAST published state record (or `undefined`)
 *  plus a caller-supplied context (cross-cutting inputs like network
 *  identifier or the flat endpoint table). Returns `undefined` to omit
 *  the service from the manifest. */
export interface ServiceProjection<I, TState, TView, TContext> {
	readonly name: string;
	readonly registry: Context.Service<I, RegistryShape<TState>>;
	readonly project: (input: {
		readonly state: TState | undefined;
		readonly ctx: TContext;
	}) => TView | undefined;
}

/** Build the projection's `read` Effect: yield the registry, snapshot
 *  it, take the last record, run `project`. Curried on `TContext` so
 *  the caller pins the shared context shape once; `TState`/`TView`/`I`
 *  still infer from the spec. Returns the spec extended with `read` so
 *  callers either consume `read` directly (single projection) or
 *  `project` + `name` via a table loop. */
export const defineServiceProjection =
	<TContext>() =>
	<I, TState, TView>(
		spec: ServiceProjection<I, TState, TView, TContext>,
	): ServiceProjection<I, TState, TView, TContext> & {
		readonly read: (ctx: TContext) => Effect.Effect<TView | undefined, never, I>;
	} => ({
		...spec,
		read: (ctx) =>
			Effect.gen(function* () {
				const reg = yield* spec.registry;
				const raw = yield* reg.snapshot;
				const state = raw[raw.length - 1];
				return spec.project({ state, ctx });
			}),
	});
