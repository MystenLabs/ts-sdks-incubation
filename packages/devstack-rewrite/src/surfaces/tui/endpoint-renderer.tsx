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

import type { Endpoint } from '../../substrate/projection.ts';
import { endpointLine } from './display-derivation.ts';

export interface EndpointRendererProps {
	readonly endpoints: ReadonlyArray<Endpoint>;
}

export const EndpointRenderer = ({ endpoints }: EndpointRendererProps): React.JSX.Element => {
	if (endpoints.length === 0) {
		return <Text color="gray">no endpoints registered</Text>;
	}
	return (
		<Box flexDirection="column">
			<Text bold>Endpoints</Text>
			{endpoints.map((endpoint) => (
				<Text key={endpoint.endpointKey} color="cyan">
					{endpointLine(endpoint)}
				</Text>
			))}
		</Box>
	);
};
