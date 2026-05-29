// Shared `unknown → string` projector for plugin error messages.
//
// Lifted from 5 identical local definitions across mode/local.ts,
// mode/shared-boot.ts, mode/fork.ts, mode/external.ts, chain-probe.ts,
// fork-transaction.ts. Callers concatenate this into plugin-tagged
// error `message` fields; cascade-formatter walks the actual `cause`
// separately for structured rendering.
//
// NB: this does NOT stringify Effect's `Cause` type — it projects an
// arbitrary `unknown` (typically a caught throwable) to a short
// string suitable for splicing into a human-readable error message.

// Bounds the `.cause` walk so a self-referential or pathologically deep
// chain can't produce a runaway string (or loop forever).
const MAX_CAUSE_DEPTH = 5;

// A nested `.cause` only earns a place in the spliced message when it
// carries a human-readable string of its own — an `Error`, a string, or
// a tagged object with a `.message`. Raw detail bags (e.g. `{ sender,
// objectCount }`) are skipped here so they don't dump JSON into the
// headline message; the structured cascade-formatter still renders them.
const nestedCauseMessage = (cause: unknown, depth: number): string | null => {
	if (cause instanceof Error) return cause.message;
	if (typeof cause === 'string') return cause.length > 0 ? cause : null;
	if (typeof cause === 'object' && cause !== null) {
		const message = (cause as { readonly message?: unknown }).message;
		if (typeof message === 'string' && message.length > 0) {
			return project(cause, depth);
		}
	}
	return null;
};

const project = (cause: unknown, depth: number): string => {
	if (cause instanceof Error) return cause.message;
	if (typeof cause === 'string') return cause;
	if (typeof cause === 'object' && cause !== null) {
		const tagged = cause as { readonly message?: unknown; readonly cause?: unknown };
		// Tagged devstack errors (`AccountSignError`, `SuiPluginError`, …)
		// are plain objects, NOT `Error` instances — `String(obj)` on them
		// yields `[object Object]`. Prefer their `.message`, then chain the
		// `.cause` so a generic wrapper ("… submit failed.") still surfaces
		// the actionable root ("… no SUI gas coins found for 0x…").
		if (typeof tagged.message === 'string' && tagged.message.length > 0) {
			const nested =
				depth < MAX_CAUSE_DEPTH ? nestedCauseMessage(tagged.cause, depth + 1) : null;
			return nested !== null && !tagged.message.includes(nested)
				? `${tagged.message} [cause: ${nested}]`
				: tagged.message;
		}
	}
	try {
		return JSON.stringify(cause);
	} catch {
		return String(cause);
	}
};

export const formatUnknownError = (cause: unknown): string => project(cause, 0);
