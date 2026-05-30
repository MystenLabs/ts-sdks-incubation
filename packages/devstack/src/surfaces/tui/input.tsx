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
//   s | S                  -> open snapshot-name prompt
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
	/** `null` means normal keymap mode; string means snapshot-name prompt mode. */
	readonly snapshotPromptValue: string | null;
	/** Update the snapshot prompt. Pass `null` to close it. */
	readonly onSnapshotPromptChange: (value: string | null) => void;
	/** Disable input handling (e.g. shutting-down state); defaults
	 *  to false. */
	readonly disabled?: boolean;
}

export interface CommandForKeyOptions {
	readonly shutdownAlreadyRequested?: boolean;
	readonly now?: () => number;
}

export interface InputActionForKeyOptions extends CommandForKeyOptions {
	readonly snapshotPromptValue?: string | null;
}

interface KeyFlags {
	readonly ctrl?: boolean;
	readonly return?: boolean;
	readonly escape?: boolean;
	readonly backspace?: boolean;
	readonly delete?: boolean;
}

export type InputAction =
	| { readonly tag: 'publish'; readonly command: EngineCommand }
	| { readonly tag: 'snapshotPrompt.open' }
	| { readonly tag: 'snapshotPrompt.update'; readonly value: string }
	| { readonly tag: 'snapshotPrompt.cancel' };

const MAX_SNAPSHOT_NAME_LENGTH = 128;

const isPrintableSnapshotNameCharacter = (character: string): boolean => {
	const codePoint = character.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f;
};

const printableSnapshotNameInput = (input: string): string =>
	Array.from(input)
		.filter(isPrintableSnapshotNameCharacter)
		.join('')
		.slice(0, MAX_SNAPSHOT_NAME_LENGTH);

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
		default:
			return null;
	}
};

export const inputActionForKey = (
	input: string,
	key: KeyFlags,
	options: InputActionForKeyOptions = {},
): InputAction | null => {
	if (options.snapshotPromptValue !== null && options.snapshotPromptValue !== undefined) {
		if (key.ctrl === true && input === 'c') {
			const command = commandForKey(input, true, options);
			return command === null ? null : { tag: 'publish', command };
		}
		if (key.escape === true) return { tag: 'snapshotPrompt.cancel' };
		if (key.return === true) {
			const name = options.snapshotPromptValue.trim();
			return {
				tag: 'publish',
				command:
					name.length === 0 ? { tag: 'snapshot.capture' } : { tag: 'snapshot.capture', name },
			};
		}
		if (key.backspace === true || key.delete === true) {
			return {
				tag: 'snapshotPrompt.update',
				value: options.snapshotPromptValue.slice(0, -1),
			};
		}
		if (key.ctrl === true) return null;
		const printable = printableSnapshotNameInput(input);
		if (printable.length === 0) return null;
		return {
			tag: 'snapshotPrompt.update',
			value: `${options.snapshotPromptValue}${printable}`.slice(0, MAX_SNAPSHOT_NAME_LENGTH),
		};
	}

	if (input === 's' || input === 'S') return { tag: 'snapshotPrompt.open' };
	const command = commandForKey(input, key.ctrl === true, options);
	return command === null ? null : { tag: 'publish', command };
};

export const InputHandler = ({
	publish,
	snapshotPromptValue,
	onSnapshotPromptChange,
	disabled = false,
}: InputHandlerProps): null => {
	const shutdownRequested = useRef(false);
	useInput(
		(input, key) => {
			if (disabled) return;
			const action = inputActionForKey(input, key, {
				snapshotPromptValue,
				shutdownAlreadyRequested: shutdownRequested.current,
			});
			switch (action?.tag) {
				case 'publish': {
					const { command } = action;
					if (
						command.tag === 'shutdown.requested' ||
						command.tag === 'shutdown.hardKillRequested'
					) {
						onSnapshotPromptChange(null);
						shutdownRequested.current = true;
					}
					if (command.tag === 'snapshot.capture') {
						onSnapshotPromptChange(null);
					}
					publish(command);
					break;
				}
				case 'snapshotPrompt.open':
					onSnapshotPromptChange('');
					break;
				case 'snapshotPrompt.update':
					onSnapshotPromptChange(action.value);
					break;
				case 'snapshotPrompt.cancel':
					onSnapshotPromptChange(null);
					break;
				default:
					break;
			}
		},
		{ isActive: !disabled },
	);
	return null;
};
