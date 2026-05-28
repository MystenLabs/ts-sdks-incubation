// Bounded stdout/stderr trimming for error-message tails.
//
// Two failure-message shapes converged on the same primitive:
//   - `walrus/deploy.ts::excerpt` — emit a labelled, JSON-quoted body
//     (` stdout="..."`) with mid-truncation when oversize (head + tail
//     window with a `<truncated N chars>` marker), elided when empty.
//   - `seal/bootstrap-assets/source-fetch.ts::outputTail` — emit just
//     the last N chars of the raw stream, passed as the `stdout:` /
//     `stderr:` field of a typed error.
//
// Both are stdout/stderr bound-the-blast-radius helpers. Both used to
// inline ad-hoc constants. Folded into one module so the
// boundedness-policy lives in ONE place and the per-call-site shape
// (label-wrapped vs raw tail) is just an output decision.

/** Return the trailing `maxChars` characters of `value`, or `value`
 *  unchanged if shorter. Used at error-construction sites that want to
 *  surface the most-recent output (typically where the failure cause
 *  appears at the END of a long stream — e.g. a git clone trace whose
 *  fatal line is the last one). Defaults to 1000 chars, the source-fetch
 *  call sites' original budget. */
export const tailOutput = (value: string, maxChars: number = 1_000): string =>
	value.length > maxChars ? value.slice(-maxChars) : value;

/** Render `value` as a labelled, JSON-quoted suffix (` <label>=<json>`)
 *  for inline error messages. Empty / whitespace-only input collapses to
 *  the empty string so the caller can unconditionally concatenate the
 *  result without producing dangling labels.
 *
 *  Oversize input is mid-truncated: a head slice + literal
 *  `...<truncated N chars>...` + a tail slice, keeping both the leading
 *  context (which often identifies the command) AND the trailing context
 *  (which often identifies the cause). Defaults size the output so a
 *  combined stdout + stderr fits inside an L4-level log line without
 *  overflowing typical terminal scroll buffers.
 *
 *  @param maxChars - total budget before mid-truncation kicks in (default
 *    2400). Below this the body is emitted verbatim.
 *  @param windowChars - per-side window kept when truncating (default
 *    1100). Total kept output is roughly `2 * windowChars` plus the
 *    truncation marker. */
export const labelledExcerpt = (
	label: string,
	value: string,
	maxChars: number = 2_400,
	windowChars: number = 1_100,
): string => {
	const trimmed = value.trim();
	if (trimmed.length === 0) return '';
	const body =
		trimmed.length > maxChars
			? `${trimmed.slice(0, windowChars)}...<truncated ${trimmed.length - 2 * windowChars} chars>...${trimmed.slice(-windowChars)}`
			: trimmed;
	return ` ${label}=${JSON.stringify(body)}`;
};
