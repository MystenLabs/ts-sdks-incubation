// Ink mount helper.
//
// Owns the `<App/>` JSX expression so `index.ts` stays a plain `.ts`
// file (no JSX). Lazy-imported from `index.ts` only when the `ink`
// mode is selected, so CI / non-TTY callers don't pay the ink+react
// import cost.
//
// The mount itself awaits `instance.waitUntilExit()` so the surface's
// mount Effect remains open until the user exits the ink app or the
// supervisor finalizes the scope.

import { Effect, Scope, Stream, SubscriptionRef } from 'effect';
import { render } from 'ink';

import type { EngineCommand, EngineEvent } from '../../substrate/events.ts';
import type { SubscribableState } from '../../substrate/projection.ts';
import { App } from './app.tsx';
import { mountFailed, type RendererError } from './errors.ts';

export interface MountInkAppInput {
	readonly stateRef: SubscriptionRef.SubscriptionRef<SubscribableState>;
	readonly events: Stream.Stream<EngineEvent, never>;
	readonly publishCommand: (command: EngineCommand) => void;
}

export const INK_RENDER_OPTIONS = {
	exitOnCtrlC: false,
	patchConsole: true,
} as const;

export const mountInkApp = (
	input: MountInkAppInput,
): Effect.Effect<void, RendererError, Scope.Scope> =>
	Effect.gen(function* () {
		const instance = yield* Effect.try({
			try: () =>
				render(
					<App stateRef={input.stateRef} events={input.events} publish={input.publishCommand} />,
					INK_RENDER_OPTIONS,
				),
			catch: (cause) => mountFailed(cause instanceof Error ? cause.message : String(cause)),
		});

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				instance.unmount();
			}),
		);

		yield* Effect.tryPromise({
			try: () => instance.waitUntilExit(),
			catch: (cause) =>
				mountFailed(
					`ink waitUntilExit failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				),
		});
	});
