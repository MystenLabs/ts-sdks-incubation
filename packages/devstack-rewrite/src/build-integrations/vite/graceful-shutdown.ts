// SIGTERM / SIGINT wiring for Vite's dev server.
//
// Architecture § Per-integration requirements (Vite +
// process-tree cleanup): without an explicit signal handler, Vite's
// child of the supervisor inherits the parent process group but does
// NOT close its dev server when the supervisor sends SIGTERM. The
// result is an orphaned process holding the dev-server port until the
// next reboot.
//
// This module wires ONE handler per signal per dev server. Calls are
// idempotent — registering twice does not double-fire close. The
// handler closes the server with a 10s grace before exiting; the
// timeout matches the Playwright preset's `gracefulShutdown` policy
// (architecture § Per-integration requirements / Playwright,
// "SIGTERM + 10s").

import type { ViteDevServer } from 'vite';

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

/** Marker on the server instance so a re-register is a no-op. */
const WIRED_SYMBOL = Symbol.for('@devstack-rewrite/vite/graceful-shutdown/wired');

type WiredFlag = { [WIRED_SYMBOL]?: true };

// -----------------------------------------------------------------------------
// Public surface
// -----------------------------------------------------------------------------

export interface GracefulShutdownOptions {
	/** Grace period in ms before the process force-exits. Default
	 *  10_000 (matches the Playwright preset). */
	readonly graceMs?: number;
	/** Signals to listen for. Default `['SIGTERM', 'SIGINT']`. */
	readonly signals?: ReadonlyArray<'SIGTERM' | 'SIGINT'>;
}

/**
 * Wire SIGTERM / SIGINT handlers that close `server` and exit. Safe
 * to call multiple times per server (uses an instance-level wired
 * marker so a re-register is a no-op).
 *
 * Returns a disposer that detaches the handlers — used by tests and
 * by callers that take ownership of shutdown elsewhere.
 */
export const wireGracefulShutdown = (
	server: ViteDevServer,
	options: GracefulShutdownOptions = {},
): (() => void) => {
	const marker = server as unknown as WiredFlag;
	if (marker[WIRED_SYMBOL]) {
		return () => {
			// No-op disposer when a prior call wired the handlers.
		};
	}
	marker[WIRED_SYMBOL] = true;

	const graceMs = options.graceMs ?? 10_000;
	const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as const);

	const handler = (signal: NodeJS.Signals): void => {
		// Hard-exit fallback if `server.close()` hangs (a known Vite
		// pathology when an HMR WebSocket client is stuck).
		const force = setTimeout(() => {
			// eslint-disable-next-line no-process-exit
			process.exit(143);
		}, graceMs);
		// `unref` so the timer alone doesn't keep the loop alive past
		// the close-success path.
		if (typeof force.unref === 'function') force.unref();

		Promise.resolve(server.close()).finally(() => {
			clearTimeout(force);
			// Mirror the inbound signal in the exit code (POSIX
			// convention: 128 + signum). The supervisor uses this to
			// distinguish graceful from abrupt shutdowns.
			const code = signal === 'SIGINT' ? 130 : 143;
			process.exit(code);
		});
	};

	type SignalHandler = (signal: NodeJS.Signals) => void;
	const registered: Array<{ readonly signal: NodeJS.Signals; readonly fn: SignalHandler }> = [];
	for (const signal of signals) {
		const fn: SignalHandler = () => handler(signal);
		process.on(signal, fn);
		registered.push({ signal, fn });
	}

	return () => {
		for (const { signal, fn } of registered) {
			process.off(signal, fn);
		}
		delete marker[WIRED_SYMBOL];
	};
};
