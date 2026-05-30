// Typed `process.env` accessor.
//
// The devstack package is consumed from both Node and browser-like
// runtimes (Playwright fixtures, vitest browser mode), so we can't
// reach for `process.env` directly — TypeScript with `"types": []`
// rejects the global. Callers used to inline a one-off
// `globalThis as { process?: { env?: ... } }` cast every time they
// needed to read an env var. This centralises the cast so the rest of
// the code reads `readEnv('FOO')` cleanly.
//
// Returns `undefined` when the runtime has no `process.env` (browser),
// or when the env var is unset. Callers treat `undefined` and `''` as
// equivalent "absent" sentinels.

export const readEnv = (name: string): string | undefined => {
	const process = (
		globalThis as { process?: { env?: Record<string, string | undefined> } }
	).process;
	return process?.env?.[name];
};
