// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppleHelper } from './helper.js';
import { SubprocessHelper } from './helper.js';

/**
 * A module-scoped promise for the shared helper. Lazily created on first use
 * so that consumers who never call a factory (or use a custom `helper`) don't
 * pay the subprocess-spawn cost, and so that cleanup hooks are only installed
 * once we have a process to clean up.
 */
let defaultHelperPromise: Promise<AppleHelper> | null = null;
let installedCleanup = false;

/**
 * Returns the shared default helper subprocess, spawning it on first call.
 *
 * All factory functions that don't receive an explicit `helper` option route
 * through here. Consequence: one helper per Node process, shared across every
 * signer type (enclave + keychain), which means **one biometric prompt per
 * process run** regardless of how many signers you create.
 *
 * Users who need isolation (tests, multi-tenant scenarios) should construct
 * `new SubprocessHelper(...)` themselves and pass it via the `helper` option.
 */
export async function getDefaultHelper(): Promise<AppleHelper> {
	if (!defaultHelperPromise) {
		defaultHelperPromise = SubprocessHelper.load();
		installProcessCleanup();
	}
	return defaultHelperPromise;
}

/** Exposed for tests — resets the default helper so new calls spawn a fresh one. */
export function __resetDefaultHelperForTesting(): void {
	defaultHelperPromise = null;
}

/**
 * Cleanup strategy: rely on the subprocess self-terminating when its stdin pipe
 * gets EOF. That happens automatically during any normal Node teardown
 * (`process.exit`, uncaught exception → Node's auto-exit, default SIGINT/SIGTERM
 * handling) — Node closes child stdin as part of shutting down, the helper's
 * Swift `readLine()` returns nil, the loop exits, the helper dies.
 *
 * We deliberately do NOT install `SIGINT`/`SIGTERM` listeners. Doing so would
 * override Node's default signal behavior and conflict with app-owned shutdown
 * coordinators (frameworks, graceful-shutdown libs, test runners, process
 * managers). The `'exit'` handler below is belt-and-suspenders — `'exit'` is
 * synchronous-only, so we can't await the helper's `close()`, but we flag the
 * promise chain so any microtasks that manage to run see a closed state.
 */
function installProcessCleanup(): void {
	if (installedCleanup) return;
	installedCleanup = true;

	process.once('exit', () => {
		if (!defaultHelperPromise) return;
		defaultHelperPromise.then((h) => h.close()).catch(() => {});
	});
}
