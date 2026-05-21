// Per-plugin log tail pane.
//
// Reads `row.logTail` from the projection. The projection reducer
// already caps the buffer at MAX_ROW_LOG_LINES; this pane just
// renders.
//
// Promoted-level coloring: a log tail that has ever seen an ERROR or
// WARN line carries `level: 'error' | 'warn'` (promoted by the
// reducer); we tint accordingly.

import { Box, Text } from 'ink';
import type React from 'react';

import type { Row } from '../../substrate/projection.ts';
import { labelForRow } from './display-derivation.ts';

export interface LogPaneProps {
	readonly row: Row;
	/** Tail length cap for display (smaller than the buffer cap so
	 *  the pane stays compact). Default 10. */
	readonly tailLines?: number;
}

const colorForLevel = (level: 'info' | 'warn' | 'error'): 'gray' | 'yellow' | 'red' => {
	switch (level) {
		case 'info':
			return 'gray';
		case 'warn':
			return 'yellow';
		case 'error':
			return 'red';
	}
};

export const LogPane = ({ row, tailLines = 10 }: LogPaneProps): React.JSX.Element => {
	const lines = row.logTail.lines.slice(-tailLines);
	if (lines.length === 0) {
		return <Text color="gray">no log output</Text>;
	}
	const color = colorForLevel(row.logTail.level);
	return (
		<Box flexDirection="column">
			<Text bold>
				Log — {labelForRow(row.key, row.kind)}
				{row.logTail.truncated ? ' (truncated)' : ''}
			</Text>
			{lines.map((line, idx) => (
				<Text key={idx} color={color}>
					{line}
				</Text>
			))}
		</Box>
	);
};
