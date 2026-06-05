import { Box, Text, render, useApp, useInput } from 'ink';
import React, { useMemo, useState } from 'react';

import type { PluginId } from './plugin-manifest.js';

interface PluginPickerChoice {
	readonly id: PluginId;
	readonly label: string;
	readonly hint: string;
	readonly locked?: boolean;
}

export const promptPlugins = (
	choices: ReadonlyArray<PluginPickerChoice>,
): Promise<Set<PluginId> | undefined> =>
	new Promise((resolve) => {
		let instance: ReturnType<typeof render> | undefined;
		let settled = false;
		const finish = (selection: Set<PluginId> | undefined): void => {
			if (settled) return;
			settled = true;
			instance?.unmount();
			resolve(selection);
		};
		instance = render(
			React.createElement(PluginPicker, {
				choices,
				onSubmit: (selection) => finish(selection),
				onCancel: () => finish(undefined),
			}),
			{ exitOnCtrlC: false },
		);
	});

interface PluginPickerProps {
	readonly choices: ReadonlyArray<PluginPickerChoice>;
	readonly onSubmit: (selection: Set<PluginId>) => void;
	readonly onCancel: () => void;
}

const firstSelectable = (choices: ReadonlyArray<PluginPickerChoice>): number => {
	const index = choices.findIndex((choice) => choice.locked !== true);
	return index >= 0 ? index : 0;
};

const PluginPicker = ({ choices, onSubmit, onCancel }: PluginPickerProps): React.JSX.Element => {
	const app = useApp();
	const [cursor, setCursor] = useState(() => firstSelectable(choices));
	const [selected, setSelected] = useState<ReadonlySet<PluginId>>(
		() => new Set(choices.map((choice) => choice.id)),
	);

	const lockedIds = useMemo(
		() => new Set(choices.filter((choice) => choice.locked === true).map((choice) => choice.id)),
		[choices],
	);

	const selectable = (choice: PluginPickerChoice | undefined): choice is PluginPickerChoice =>
		choice !== undefined && choice.locked !== true;

	const move = (dir: 1 | -1): void => {
		if (choices.length === 0) return;
		let next = cursor;
		for (let i = 0; i < choices.length; i += 1) {
			next = (next + dir + choices.length) % choices.length;
			if (selectable(choices[next])) {
				setCursor(next);
				return;
			}
		}
	};

	const withLocked = (next: Set<PluginId>): Set<PluginId> => {
		for (const id of lockedIds) next.add(id);
		return next;
	};

	const toggle = (): void => {
		const choice = choices[cursor];
		if (!selectable(choice)) return;
		const id = choice.id;
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return withLocked(next);
		});
	};

	const selectAll = (): void => {
		setSelected(new Set(choices.map((choice) => choice.id)));
	};

	const selectNone = (): void => {
		setSelected(new Set(lockedIds));
	};

	const submit = (): void => {
		app.exit();
		onSubmit(withLocked(new Set(selected)));
	};

	const cancel = (): void => {
		app.exit();
		onCancel();
	};

	useInput((input, key) => {
		if (input === 'q' || input === 'Q' || key.escape || (key.ctrl && input === 'c')) {
			cancel();
			return;
		}
		if (key.upArrow || input === 'k') {
			move(-1);
			return;
		}
		if (key.downArrow || input === 'j') {
			move(1);
			return;
		}
		if (input === ' ') {
			toggle();
			return;
		}
		if (input === 'a' || input === 'A') {
			selectAll();
			return;
		}
		if (input === 'n' || input === 'N') {
			selectNone();
			return;
		}
		if (key.return) submit();
	});

	return (
		<Box flexDirection="column">
			<Box paddingX={1} borderStyle="round" borderColor="gray">
				<Text bold>create-devstack-app</Text>
				<Text dimColor> choose demo panels</Text>
			</Box>
			<Box flexDirection="column" paddingX={1}>
				{choices.map((choice, index) => (
					<PluginRow
						key={choice.id}
						choice={choice}
						checked={selected.has(choice.id)}
						focused={index === cursor}
					/>
				))}
			</Box>
			<Box paddingX={1} marginTop={1} flexDirection="column">
				<Text dimColor>[space] toggle [a] all [n] none [enter] create [q]uit</Text>
			</Box>
		</Box>
	);
};

const PluginRow = ({
	choice,
	checked,
	focused,
}: {
	readonly choice: PluginPickerChoice;
	readonly checked: boolean;
	readonly focused: boolean;
}): React.JSX.Element => {
	const cursor = focused ? '>' : ' ';
	const box = choice.locked === true ? '[-]' : checked ? '[x]' : '[ ]';
	const color = choice.locked === true ? 'gray' : focused ? 'cyan' : undefined;
	const suffix = choice.locked === true ? ' always included' : choice.hint;
	return (
		<Box>
			<Text color={color} bold={focused && choice.locked !== true}>
				{cursor} {box} {choice.label}{' '}
			</Text>
			<Text dimColor>{suffix}</Text>
		</Box>
	);
};
