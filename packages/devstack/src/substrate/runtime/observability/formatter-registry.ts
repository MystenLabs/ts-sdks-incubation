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

import { Context, Effect, Layer, Scope } from 'effect';

import type { PluginErrorContribution } from '../../plugin.ts';
import { makeScopedMultimap } from '../scoped-registry/index.ts';
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
}

export class FormatterRegistryService extends Context.Service<
	FormatterRegistryService,
	FormatterRegistryShape
>()('@devstack/substrate/FormatterRegistry') {}

/** Layer constructing the per-stack formatter registry. Stateful;
 *  the substrate provides one per supervisor scope.
 *
 *  Storage is the shared scoped-registry multimap surface keyed by tag.
 *  The per-entry
 *  value is the (optional) formatter — the registry may track a tag
 *  with NO formatter (default rendering is enough), so `null` is a
 *  legitimate value and the seq still tracks the registration. */
export const layerFormatterRegistry: Layer.Layer<FormatterRegistryService> = Layer.effect(
	FormatterRegistryService,
	Effect.gen(function* () {
		const store = yield* makeScopedMultimap<string, TagFormatter | null>();

		const register = (
			contribution: PluginErrorContribution,
		): Effect.Effect<void, never, Scope.Scope> =>
			Effect.gen(function* () {
				// Wrap the optional formatter so the cascade-formatter's
				// `TagFormatter` shape is consistent regardless of whether
				// the plugin provided one.
				const fmt: TagFormatter | null =
					contribution.formatter !== undefined
						? (value, recurse) => contribution.formatter!(value, recurse)
						: null;
				// One entry per declared tag, all sharing the multimap's
				// seq + finalizer — parallel plugin registrations stay
				// isolated and only drop what they added.
				yield* store.register(contribution.errorTags.map((tag) => ({ key: tag, value: fmt })));
			});

		const snapshot: Effect.Effect<FormatterRegistry> = Effect.gen(function* () {
			const current = yield* store.snapshot;
			if (current.size === 0) return emptyFormatterRegistry;
			const out = new Map<string, TagFormatter>();
			for (const [tag, entries] of current) {
				// Last registration wins on the formatter slot — a tag
				// registered without a custom formatter is dropped from the
				// snapshot (the cascade-formatter falls back to default
				// rendering for it).
				let chosen: TagFormatter | null = null;
				let chosenSeq = -1;
				for (const e of entries) {
					if (e.value !== null && e.seq > chosenSeq) {
						chosen = e.value;
						chosenSeq = e.seq;
					}
				}
				if (chosen !== null) out.set(tag, chosen);
			}
			return out as FormatterRegistry;
		});

		return FormatterRegistryService.of({ register, snapshot });
	}),
);
