// Formatter registry service.
//
// Architecture § L0 Observability: the cascade formatter consults a
// per-tag `FormatterRegistry` for custom renderers. The registry is
// substrate-owned and populated by the supervisor's harvest loop from
// each acquired plugin's `errorContributions` field. The substrate
// stays name-blind: it dispatches on `_tag` strings the plugins
// declare, never on plugin identifiers.
//
// Two surfaces:
//   - `register(contribution)` — adds tags + optional formatter for a
//     single `PluginErrorContribution`. Idempotent on the tag set
//     when no formatter is provided; last-write-wins on the formatter
//     slot when one is.
//   - `snapshot()` — returns an immutable `FormatterRegistry` the
//     cascade formatter consumes.
//
// Scope-bound: callers `register` inside a plugin's scope so the
// contribution dies with the plugin (selective restart, shutdown).
// The supervisor uses `Effect.addFinalizer` at the dispatch site;
// this service exposes the unregister side as a complement.

import { Context, Effect, Layer, Ref, Scope } from 'effect';

import type { PluginErrorContribution } from '../../plugin.ts';
import {
	emptyFormatterRegistry,
	type FormatterRegistry,
	type TagFormatter,
} from './cascade-formatter.ts';

/** Public shape of the formatter-registry service. */
export interface FormatterRegistryShape {
	/** Register a plugin's contribution. Scope-bound: the contribution
	 *  is reaped when the surrounding `Scope` closes. The supervisor
	 *  calls this inside each plugin's scope so selective-restart
	 *  cleans up the plugin's formatters automatically. */
	readonly register: (
		contribution: PluginErrorContribution,
	) => Effect.Effect<void, never, Scope.Scope>;
	/** Snapshot the live registry as an immutable `FormatterRegistry`
	 *  the cascade formatter consumes. */
	readonly snapshot: Effect.Effect<FormatterRegistry>;
	/** Diagnostic: list every tag the registry currently tracks. */
	readonly tags: Effect.Effect<ReadonlyArray<string>>;
}

export class FormatterRegistryService extends Context.Service<
	FormatterRegistryService,
	FormatterRegistryShape
>()('@devstack-rewrite/substrate/FormatterRegistry') {}

/** Per-tag entry. The registry may track a tag with no formatter
 *  (default rendering is enough) — that's why `formatter` is
 *  optional. We keep a sequence number so multi-plugin registrations
 *  for the same tag can dedup deterministically on scope close. */
interface Entry {
	readonly tag: string;
	readonly formatter: TagFormatter | null;
	readonly seq: number;
}

type State = ReadonlyMap<string, ReadonlyArray<Entry>>;

/** Layer constructing the per-stack formatter registry. Stateful;
 *  the substrate provides one per supervisor scope. */
export const layerFormatterRegistry: Layer.Layer<FormatterRegistryService> = Layer.effect(
	FormatterRegistryService,
	Effect.gen(function* () {
		const state = yield* Ref.make<State>(new Map());
		const seqRef = yield* Ref.make(0);

		const register = (
			contribution: PluginErrorContribution,
		): Effect.Effect<void, never, Scope.Scope> =>
			Effect.gen(function* () {
				const baseSeq = yield* Ref.updateAndGet(seqRef, (n) => n + 1);
				// Wrap the optional formatter so the cascade-formatter's
				// `TagFormatter` shape is consistent regardless of whether
				// the plugin provided one.
				const fmt: TagFormatter | null =
					contribution.formatter !== undefined
						? (value, recurse) => contribution.formatter!(value, recurse)
						: null;
				const newEntries: ReadonlyArray<Entry> = contribution.errorTags.map((tag) => ({
					tag,
					formatter: fmt,
					seq: baseSeq,
				}));
				yield* Ref.update(state, (current) => {
					const next = new Map(current);
					for (const e of newEntries) {
						const existing = next.get(e.tag) ?? [];
						next.set(e.tag, [...existing, e]);
					}
					return next;
				});
				// Scope finalizer: drop these entries on scope close.
				// Sequence-number match keeps parallel plugin
				// registrations isolated — we only drop the entries this
				// registration added.
				yield* Effect.addFinalizer((_exit) =>
					Ref.update(state, (current) => {
						const next = new Map(current);
						for (const e of newEntries) {
							const existing = next.get(e.tag);
							if (!existing) continue;
							const filtered = existing.filter((x) => x.seq !== e.seq);
							if (filtered.length === 0) next.delete(e.tag);
							else next.set(e.tag, filtered);
						}
						return next;
					}),
				);
			}).pipe(Effect.withSpan('substrate.formatterRegistry.register'));

		const snapshot: Effect.Effect<FormatterRegistry> = Effect.gen(function* () {
			const current = yield* Ref.get(state);
			if (current.size === 0) return emptyFormatterRegistry;
			const out = new Map<string, TagFormatter>();
			for (const [tag, entries] of current) {
				// Last registration wins on the formatter slot — tags
				// without a custom formatter are still tracked so callers
				// can introspect via `tags()` even when no override is
				// registered.
				let chosen: TagFormatter | null = null;
				let chosenSeq = -1;
				for (const e of entries) {
					if (e.formatter !== null && e.seq > chosenSeq) {
						chosen = e.formatter;
						chosenSeq = e.seq;
					}
				}
				if (chosen !== null) out.set(tag, chosen);
			}
			return out as FormatterRegistry;
		});

		const tags: Effect.Effect<ReadonlyArray<string>> = Effect.gen(function* () {
			const current = yield* Ref.get(state);
			return [...current.keys()];
		});

		return FormatterRegistryService.of({ register, snapshot, tags });
	}),
);
