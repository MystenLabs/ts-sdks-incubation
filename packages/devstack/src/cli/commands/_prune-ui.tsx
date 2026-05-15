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
// Visual model (deliberately small — see commit 94965e70's predecessor
// for the over-engineered classification-tag version we replaced):
//
//   - Running rows render in dim red with `(running pid N)`. Not
//     selectable; the cursor skips them.
//   - Repo-gone rows (registry recorded a repoPath that no longer
//     exists on disk) render highlighted yellow and are pre-selected
//     on mount. That's the user's most common "clean this up" trigger.
//   - Everything else is a plain row, selectable, no special tag.
//
// Each row surfaces `repoPath` (last 2 path segments) and `lastSeen`
// when the registry has a record — that's the cross-machine
// recognition signal the user wanted ("oh right, that's the wallet
// example I cloned to /tmp last week").

import { Box, Text, useApp, useInput } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import type {
	InventoryRow,
	InventoryTotals,
	RouterInfo,
} from '../../engine/docker/inventory.js';
import {
	formatBytes,
	renderTotals,
	shortRepoPath,
	summarizeContainers,
	totalsFor,
	volumeBytes,
} from '../../engine/docker/inventory.js';

export interface PruneAppProps {
	readonly rows: ReadonlyArray<InventoryRow>;
	/**
	 * Shared Traefik router state, rendered as a separate non-selectable
	 * row above the (app, stack) list. The router is cross-stack
	 * infrastructure; removing it requires `--include-router` from the
	 * non-interactive surface.
	 */
	readonly router?: RouterInfo;
	/** Called with the selected rows after the user confirms. */
	readonly onSubmit: (selected: ReadonlyArray<InventoryRow>) => void;
	/** Called when the user quits without pruning. */
	readonly onQuit: () => void;
}

const rowKey = (r: InventoryRow): string => `${r.app}/${r.stack}`;

// Pre-select every repo-gone row. These are the rows the user almost
// certainly wants to clean up (the recorded `repoPath` no longer
// exists on disk — they `rm -rf`'d the example). Running rows are
// never auto-selected because they aren't selectable at all.
const initialSelection = (rows: ReadonlyArray<InventoryRow>): ReadonlySet<string> => {
	const out = new Set<string>();
	for (const r of rows) {
		if (r.classification === 'repo-gone' && r.runningPid === undefined) {
			out.add(rowKey(r));
		}
	}
	return out;
};

export function PruneApp({
	rows,
	router,
	onSubmit,
	onQuit,
}: PruneAppProps): React.ReactElement {
	const inkApp = useApp();
	const [cursor, setCursor] = useState(0);
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => initialSelection(rows));
	const [confirming, setConfirming] = useState(false);

	// First selectable row by default. If every row is running there's
	// nothing to do; the parent will render a placeholder instead of
	// mounting the picker.
	useEffect(() => {
		const firstSelectable = rows.findIndex((r) => r.runningPid === undefined);
		if (firstSelectable >= 0) setCursor(firstSelectable);
		setSelected(initialSelection(rows));
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
	const selectedTotals: InventoryTotals = useMemo(() => totalsFor(selectedRows), [selectedRows]);
	const orphanTotals = totalsFor(rows.filter(isSelectable));

	return (
		<Box flexDirection="column">
			<Box paddingX={1} borderStyle="round" borderColor="gray">
				<Text bold>devstack prune</Text>
				<Text> · </Text>
				<Text dimColor>
					{rows.length} stack{rows.length === 1 ? '' : 's'},{' '}
					{orphanTotals.bytes > 0
						? `~${formatBytes(orphanTotals.bytes)} reclaimable`
						: 'no volume usage data'}
				</Text>
			</Box>
			{router !== undefined ? (
				<Box flexDirection="column" paddingX={1}>
					<RouterRow router={router} />
				</Box>
			) : null}
			<Box flexDirection="column" paddingX={1}>
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
				<Box paddingX={1} marginTop={1} flexDirection="column">
					<Text>
						Will remove: {selectedRows.length} stack{selectedRows.length === 1 ? '' : 's'} (
						{selectedTotals.containers} containers, {selectedTotals.networks} networks,{' '}
						{selectedTotals.volumes} volumes
						{selectedTotals.bytes > 0 ? ` (~${formatBytes(selectedTotals.bytes)})` : ''}).
					</Text>
					<Text color="yellow">Proceed? [y/N]</Text>
				</Box>
			) : (
				<Box paddingX={1} marginTop={1}>
					<Text dimColor>
						[space] toggle [a] all orphans [n] none [enter] prune selected [q]uit
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
	const detail = `${containers}, ${row.networks.length} net${row.networks.length === 1 ? '' : 's'}, ${row.volumes.length} vol${row.volumes.length === 1 ? '' : 's'}${sized}`;
	const cursor = focused ? '>' : ' ';
	const box = checked ? '[x]' : '[ ]';
	const entry = row.registryEntry;
	const repoSummary =
		entry !== undefined ? shortRepoPath(entry.repoPath) : '(unknown — pre-registry)';
	const lastSeen = entry?.lastSeen ?? '—';
	if (running) {
		return (
			<Box>
				<Text dimColor>
					{cursor} [-] {row.app}/{row.stack}{' '}
				</Text>
				<Text color="red" dimColor>
					(running pid {row.runningPid})
				</Text>
				<Text dimColor> {detail}</Text>
			</Box>
		);
	}
	const repoGone = row.classification === 'repo-gone';
	const labelColor = focused ? 'cyan' : repoGone ? 'yellow' : undefined;
	return (
		<Box>
			<Text color={labelColor} bold={repoGone}>
				{cursor} {box} {row.app}/{row.stack}{' '}
			</Text>
			{repoGone ? (
				<Text color="yellow" bold>
					[repo gone]{' '}
				</Text>
			) : null}
			<Text dimColor>{detail} </Text>
			<Text dimColor>{repoSummary} </Text>
			<Text dimColor>{lastSeen}</Text>
		</Box>
	);
}

// Cross-stack router row — rendered above the (app, stack) list so the
// user can see whether the shared Traefik proxy is live. Not selectable
// because torching it would silently break every running stack; the
// non-interactive `--include-router` flag is the only way to remove it.
function RouterRow({ router }: { readonly router: RouterInfo }): React.ReactElement {
	if (!router.present) {
		return (
			<Box>
				<Text dimColor>  [router] devstack-traefik — not running</Text>
			</Box>
		);
	}
	const stateColor = router.running ? 'green' : 'red';
	const usedBy =
		router.activeBackends === 0
			? 'no active backends'
			: `${router.activeBackends} backend${router.activeBackends === 1 ? '' : 's'} across ${router.apps.length} app${router.apps.length === 1 ? '' : 's'}`;
	return (
		<Box>
			<Text dimColor>  [router] devstack-traefik </Text>
			<Text color={stateColor}>{router.running ? 'running' : 'stopped'}</Text>
			<Text dimColor> — {usedBy} (use --include-router to remove)</Text>
		</Box>
	);
}

// Test-only helper. Returns the keys of every selectable row so the
// `prune.test.ts` suite can assert the "select all orphans" path
// without rendering ink.
export const selectableKeys = (rows: ReadonlyArray<InventoryRow>): ReadonlyArray<string> =>
	rows.filter((r) => r.runningPid === undefined).map(rowKey);

export { renderTotals };
