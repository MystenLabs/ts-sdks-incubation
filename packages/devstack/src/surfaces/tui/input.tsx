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
//   ctrl-c                 -> first press 'shutdown.requested'; repeat
//                             press escalates to
//                             'shutdown.hardKillRequested'. Ink handles
//                             Ctrl-C in-process when `exitOnCtrlC:
//                             false`, so this mirrors the process-level
//                             signal handler for TTY users.
//   s | S                  -> 'snapshot.capture'
//
// Defensive: useInput is mounted at the dashboard root level, NOT in
// per-row components, so a re-rendered row never re-registers a
// handler.

import { useInput } from 'ink';
import { useRef } from 'react';

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

export interface CommandForKeyOptions {
	readonly shutdownAlreadyRequested?: boolean;
	readonly now?: () => number;
}

/**
 * Renderless component — mounts `useInput` at the dashboard root.
 * Returns `null` so it composes inside layout boxes without taking
 * up space.
 */
export const commandForKey = (
	input: string,
	ctrl: boolean,
	options: CommandForKeyOptions = {},
): EngineCommand | null => {
	if (ctrl && input === 'c') {
		if (options.shutdownAlreadyRequested === true) {
			return {
				tag: 'shutdown.hardKillRequested',
				signal: 'SIGINT',
				exitCode: 130,
				at: options.now?.() ?? Date.now(),
			};
		}
		return { tag: 'shutdown.requested' };
	}
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

export const InputHandler = ({ publish, disabled = false }: InputHandlerProps): null => {
	const shutdownRequested = useRef(false);
	useInput(
		(input, key) => {
			if (disabled) return;
			const command = commandForKey(input, key.ctrl, {
				shutdownAlreadyRequested: shutdownRequested.current,
			});
			if (command !== null) {
				if (command.tag === 'shutdown.requested' || command.tag === 'shutdown.hardKillRequested') {
					shutdownRequested.current = true;
				}
				publish(command);
			}
		},
		{ isActive: !disabled },
	);
	return null;
};
