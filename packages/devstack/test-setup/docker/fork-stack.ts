// `forkDevstackStack(prefix)` — per-test stack isolation for real-Docker
// tests. Generates a unique `DEVSTACK_STACK` so the test doesn't collide
// with the developer's interactive `main` stack OR with parallel vitest
// workers, and exposes a `wipe()` helper for the test's `try/finally`
// cleanup.
//
// Pattern mirrors `engine/snapshot.docker.test.ts:118-127`. The 8-hex
// suffix fits comfortably under docker's 63-char container name cap.

import { randomBytes } from 'node:crypto';
import { runCli } from './cli.js';

export interface StackHandle {
	readonly stack: string;
	readonly env: NodeJS.ProcessEnv;
	/** Best-effort wipe of the test stack. Errors are swallowed — the
	 *  test result is what matters, not the cleanup. Pass an explicit
	 *  `cwd` (typically the example app dir whose `devstack.config.ts`
	 *  the test is running against). */
	readonly wipe: (cwd: string) => Promise<void>;
}

export const forkDevstackStack = (prefix: string): StackHandle => {
	const stack = `${prefix}-${randomBytes(4).toString('hex')}`;
	const env: NodeJS.ProcessEnv = {
		...process.env,
		DEVSTACK_STACK: stack,
	};
	return {
		stack,
		env,
		wipe: async (cwd: string) => {
			await runCli(cwd, env, ['wipe', '--yes']).catch(() => undefined);
		},
	};
};
