// Ink picker for `devstack prune --interactive`. Mounted from
// `prune.ts` when running with a TTY.
//
// Keyboard contract:
//   ↑/↓ or k/j     move cursor between selectable (non-running) rows
//   space          toggle selection on the current row
//   a              select every orphan (non-running) row
//   n              clear selection
//   enter          confirm and prune the selected rows
//   q or Ctrl-C    quit without pruning
//
// Running rows render in dim red and are NOT selectable — pruning a
// stack whose supervisor is alive would yank the rug from a live
// dev-loop's docker resources. Operator must `q` and stop the
// supervisor first.

import { Box, Text, useApp, useInput } from 'ink';
import React, { useEffect, useState } from 'react';
import type {
	InventoryRow,
	InventoryTotals,
} from '../../internal/docker/inventory.js';
import {
	formatBytes,
	renderTotals,
	summarizeContainers,
	totalsFor,
	volumeBytes,
} from '../../internal/docker/inventory.js';

export interface PruneAppProps {
	readonly rows: ReadonlyArray<InventoryRow>;
	/** Called with the selected rows after the user confirms. */
	readonly onSubmit: (selected: ReadonlyArray<InventoryRow>) => void;
	/** Called when the user quits without pruning. */
	readonly onQuit: () => void;
}

const rowKey = (r: InventoryRow): string => `${r.app}/${r.stack}`;

export function PruneApp({ rows, onSubmit, onQuit }: PruneAppProps): React.ReactElement {
	const inkApp = useApp();
	const [cursor, setCursor] = useState(0);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [confirming, setConfirming] = useState(false);

	// First selectable row by default. If every row is running there's
	// nothing to do; the parent will render a placeholder instead of
	// mounting the picker.
	useEffect(() => {
		const firstSelectable = rows.findIndex((r) => r.runningPid === undefined);
		if (firstSelectable >= 0) setCursor(firstSelectable);
	}, [rows]);

	const isSelectable = (r: InventoryRow): boolean => r.runningPid === undefined;

	const moveCursor = (dir: 1 | -1): void => {
		if (rows.length === 0) return;
		let i = cursor;
		for (let step = 0; step < rows.length; step += 1) {
			i = (i + dir + rows.length) % rows.length;
			const row = rows[i];
			if (row !== undefined && isSelectable(row)) {
				setCursor(i);
				return;
			}
		}
	};

	const toggle = (): void => {
		const row = rows[cursor];
		if (row === undefined || !isSelectable(row)) return;
		const key = rowKey(row);
		const next = new Set(selected);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		setSelected(next);
	};

	const selectAll = (): void => {
		const next = new Set<string>();
		for (const r of rows) {
			if (isSelectable(r)) next.add(rowKey(r));
		}
		setSelected(next);
	};

	const clear = (): void => setSelected(new Set());

	useInput((input, key) => {
		if (confirming) {
			if (input === 'y' || input === 'Y') {
				const out = rows.filter((r) => selected.has(rowKey(r)));
				inkApp.exit();
				onSubmit(out);
				return;
			}
			// Any other key cancels confirmation and returns to the list.
			if (input === 'n' || input === 'N' || key.return || key.escape) {
				setConfirming(false);
				return;
			}
			return;
		}
		if (input === 'q' || input === 'Q' || (key.ctrl && input === 'c')) {
			inkApp.exit();
			onQuit();
			return;
		}
		if (key.upArrow || input === 'k') {
			moveCursor(-1);
			return;
		}
		if (key.downArrow || input === 'j') {
			moveCursor(1);
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
			clear();
			return;
		}
		if (key.return) {
			if (selected.size === 0) return;
			setConfirming(true);
			return;
		}
	});

	const selectedRows = rows.filter((r) => selected.has(rowKey(r)));
	const selectedTotals: InventoryTotals = totalsFor(selectedRows);
	const orphanTotals = totalsFor(rows.filter(isSelectable));

	return (
		<Box flexDirection='column'>
			<Box paddingX={1} borderStyle='round' borderColor='gray'>
				<Text bold>devstack prune</Text>
				<Text> · </Text>
				<Text dimColor>
					{rows.length} stack{rows.length === 1 ? '' : 's'}, {orphanTotals.bytes > 0
						? `~${formatBytes(orphanTotals.bytes)} reclaimable`
						: 'no volume usage data'}
				</Text>
			</Box>
			<Box flexDirection='column' paddingX={1}>
				{rows.map((row, i) => (
					<PruneRow
						key={rowKey(row)}
						row={row}
						focused={i === cursor}
						checked={selected.has(rowKey(row))}
					/>
				))}
			</Box>
			{confirming ? (
				<Box paddingX={1} marginTop={1} flexDirection='column'>
					<Text>
						About to remove: {selectedTotals.containers} containers,{' '}
						{selectedTotals.networks} networks, {selectedTotals.volumes} volumes
						{selectedTotals.bytes > 0
							? ` (~${formatBytes(selectedTotals.bytes)} reclaimed)`
							: ''}{' '}
						across {selectedRows.length} stack
						{selectedRows.length === 1 ? '' : 's'}.
					</Text>
					<Text color='yellow'>Proceed? [y/N]</Text>
				</Box>
			) : (
				<Box paddingX={1} marginTop={1}>
					<Text dimColor>
						[space] toggle  [a] all orphans  [n] none  [enter] prune selected  [q]uit
					</Text>
				</Box>
			)}
		</Box>
	);
}

function PruneRow({
	row,
	focused,
	checked,
}: {
	readonly row: InventoryRow;
	readonly focused: boolean;
	readonly checked: boolean;
}): React.ReactElement {
	const running = row.runningPid !== undefined;
	const bytes = volumeBytes(row);
	const sized = bytes > 0 ? ` (~${formatBytes(bytes)})` : '';
	const containers = summarizeContainers(row);
	const detail = `${containers}, ${row.networks.length} net${row.networks.length === 1 ? '' : 's'}, ${row.volumes.length} vol${row.volumes.length === 1 ? '' : 's'}${sized}, ${row.stateDirs.length > 0 ? 'state present' : 'no state'}`;
	const cursor = focused ? '>' : ' ';
	const box = checked ? '[x]' : '[ ]';
	if (running) {
		return (
			<Box>
				<Text dimColor>
					{cursor} [-] {row.app}/{row.stack}{' '}
				</Text>
				<Text color='red' dimColor>
					(running pid {row.runningPid})
				</Text>
				<Text dimColor>  {detail}</Text>
			</Box>
		);
	}
	return (
		<Box>
			<Text color={focused ? 'cyan' : undefined}>
				{cursor} {box} {row.app}/{row.stack}
			</Text>
			<Text dimColor>  {detail}</Text>
		</Box>
	);
}

// Test-only helper. Returns the keys of every selectable row so the
// `prune.test.ts` suite can assert the "select all orphans" path
// without rendering ink.
export const selectableKeys = (rows: ReadonlyArray<InventoryRow>): ReadonlyArray<string> =>
	rows.filter((r) => r.runningPid === undefined).map(rowKey);

export { renderTotals };
