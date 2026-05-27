// Shared `unknown → string` projector for sui plugin error messages.
//
// Lifted from 5 identical local definitions across mode/local.ts,
// mode/shared-boot.ts, mode/fork.ts, mode/external.ts, chain-probe.ts,
// fork-transaction.ts. Sui callers concatenate this into plugin-tagged
// error `message` fields; cascade-formatter walks the actual `cause`
// separately for structured rendering.

export const stringifyCause = (cause: unknown): string => {
	if (cause instanceof Error) return cause.message;
	if (typeof cause === 'string') return cause;
	try {
		return JSON.stringify(cause);
	} catch {
		return String(cause);
	}
};
