// Endpoint list renderer.
//
// Endpoints come from the top-level `state.endpoints[]` slice; each
// endpoint references an owning row by brand prefix (the projection
// reducer in `state-ref.ts::attachEndpoint` populates `row.endpoints`
// with the corresponding endpoint keys). This component renders the
// flat list — for inline-per-row endpoints, the dashboard composes
// it next to its row.

import { Box, Text } from 'ink';
import type React from 'react';

import type { Endpoint, Row } from '../../substrate/projection.ts';
import { endpointLine, groupEndpoints } from './display-derivation.ts';

export interface EndpointRendererProps {
	readonly endpoints: ReadonlyArray<Endpoint>;
	readonly rows?: ReadonlyArray<Row>;
}

export const EndpointRenderer = ({
	endpoints,
	rows = [],
}: EndpointRendererProps): React.JSX.Element => {
	if (endpoints.length === 0) {
		return <Text color="gray">no endpoints registered</Text>;
	}
	const groups = rows.length > 0 ? groupEndpoints(rows, endpoints) : [];
	return (
		<Box flexDirection="column">
			<Text bold>Endpoints</Text>
			{groups.length > 0
				? groups.map((group) => (
						<Box key={group.key} flexDirection="column">
							<Text color="gray">{group.label}</Text>
							{group.endpoints.map((endpoint) => (
								<Text key={endpoint.endpointKey} color="cyan">
									{endpointLine(endpoint)}
								</Text>
							))}
						</Box>
					))
				: endpoints.map((endpoint) => (
						<Text key={endpoint.endpointKey} color="cyan">
							{endpointLine(endpoint)}
						</Text>
					))}
		</Box>
	);
};
