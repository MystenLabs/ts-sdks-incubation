// Error pane — renders structured errors using the shared cascade
// formatter from substrate/runtime/observability/cascade-formatter.ts.
//
// Architecture: pretty-error rendering is a renderer concern, not
// engine-resident. The pane reads the projection's `errors[]` slice
// and the per-row `lastError` and uses the same L0 cascade formatter
// the CLI / programmable surface use; this guarantees consistent
// failure surface across surfaces (no renderer-specific divergence).
//
// We do NOT re-render the cascade for every frame; instead, the
// rendered cascade is computed by `formatValue` and the result is a
// string ready to display.

import { Box, Text } from 'ink';
import type React from 'react';

import { formatValue } from '../../substrate/runtime/observability/cascade-formatter.ts';
import type { StructuredError } from '../../substrate/projection.ts';

export interface ErrorPaneProps {
	readonly errors: ReadonlyArray<StructuredError>;
	/** Cap shown errors so the pane doesn't overflow the terminal. */
	readonly limit?: number;
}

const colorForSeverity = (severity: StructuredError['severity']): 'red' | 'yellow' | 'magenta' => {
	switch (severity) {
		case 'fatal':
			return 'magenta';
		case 'error':
			return 'red';
		case 'warn':
			return 'yellow';
	}
};

/**
 * Format a single structured-error entry using the cascade formatter.
 * The `chain` field carries the pre-walked cause chain (engine-side
 * convenience); we feed it through `formatValue` for consistent
 * rendering.
 */
export const formatStructuredError = (error: StructuredError): string => {
	const header = `[${error.tag}] ${error.summary}`;
	if (error.chain.length === 0) return header;
	// `chain` is the cause-walker's output (string lines). We render
	// it through the same shared formatter so future enhancements
	// (per-tag formatters) take effect here too.
	const causeBlob = error.chain.join('\n');
	return `${header}\n${formatValue(causeBlob)}`;
};

export const ErrorPane = ({ errors, limit = 5 }: ErrorPaneProps): React.JSX.Element => {
	if (errors.length === 0) {
		return <Text color="gray">no errors</Text>;
	}
	const shown = errors.slice(-limit).reverse();
	return (
		<Box flexDirection="column">
			<Text bold>
				Errors {errors.length > limit ? `(showing latest ${limit} of ${errors.length})` : ''}
			</Text>
			{shown.map((error, idx) => (
				<Box key={`${error.at}-${idx}`} flexDirection="column" marginBottom={1}>
					<Text color={colorForSeverity(error.severity)}>{formatStructuredError(error)}</Text>
				</Box>
			))}
		</Box>
	);
};
