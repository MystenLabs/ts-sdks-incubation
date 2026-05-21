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
//                             second handled SIGINT/SIGTERM as
//                             'shutdown.hardKillRequested' — the
//                             renderer does not own that logic)
//   s | S                  -> 'snapshot.capture'
//   up/down | j/k          -> local row focus movement
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
	/** Move local row focus without touching the engine. */
	readonly onMoveSelection?: (delta: -1 | 1) => void;
	/** Disable input handling (e.g. shutting-down state); defaults
	 *  to false. */
	readonly disabled?: boolean;
}

/**
 * Renderless component — mounts `useInput` at the dashboard root.
 * Returns `null` so it composes inside layout boxes without taking
 * up space.
 */
export const commandForKey = (input: string, ctrl: boolean): EngineCommand | null => {
	if (ctrl && input === 'c') return { tag: 'shutdown.requested' };
	switch (input) {
		case 'q':
		case 'Q':
			return { tag: 'shutdown.requested' };
		case 'r':
		case 'R':
			return { tag: 'stack.restart' };
		case 's':
		case 'S':
			return { tag: 'snapshot.capture' };
		default:
			return null;
	}
};

export const selectionDeltaForKey = (
	input: string,
	key: { readonly upArrow?: boolean; readonly downArrow?: boolean },
): -1 | 1 | null => {
	if (key.upArrow === true || input === 'k' || input === 'K') return -1;
	if (key.downArrow === true || input === 'j' || input === 'J') return 1;
	return null;
};

export const InputHandler = ({
	publish,
	onMoveSelection,
	disabled = false,
}: InputHandlerProps): null => {
	useInput(
		(input, key) => {
			if (disabled) return;
			const move = selectionDeltaForKey(input, key);
			if (move !== null) {
				onMoveSelection?.(move);
				return;
			}
			const command = commandForKey(input, key.ctrl);
			if (command !== null) publish(command);
		},
		{ isActive: !disabled },
	);
	return null;
};
