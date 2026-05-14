export const stringifyCause = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);
