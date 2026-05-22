import { Box, Text, render, useApp, useInput } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import { Effect } from 'effect';

import {
	defaultPruneSelection,
	groupResourceCountForResources,
	hasPruneResources,
	summarizePruneGroups,
	summarizePruneGroupsForResources,
	type PruneGroup,
	type PruneInventory,
	type PruneResourceScope,
	type PruneTargetSelection,
} from './prune.ts';

export const selectPruneTargets = (
	inventory: PruneInventory,
	resources: PruneResourceScope,
): Effect.Effect<PruneTargetSelection> => {
	if (inventory.groups.length === 0) return Effect.succeed({ groupKeys: [], resources });
	return Effect.callback<PruneTargetSelection>((resume) => {
		const instance = renderPrunePicker({
			inventory,
			resources,
			onSubmit: (selection) => {
				instance.unmount();
				resume(Effect.succeed(selection));
			},
			onQuit: () => {
				instance.unmount();
				resume(Effect.succeed({ groupKeys: [], resources }));
			},
		});
	});
};

const renderPrunePicker = (props: PrunePickerProps) => {
	return render(React.createElement(PrunePicker, props), { exitOnCtrlC: false });
};

interface PrunePickerProps {
	readonly inventory: PruneInventory;
	readonly resources: PruneResourceScope;
	readonly onSubmit: (selection: PruneTargetSelection) => void;
	readonly onQuit: () => void;
}

const PrunePicker = ({
	inventory,
	resources: initialResources,
	onSubmit,
	onQuit,
}: PrunePickerProps): React.JSX.Element => {
	const app = useApp();
	const rows = inventory.groups;
	const [cursor, setCursor] = useState(0);
	const [resources, setResources] = useState<PruneResourceScope>(initialResources);
	const [selected, setSelected] = useState<ReadonlySet<string>>(
		() => new Set(defaultPruneSelection(inventory, initialResources)),
	);
	const [confirming, setConfirming] = useState(false);

	useEffect(() => {
		const first = rows.findIndex((row) => !row.live);
		setCursor(first >= 0 ? first : 0);
		setResources(initialResources);
		setSelected(new Set(defaultPruneSelection(inventory, initialResources)));
	}, [initialResources, inventory, rows]);

	const selectable = (row: PruneGroup): boolean => !row.live;

	const move = (dir: 1 | -1): void => {
		if (rows.length === 0) return;
		let next = cursor;
		for (let i = 0; i < rows.length; i += 1) {
			next = (next + dir + rows.length) % rows.length;
			const row = rows[next];
			if (row !== undefined && selectable(row)) {
				setCursor(next);
				return;
			}
		}
	};

	const toggle = (): void => {
		const row = rows[cursor];
		if (row === undefined || !selectable(row)) return;
		const next = new Set(selected);
		if (next.has(row.key)) next.delete(row.key);
		else next.add(row.key);
		setSelected(next);
	};

	const selectAll = (): void => {
		setSelected(
			new Set(
				rows
					.filter((row) => selectable(row) && groupResourceCountForResources(row, resources) > 0)
					.map((row) => row.key),
			),
		);
	};

	const toggleResource = (name: keyof PruneResourceScope): void => {
		setResources((current) => ({ ...current, [name]: !current[name] }));
	};

	useInput((input, key) => {
		if (confirming) {
			if (input === 'y' || input === 'Y') {
				app.exit();
				onSubmit({ groupKeys: [...selected], resources });
				return;
			}
			if (input === 'n' || input === 'N' || key.escape || key.return) {
				setConfirming(false);
			}
			return;
		}
		if (input === 'q' || input === 'Q' || (key.ctrl && input === 'c')) {
			app.exit();
			onQuit();
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
		if (input === '1') {
			toggleResource('containers');
			return;
		}
		if (input === '2') {
			toggleResource('networks');
			return;
		}
		if (input === '3') {
			toggleResource('volumes');
			return;
		}
		if (input === '4' || input === 'i' || input === 'I') {
			toggleResource('images');
			return;
		}
		if (input === 'a' || input === 'A') {
			selectAll();
			return;
		}
		if (input === 'n' || input === 'N') {
			setSelected(new Set());
			return;
		}
		if (
			key.return &&
			selected.size > 0 &&
			hasPruneResources(resources) &&
			selectedResourceCount(rows, selected, resources) > 0
		) {
			setConfirming(true);
		}
	});

	const selectedRows = useMemo(() => rows.filter((row) => selected.has(row.key)), [rows, selected]);
	const selectedTotals = useMemo(
		() => summarizePruneGroupsForResources(selectedRows, resources),
		[selectedRows, resources],
	);
	const idleTotals = summarizePruneGroupsForResources(
		rows.filter((row) => !row.live),
		resources,
	);
	const allIdleTotals = summarizePruneGroups(rows.filter((row) => !row.live));
	const effectiveSelectedCount =
		selectedTotals.containers +
		selectedTotals.networks +
		selectedTotals.volumes +
		selectedTotals.images;

	return (
		<Box flexDirection="column">
			<Box paddingX={1} borderStyle="round" borderColor="gray">
				<Text bold>devstack prune</Text>
				<Text dimColor>
					{' '}
					{rows.length} group(s), {idleTotals.containers} container(s), {idleTotals.networks}{' '}
					network(s), {idleTotals.volumes} volume(s), {idleTotals.images} image(s)
				</Text>
			</Box>
			<ResourceScopeRow resources={resources} totals={allIdleTotals} />
			<Box flexDirection="column" paddingX={1}>
				{rows.map((row, index) => (
					<PruneRow
						key={row.key}
						row={row}
						resources={resources}
						focused={index === cursor}
						checked={selected.has(row.key)}
					/>
				))}
			</Box>
			{confirming ? (
				<Box paddingX={1} marginTop={1} flexDirection="column">
					<Text>
						Will remove {selectedRows.length} group(s): {selectedTotals.containers} container(s),{' '}
						{selectedTotals.networks} network(s), {selectedTotals.volumes} volume(s),{' '}
						{selectedTotals.images} image(s).
					</Text>
					<Text color="yellow">Proceed? [y/N]</Text>
				</Box>
			) : (
				<Box paddingX={1} marginTop={1} flexDirection="column">
					{!hasPruneResources(resources) ? (
						<Text color="yellow">Enable at least one resource type.</Text>
					) : selected.size > 0 && effectiveSelectedCount === 0 ? (
						<Text color="yellow">Selected groups have no enabled resource types.</Text>
					) : null}
					<Text dimColor>
						[space] toggle row [1-4] resources [a] all [n] none [enter] prune selected [q]uit
					</Text>
				</Box>
			)}
		</Box>
	);
};

const selectedResourceCount = (
	rows: ReadonlyArray<PruneGroup>,
	selected: ReadonlySet<string>,
	resources: PruneResourceScope,
): number =>
	rows
		.filter((row) => selected.has(row.key))
		.reduce((total, row) => total + groupResourceCountForResources(row, resources), 0);

const ResourceScopeRow = ({
	resources,
	totals,
}: {
	readonly resources: PruneResourceScope;
	readonly totals: ReturnType<typeof summarizePruneGroups>;
}): React.JSX.Element => (
	<Box paddingX={1}>
		<Text dimColor>resources </Text>
		<ResourceToggle
			active={resources.containers}
			index="1"
			label="containers"
			count={totals.containers}
		/>
		<Text> </Text>
		<ResourceToggle
			active={resources.networks}
			index="2"
			label="networks"
			count={totals.networks}
		/>
		<Text> </Text>
		<ResourceToggle active={resources.volumes} index="3" label="volumes" count={totals.volumes} />
		<Text> </Text>
		<ResourceToggle active={resources.images} index="4" label="images" count={totals.images} />
	</Box>
);

const ResourceToggle = ({
	active,
	index,
	label,
	count,
}: {
	readonly active: boolean;
	readonly index: string;
	readonly label: string;
	readonly count: number;
}): React.JSX.Element => (
	<Text color={active ? 'green' : 'gray'}>
		{index}:{active ? '[x]' : '[ ]'} {label}({count})
	</Text>
);

const PruneRow = ({
	row,
	resources,
	focused,
	checked,
}: {
	readonly row: PruneGroup;
	readonly resources: PruneResourceScope;
	readonly focused: boolean;
	readonly checked: boolean;
}): React.JSX.Element => {
	const cursor = focused ? '>' : ' ';
	const box = row.live ? '[-]' : checked ? '[x]' : '[ ]';
	const state = row.live ? `live pid ${row.livePids.join(',')}` : row.shared ? 'shared' : 'idle';
	const color = row.live ? 'red' : focused ? 'cyan' : row.shared ? 'yellow' : undefined;
	const running = row.runningContainers > 0 ? `, ${row.runningContainers} running` : '';
	return (
		<Box>
			<Text color={color} bold={focused || row.shared}>
				{cursor} {box} {row.app}/{row.stack}{' '}
			</Text>
			<Text dimColor>
				{state}
				{running}{' '}
			</Text>
			<ResourceCount active={resources.containers} count={row.containers} label="ctr" />
			<Text dimColor>, </Text>
			<ResourceCount active={resources.networks} count={row.networks} label="net" />
			<Text dimColor>, </Text>
			<ResourceCount active={resources.volumes} count={row.volumes} label="vol" />
			<Text dimColor>, </Text>
			<ResourceCount active={resources.images} count={row.images} label="img" />
		</Box>
	);
};

const ResourceCount = ({
	active,
	count,
	label,
}: {
	readonly active: boolean;
	readonly count: number;
	readonly label: string;
}): React.JSX.Element => (
	<Text color={active ? undefined : 'gray'}>
		{count} {label}
	</Text>
);
