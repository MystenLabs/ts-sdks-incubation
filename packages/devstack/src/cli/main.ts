#!/usr/bin/env node
// Bin entry. Provides the Node platform layers (FileSystem, Path,
// ChildProcessSpawner, Stdio, Terminal — bundled via NodeServices.layer) so
// that both the CLI itself and any dynamically-imported user
// `devstack.config.ts` can resolve them. Hands the resulting effect to
// `NodeRuntime.runMain` for signal handling and exit codes.
//
// Error printing is owned by `cli/index.ts`'s `Effect.tapCause`, which walks
// the full tagged-error tree via `prettyError`. To avoid duplicate output:
//   - `disableErrorReporting: true` suppresses runMain's built-in
//     `Effect.tapCause(...Effect.logError(cause))` wrapper (which would
//     otherwise re-print the cause with a `[timestamp] ERROR (#N):` prefix
//     via Effect's default Logger).
//   - The teardown below sets the exit code without re-rendering the cause
//     (no `console.error(Cause.pretty(...))`) — `cli/index.ts` already did
//     that in our preferred format.

import { Cause, Effect, Exit, Layer } from 'effect';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { runMain } from '@effect/platform-node/NodeRuntime';
import { RegistryLive } from '../engine/registry.js';
import { cli } from './index.js';

const CliPlatform = Layer.provideMerge(RegistryLive, NodeServicesLayer);

// Custom teardown so a Ctrl-C / `q`-keypress quit exits cleanly with 0
// instead of 130. Without this `pnpm dev` users see
// `ELIFECYCLE Command failed with exit code 130` after every clean
// shutdown — `pnpm` reads any non-zero as a failure regardless of
// signal semantics. Real failures (non-interrupted causes) exit 1; the
// error itself was already rendered by `cli/index.ts`'s `tapCause`.
runMain(cli.pipe(Effect.provide(CliPlatform)) as Effect.Effect<void, unknown, never>, {
	disableErrorReporting: true,
	teardown: (exit, onExit) => {
		if (Exit.isSuccess(exit)) {
			onExit(0);
			return;
		}
		if (Cause.hasInterruptsOnly(exit.cause)) {
			onExit(0);
			return;
		}
		onExit(1);
	},
});
