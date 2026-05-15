#!/usr/bin/env node
// Bin entry. Provides the Node platform layers (FileSystem, Path,
// ChildProcessSpawner, Stdio, Terminal — bundled via NodeServices.layer) so
// that both the CLI itself and any dynamically-imported user
// `devstack.config.ts` can resolve them. Hands the resulting effect to
// `NodeRuntime.runMain` for signal handling, error reporting, and exit codes.

import { Cause, Effect, Exit } from 'effect';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { runMain } from '@effect/platform-node/NodeRuntime';
import { cli } from './index.js';

// Custom teardown so a Ctrl-C / `q`-keypress quit exits cleanly with 0
// instead of 130. Without this `pnpm dev` users see
// `ELIFECYCLE Command failed with exit code 130` after every clean
// shutdown — `pnpm` reads any non-zero as a failure regardless of
// signal semantics. We still surface real failures (non-interrupted
// causes) with exit 1 + a logged error.
runMain(cli.pipe(Effect.provide(NodeServicesLayer)), {
	teardown: (exit, onExit) => {
		if (Exit.isSuccess(exit)) {
			onExit(0);
			return;
		}
		if (Cause.hasInterruptsOnly(exit.cause)) {
			onExit(0);
			return;
		}
		// eslint-disable-next-line no-console
		console.error(Cause.pretty(exit.cause));
		onExit(1);
	},
});
