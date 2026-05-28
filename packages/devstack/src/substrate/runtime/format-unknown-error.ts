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

export const formatUnknownError = (cause: unknown): string => {
	if (cause instanceof Error) return cause.message;
	if (typeof cause === 'string') return cause;
	try {
		return JSON.stringify(cause);
	} catch {
		return String(cause);
	}
};
