// Single-line cause summary, routed through `pretty-error.ts` so the
// structured tagged-error / Cause walk is the source of truth. Callers
// that need a short label for a log line or an outer `message` use this;
// callers that need to surface the full structured chain pass the raw
// cause via the tagged error's `cause:` field — the top-level reporter
// walks it.
//
// This module is retained ONLY because services that still wrap their
// inner failures into a single message string consume it. New code
// should prefer threading `cause:` through tagged errors.

import { prettyError } from './pretty-error.js';

export const stringifyCause = (cause: unknown): string => {
	const rendered = prettyError(cause);
	return rendered.split('\n')[0] ?? '';
};
