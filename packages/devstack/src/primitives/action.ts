import { Effect } from 'effect';
import { makeTag, type PluginTag } from '../tag.js';

export interface ActionOptions<Name extends string, A, E, R> {
	readonly name: Name;
	readonly run: Effect.Effect<A, E, R>;
	readonly dependsOn?: ReadonlyArray<PluginTag<any, any, any, any>>;
}

export const action = <const Name extends string, A, E = never, R = never>(
	options: ActionOptions<Name, A, E, R>,
) =>
	makeTag(
		options.name,
		Effect.gen(function* () {
			for (const tag of options.dependsOn ?? []) {
				yield* tag;
			}
			return yield* options.run;
		}).pipe(Effect.withSpan(`action(${options.name})`)),
		{
			kind: 'action',
			displayTitle: options.name,
			display: () => ({ title: options.name }),
		},
	);
