import { Box, Text } from 'ink';
import type React from 'react';

import type { Endpoint, Row } from '../../substrate/projection.ts';
import { deriveDisplayCells, endpointsForRow } from './display-derivation.ts';

export interface DetailPaneProps {
	readonly row: Row | null;
	readonly endpoints: ReadonlyArray<Endpoint>;
}

export const DetailPane = ({ row, endpoints }: DetailPaneProps): React.JSX.Element => {
	if (row === null) return <Text color="gray">No row selected</Text>;
	const cells = deriveDisplayCells(row, endpoints);
	const rowEndpoints = endpointsForRow(row, endpoints);
	return (
		<Box flexDirection="column">
			<Text bold>Details - {cells.label}</Text>
			<Text>
				<Text color={cells.statusColor}>{cells.statusLabel}</Text>
				<Text color="gray"> / {cells.section}</Text>
				<Text color="gray"> / owner {cells.owner}</Text>
			</Text>
			{cells.headline.length > 0 && <Text color="cyan">{cells.headline}</Text>}
			{rowEndpoints.map((endpoint) => (
				<Text key={endpoint.endpointKey} color="cyan">
					{endpoint.name} {endpoint.displayUrl ?? endpoint.url}
				</Text>
			))}
			{cells.secondary.map((line, idx) => (
				<Text key={idx} color="gray">
					{line}
				</Text>
			))}
			{row.lastError !== null && (
				<>
					<Text color="red">
						{row.lastError.tag}: {row.lastError.summary}
					</Text>
					{row.lastError.chain.map((line, idx) => (
						<Text key={idx} color="red">
							{line}
						</Text>
					))}
				</>
			)}
		</Box>
	);
};
