import { Context, Effect, Option } from 'effect';

import type { PluginKey } from '../brand.ts';
import type { PhaseNarration } from '../lifecycle.ts';

/** Acquire-time identity for the plugin currently being supervised.
 *
 * Plugins that stream host-process output need the supervisor-minted
 * row key so logger lines publish as `log.appended` events for the
 * correct projection row. */
export interface CurrentPluginKeyShape {
	readonly key: PluginKey;
}

export class CurrentPluginKey extends Context.Service<CurrentPluginKey, CurrentPluginKeyShape>()(
	'@devstack/substrate/CurrentPluginKey',
) {}

export interface CurrentPluginProgressShape {
	readonly setPhase: (phase: PhaseNarration | null) => Effect.Effect<void>;
}

export class CurrentPluginProgress extends Context.Service<
	CurrentPluginProgress,
	CurrentPluginProgressShape
>()('@devstack/substrate/CurrentPluginProgress') {}

/** Publish acquire-time row narration for the currently supervised
 * plugin. Safe to call from plugin code: if the caller is running
 * outside a supervisor, the helper is a no-op. */
export const setCurrentPluginPhase = (phase: PhaseNarration | null): Effect.Effect<void> =>
	Effect.gen(function* () {
		const progress = yield* Effect.serviceOption(CurrentPluginProgress);
		if (Option.isSome(progress)) {
			yield* progress.value.setPhase(phase);
		}
	});
