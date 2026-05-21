// Keyboard input handler.
//
// HARD INVARIANT (distilled/21-tui § Learnings #3): keypress handlers
// MUST NOT call engine methods directly. They publish typed
// `EngineCommand` values onto a `CommandPublisher` callback the
// surface receives at mount time. The engine consumes the channel on
// the other end; the renderer has no awareness of supervisor
// internals like Deferred / Queue / scope structure.
//
// Key map (architecture §11 + distilled/21-tui §Responsibilities):
//
//   q | Q                  -> 'shutdown.requested'
//   r | R                  -> 'stack.restart'
//   ctrl-c                 -> 'shutdown.requested' (additionally, the
//                             supervisor's signal handler counts the
//                             second hit toward hard-kill — the
//                             renderer does not own that logic)
//   s | S                  -> 'snapshot.capture'
//   (future) k             -> 'selective-restart.requested' (needs a
//                             row-selection UI; out of scope for v1)
//
// Defensive: useInput is mounted at the dashboard root level, NOT in
// per-row components, so a re-rendered row never re-registers a
// handler.

import { useInput } from 'ink';

import type { EngineCommand } from '../../substrate/events.ts';

/**
 * Command publisher. A pure callback the renderer invokes with a
 * typed `EngineCommand`. The surface layer wires this to whatever
 * channel the engine is consuming on (Effect Queue, EventEmitter,
 * etc.); the renderer doesn't care.
 */
export type CommandPublisher = (command: EngineCommand) => void;

export interface InputHandlerProps {
	/** Publish a typed EngineCommand. */
	readonly publish: CommandPublisher;
	/** Disable input handling (e.g. shutting-down state); defaults
	 *  to false. */
	readonly disabled?: boolean;
}

/**
 * Renderless component — mounts `useInput` at the dashboard root.
 * Returns `null` so it composes inside layout boxes without taking
 * up space.
 */
export const InputHandler = ({ publish, disabled = false }: InputHandlerProps): null => {
	useInput(
		(input, key) => {
			if (disabled) return;
			if (key.ctrl && input === 'c') {
				publish({ tag: 'shutdown.requested' });
				return;
			}
			switch (input) {
				case 'q':
				case 'Q':
					publish({ tag: 'shutdown.requested' });
					return;
				case 'r':
				case 'R':
					publish({ tag: 'stack.restart' });
					return;
				case 's':
				case 'S':
					publish({ tag: 'snapshot.capture' });
					return;
				default:
					return;
			}
		},
		{ isActive: !disabled },
	);
	return null;
};
