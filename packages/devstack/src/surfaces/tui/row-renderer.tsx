// Per-row renderer.
//
// Consumes ONLY the typed projection slice (`Row`) and the derived
// `DisplayCells` from `display-derivation.ts`. NEVER reads
// `row.title`, `row.primary`, `row.extras` — those fields do not
// exist on the projection.
//
// One row = one line in the dashboard. Layout (left → right):
//
//   <statusGlyph> <kindGlyph> <label> <narration?>  <errorSummary?>
//
// Color allocations:
//   - statusGlyph: statusColor()
//   - kindGlyph: labelColor() (kind-derived)
//   - label: labelColor()
//   - narration: gray (de-emphasised, secondary info)
//   - errorSummary: red (only present when row.status === 'failed')

import { Box, Text } from 'ink';
import type React from 'react';

import type { Endpoint, Row } from '../../substrate/projection.ts';
import { deriveDisplayCells } from './display-derivation.ts';

export interface RowRendererProps {
	readonly row: Row;
	readonly selected?: boolean;
	readonly highlightSelectiveRestart?: boolean;
	readonly endpoints?: ReadonlyArray<Endpoint>;
}

export const RowRenderer = ({
	row,
	selected = false,
	highlightSelectiveRestart = false,
	endpoints = [],
}: RowRendererProps): React.JSX.Element => {
	const cells = deriveDisplayCells(row, endpoints);
	const restartTint = highlightSelectiveRestart || row.selectiveRestartHighlight;

	return (
		<Box flexDirection="row" gap={1}>
			<Text color={selected ? 'cyan' : 'gray'}>{selected ? '>' : ' '}</Text>
			<Text color={cells.statusColor}>{cells.statusGlyph}</Text>
			<Text color={cells.labelColor}>{cells.kindGlyph}</Text>
			<Text color={cells.statusColor}>{cells.statusLabel}</Text>
			<Text color={cells.labelColor}>[{cells.owner}]</Text>
			<Text color={cells.labelColor} bold={restartTint} underline={restartTint}>
				{cells.label}
			</Text>
			{cells.narration && <Text color="gray">{cells.narration}</Text>}
			{cells.headline &&
				cells.headline !== cells.narration &&
				cells.headline !== cells.errorSummary && <Text color="cyan">{cells.headline}</Text>}
			{cells.errorSummary && <Text color="red">{cells.errorSummary}</Text>}
		</Box>
	);
};
